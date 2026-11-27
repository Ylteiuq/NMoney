# 运行测试

从项目根目录执行下面的命令。Python 测试会在临时目录建账本，测试中的微信、支付宝文件由样例数据构造。

```sh
python3 -m unittest discover -s tests -v
```

| 文件 | 验证范围 |
| --- | --- |
| [test_http.py](test_http.py) | 用 WSGI 环境直接调用 `app.application`。核对 Host、路由和写请求头的先后顺序，校验状态码、响应类型、正文长度及静态资源。 |
| [test_ledger.py](test_ledger.py) | 用临时 SQLite 账本跑导入和标注请求，覆盖重复导入、退款、回滚、跨月 AA、理财买入、上限例外、手动日常选择和模型初分。 |
| [test_clustering.py](test_clustering.py) | 调用后端的 `clustered_rows`，检查相似交易成组、无文本交易独立、过滤非支出、输入倒序仍能得到相同分组。 |

如果某笔交易合计不对，先看 [test_ledger.py](test_ledger.py) 中相应的用例，它同时给出了原始账单行、写入操作和最终金额。若变更影响拒绝请求的顺序，可用 `python3 -m unittest discover -s tests -p test_http.py -v` 单独运行 HTTP 测试。
