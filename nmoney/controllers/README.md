# 账本 HTTP 接口

[ledger.py](ledger.py) 中的 `LedgerController` 将查询字符串、JSON 或上传的文件正文转换为服务参数，并构建响应。比如 `receipt_options` 把查询字符串中的 `receipt_id` 转成整数，回款能否抵扣则由 [服务层](../services/README.md) 判断。下表的 ID 均为本地 `trades.id`。金额单位均为分。

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| `GET /api/ping` | 无 | `app` 和当前账本的 `database` 路径 |
| `GET /api/ledger` | 可选查询参数 `start`、`end`（含首尾日期）、`platform` | `rows` 流水、`cap` 上限、`choices` 用途选项、可选月份及各项汇总 |
| `GET /api/aa-options` | 查询参数 `receipt_id` | 可关联付款的数组，按与回款的时间差排序 |
| `POST /api/import` | 查询参数 `filename`，请求正文直接放 XLSX 或 CSV 的原始字节 | `platform`、`added` 新增笔数、`changed` 更新笔数、`skipped` 跳过笔数 |
| `POST /api/annotate` | `id`、`category`、`note`、`rule`（`keep`、`set`、`remove`），可选 `include_over_cap` | `{"ok": true}` |
| `POST /api/aa` | `receipt_id`、`expense_id`，后者传 `null` 可解除关联 | `{"ok": true}` |
| `POST /api/cap` | `cents`，非负整数。例如 `10000` 表示 100 元 | `{"ok": true}` |
| `POST /api/daily` | `ids` 为流水 ID 数组，`choice` 取 `"yes"`、`"no"` 或 `null`，另有两个可选布尔值 `pending_only`、`sync_staged` | `{"changed": n}`，其中 `n` 是实际变化的笔数 |

POST 均需 `X-NMoney: 1` 请求头。除文件导入外，POST 正文均为 JSON。`/api/daily` 的 `pending_only` 供批量确认待处理记录使用。`sync_staged` 供旧版网页暂存标记回写，使用时同时传 `pending_only: true`。

同文件里的 `static_file` 接收路由已选好的文件路径和 MIME 类型。所有 URL 在 [router.py](../http/router.py) 注册。
