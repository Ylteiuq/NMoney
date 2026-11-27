"""NMoney 的本地 WSGI 服务器。"""

from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer


class LocalWSGIServer(ThreadingMixIn, WSGIServer):
    """每条连接由单独的线程处理，浏览器预先打开的连接可以独立等待请求。"""

    daemon_threads = True

    def set_app(self, application):
        # 标准库 WSGIRequestHandler 默认报告单线程，按实际调度方式传给应用。
        def threaded_application(environ, start_response):
            environ["wsgi.multithread"] = True
            return application(environ, start_response)

        super().set_app(threaded_application)
