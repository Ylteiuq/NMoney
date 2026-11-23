"""NMoney 的本地 HTTP 入口。运行 python3 app.py --open 即可在浏览器使用。"""

import argparse
from datetime import datetime
import errno
import json
import sys
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs
from urllib.request import urlopen
from wsgiref.simple_server import make_server

from nmoney.ledger import DEFAULT_DB, annotate, dashboard, database, import_statement, initialize, link_receipt, mark_daily, set_cap
from nmoney.statements import parse_statement


WEB = Path(__file__).resolve().parent / "web"
ASSETS = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
          "/app.js": ("app.js", "text/javascript"), "/favicon.svg": ("favicon.svg", "image/svg+xml")}


def api(conn, path, query, body):
    if path == "/api/ping":
        location = conn.execute("PRAGMA database_list").fetchone()["file"]
        return {"app": "NMoney", "database": location}
    if path == "/api/ledger":
        return dashboard(conn, query.get("start", ""), query.get("end", ""), query.get("platform", ""))
    if path == "/api/aa-options":
        receipt_id = int(query["receipt_id"])
        rows = dashboard(conn)["rows"]
        target = next((r for r in rows if r["id"] == receipt_id and r["group_receipt"]), None)
        if not target:
            raise ValueError("找不到这笔群收款。")
        candidates = [r for r in rows if r["editable"]]
        # 优先显示回款当日的付款，再按两笔交易间隔排序，最终由用户指定。
        when = datetime.fromisoformat(target["time"])
        candidates.sort(key=lambda r: abs((datetime.fromisoformat(r["time"]) - when).total_seconds()))
        return [{"id": r["id"], "time": r["time"], "platform": r["platform"], "merchant": r["merchant"],
                 "product": r["product"], "cents": r["cents"]} for r in candidates]
    if path == "/api/import":
        statement = parse_statement(query.get("filename", ""), body)
        return dict(platform=statement.platform, **import_statement(conn, statement))
    payload = json.loads(body)
    if path == "/api/annotate":
        annotate(conn, payload["id"], payload["category"], payload["note"], payload["rule"], payload.get("include_over_cap"))
    elif path == "/api/aa":
        link_receipt(conn, payload["receipt_id"], payload["expense_id"])
    elif path == "/api/cap":
        set_cap(conn, payload["cents"])
    elif path == "/api/daily":
        return {"changed": mark_daily(conn, payload["ids"], payload["choice"], payload.get("pending_only", False),
                                      payload.get("sync_staged", False))}
    return {"ok": True}


def application(db_path):
    """每次请求独立提交。导入失败时回滚整个文件，重复上传可以安全重试。"""
    def handle(env, start_response):
        path, method = env["PATH_INFO"], env["REQUEST_METHOD"]
        mime = "application/json"
        status = "200 OK"
        if env.get("HTTP_HOST", "").split(":")[0] not in {"127.0.0.1", "localhost"}:
            status, data = "403 Forbidden", b'{}'
        elif method == "GET" and path in ASSETS:
            name, mime = ASSETS[path]
            data = (WEB / name).read_bytes()
        elif (method, path) in {("GET", "/api/aa-options"), ("POST", "/api/aa"), ("GET", "/api/ping"), ("GET", "/api/ledger"), ("POST", "/api/import"),
                                ("POST", "/api/annotate"), ("POST", "/api/cap"), ("POST", "/api/daily")}:
            try:
                # 自定义请求头限制外站表单写入本地账本。浏览器页面与 API 来自同一地址。
                if method == "POST" and env.get("HTTP_X_NMONEY") != "1":
                    raise ValueError("请从 NMoney 页面提交。")
                body = env["wsgi.input"].read(int(env.get("CONTENT_LENGTH") or 0))
                query = {key: values[0] for key, values in parse_qs(env["QUERY_STRING"]).items()}
                with database(db_path) as conn:
                    result = api(conn, path, query, body)
            except (ValueError, KeyError) as exc:
                status, result = "400 Bad Request", {"error": str(exc)}
            data = json.dumps(result, ensure_ascii=False).encode()
        else:
            status, data = "404 Not Found", b'{}'
        start_response(status, [("Content-Type", mime + "; charset=utf-8"), ("Content-Length", str(len(data))),
                                ("Cache-Control", "no-store")])
        return [data]
    return handle


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
