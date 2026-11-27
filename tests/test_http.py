"""固定重构前的 WSGI 协议及鉴权、路由、读取请求体的先后顺序。"""

import io
import json
import socket
import tempfile
import unittest
from http.client import HTTPResponse
from pathlib import Path
from threading import Thread
from wsgiref.simple_server import WSGIRequestHandler
from wsgiref.util import setup_testing_defaults

from app import application
from nmoney.http.server import LocalWSGIServer
from nmoney.ledger import initialize


class UnreadableBody:
    def read(self, size):
        raise AssertionError("被拒绝的请求不应读取请求体")


class HttpContractTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "ledger.db"
        initialize(self.path)
        self.app = application(self.path)

    def call(self, method, path, body=b"", **values):
        env = {}
        setup_testing_defaults(env)
        env.update(REQUEST_METHOD=method, PATH_INFO=path, QUERY_STRING="", CONTENT_LENGTH=str(len(body)))
        env["wsgi.input"] = io.BytesIO(body)
        env.update(values)
        response = []
        data = b"".join(self.app(env, lambda status, headers: response.append((status, dict(headers)))))
        status, headers = response[0]
        self.assertEqual(headers["Content-Length"], str(len(data)))
        self.assertEqual(headers["Cache-Control"], "no-store")
        return status, headers["Content-Type"], data

    def test_idle_browser_connection_does_not_block_ping(self):
        # 用两对已连接的套接字模拟 accept 的结果，无需占用本机账本端口。
        with LocalWSGIServer(("127.0.0.1", 8765), WSGIRequestHandler, bind_and_activate=False) as server:
            server.server_name, server.server_port = server.server_address
            server.setup_environ()
            server.set_app(self.app)
            idle_server, idle_browser = socket.socketpair()
            page_server, page_browser = socket.socketpair()

            def dispatch():
                for connection in (idle_server, page_server):
                    server.process_request(connection, ("127.0.0.1", 30000))

            dispatcher = Thread(target=dispatch, daemon=True)
            try:
                with idle_browser, page_browser:
                    dispatcher.start()
                    page_browser.settimeout(2)
                    page_browser.sendall(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1:8765\r\n\r\n")
                    with HTTPResponse(page_browser) as response:
                        response.begin()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.load(response)["database"], str(self.path.resolve()))
            finally:
                dispatcher.join(2)

    def test_host_then_route_then_write_header(self):
        stream = {"wsgi.input": UnreadableBody()}
        for path in ("/", "/api/ledger", "/missing"):
            self.assertEqual(self.call("POST", path, HTTP_HOST="outside.test", **stream)[::2],
                             ("403 Forbidden", b"{}"))
        for method, path in (("GET", "/missing"), ("POST", "/api/ledger"), ("GET", "/api/cap"),
                             ("POST", "/missing"), ("POST", "/"), ("HEAD", "/")):
            self.assertEqual(self.call(method, path, **stream)[::2], ("404 Not Found", b"{}"))
        status, mime, data = self.call("POST", "/api/cap", **stream)
        self.assertEqual((status, mime), ("400 Bad Request", "application/json; charset=utf-8"))
        self.assertEqual(json.loads(data), {"error": "请从 NMoney 页面提交。"})

    def test_response_and_request_contract(self):
        status, mime, data = self.call("GET", "/api/ping", HTTP_HOST="localhost:8765")
        self.assertEqual((status, mime), ("200 OK", "application/json; charset=utf-8"))
        self.assertEqual(json.loads(data), {"app": "NMoney", "database": str(self.path.resolve())})
        for path, mime in (("/", "text/html"), ("/app.js", "text/javascript"), ("/style.css", "text/css"),
                           ("/favicon.svg", "image/svg+xml")):
            status, actual, body = self.call("GET", path, **{"wsgi.input": UnreadableBody()})
            self.assertEqual((status, actual), ("200 OK", mime + "; charset=utf-8"))
            self.assertTrue(body)
        for method, path, body in (("POST", "/api/cap", b"{"), ("POST", "/api/cap", b"{}"),
                                   ("GET", "/api/aa-options", b"")):
            status, _, data = self.call(method, path, body, HTTP_X_NMONEY="1")
            self.assertEqual(status, "400 Bad Request")
            self.assertIn("error", json.loads(data))
        self.assertEqual(self.call("GET", "/api/ledger", CONTENT_LENGTH="invalid")[0], "400 Bad Request")
