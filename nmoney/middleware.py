"""对所有请求校验 Host，对已注册的 API 校验写请求头并统一转换输入和业务错误。"""

from .http import Response


def local_only(handler):
    def handle(request):
        if request.host.split(":")[0] not in {"127.0.0.1", "localhost"}:
            return Response.json({}, "403 Forbidden")
        return handler(request)
    return handle


def api_middleware(handler):
    def handle(request):
        try:
            if request.method == "POST" and request.write_header != "1":
                raise ValueError("请从 NMoney 页面提交。")
            request.read_input()
            return handler(request)
        except (ValueError, KeyError) as exc:
            return Response.json({"error": str(exc)}, "400 Bad Request")
    return handle
