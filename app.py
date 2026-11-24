"""NMoney 本地服务的配置、组装与启动入口。"""

import argparse
import errno
from functools import partial
import json
import sys
import webbrowser
from pathlib import Path
from urllib.request import urlopen
from wsgiref.simple_server import make_server

from nmoney.controllers.ledger import LedgerController
from nmoney.http.application import as_wsgi
from nmoney.infrastructure.database import DEFAULT_DB, initialize, repository_session
from nmoney.http.middleware import local_only
from nmoney.http.router import build_router
from nmoney.services.ledger import LedgerService


WEB = Path(__file__).resolve().parent / "web"


def application(db_path):
    """组装一个指向指定账本的应用，测试可以传入临时 SQLite 路径。"""
    # 这里绑定数据库路径。每次业务调用再打开连接和事务。
    service = LedgerService(partial(repository_session, db_path))
    router = build_router(LedgerController(service), WEB)
    return as_wsgi(local_only(router))


def main():
    parser = argparse.ArgumentParser(description="NMoney 本地个人账本")
    parser.add_argument("--open", action="store_true", help="同时打开浏览器")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="指定 SQLite 账本路径")
    args = parser.parse_args()
    initialize(args.db)
    url = f"http://127.0.0.1:{args.port}"
    try:
        server = make_server("127.0.0.1", args.port, application(args.db))
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        try:
            with urlopen(url + "/api/ping", timeout=2) as response:
                service = json.load(response)
                already_running = service.get("app") == "NMoney" and service.get("database") == str(args.db.resolve())
        except (OSError, ValueError):
            already_running = False
        if already_running and args.open:
            webbrowser.open(url)
            return
        sys.exit(f"端口 {args.port} 已被占用。可打开现有账本，或使用 --port 指定其他端口。")
    with server:
        print(f"NMoney 已启动  {url}\n按 Ctrl+C 退出。", flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
