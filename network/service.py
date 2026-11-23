"""Continuous sampling stays on the server, independent of the number of open browsers."""
import logging
import secrets
import sqlite3
import ssl
import threading
import time
from collections import defaultdict

from .actions import Actions, millis
from .history import History, RANGES
from .measure import client_readings, integer, newer, physical_wan, ping_result, port_details, seconds, select_wan, total
from .routeros import Router, Trap

STATUS_INTERVAL = 3
WAN_INTERVAL = 5
CLIENT_INTERVAL = 10
QUALITY_INTERVAL = 60


def initial(config):
    return {"online": None, "end": 0, "lastSample": None, "source": f"正在连接 {config.protocol_name}", "site": "RB5009",
            "model": "", "version": "", "uptime": "", "cpu": None, "memory": None, "iface": "", "wanPort": "", "address": "",
            "down": None, "up": None, "latency": None, "loss": None, "pingTarget": config.ping, "ports": None, "logs": None,
            "clientReady": False, "historyRouterId": config.gateway_id,
            "maintenance": {"routerId": config.gateway_id, "routerName": "", "canWrite": False, "latest": "",
                            "available": False, "channel": "", "status": "", "boot": None}}


class Service:
    def __init__(self, config):
        self.config, self.lock = config, threading.RLock()
        self.history = History(config.data, config.gateway_id)
        self.state = initial(config)
        self.actions = Actions(self)
        self.epoch = 0
        self.sync_session = secrets.token_hex(8)
        self.stopping = threading.Event()
        self.next_run = {}
        self.ports, self.addresses, self.flow_base = {}, {}, {}
        self.board, self.package = {}, {}
        self.wan, self.wan_port, self.name, self.flow_ts = "", "", "", 0
        self.has_logs_viewer_until = 0

    def due(self, key, now, interval):
        deadline = self.next_run.get(key, now)
        if now < deadline:
            return False
        # Anchor deadlines to the cadence and skip missed rounds after a slow response.
        self.next_run[key] = deadline + (int((now - deadline) // interval) + 1) * interval
        return True

    def poll(self, router):
        now = time.monotonic()
        status_due = self.due("status", now, STATUS_INTERVAL)
        traffic_due = self.due("traffic", now, WAN_INTERVAL)
        if not (status_due or traffic_due):
            return
        with self.lock:
            epoch = self.epoch
            collect_logs = self.has_logs_viewer_until > now
            pending = self.actions.job and self.actions.job["stage"] not in {"verified", "failed", "unknown"}
            prev_flows, prev_ts = self.flow_base, self.flow_ts
        resource_fields = "uptime"
        if traffic_due:
            resource_fields += ",board-name,version"
        if status_due:
            resource_fields += ",cpu-load,total-memory,free-memory"
        resource = router.table("/system/resource", resource_fields)
        if not resource:
            raise Trap("resource missing")
        r = resource[0]
        status = {}
        if status_due:
            self.ports = port_details(router)
            mem, free = integer(r.get("total-memory")), integer(r.get("free-memory"))
            status = {"cpu": integer(r.get("cpu-load")), "memory": round((mem - free) * 100 / mem, 1) if mem and free is not None else None,
                      "uptime": r.get("uptime", "")}
        if not traffic_due:
            # Update only the live fields, retaining the last measured rates and byte totals.
            with self.lock:
                self.state.update(status)
                if self.state["ports"] is not None:
                    self.state["ports"] = [p | self.ports.get(p["name"], {"linkRate": "", "poe": None}) for p in self.state["ports"]]
            return
        fields = ".id,name,type,running,disabled,comment,mac-address,rx-byte,tx-byte,rx-error,tx-error,rx-drop,tx-drop,link-downs"
        interfaces = router.table("/interface", fields)
        ts = millis()
        if self.due("network", now, 30):
            ips = router.optional("/ip/address", "address,interface,actual-interface,disabled")
            self.addresses = defaultdict(list)
            for row in ips:
                if row.get("disabled") != "true" and row.get("address"):
                    self.addresses[row.get("actual-interface") or row.get("interface", "")].append(row["address"])
            routes = router.optional("/ip/route", "gateway,immediate-gw,active,routing-table", "?dst-address=0.0.0.0/0")
            lists = router.optional("/interface/list/member", "list,interface", "?list=WAN")
            interface_types = {p["name"]: p.get("type") for p in interfaces if p.get("name")}
            self.wan = select_wan(self.config.wan, routes, lists, set(interface_types))
            self.wan_port = physical_wan(router, self.wan, interface_types, self.ports)
            self.name = (router.optional("/system/identity", "name") or [{}])[0].get("name", "")
        readings = []
        for p in interfaces:
            name = p.get("name")
            if not name:
                continue
            readings.append({"name": name, "id": p.get(".id", name), "type": p.get("type", ""), "running": p.get("running") == "true",
                             "disabled": p.get("disabled") == "true", "comment": p.get("comment", ""), "macAddr": p.get("mac-address", ""),
                             "rxBytes": integer(p.get("rx-byte")), "txBytes": integer(p.get("tx-byte")),
                             "errors": total(p, "rx-error", "tx-error"), "drops": total(p, "rx-drop", "tx-drop"),
                             "linkDowns": integer(p.get("link-downs")), "ips": self.addresses.get(name, []),
                             "physical": name in self.ports or p.get("type") == "ether", **self.ports.get(name, {})})

        if self.due("update-check", now, 12 * 3600) and not pending:
            try:
                router.call("/system/package/update/check-for-updates", "=once=")
            except Trap:
                pass
        # The update status is local to the router. It can report bytes, a percentage, or only a phase.
        if self.due("versions", now, 10) or pending:
            self.package = (router.optional("/system/package/update", "channel,installed-version,latest-version,status") or [{}])[0]
            self.board = (router.optional("/system/routerboard", "model,current-firmware,upgrade-firmware") or [{}])[0]
        update, board = self.package, self.board
        installed = r.get("version", "")
        curr, latest = board.get("current-firmware", ""), board.get("upgrade-firmware", "")
        boot = {"current": curr, "latest": latest, "available": newer(latest, curr)} if curr else None
        address = next(iter(self.addresses.get(self.wan, [])), "").split("/")[0]
        sample = {**status, "online": True, "lastSample": ts, "source": f"RouterOS {self.config.protocol_name}", "site": self.name or "RB5009",
                  "model": board.get("model") or r.get("board-name", ""), "version": installed,
                  "iface": self.wan, "wanPort": self.wan_port, "address": address,
                  "maintenance": {"routerId": self.config.gateway_id, "routerName": self.name, "canWrite": bool(self.config.admin_password),
                                  "latest": update.get("latest-version", ""), "available": newer(update.get("latest-version", ""), installed),
                                  "channel": update.get("channel", ""), "status": update.get("status", ""), "boot": boot}}

        ping = devices = flows = None
        if self.due("ping", now, QUALITY_INTERVAL):
            try:
                ping = ping_result(router.call("/tool/ping", "=address=" + self.config.ping, "=count=3", "=interval=300ms"))
            except Trap:
                pass
            sample.update(latency=ping["rtt"] if ping else None, loss=ping["loss"] if ping else None)
        if self.due("clients", now, CLIENT_INTERVAL):
            local = {ip.split("/")[0] for ips in self.addresses.values() for ip in ips}
            devices, flows = client_readings(router, ts, prev_flows, prev_ts, local)
        if collect_logs and self.due("logs", now, 10):
            try:
                logs = router.table("/log", "time,topics,message")
                sample["logs"] = [{"time": v.get("time", ""), "topics": v.get("topics", ""), "message": v.get("message", ""),
                                   "severity": next((k for k in ("critical", "error", "warning", "debug") if k in v.get("topics", "").split(",")), "info")}
                                  for v in reversed(logs[-500:])]
            except Trap:
                sample["logs"] = None
        with self.lock:
            if self.epoch != epoch:
                # A reset happened while the router commands were in flight.
                self.next_run.clear()
                return
            with self.history.db:
                ports, down, up = self.history.interfaces(readings, self.wan, ts, seconds(r.get("uptime")))
                if ping:
                    self.history.save_ping(self.config.ping, ts, ping)
                if devices is not None:
                    self.history.save_clients(ts, devices)
                if self.due("prune", now, 3600):
                    self.history.prune(ts)
            self.state.update(sample, ports=ports, down=down, up=up)
            if devices is not None:
                self.flow_base, self.flow_ts = flows, ts
                self.state["clientReady"] = True
            self.actions.observe(self.state | {"uptime": r.get("uptime", "")})

    def offline(self, reason):
        with self.lock:
            self.flow_base, self.flow_ts = {}, 0
            # Do not carry last night's readings forward as live rates.
            self.state.update(online=False, source=reason, down=None, up=None, cpu=None, memory=None,
                              latency=None, loss=None, ports=None, logs=None, uptime="")
            self.next_run = {k: v for k, v in self.next_run.items() if k == "update-check"}

    def run(self):
        router, delay = None, 2
        try:
            while not self.stopping.is_set():
                try:
                    if not router:
                        router = Router(self.config)
                    self.poll(router)
                    delay = 2
                    now = time.monotonic()
                    next_poll = min(self.next_run.get("status", now), self.next_run.get("traffic", now))
                    self.stopping.wait(max(0, next_poll - now))
                except (OSError, Trap, sqlite3.Error) as e:
                    if isinstance(e, ssl.SSLCertVerificationError):
                        reason = "API-SSL 证书校验失败，请核对 CA 和证书名称"
                    elif isinstance(e, Trap):
                        reason = "RouterOS 拒绝登录或读取，请核对账号权限"
                    elif isinstance(e, sqlite3.Error):
                        reason = "SQLite 读写失败，请检查数据卷"
                    else:
                        reason = f"无法连接 {self.config.protocol_name}，请核对网关地址、服务端口和允许来源"
                    if reason != self.state["source"]:
                        logging.warning("%s (%s)", reason, type(e).__name__)
                    self.offline(reason)
                    if router:
                        router.close()
                        router = None
                    self.stopping.wait(delay)
                    delay = min(delay * 2, 60)
        finally:
            if router:
                router.close()

    def snapshot(self, span, page, cursor=""):
        with self.lock:
            now = millis()
            if page == "logs":
                self.has_logs_viewer_until = time.monotonic() + 30
            online = bool(self.state["online"])
            clients = self.history.clients(now, online)
            history = self.history.traffic(now, RANGES[span])
            pings = self.history.pings(self.config.ping, now)
            # Acknowledging committed samples avoids skipping an in-flight collection.
            stamp = max([self.state["lastSample"] or 0] + [p["ts"] for p in history["points"]] +
                        [p["ts"] for c in clients for p in c["samples"]] + [p["ts"] for p in pings])
            prefix = f"{self.sync_session}:{self.epoch}:{span}"
            previous, _, raw_stamp = cursor.rpartition(":")
            since = int(raw_stamp) if raw_stamp.isdecimal() and len(raw_stamp) <= 16 else -1
            incremental = previous == prefix and 0 <= since <= stamp
            bucket = max(10000, RANGES[span] // 240)
            if incremental:
                for client in clients:
                    client["samples"] = [p for p in client["samples"] if p["ts"] > since]
                pings = [p for p in pings if p["ts"] > since]
                # Both edge buckets can change as the window moves or receives a sample.
                history["points"] = [p for i, p in enumerate(history["points"])
                                     if i == 0 or p["ts"] // bucket >= since // bucket]
            return {**self.state, "logs": self.state["logs"] if page == "logs" else None, "end": now, "clientsAsOf": now,
                    "history": history, "pings": pings, "clients": clients,
                    "sync": {"cursor": f"{prefix}:{stamp}", "incremental": incremental, "bucketMs": bucket},
                    "clientReady": self.state["clientReady"] or bool(clients), "progress": self.actions.public()}

    def reset(self):
        with self.lock:
            now = millis()
            count = self.history.clear(now)
            self.epoch += 1
            self.flow_base, self.flow_ts = {}, 0
            self.state.update(latency=None, loss=None)
            if self.state["ports"]:
                self.state["ports"] = [p | {"panelBytes": {d: 0 if p[d + "Bytes"] is not None else None for d in ("rx", "tx")}}
                                       for p in self.state["ports"]]
            return {"routerId": self.config.gateway_id, "deleted": count, "ts": now}
