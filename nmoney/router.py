"""所有 HTTP 入口仅在这里注册一次，按方法和路径精确匹配。"""

from functools import partial

from .controllers import static_file
from .http import Response
from .middleware import api_middleware


def build_router(controller, web_root):
    api = {
        ("GET", "/api/ping"): controller.ping,
        ("GET", "/api/ledger"): controller.ledger,
        ("GET", "/api/aa-options"): controller.receipt_options,
        ("POST", "/api/import"): controller.import_statement,
        ("POST", "/api/annotate"): controller.annotate,
        ("POST", "/api/aa"): controller.link_receipt,
        ("POST", "/api/cap"): controller.set_cap,
        ("POST", "/api/daily"): controller.mark_daily,
    }
    routes = {route: api_middleware(handler) for route, handler in api.items()}
    routes.update({
        ("GET", "/"): partial(static_file, file=web_root / "index.html", mime="text/html"),
        ("GET", "/style.css"): partial(static_file, file=web_root / "style.css", mime="text/css"),
        ("GET", "/app.js"): partial(static_file, file=web_root / "app.js", mime="text/javascript"),
        ("GET", "/favicon.svg"): partial(static_file, file=web_root / "favicon.svg", mime="image/svg+xml"),
    })

    def dispatch(request):
        handler = routes.get((request.method, request.path))
        if handler is None:
            return Response.json({}, "404 Not Found")
        return handler(request)
    return dispatch
