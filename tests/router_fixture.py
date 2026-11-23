"""Synthetic RB5009 peer for exercising the real TLS/login/monitoring path."""
import argparse
import socketserver
import ssl
import time

from network.routeros import Router, Trap, read_sentence, sentence


class Fixture:
    table = Router.table
    optional = Router.optional

    def __init__(self, now=time.time):
        self.now = now
        self.boot = int(now()) - 7200
        self.commands = []
        self.version = "7.20.4"
        self.status = "New version is available"

    def call(self, path, *args):
        self.commands.append(path)
        tick = int(self.now()) - self.boot
        if path == "/system/resource/print":
            return [{"board-name": "RB5009UPr+S+", "uptime": f"{tick}s", "version": self.version,
                     "cpu-load": "12", "total-memory": "1000000", "free-memory": "660000"}]
        if path == "/system/routerboard/print":
            return [{"model": "RB5009UPr+S+", "current-firmware": "7.20.4", "upgrade-firmware": "7.20.4"}]
        if path == "/system/package/update/print":
            return [{"channel": "stable", "installed-version": self.version, "latest-version": "7.20.5", "status": self.status}]
        if path == "/system/package/update/download":
            self.status = "Downloaded, please reboot router to upgrade"
            return []
        if path == "/system/reboot":
            self.boot = int(self.now())
            self.version = "7.20.5"
            self.status = "System is already up to date"
            return []
        if path == "/system/identity/print":
            return [{"name": "Network fixture"}]
        if path == "/interface/print":
            return [{".id": f"*{i}", "name": name, "type": "ether", "running": "true", "disabled": "false",
                     "rx-byte": str(tick * 1000000 * i), "tx-byte": str(tick * 125000 * i),
                     "rx-error": "0", "tx-error": "0", "rx-drop": "0", "tx-drop": "0", "link-downs": "0"}
                    for i, name in enumerate(("ether1", "ether2", "sfp-sfpplus1"), 1)]
        if path == "/interface/ethernet/print":
            return [{".id": f"*{i}", "name": n, "default-name": n, "running": "true", "disabled": "false"}
                    for i, n in enumerate(("ether1", "ether2", "sfp-sfpplus1"), 1)]
        if path == "/interface/ethernet/monitor":
            return [{"name": "ether1", "rate": "2.5Gbps"}, {"name": "ether2", "rate": "1Gbps"}]
        if path == "/interface/ethernet/poe/print":
            return [{".id": "*2", "name": "ether2", "poe-out": "auto-on"}]
        if path == "/interface/ethernet/poe/monitor":
            return [{"name": "ether2", "port-type": "poe-out", "poe-out-status": "powered-on", "poe-out-power": "8.4"}]
        if path == "/ip/route/print":
            return [{"active": "true", "routing-table": "main", "immediate-gw": "192.0.2.1%ether1"}]
        if path == "/ip/address/print":
            return [{"interface": "ether1", "address": "192.0.2.2/24"}, {"interface": "bridge", "address": "198.51.100.1/24"}]
        if path == "/tool/ping":
            return [{"seq": str(i), "time": "8ms"} for i in range(3)]
        if path == "/ip/dhcp-server/lease/print":
            return [{"address": "198.51.100.10", "mac-address": "02:00:00:00:00:10", "host-name": "Fixture NAS",
                     "status": "bound", "last-seen": "5m"}]
        if path == "/ip/firewall/connection/print":
            return [{".id": "*F", "protocol": "tcp", "src-address": "198.51.100.10:5555", "dst-address": "203.0.113.2:443",
                     "orig-bytes": str(tick * 10000), "repl-bytes": str(tick * 100000)}]
        if path == "/ppp/active/print":
            return [{"address": "198.51.100.11", "caller-id": "02:00:00:00:00:11", "name": "Fixture PPP", "uptime": f"{tick}s"}]
        if path == "/log/print":
            return [{"time": "12:00:00", "topics": "system,info", "message": "RouterOS fixture is online"}]
        if path in ("/system/package/update/check-for-updates", "/interface/list/member/print", "/ip/arp/print"):
            return []
        raise Trap("no such command")


def serve_fixture(cert, key, port):
    model = Fixture()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            authenticated = False
            try:
                while True:
                    words = read_sentence(self.rfile)
                    path = words[0]
                    if path == "/login":
                        authenticated = "=name=fixture" in words and "=password=fixture-only" in words
                        if not authenticated:
                            self.wfile.write(sentence(["!trap", "=message=login rejected"]))
                    elif not authenticated:
                        return
                    else:
                        try:
                            rows = model.call(path, *words[1:])
                            for row in rows:
                                self.wfile.write(sentence(["!re", *["=" + k + "=" + v for k, v in row.items()]]))
                            if not rows:
                                self.wfile.write(sentence(["!empty"]))
                        except Trap:
                            self.wfile.write(sentence(["!trap", "=message=command refused"]))
                    self.wfile.write(sentence(["!done"]))
            except (OSError, IndexError):
                pass

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server(("127.0.0.1", port), Handler) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("cert")
    parser.add_argument("key")
    parser.add_argument("--port", type=int, default=8729)
    options = parser.parse_args()
    serve_fixture(options.cert, options.key, options.port)
