"""User-initiated gateway maintenance. Requests are sent once and verified by later samples."""
import re
import threading
import time

from .measure import newer, seconds
from .routeros import Router, Trap

TERMINAL = {"failed", "verified", "unknown"}
COMMAND = {"upgrade": "/system/package/update/download", "fwupgrade": "/system/routerboard/upgrade", "reboot": "/system/reboot"}


def millis():
    return time.time_ns() // 1_000_000


class ActionError(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status


def download_status(status):
    lower = status.lower()
    if "downloaded" in lower and ("reboot" in lower or "restart" in lower):
        return {"stage": "downloaded"}
    if "error" in lower or "failed" in lower:
        return {"stage": "failed"}
    if "download" not in lower:
        return {}
    out = {"stage": "downloading"}
    percent = re.search(r"(\d+(?:\.\d+)?)\s*%", status)
    if percent and 0 <= float(percent[1]) <= 100:
        out["percent"] = float(percent[1])
    sizes = re.findall(r"(\d+(?:\.\d+)?)\s*([kmgt]?i?b)\b", status, re.I)
    if sizes:
        out["downloaded"] = " ".join(sizes[0])
        if len(sizes) == 2 and sizes[0][1].lower() == sizes[1][1].lower() and float(sizes[1][0]) > 0:
            fraction = float(sizes[0][0]) / float(sizes[1][0])
            if 0 <= fraction <= 1:
                out.setdefault("percent", int(100 * fraction))
    return out


class Actions:
    def __init__(self, service):
        self.service = service
        self.job = service.history.setting("operation")

    def save(self, **values):
        if all(self.job.get(k) == v for k, v in values.items()):
            return
        self.job.update(values, updatedAt=max(millis(), self.job.get("updatedAt", 0) + 1))
        with self.service.history.db:
            self.service.history.set("operation", self.job)

    def public(self):
        j = self.job
        if not j:
            return None
        return {k: j[k] for k in ("kind", "from", "target", "startedAt", "updatedAt", "stage", "percent", "downloaded") if k in j}

    def observe(self, state):
        j = self.job
        if not j or j["stage"] in {"verified", "failed"}:
            return
        m = state["maintenance"]
        if j["kind"] == "reboot":
            uptime = seconds(state["uptime"])
            if uptime is not None and millis() - uptime * 1000 > j["boot"] + 4000:
                self.save(stage="verified")
        elif (state["version"].split(" ")[0] if j["kind"] == "routeros" else (m["boot"] or {}).get("current")) == j["target"]:
            self.save(stage="verified")
        elif j["kind"] == "routeros" and j["stage"] in ("requested", "downloading", "unknown"):
            update = download_status(m["status"])
            if update:
                self.save(**update)
        if j["stage"] not in TERMINAL | {"staged", "downloaded"} and millis() - j["updatedAt"] > 30 * 60_000:
            self.save(stage="unknown")

    def submit(self, target, confirm):
        svc = self.service
        with svc.lock:
            s, m = svc.state, svc.state["maintenance"]
            action = target.get("action")
            if not svc.config.admin_password:
                raise ActionError("denied", 403)
            if confirm != "确认" or target.get("id") != svc.config.gateway_id or target.get("name") != m["routerName"]:
                raise ActionError("confirm-mismatch")
            if action not in COMMAND or not s["online"] or not s["model"].upper().startswith("RB5009") or millis() - (s["lastSample"] or 0) > 45000:
                raise ActionError("unavailable")
            j = self.job
            pending = j and j["stage"] not in TERMINAL
            prepared = bool(pending and j["stage"] in {"downloaded", "staged"} and action == "reboot")
            if pending and not prepared:
                raise ActionError("upgrade-in-progress")
            if prepared:
                if (target.get("preparedAt") != j["startedAt"] or target.get("from") != j["from"]
                        or target.get("to") != j["target"]):
                    raise ActionError("target-changed")
                self.save(stage="restarting")
            else:
                if target.get("preparedAt") is not None:
                    raise ActionError("target-changed")
                current = s["version"].split(" ")[0]
                latest = ""
                if action == "upgrade":
                    latest = m["latest"]
                elif action == "fwupgrade":
                    boot = m["boot"] or {}
                    current, latest = boot.get("current", ""), boot.get("latest", "")
                if target.get("from") != current or target.get("to") != latest or (action != "reboot" and not newer(latest, current)):
                    raise ActionError("target-changed")
                now = millis()
                self.job = {"kind": {"fwupgrade": "routerboot", "upgrade": "routeros", "reboot": "reboot"}[action],
                            "startedAt": now, "from": current, "target": latest, "boot": now - (seconds(s["uptime"]) or 0) * 1000}
                self.save(stage="restarting" if action == "reboot" else "requested")
            stamp = self.job["startedAt"]
            threading.Thread(target=self._execute, args=(action, stamp, target.copy()), daemon=True).start()

    def _execute(self, action, stamp, target):
        svc = self.service
        router = None
        sent = False
        stage = None
        try:
            router = Router(svc.config, timeout=90)
            board = (router.table("/system/routerboard", "model,current-firmware,upgrade-firmware") or [{}])[0]
            resource = (router.table("/system/resource", "version,board-name") or [{}])[0]
            name = (router.table("/system/identity", "name") or [{}])[0].get("name")
            if name != target["name"] or not (board.get("model") or resource.get("board-name", "")).upper().startswith("RB5009"):
                raise Trap("target changed")
            if action == "fwupgrade":
                current, latest = board.get("current-firmware"), board.get("upgrade-firmware")
            else:
                current = resource.get("version", "").split(" ")[0]
                latest = (router.table("/system/package/update", "latest-version") or [{}])[0].get("latest-version") if action == "upgrade" else ""
            # A prepared reboot may be for RouterBOOT, whose current version can differ from RouterOS.
            if target.get("preparedAt"):
                with svc.lock:
                    if self.job["kind"] == "routerboot":
                        current = board.get("current-firmware")
            if current != target["from"] or (action != "reboot" and latest != target["to"]):
                raise Trap("target changed")
            sent = True
            router.call(COMMAND[action])
            if action == "fwupgrade":
                stage = "staged"
        except Trap:
            stage = "failed"
        except OSError:
            # Reboot often closes the connection before !done. Only the new uptime/version confirms it.
            if not sent:
                stage = "failed"
            elif action != "reboot":
                stage = "unknown"
        finally:
            if router:
                router.close()
            with svc.lock:
                if stage and self.job["startedAt"] == stamp and self.job["stage"] not in {"verified", "downloaded", "staged"}:
                    self.save(stage=stage)
