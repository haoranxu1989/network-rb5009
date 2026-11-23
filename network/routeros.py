"""A RouterOS binary API session over verified TLS or explicitly configured plain TCP."""
import hashlib
import ipaddress
import os
import socket
import ssl
from dataclasses import dataclass, field


class Trap(Exception):
    """RouterOS rejected a command. The complete reply has been drained."""


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    user: str
    password: str = field(repr=False)
    ca: str | None = None
    server_name: str | None = None
    wan: str = ""
    ping: str = "223.5.5.5"
    admin_password: str = field(default="", repr=False)
    data: str = "/data"
    transport: str = "api-ssl"

    @property
    def protocol_name(self):
        return self.transport.upper()

    @property
    def gateway_id(self):
        return hashlib.sha256(f"{self.host.lower()}:{self.port}".encode()).hexdigest()[:20]

    @classmethod
    def from_env(cls):
        host = os.getenv("ROUTEROS_HOST", "10.0.10.1").strip()
        user = os.getenv("ROUTEROS_USER", "").strip()
        password = os.getenv("ROUTEROS_PASSWORD", "")
        transport = os.getenv("ROUTEROS_TRANSPORT", "api-ssl").strip().lower()
        if transport not in ("api-ssl", "api"):
            raise ValueError("ROUTEROS_TRANSPORT 必须是 api-ssl 或 api")
        port = int(os.getenv("ROUTEROS_PORT") or (8729 if transport == "api-ssl" else 8728))
        if not host or not user or not password or not 1 <= port <= 65535:
            raise ValueError("请设置有效的 ROUTEROS_HOST、ROUTEROS_PORT、ROUTEROS_USER 和 ROUTEROS_PASSWORD")
        ping = str(ipaddress.ip_address(os.getenv("NETWORK_PING_TARGET", cls.ping)))
        return cls(host, port, user, password, os.getenv("ROUTEROS_CA_FILE"),
                   os.getenv("ROUTEROS_SERVER_NAME"), os.getenv("NETWORK_WAN", ""), ping,
                   os.getenv("NETWORK_ADMIN_PASSWORD", ""), os.getenv("NETWORK_DATA_DIR", "/data"), transport)


def word_size(size):
    for limit, mask, width in ((0x80, 0, 1), (0x4000, 0x8000, 2),
                               (0x200000, 0xc00000, 3), (0x10000000, 0xe0000000, 4)):
        if size < limit:
            return (size | mask).to_bytes(width, "big")
    return b"\xf0" + size.to_bytes(4, "big")


def read_exact(reader, size):
    data = reader.read(size)
    if len(data) != size:
        raise ConnectionError("RouterOS disconnected")
    return data


def read_sentence(reader):
    words = []
    while True:
        lead = read_exact(reader, 1)[0]
        if lead == 0:
            return words
        if lead < 0x80:
            size = lead
        else:
            for limit, mask, count in ((0xc0, 0x3f, 1), (0xe0, 0x1f, 2),
                                       (0xf0, 0x0f, 3), (0xf1, 0, 4)):
                if lead < limit:
                    size = ((lead & mask) << (8 * count)) | int.from_bytes(read_exact(reader, count), "big")
                    break
            else:
                raise ConnectionError("invalid RouterOS word prefix")
        if size > 4 * 1024 * 1024 or len(words) > 1024:
            raise ConnectionError("RouterOS reply exceeded limit")
        words.append(read_exact(reader, size).decode("utf-8", errors="replace"))


def sentence(words):
    data = [word.encode("utf-8") for word in words]
    return b"".join(word_size(len(word)) + word for word in data) + b"\x00"


class Router:
    def __init__(self, config, timeout=8):
        raw = socket.create_connection((config.host, config.port), timeout=timeout)
        try:
            if config.transport == "api-ssl":
                context = ssl.create_default_context(cafile=config.ca)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                self.sock = context.wrap_socket(raw, server_hostname=config.server_name or config.host)
            elif config.transport == "api":
                self.sock = raw
            else:
                raise ValueError("未知的 RouterOS 连接方式")
        except BaseException:
            raw.close()
            raise
        self.reader = self.sock.makefile("rb")
        try:
            self.call("/login", "=name=" + config.user, "=password=" + config.password)
        except BaseException:
            self.close()
            raise

    def close(self):
        self.reader.close()
        self.sock.close()

    def call(self, path, *args):
        self.sock.sendall(sentence((path, *args)))
        rows, error = [], None
        while True:
            words = read_sentence(self.reader)
            if not words:
                continue
            kind, *rest = words
            row = dict(word[1:].split("=", 1) for word in rest if word.startswith("=") and "=" in word[1:])
            if kind == "!re":
                rows.append(row)
                if len(rows) > 150000:
                    raise ConnectionError("RouterOS table exceeded limit")
            elif kind == "!trap":
                error = Trap(row.get("message", "command refused"))
            elif kind == "!fatal":
                raise ConnectionError("RouterOS closed the session")
            elif kind == "!done":
                if error:
                    raise error
                return rows
            elif kind != "!empty":
                raise ConnectionError("unexpected RouterOS reply")

    def table(self, path, fields, *filters):
        return self.call(path + "/print", "=.proplist=" + fields, *filters)

    def optional(self, path, fields, *filters):
        try:
            return self.table(path, fields, *filters)
        except Trap:
            return []
