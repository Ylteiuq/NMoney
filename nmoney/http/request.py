"""将 WSGI 请求转换成控制器使用的方法、路径、查询参数和正文。"""

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
