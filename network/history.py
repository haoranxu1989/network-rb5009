"""SQLite history for a single configured gateway. Access is serialized by the service lock."""
import json
import sqlite3
from pathlib import Path

HOUR = 3_600_000
DAY = 24 * HOUR
RANGES = {"1h": HOUR, "24h": DAY, "7d": 7 * DAY}
SCHEMA = """
CREATE TABLE IF NOT EXISTS counters (
 gateway TEXT, port TEXT, ts INTEGER, boot INTEGER, rx INTEGER, tx INTEGER,
 rx_total INTEGER, tx_total INTEGER, PRIMARY KEY(gateway,port));
CREATE TABLE IF NOT EXISTS traffic (
 gateway TEXT, ts INTEGER, port TEXT, duration INTEGER, rx INTEGER, tx INTEGER, PRIMARY KEY(gateway,ts));
CREATE TABLE IF NOT EXISTS ping (
 gateway TEXT, ts INTEGER, rtt REAL, loss REAL, PRIMARY KEY(gateway,ts));
CREATE TABLE IF NOT EXISTS ping_samples (
 gateway TEXT, target TEXT, ts INTEGER, rtt REAL, loss REAL, PRIMARY KEY(gateway,target,ts));
CREATE TABLE IF NOT EXISTS clients (
 gateway TEXT, id TEXT, name TEXT, ip TEXT, mac TEXT, connection TEXT, last_seen INTEGER,
 connected_at INTEGER, valid_until INTEGER, updated INTEGER, PRIMARY KEY(gateway,id));
CREATE TABLE IF NOT EXISTS activity (
 gateway TEXT, ts INTEGER, id TEXT, down REAL, up REAL, PRIMARY KEY(gateway,ts,id));
CREATE TABLE IF NOT EXISTS settings (
 gateway TEXT, key TEXT, value TEXT, PRIMARY KEY(gateway,key));
"""


class History:
    def __init__(self, directory, gateway):
        Path(directory).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(Path(directory) / "network.sqlite3", timeout=8, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.gateway = gateway

    def setting(self, key, default=None):
        row = self.db.execute("SELECT value FROM settings WHERE gateway=? AND key=?", (self.gateway, key)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?,?)", (self.gateway, key, json.dumps(value)))

    def interfaces(self, readings, wan, ts, uptime):
        # Compare estimated boot times as well as counters. A reboot can be hidden by a long collection gap.
        boot = ts - int(uptime * 1000) if uptime is not None else None
        ports, wan_down, wan_up = [], None, None
        old_wan = self.setting("wan")
        if wan != old_wan:
            self.set("wan", wan)
        for p in readings:
            if not p["physical"] and p["name"] != wan:
                continue
            key = p.get("defaultName") or p["id"] or p["name"]
            old = self.db.execute("SELECT * FROM counters WHERE gateway=? AND port=?", (self.gateway, key)).fetchone()
            dt = ts - old["ts"] if old else 0
            same_boot = old and (boot is None or old["boot"] is None or abs(old["boot"] - boot) < 5000)
            values, deltas, rates = {}, {}, {}
            for d in ("rx", "tx"):
                raw = p[d + "Bytes"]
                last = old[d] if old else None
                delta = raw - last if same_boot and dt > 0 and raw is not None and last is not None and raw >= last else None
                # Volume only includes measured increments. A counter reset establishes a new baseline.
                previous_total = old[d + "_total"] if old else 0
                values[d] = (previous_total or 0) + (delta or 0)
                rates[d] = delta * .008 / dt if delta is not None and dt <= 45000 else None
                deltas[d] = delta
            self.db.execute("INSERT OR REPLACE INTO counters VALUES(?,?,?,?,?,?,?,?)",
                            (self.gateway, key, ts, boot, p["rxBytes"], p["txBytes"], values["rx"], values["tx"]))
            if p["name"] == wan:
                wan_down, wan_up = rates["rx"], rates["tx"]
                if old_wan == wan and wan_down is not None and wan_up is not None:
                    self.db.execute("INSERT OR REPLACE INTO traffic VALUES(?,?,?,?,?,?)",
                                    (self.gateway, ts, wan, dt, deltas["rx"], deltas["tx"]))
            if p["physical"]:
                port = {k: v for k, v in p.items() if k != "physical"}
                port.update(rxMbps=rates["rx"], txMbps=rates["tx"],
                            panelBytes={d: values[d] if p[d + "Bytes"] is not None else None for d in values})
                ports.append(port)
        return ports, wan_down, wan_up

    def save_clients(self, ts, devices):
        cutoff = self.setting("reset_at", 0)
        # An absent PPP session loses its confirmed start immediately on the next inventory.
        self.db.execute("UPDATE clients SET connected_at=NULL,valid_until=NULL WHERE gateway=? AND connected_at IS NOT NULL", (self.gateway,))
        for c in devices:
            seen = c["lastSeen"] if c["lastSeen"] >= cutoff else 0
            self.db.execute("""
              INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(gateway,id) DO UPDATE SET name=CASE WHEN excluded.name=excluded.ip AND clients.name<>clients.ip
                THEN clients.name ELSE excluded.name END, ip=excluded.ip,mac=excluded.mac,connection=excluded.connection,
                last_seen=max(clients.last_seen,excluded.last_seen),connected_at=excluded.connected_at,
                valid_until=excluded.valid_until,updated=excluded.updated""",
                            (self.gateway, c["id"], c["name"], c["ip"], c["mac"], c["connection"], seen,
                             c["connectedAt"], ts + 65000 if c["connectedAt"] else None, ts))
            if c["down"] is not None and c["up"] is not None:
                self.db.execute("INSERT OR REPLACE INTO activity VALUES(?,?,?,?,?)",
                                (self.gateway, ts, c["id"], c["down"], c["up"]))

    def clients(self, now, online):
        series = {}
        for r in self.db.execute("SELECT id,ts,down,up FROM activity WHERE gateway=? AND ts>=? ORDER BY ts",
                                 (self.gateway, now - HOUR)):
            points = series.setdefault(r["id"], [])
            points.append({"ts": r["ts"], "down": r["down"], "up": r["up"],
                           "gap": not points or r["ts"] - points[-1]["ts"] > 45000})
        result = []
        for r in self.db.execute("SELECT * FROM clients WHERE gateway=? AND updated>=?", (self.gateway, now - 7 * DAY)):
            samples = series.get(r["id"], [])
            last = samples[-1] if samples and online and samples[-1]["ts"] == r["updated"] and now - r["updated"] <= 45000 else {}
            presence = {"lastSeen": r["last_seen"]} if r["last_seen"] else None
            active = online and r["connected_at"] and r["valid_until"] > now
            if active:
                presence = {"lastSeen": r["last_seen"], "connectedAt": r["connected_at"],
                            "validUntil": r["valid_until"], "sessionKind": "pppoe"}
            result.append({"id": r["id"], "ip": r["ip"], "name": r["name"], "mac": r["mac"], "connection": r["connection"],
                           "status": "PPPoE 已连接" if active else "有在线记录" if presence else "已发现",
                           "icon": "display", "down": last.get("down"), "up": last.get("up"), "samples": samples, "presence": presence})
        return sorted(result, key=lambda c: (-(c["down"] if c["down"] is not None else -1),
                                            -(c["presence"] or {}).get("lastSeen", 0), c["name"]))

    def traffic(self, now, duration):
        start = now - duration
        # Prorate the interval which straddles the range boundary, then form time-weighted chart buckets.
        rows = self.db.execute("""
          WITH window AS (
            SELECT ts, duration, min(duration, ts-?) AS covered, rx, tx FROM traffic
            WHERE gateway=? AND ts>? AND ts<=?
          ) SELECT max(ts) AS ts,sum(covered) AS dt,
                   sum(rx*1.0*covered/duration) AS rx,sum(tx*1.0*covered/duration) AS tx
            FROM window GROUP BY CAST(ts/? AS INTEGER) ORDER BY ts""",
                               (start, self.gateway, start, now, max(10000, duration // 240))).fetchall()
        points = [{"ts": r["ts"], "rx_mbps": r["rx"] * .008 / r["dt"], "tx_mbps": r["tx"] * .008 / r["dt"]} for r in rows]
        empty_total = 0 if not rows and self.setting("reset_at") else None
        return {"points": points, "downMB": sum(r["rx"] for r in rows) / 1e6 if rows else empty_total,
                "upMB": sum(r["tx"] for r in rows) / 1e6 if rows else empty_total, "message": "" if rows else "等待 WAN 流量采样"}

    def save_ping(self, target, ts, ping):
        self.db.execute("INSERT OR REPLACE INTO ping_samples VALUES(?,?,?,?,?)", (self.gateway, target, ts, ping["rtt"], ping["loss"]))

    def pings(self, target, now):
        return [dict(r) for r in self.db.execute("SELECT ts,rtt,loss FROM ping_samples WHERE gateway=? AND target=? AND ts>=? ORDER BY ts",
                                                (self.gateway, target, now - DAY))]

    def count(self):
        # Older probes in ping have no recorded target. Keep them until the normal expiry or reset.
        return sum(self.db.execute(f"SELECT count(*) FROM {table} WHERE gateway=?", (self.gateway,)).fetchone()[0]
                   for table in ("traffic", "ping", "ping_samples", "clients", "activity"))

    def clear(self, ts):
        count = self.count()
        with self.db:
            for table in ("counters", "traffic", "ping", "ping_samples", "clients", "activity"):
                self.db.execute(f"DELETE FROM {table} WHERE gateway=?", (self.gateway,))
            self.set("reset_at", ts)
        return count

    def prune(self, now):
        for table, col, age in (("traffic", "ts", 7 * DAY), ("ping", "ts", DAY), ("ping_samples", "ts", DAY), ("activity", "ts", HOUR),
                                ("clients", "updated", 7 * DAY), ("counters", "ts", 7 * DAY)):
            self.db.execute(f"DELETE FROM {table} WHERE gateway=? AND {col}<?", (self.gateway, now - age))
