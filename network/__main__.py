import logging
import signal
import sqlite3
import threading
from pathlib import Path

from waitress import serve

from .http import application, listen_port
from .routeros import Config
from .service import Service


def main():
    logging.basicConfig(format="%(levelname)s %(message)s", level=logging.INFO)
    try:
        port = listen_port()
        config = Config.from_env()
        service = Service(config)
    except sqlite3.OperationalError as e:
        database = Path(config.data) / "network.sqlite3"
        raise SystemExit(f"无法初始化 SQLite 历史数据库 {database}（{e}）") from None
    except (ValueError, OSError) as e:
        raise SystemExit(str(e)) from None
    html = (Path(__file__).resolve().parent.parent / "index.html").read_bytes()
    worker = threading.Thread(target=service.run, name="routeros-collector", daemon=True)
    worker.start()

    def stop(signum, frame):
        service.stopping.set()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        serve(application(service, html), host="0.0.0.0", port=port, threads=4,
              max_request_body_size=4096, expose_tracebacks=False, ident="Network")
    finally:
        service.stopping.set()
        worker.join(timeout=2)


if __name__ == "__main__":
    main()
