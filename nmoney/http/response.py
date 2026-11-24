"""将响应正文、状态码和媒体类型编码成 WSGI 响应。"""

from dataclasses import dataclass
import json


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
