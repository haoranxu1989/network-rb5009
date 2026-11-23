"""Translate RouterOS readings into the fields shown on the Network dashboard."""
import re
from collections import defaultdict
from .routeros import Trap

DURATION = re.compile(r"(\d+(?:\.\d+)?)(ms|us|µs|ns|w|d|h|m|s)")
SECONDS = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1,
           "ms": .001, "us": .000001, "µs": .000001, "ns": .000000001}


def seconds(raw):
    if not raw:
        return None
    clock = re.fullmatch(r"(?:(\d+)w)?(?:(\d+)d)?(\d+):(\d+):(\d+(?:\.\d+)?)", raw)
    if clock:
        return sum(float(v or 0) * k for v, k in zip(clock.groups(), (604800, 86400, 3600, 60, 1)))
    parts = DURATION.findall(raw)
    if not parts or "".join(n + u for n, u in parts) != raw:
        return None
    return sum(float(n) * SECONDS[u] for n, u in parts)


def integer(raw):
    try:
        value = int(raw)
        return value if 0 <= value <= 2**63 - 1 else None
    except (ValueError, TypeError):
        return None


def total(row, *fields):
    values = [integer(row.get(f)) for f in fields]
    return sum(values) if all(v is not None for v in values) else None


def newer(latest, current):
    def order(v):
        m = re.fullmatch(r"(\d+)\.(\d+)(?:\.(\d+))?(?:(alpha|beta|rc)(\d+))?", v.split(" ")[0])
        if not m:
            return ()
        return (*[int(s or 0) for s in m.groups()[:3]], {"alpha": 0, "beta": 1, "rc": 2, None: 3}[m[4]], int(m[5] or 0))
    return bool(order(current) and order(latest) > order(current))


def watts(raw):
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(mw|dw|w)?", raw.strip().lower())
    # The native PoE monitor reports bare watts, including whole numbers.
    return float(match[1]) * {"mw": .001, "dw": .1, "w": 1, None: 1}[match[2]] if match else None


def monitor(router, menu, rows, fields):
    ids = ",".join(row[".id"] for row in rows if ".id" in row)
    if not ids:
        return {}
    try:
        result = router.call(menu + "/monitor", "=numbers=" + ids, "=once=", "=.proplist=" + fields)
    except Trap:
        return {}
    return {r["name"]: r for r in result if "name" in r}


def port_details(router):
    menu = "/interface/ethernet"
    ports = router.optional(menu, ".id,name,default-name,running,disabled")
    links = monitor(router, menu, ports, "name,status,rate")
    poe_rows = router.optional(menu + "/poe", ".id,name,port-type,poe-out")
    power = monitor(router, menu + "/poe", poe_rows, "name,port-type,poe-out,poe-out-status,poe-out-power")
    poe = {}
    for row in poe_rows:
        name = row.get("name", "")
        r = row | power.get(name, {})
        kind, mode = r.get("port-type", ""), r.get("poe-out", "")
        status = r.get("poe-out-status", "disabled" if mode == "off" else "")
        poe[name] = {"input": "poe-in" in kind, "output": "poe-out" in kind or (not kind and bool(mode or status)),
                     "status": status, "watts": watts(r.get("poe-out-power", "")) if status == "powered-on" else None}
    details = {}
    for row in ports:
        name = row.get("name")
        if not name:
            continue
        port = {"defaultName": row.get("default-name", name), "linkRate": links.get(name, {}).get("rate", ""), "poe": poe.get(name)}
        for field in ("running", "disabled"):
            if field in row:
                port[field] = row[field] == "true"
        details[name] = port
    return details


def select_wan(configured, routes, members, interfaces):
    if configured:
        return configured if configured in interfaces else ""
    for route in routes:
        if route.get("active") != "true" or route.get("routing-table", "main") != "main":
            continue
        gw = route.get("immediate-gw") or route.get("gateway", "")
        name = gw.split("%")[-1]
        if name in interfaces:
            return name
    candidates = {r.get("interface") for r in members if r.get("list") == "WAN"} & interfaces
    return next(iter(candidates)) if len(candidates) == 1 else ""


def physical_wan(router, name, interface_types, ports):
    parents = {"pppoe-out": "/interface/pppoe-client", "vlan": "/interface/vlan"}
    visited = set()
    while name and name not in visited:
        if name in ports or interface_types.get(name) == "ether":
            return name
        menu = parents.get(interface_types.get(name))
        if not menu:
            break
        visited.add(name)
        rows = router.optional(menu, "interface", "?name=" + name)
        name = rows[0].get("interface", "") if len(rows) == 1 else ""
    return ""


def ping_result(rows):
    latencies = []
    for r in rows:
        duration = seconds(r.get("time") or r.get("response-time"))
        if duration is not None:
            latencies.append(duration * 1000)
    last = rows[-1] if rows else {}
    sent, received = integer(last.get("sent")), integer(last.get("received"))
    if not sent:
        sent = sum(bool("seq" in r or "time" in r or "status" in r or "response-time" in r) for r in rows)
        received = len(latencies)
    if not sent or received is None:
        return None
    rtt = sum(latencies) / len(latencies) if latencies else None
    if rtt is None and received and (avg := seconds(last.get("avg-rtt"))) is not None:
        rtt = avg * 1000
    return {"rtt": round(rtt, 2) if rtt is not None else None, "loss": round(100 * (sent - received) / sent, 1)}


def endpoint(raw):
    if raw.startswith("["):
        return raw[1:].split("]")[0]
    return raw.split(":")[0] if raw.count(":") == 1 else raw


def client_readings(router, ts, previous, previous_ts, local_addresses):
    """Only matching flows with two samples contribute. Keep DHCP identity separate from evidence of activity."""
    leases = router.optional("/ip/dhcp-server/lease", "address,active-address,mac-address,active-mac-address,host-name,comment,status,last-seen", "?status=bound")
    arp = router.optional("/ip/arp", "address,mac-address,interface,status")
    sessions = router.optional("/ppp/active", "name,address,caller-id,service,uptime", "?service=pppoe")
    devices, by_ip = {}, {}

    def device(mac, ip, name="", connection=""):
        if not ip or ip in local_addresses:
            return None
        key = mac.upper() if mac else "ip:" + ip
        c = devices.setdefault(key, {"id": key, "name": name or ip, "ip": ip, "mac": mac.upper(), "connection": connection,
                                     "status": "已发现", "lastSeen": 0, "connectedAt": None, "down": None, "up": None})
        c["connection"] = c["connection"] or connection
        by_ip[ip] = c
        return c

    for r in leases:
        c = device(r.get("active-mac-address") or r.get("mac-address", ""), r.get("active-address") or r.get("address", ""),
                   r.get("host-name") or r.get("comment", ""))
        age = seconds(r.get("last-seen"))
        if c and age is not None:
            c["lastSeen"] = max(0, ts - int(age * 1000))
    for r in arp:
        if not r.get("mac-address") or r.get("status") in ("failed", "incomplete"):
            continue
        c = device(r["mac-address"], r.get("address", ""), connection=r.get("interface", ""))
        if c and r.get("status") == "reachable":
            c["lastSeen"] = ts
    for r in sessions:
        caller = r.get("caller-id", "")
        mac = caller if re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", caller) else ""
        c = by_ip.get(r.get("address")) or device(mac, r.get("address", ""), r.get("name", ""))
        if c:
            age = seconds(r.get("uptime"))
            c.update(connection="PPPoE", status="PPPoE 已连接", lastSeen=ts,
                     connectedAt=ts - int(age * 1000) if age is not None else None)

    flow_key = (".id", "protocol", "src-address", "src-port", "dst-address", "dst-port",
                "reply-src-address", "reply-src-port", "reply-dst-address", "reply-dst-port")
    fields = ",".join((*flow_key, "orig-bytes", "repl-bytes"))
    flows = router.optional("/ip/firewall/connection", fields)
    current, totals = {}, defaultdict(lambda: [0, 0])
    dt = ts - previous_ts
    for r in flows:
        src, dst = endpoint(r.get("src-address", "")), endpoint(r.get("dst-address", ""))
        # The reply source identifies a LAN server behind destination NAT.
        a = by_ip.get(src)
        b = by_ip.get(endpoint(r.get("reply-src-address", ""))) or by_ip.get(dst)
        if not (a or b) or a is b:
            continue
        key = tuple(r.get(k, "") for k in flow_key)
        orig, repl = integer(r.get("orig-bytes")), integer(r.get("repl-bytes"))
        if orig is None or repl is None:
            continue
        current[key] = orig, repl
        old = previous.get(key)
        if old is None or not 0 < dt <= 65000 or orig < old[0] or repl < old[1]:
            continue
        sent, received = orig - old[0], repl - old[1]
        for c, down, up in ((a, received, sent), (b, sent, received)):
            if c:
                pair = totals[c["id"]]
                pair[0] += down
                pair[1] += up
                if down or up:
                    c["lastSeen"] = ts
    for key, (down, up) in totals.items():
        devices[key].update(down=down * .008 / dt, up=up * .008 / dt)
    return list(devices.values()), current
