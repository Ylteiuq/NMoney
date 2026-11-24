"""连接标准库 WSGI 服务器与 NMoney 的请求处理函数。"""

from .request import Request


def as_wsgi(handler):
    def application(environ, start_response):
        return handler(Request(environ)).send(start_response)
    return application
