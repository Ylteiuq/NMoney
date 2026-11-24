"""连接标准库 WSGI 服务器与 NMoney 的请求处理函数。"""

from .request import Request


def as_wsgi(handler):
    """把接收 Request 的处理函数转换为 serve_forever() 能调用的 WSGI 应用。"""
    def application(environ, start_response):
        return handler(Request(environ)).send(start_response)
    return application
