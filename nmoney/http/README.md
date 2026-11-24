# HTTP 请求怎样进入账本

标准库 WSGI 服务器每接到一次请求，就调用应用并传入 `environ` 和 `start_response`。前者是此次请求的字典，含方法、路径、请求头、正文输入流等。后者是服务器提供的回调，应用用它发送状态和响应头。

| 文件 | 读代码时关注什么 |
| --- | --- |
| [application.py](application.py) | `as_wsgi` 把 `environ` 包为 `Request`，调用处理函数，再用 `Response.send` 把结果交回服务器。 |
| [request.py](request.py) | 从 WSGI 字段取方法、路径和请求头。`read_input` 按 `CONTENT_LENGTH` 的字节数读正文，重复查询参数取第一个解析出的值。`json()` 供控制器解析 JSON 正文。 |
| [middleware.py](middleware.py) | `local_only` 检查 Host。`api_middleware` 检查 API 写请求头，读取输入，把输入及业务校验抛出的 `ValueError`、`KeyError` 转成带 `error` 字段的 JSON。 |
| [router.py](router.py) | `build_router` 是唯一的路由注册点。用「方法、路径」精确查表，静态资源逐个指定文件和类型。 |
| [response.py](response.py) | `body` 存已编码的字节，`mime` 决定 `Content-Type`，如 `text/html` 或 `application/json`。响应同时携带字节长度和 `Cache-Control: no-store`。 |

## 拒绝请求的顺序

1. 先检查 Host。只接受 `localhost`、`127.0.0.1`（可带端口），其余返回 `403`。
2. 再匹配路由。路径或方法未注册就返回 `404`，这一步尚未读取正文。
3. 匹配到 API 后，POST 必须携带 `X-NMoney: 1`，缺少或值不符返回 `400`。通过后才读取输入并调用控制器。静态资源直接按注册的文件返回。

新增接口时，在 [控制器](../controllers/README.md) 写接收参数的方法，在路由表登记一次。可用 [HTTP 协议测试](../../tests/test_http.py) 验证状态码、响应头和校验顺序。
