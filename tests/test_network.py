import base64
import gzip
import io
import json
import os
import ssl
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import Mock, patch

from network.actions import download_status
from network.http import application, listen_port
from network.measure import physical_wan, ping_result, seconds, select_wan, watts
from network.routeros import Config, Trap, Router, read_sentence, sentence, word_size
from network.service import Service, WAN_INTERVAL
from router_fixture import Fixture


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = Config("simulated-router", 8729, "fixture", "fixture-only", data=self.tmp.name)
        self.s = Service(self.config)
        self.addCleanup(self.s.history.db.close)
        self.now = 1_800_000_000
        self.fixture = Fixture(lambda: self.now)
        for target in ("network.service.millis", "network.actions.millis"):
            self.enterContext(patch(target, side_effect=lambda: self.now * 1000))
        self.enterContext(patch("network.service.time.monotonic", side_effect=lambda: self.now))

    def poll(self, advance=0):
        self.now += advance
        self.s.poll(self.fixture)

    def view(self):
        return self.s.snapshot("1h", "overview")

    def test_worker_schedules_status_traffic_clients_and_ping_independently(self):
        start, calls = self.now, {}
        fixture_call = self.fixture.call

        def record(path, *args):
            calls.setdefault(path, []).append(self.now - start)
            if path == "/system/resource/print" and "cpu-load" in args[0]:
                calls.setdefault("cpu", []).append(self.now - start)
            return fixture_call(path, *args)

        def advance(seconds):
            self.assertGreater(seconds, 0)
            self.now += seconds
            if self.now > start + 60:
                self.s.stopping.set()

        with patch("network.service.Router", return_value=self.fixture), patch.object(self.fixture, "close", create=True), \
                patch.object(self.fixture, "call", side_effect=record), patch.object(self.s.stopping, "wait", side_effect=advance):
            self.s.run()

        cadence = {"cpu": 3, "/interface/ethernet/print": 3, "/interface/ethernet/monitor": 3, "/interface/ethernet/poe/monitor": 3,
                   "/interface/print": 5, "/ip/firewall/connection/print": 10, "/ip/route/print": 30, "/tool/ping": 60}
        for key, interval in cadence.items():
            self.assertEqual(calls[key], list(range(0, 61, interval)), key)
        shared_ticks = sorted(set(range(0, 61, 3)) | set(range(0, 61, 5)))
        self.assertEqual(calls["/system/resource/print"], shared_ticks)

    def test_status_refresh_updates_port_and_gateway_without_changing_traffic(self):
        self.poll()
        self.poll(3)
        self.poll(2)
        before = self.view()
        fixture_call = self.fixture.call

        def changed(path, *args):
            rows = fixture_call(path, *args)
            if path == "/system/resource/print":
                rows[0].update({"cpu-load": "29", "free-memory": "400000"})
            elif path == "/interface/ethernet/print":
                rows[0].update(running="false", disabled="true")
            elif path == "/interface/ethernet/monitor":
                rows[1]["rate"] = "100Mbps"
            elif path == "/interface/ethernet/poe/monitor":
                rows[0]["poe-out-power"] = "6.2"
            return rows

        with patch.object(self.fixture, "call", side_effect=changed):
            self.poll(1)
        after = self.view()
        self.assertEqual((after["cpu"], after["memory"], after["uptime"]), (29, 60, "7206s"))
        self.assertEqual((after["ports"][0]["running"], after["ports"][0]["disabled"]), (False, True))
        self.assertEqual((after["ports"][1]["linkRate"], after["ports"][1]["poe"]["watts"]), ("100Mbps", 6.2))
        for key in ("down", "up", "lastSample", "history"):
            self.assertEqual(after[key], before[key], key)
        for key in ("rxMbps", "txMbps", "panelBytes"):
            self.assertEqual(after["ports"][1][key], before["ports"][1][key], key)

    def test_ping_history_is_scoped_to_the_actual_target(self):
        ts = self.now * 1000
        history = self.s.history
        previous = "1.1.1.1"
        with history.db:
            history.db.execute("INSERT INTO ping VALUES(?,?,?,?)", (self.config.gateway_id, ts - 60000, 145, 0))
            history.save_ping(previous, ts, {"rtt": 149.2, "loss": 0})
        self.assertEqual(self.view()["pings"], [])
        with patch.object(self.fixture, "call", wraps=self.fixture.call) as query:
            self.poll()
            query.assert_any_call("/tool/ping", "=address=223.5.5.5", "=count=3", "=interval=300ms")
        self.assertEqual(self.view()["pingTarget"], "223.5.5.5")
        self.assertEqual(self.view()["pings"], [{"ts": ts, "rtt": 8, "loss": 0}])
        other = Service(replace(self.config, ping=previous))
        self.addCleanup(other.history.db.close)
        self.assertEqual(other.snapshot("24h", "overview")["pings"], [{"ts": ts, "rtt": 149.2, "loss": 0}])
        self.assertEqual(history.db.execute("SELECT count(*) FROM ping").fetchone()[0], 1)

    def test_native_collection_restart_and_reset(self):
        self.poll()
        self.assertIsNone(self.view()["down"])
        self.poll(30)
        v = self.view()
        self.assertEqual((v["iface"], v["address"], v["down"], v["up"]), ("ether1", "192.0.2.2", 8, 1))
        self.assertEqual((v["history"]["downMB"], v["ports"][0]["panelBytes"]["rx"]), (30, 30_000_000))
        self.assertEqual(v["ports"][1]["poe"]["watts"], 8.4)
        self.assertEqual((v["latency"], v["loss"]), (8, 0))
        by_name = {c["name"]: c for c in v["clients"]}
        self.assertAlmostEqual(by_name["Fixture NAS"]["down"], .8)
        self.assertNotIn("connectedAt", by_name["Fixture NAS"]["presence"])
        self.assertEqual(by_name["Fixture PPP"]["presence"]["connectedAt"], self.fixture.boot * 1000)
        reopened = Service(self.config)
        self.addCleanup(reopened.history.db.close)
        stored = reopened.snapshot("7d", "overview")
        self.assertEqual(stored["history"]["points"], v["history"]["points"])
        self.assertEqual(len(stored["clients"]), 2)
        self.assertIsNone(stored["clients"][0]["down"])
        self.assertGreater(self.s.reset()["deleted"], 0)
        self.assertEqual(self.view()["ports"][0]["panelBytes"], {"rx": 0, "tx": 0})
        self.assertEqual((self.view()["clients"], self.view()["pings"], self.view()["history"]["downMB"]), ([], [], 0))
        self.assertEqual(reopened.snapshot("24h", "overview")["history"]["points"], [])
        self.poll(10)
        self.assertEqual(self.view()["ports"][0]["panelBytes"]["rx"], 0)
        self.poll(10)
        self.assertEqual(self.view()["ports"][0]["panelBytes"]["rx"], 10_000_000)
        self.assertNotIn("/system/reboot", self.fixture.commands)

    def test_inflight_sample_cannot_undo_reset_and_gateways_are_isolated(self):
        self.poll()
        self.poll(30)
        with patch.object(self.fixture, "table", wraps=self.fixture.table) as query:
            def reset_then_read(menu, fields, *filters):
                if menu == "/interface":
                    self.s.reset()
                return Router.table(self.fixture, menu, fields, *filters)
            query.side_effect = reset_then_read
            self.poll(10)
        self.assertEqual(self.s.history.count(), 0)
        self.poll(10)
        self.poll(10)
        other = Service(replace(self.config, host="another-endpoint"))
        self.addCleanup(other.history.db.close)
        self.assertEqual(other.history.count(), 0)
        self.assertGreater(self.s.history.count(), 0)

    def test_gap_and_reboot_do_not_create_a_rate_spike(self):
        self.poll()
        self.poll(10)
        self.poll(180)
        self.assertIsNone(self.view()["down"])
        self.assertEqual(len(self.view()["history"]["points"]), 1)
        self.fixture.boot = self.now
        self.poll(10)
        self.assertIsNone(self.view()["down"])
        self.poll(10)
        self.assertEqual(self.view()["down"], 8)

    def test_http_confirm_auth_and_origin(self):
        protected = Service(replace(self.config, admin_password="local-example"))
        self.addCleanup(protected.history.db.close)
        app = application(protected, b"<title>Network</title>")
        def request(path, method="GET", body=None, auth=True, **extra):
            status = []
            raw = json.dumps(body).encode() if body is not None else b""
            env = {"REQUEST_METHOD": method, "PATH_INFO": path, "HTTP_HOST": "localhost:8080", "wsgi.input": io.BytesIO(raw),
                   "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json", **extra}
            if auth:
                env["HTTP_AUTHORIZATION"] = "Basic " + base64.b64encode(b"network:local-example").decode()
            data = app(env, lambda code, _headers: status.append(code))
            return int(status[0].split()[0]), b"".join(data)
        hist = "/api/gateway/" + self.config.gateway_id + "/history"
        self.assertEqual(request("/api/overview", auth=False)[0], 401)
        self.assertEqual(request(hist, "POST", {"confirm": "wrong"})[0], 400)
        self.assertEqual(request(hist, "POST", {"confirm": "确认"}, HTTP_ORIGIN="https://elsewhere.invalid")[0], 403)
        self.assertEqual(request(hist, "POST", {"confirm": "确认"})[0], 200)
        with patch.object(protected, "snapshot", wraps=protected.snapshot) as snapshot:
            self.assertNotIn(b"fixture-only", request("/api/overview")[1])
            snapshot.assert_called_once_with("1h", "overview", "")
        self.assertEqual(request("/api/overview", QUERY_STRING="range=2y")[0], 400)

    def test_gzip_preserves_json_and_respects_encoding_negotiation(self):
        self.poll()
        self.poll(10)
        app = application(self.s, b"<title>Network</title>" * 100)

        def request(encoding, path="/api/overview"):
            response = {}
            def start(status, headers):
                response.update(status=status, headers=dict(headers))
            body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": path,
                                "HTTP_ACCEPT_ENCODING": encoding}, start))
            self.assertEqual(int(response["headers"]["Content-Length"]), len(body))
            return body, response["headers"]

        plain, _ = request("")
        for encoding in ("gzip", "br, GZip;q=0.5", "*;q=1"):
            compressed, headers = request(encoding)
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(gzip.decompress(compressed), plain)
            self.assertLess(len(compressed), len(plain))
            self.assertEqual(headers["Vary"], "Accept-Encoding")
        for encoding in ("gzip;q=0", "gzip;q=0, *;q=1", "br", "gzip;q=invalid"):
            body, headers = request(encoding)
            self.assertNotIn("Content-Encoding", headers)
            self.assertEqual(body, plain)
        html, headers = request("gzip", "/")
        self.assertEqual(gzip.decompress(html), b"<title>Network</title>" * 100)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        health, headers = request("gzip", "/healthz")
        self.assertNotIn("Content-Encoding", headers)
        self.assertEqual(json.loads(health)["router"], "online")

    def test_history_cursor_sends_new_samples_and_recovers_after_reset_and_restart(self):
        self.poll()
        self.poll(10)
        first = self.s.snapshot("1h", "overview")
        again = self.s.snapshot("1h", "overview", first["sync"]["cursor"])
        self.assertTrue(again["sync"]["incremental"])
        self.assertEqual(again["pings"], [])
        self.assertTrue(all(not c["samples"] for c in again["clients"]))
        self.poll(10)
        update = self.s.snapshot("1h", "overview", again["sync"]["cursor"])
        self.assertTrue(update["sync"]["incremental"])
        self.assertEqual(sum(len(c["samples"]) for c in update["clients"]), 1)
        self.assertEqual(update["clients"][0]["samples"][0]["ts"], self.now * 1000)
        for cursor in ("bad", first["sync"]["cursor"] + "x", first["sync"]["cursor"].rsplit(":", 1)[0] + ":9999999999999999"):
            self.assertFalse(self.s.snapshot("1h", "overview", cursor)["sync"]["incremental"])
        self.assertFalse(self.s.snapshot("24h", "overview", first["sync"]["cursor"])["sync"]["incremental"])
        reopened = Service(self.config)
        self.addCleanup(reopened.history.db.close)
        self.assertFalse(reopened.snapshot("1h", "overview", first["sync"]["cursor"])["sync"]["incremental"])
        self.s.reset()
        cleared = self.s.snapshot("1h", "overview", first["sync"]["cursor"])
        self.assertFalse(cleared["sync"]["incremental"])
        self.assertEqual((cleared["history"]["points"], cleared["pings"], cleared["clients"]), ([], [], []))

    def test_incremental_windows_match_full_history_at_bucket_edges_and_after_gaps(self):
        self.poll()
        self.poll(10)
        # Include samples on both sides of each moving left edge.
        stamp = self.now * 1000
        with self.s.history.db:
            for duration in (3_600_000, 86_400_000, 604_800_000):
                for offset in (-10000, 1000, 7000, 18000):
                    ts = stamp - duration + offset
                    self.s.history.db.execute("INSERT OR REPLACE INTO traffic VALUES(?,?,?,?,?,?)",
                                              (self.config.gateway_id, ts, "ether1", 10000, ts % 23000, ts % 11000))
            self.s.history.db.execute("INSERT INTO activity VALUES(?,?,?,?,?)",
                                      (self.config.gateway_id, stamp - 3599000, "02:00:00:00:00:10", 1, 2))
            self.s.history.save_ping(self.config.ping, stamp - 86399000, {"rtt": 9, "loss": 0})
        views = {span: self.s.snapshot(span, "overview") for span in ("1h", "24h", "7d")}

        def merge(old, new, start, bucket=1):
            points = {p["ts"] // bucket: p for p in old if p["ts"] >= start}
            points.update({p["ts"] // bucket: p for p in new})
            return sorted(points.values(), key=lambda p: p["ts"])

        for advance in (3, 2, 1, 4, 10, 60, 120, 3700):
            self.poll(advance)
            for span, duration in (("1h", 3_600_000), ("24h", 86_400_000), ("7d", 604_800_000)):
                previous = views[span]
                delta = self.s.snapshot(span, "overview", previous["sync"]["cursor"])
                full = self.s.snapshot(span, "overview")
                bucket = delta["sync"]["bucketMs"]
                points = merge(previous["history"]["points"], delta["history"]["points"], full["end"] - duration + 1, bucket)
                self.assertEqual(points, full["history"]["points"], (span, advance))
                self.assertEqual(delta["history"]["downMB"], full["history"]["downMB"])
                pings = merge(previous["pings"], delta["pings"], full["end"] - 86_400_000)
                self.assertEqual(pings, full["pings"])
                prior = {c["id"]: c for c in previous["clients"]}
                for client, complete in zip(delta["clients"], full["clients"]):
                    samples = merge(prior.get(client["id"], {}).get("samples", []), client["samples"], full["end"] - 3_600_000)
                    if samples:
                        samples[0] = samples[0] | {"gap": True}
                    self.assertEqual(samples, complete["samples"])
                views[span] = full

    def test_manual_download_and_separate_reboot(self):
        s = Service(replace(self.config, admin_password="example"))
        self.addCleanup(s.history.db.close)
        s.poll(self.fixture)
        target = {"action": "upgrade", "id": self.config.gateway_id, "name": "Network fixture", "from": "7.20.4", "to": "7.20.5"}
        self.fixture.close = lambda: None
        with patch("network.actions.Router", return_value=self.fixture), patch("network.actions.threading.Thread") as thread:
            thread.side_effect = lambda target, args, daemon: type("Worker", (), {"start": lambda _: target(*args)})()
            s.actions.submit(target, "确认")
            self.now += WAN_INTERVAL
            s.poll(self.fixture)
            self.assertEqual(s.actions.public()["stage"], "downloaded")
            self.assertNotIn("/system/reboot", self.fixture.commands)
            s.actions.submit(target | {"action": "reboot", "preparedAt": s.actions.public()["startedAt"]}, "确认")
            self.now += WAN_INTERVAL
            s.poll(self.fixture)
            self.assertEqual(s.actions.public()["stage"], "verified")
            self.assertEqual(self.fixture.commands.count("/system/reboot"), 1)


class ParsingTest(unittest.TestCase):
    def test_dashboard_listen_port_is_independent_of_routeros(self):
        with patch.dict(os.environ, {"ROUTEROS_PORT": "8728"}, clear=True):
            self.assertEqual(listen_port(), 8080)
            for port in ("80", "18080", "65535"):
                os.environ["NETWORK_HTTP_PORT"] = port
                self.assertEqual(listen_port(), int(port))
            for invalid in ("", "0", "65536", "http"):
                os.environ["NETWORK_HTTP_PORT"] = invalid
                with self.assertRaisesRegex(ValueError, "NETWORK_HTTP_PORT"):
                    listen_port()

    def test_transport_selection_keeps_tls_default_and_requires_explicit_plain_api(self):
        with patch.dict(os.environ, {"ROUTEROS_USER": "fixture", "ROUTEROS_PASSWORD": "fixture-only"}, clear=True):
            secure = Config.from_env()
            self.assertEqual((secure.transport, secure.port), ("api-ssl", 8729))
            self.assertEqual(secure.ping, "223.5.5.5")
            with patch.dict(os.environ, {"NETWORK_PING_TARGET": "192.0.2.10"}):
                self.assertEqual(Config.from_env().ping, "192.0.2.10")
            with patch("network.routeros.socket.create_connection") as connect, patch("network.routeros.ssl.create_default_context") as tls:
                tls.return_value.wrap_socket.side_effect = ssl.SSLCertVerificationError("test")
                with self.assertRaises(ssl.SSLCertVerificationError):
                    Router(secure)
                connect.assert_called_once()
                connect.return_value.sendall.assert_not_called()
            os.environ["ROUTEROS_TRANSPORT"] = "api"
            plain = Config.from_env()
            self.assertEqual((plain.transport, plain.port), ("api", 8728))
            with patch("network.routeros.socket.create_connection") as connect, patch("network.routeros.ssl.create_default_context") as tls:
                connect.return_value.makefile.return_value = io.BytesIO(sentence(["!done"]))
                Router(plain).close()
                connect.return_value.sendall.assert_called_once_with(sentence(["/login", "=name=fixture", "=password=fixture-only"]))
                tls.assert_not_called()
            os.environ["ROUTEROS_TRANSPORT"] = "typo"
            with self.assertRaises(ValueError):
                Config.from_env()

    def test_binary_framing_and_trap_drain(self):
        for n in (0, 127, 128, 16383, 16384, 2097151, 2097152):
            if n:
                self.assertEqual(read_sentence(io.BytesIO(sentence(["x" * n]))), ["x" * n])
            else:
                self.assertEqual(word_size(n), b"\0")
        class Socket:
            def sendall(self, data):
                pass
        router = Router.__new__(Router)
        router.sock = Socket()
        router.reader = io.BytesIO(b"".join(sentence(words) for words in (
            ["!trap", "=message=denied"], ["!done"], ["!empty"], ["!done"], ["!re", "=name=a=b"], ["!done"])))
        with self.assertRaises(Trap):
            router.call("/refused")
        self.assertEqual(router.call("/empty"), [])
        self.assertEqual(router.call("/ok"), [{"name": "a=b"}])

    def test_units_and_reported_progress(self):
        self.assertAlmostEqual(seconds("2ms700us"), .0027)
        self.assertEqual(seconds("1w2d00:00:10"), 777610)
        self.assertEqual(watts("6"), 6)
        self.assertEqual(watts("5.9"), 5.9)
        self.assertEqual(watts("52dW"), 5.2)
        self.assertEqual(ping_result([{"seq": "0", "status": "timeout"}]), {"rtt": None, "loss": 100})
        self.assertEqual(download_status("downloading package"), {"stage": "downloading"})
        self.assertEqual(download_status("downloaded 500 KiB of 1000 KiB")["percent"], 50)
        self.assertEqual(select_wan("", [], [{"list": "WAN", "interface": "e1"}, {"list": "WAN", "interface": "e2"}],
                                    {"e1", "e2"}), "")

    def test_dialup_wan_resolves_only_to_an_unambiguous_physical_port(self):
        router = Mock()
        router.optional.side_effect = [[{"interface": "wan-vlan"}], [{"interface": "ether8"}]]
        types = {"dial": "pppoe-out", "wan-vlan": "vlan", "ether8": "ether", "lan": "bridge"}
        self.assertEqual(physical_wan(router, "dial", types, {"ether8"}), "ether8")
        self.assertEqual(physical_wan(router, "lan", types, {"ether8"}), "")
