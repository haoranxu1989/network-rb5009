"""Fixed, same-origin dashboard endpoints for one gateway."""
import base64
import binascii
import gzip
import hmac
import json
import os
from urllib.parse import parse_qs, urlsplit

from .actions import ActionError
from .history import RANGES


def listen_port():
    try:
        port = int(os.getenv("NETWORK_HTTP_PORT", "8080"))
    except ValueError:
        port = 0
    if not 1 <= port <= 65535:
        raise ValueError("NETWORK_HTTP_PORT 必须是 1 到 65535 的整数")
    return port


def accepts_gzip(header):
    encodings = {}
    for item in header.lower().split(","):
        name, *parameters = item.strip().split(";")
        quality = 1.0
        for parameter in parameters:
            key, _, value = parameter.strip().partition("=")
            if key == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0
        encodings[name.strip()] = quality if 0 <= quality <= 1 else 0
    return encodings.get("gzip", encodings.get("*", 0)) > 0


def application(service, html):
    config = service.config
    history_path = "/api/gateway/" + config.gateway_id + "/history"
    phases = {200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
              404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
              415: "Unsupported Media Type", 503: "Service Unavailable"}

    def app(env, start):
        method, path = env["REQUEST_METHOD"], env["PATH_INFO"]

        def reply(code, value, headers=()):
            body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            content_type = "text/html" if isinstance(value, bytes) else "application/json"
            headers = [("Vary", "Accept-Encoding"), *headers]
            if len(body) >= 1024 and accepts_gzip(env.get("HTTP_ACCEPT_ENCODING", "")):
                compressed = gzip.compress(body, compresslevel=5, mtime=0)
                if len(compressed) < len(body):
                    body = compressed
                    headers.append(("Content-Encoding", "gzip"))
            start(f"{code} {phases[code]}", [("Content-Type", content_type + "; charset=utf-8"), ("Content-Length", str(len(body))),
                  ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "DENY"),
                  ("Referrer-Policy", "same-origin"), *headers])
            return [body]

        if method == "GET" and path == "/healthz":
            with service.lock:
                online = service.state["online"]
            return reply(200, {"status": "ok", "router": "online" if online else "offline" if online is False else "connecting"})
        if config.admin_password:
            expected = ("network:" + config.admin_password).encode()
            scheme, _, token = env.get("HTTP_AUTHORIZATION", "").partition(" ")
            try:
                actual = base64.b64decode(token, validate=True) if scheme.lower() == "basic" else b""
            except (ValueError, binascii.Error):
                actual = b""
            if not hmac.compare_digest(expected, actual):
                return reply(401, {"error": "authentication-required"}, [("WWW-Authenticate", 'Basic realm="Network", charset="UTF-8"')])
        if method == "GET":
            if path in {"/", "/home", "/index.html", "/demo"}:
                return reply(200, html)
            if path == "/api/overview":
                query = parse_qs(env.get("QUERY_STRING", ""))
                span, page = query.get("range", ["1h"])[0], query.get("page", ["overview"])[0]
                if span not in RANGES or page not in {"overview", "logs"}:
                    return reply(400, {"error": "invalid-range-or-page"})
                return reply(200, service.snapshot(span, page, query.get("cursor", [""])[0]))
            if path == history_path:
                with service.lock:
                    return reply(200, {"routerId": config.gateway_id, "total": service.history.count()})
        if path not in {history_path, "/api/gateway/action"}:
            return reply(404, {"error": "not-found"})
        if method != "POST":
            return reply(405, {"error": "method-not-allowed"})
        origin = env.get("HTTP_ORIGIN")
        try:
            foreign_origin = bool(origin and urlsplit(origin).netloc != env.get("HTTP_HOST"))
        except ValueError:
            foreign_origin = True
        if foreign_origin or env.get("HTTP_SEC_FETCH_SITE") == "cross-site":
            return reply(403, {"error": "cross-origin"})
        if env.get("CONTENT_TYPE", "").partition(";")[0] != "application/json":
            return reply(415, {"error": "json-required"})
        try:
            size = int(env.get("CONTENT_LENGTH") or 0)
            if not 0 < size <= 4096:
                return reply(413 if size > 4096 else 400, {"error": "invalid-body-size"})
            data = json.loads(env["wsgi.input"].read(size))
        except (ValueError, UnicodeError):
            return reply(400, {"error": "invalid-json"})
        if not isinstance(data, dict) or data.get("confirm") != "确认":
            return reply(400, {"error": "confirm-mismatch"})
        if path == history_path:
            return reply(200, service.reset())
        target = data.get("target")
        if not isinstance(target, dict) or not all(isinstance(target.get(key), str) for key in ("action", "from", "to", "id", "name")):
            return reply(400, {"error": "invalid-target"})
        try:
            service.actions.submit(target, data["confirm"])
        except ActionError as e:
            return reply(e.status, {"error": e.code})
        return reply(202, {"accepted": True})
    return app
