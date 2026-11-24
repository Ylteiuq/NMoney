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
        # WSGI 通过回调发送状态和响应头，返回值是字节串序列。长度按编码后的字节数计算。
        start_response(self.status, [
            ("Content-Type", self.mime + "; charset=utf-8"),
            ("Content-Length", str(len(self.body))),
            ("Cache-Control", "no-store"),
        ])
        return [self.body]
