"""HTTP 请求、响应与 WSGI 边界。"""

from dataclasses import dataclass
import json
from urllib.parse import parse_qs


class Request:
    def __init__(self, environ):
        self.method = environ["REQUEST_METHOD"]
        self.path = environ["PATH_INFO"]
        self.host = environ.get("HTTP_HOST", "")
        self.write_header = environ.get("HTTP_X_NMONEY")
        self._environ = environ

    def read_input(self):
        """仅在通过校验、匹配到 API 后读取 WSGI 输入流。重复的查询参数沿用第一个值。"""
        env = self._environ
        self.body = env["wsgi.input"].read(int(env.get("CONTENT_LENGTH") or 0))
        self.query = {key: values[0] for key, values in parse_qs(env["QUERY_STRING"]).items()}

    def json(self):
        return json.loads(self.body)


@dataclass(frozen=True)
class Response:
    body: bytes
    mime: str
    status: str = "200 OK"

    @classmethod
    def json(cls, value, status="200 OK"):
        return cls(json.dumps(value, ensure_ascii=False).encode(), "application/json", status)

    def send(self, start_response):
        start_response(self.status, [
            ("Content-Type", self.mime + "; charset=utf-8"),
            ("Content-Length", str(len(self.body))),
            ("Cache-Control", "no-store"),
        ])
        return [self.body]


def as_wsgi(handler):
    def application(environ, start_response):
        return handler(Request(environ)).send(start_response)
    return application
