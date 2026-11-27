# 数据库与账单文件

[database.py](database.py) 的 `SCHEMA` 包含完整建表 SQL，每个字段旁都有中文注释。`initialize(path)` 用它新建账本，也会给早期账本补齐缺少的初分列。[statements.py](statements.py) 从微信 XLSX、支付宝 CSV 的原始字节中识别表头，解析成 [Statement](../models/README.md)。同一份文件先完整解析，再交给服务写库。

## 连接和事务

- `database(path)` 打开一条 SQLite 连接，让查询结果可以按列名读取，并为该连接开启外键检查。正常退出提交，抛出异常时回滚，最后关闭连接。
- `repository_session(path, immediate=False)` 为一个用例提供同一连接上的仓储。需要先读后写的群收款关联和批量日常标记传入 `immediate=True`，用 `BEGIN IMMEDIATE` 先取得写锁。
- `repository_on(conn)` 让已有脚本复用自己持有的连接。调用方负责在整组操作完成后提交或回滚。

## 字段字典

金额统一使用整数分。下面先列平台流水，再列出记录使用者决定的表。`trades.id` 是本地关联使用的主键，`(platform, order_id)` 是重导时识别同一笔交易的唯一键。

### trades

每条平台流水一行，包括付款和入账。两次导出的交易日期范围重叠时，服务按导出时间决定是否更新已有行的原始数据。

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | SQLite 分配的本地流水 ID。页面操作和其他表的外键都使用它。 |
| `platform` | TEXT NOT NULL | 来源平台，目前为微信或支付宝。与 `order_id` 组成唯一键。 |
| `order_id` | TEXT NOT NULL | 平台交易订单号，文本保留前导零和长号码。不同平台可以使用相同号码。 |
| `time` | TEXT NOT NULL | 交易发生时间，平台账单通常为 `YYYY-MM-DD HH:MM:SS`。用于范围查询、排序和月份归属，`trades_time` 索引建在此列。 |
| `merchant` | TEXT NOT NULL | 平台显示的交易对方，可能是商户，也可能是个人。商户规则按同平台的这个名字精确匹配。 |
| `product` | TEXT NOT NULL | 平台的商品名、订单或转账说明，供搜索和用途推断使用。 |
| `source_category` | TEXT NOT NULL | 平台原始交易类型，如「群收款」「投资理财」。用它识别资金性质。 |
| `direction` | TEXT NOT NULL | 平台原始收支标记，如「支出」「收入」「不计收支」或「/」。需结合类型、状态判断实际资金流出。 |
| `cents` | INTEGER NOT NULL | 平台原始金额，以分为单位。例如 12.50 元存 `1250`。退款和分摊另行计算。 |
| `status` | TEXT NOT NULL | 平台交易状态。可包含支付成功、部分退款和具体退款金额等信息，较新的导出可以更新它。 |
| `exported_at` | TEXT NOT NULL | 最近被采纳的账单导出时间，格式为 `YYYY-MM-DD HH:MM:SS`。文件无导出时间时存空串，可新增订单，不能覆盖已有快照。 |
| `manual_category` | TEXT，可空 | 用户给本笔付款指定的用途，优先于商户规则和自动分类。`NULL` 表示没有逐笔标注。 |
| `note` | TEXT NOT NULL，默认空串 | 用户给本笔流水写的备注，重导时保留。 |
| `initial_daily` | TEXT，可空 | `yes` / `no` 是初分给出的日常归属。`NULL` 表示没有初分值。`pending` 表示用户主动退回待确认，后续初分保留该决定。 |
| `initial_category` | TEXT，可空 | 初分模型推断的用途。`NULL` 表示没有写入推断用途。仅在未指定单笔或商户用途、规则也无法判定时用于补全。 |

### merchant_rules

一条规则影响同平台、同名交易对方的历史及未来订单。

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `platform` | TEXT NOT NULL | 规则生效的平台，与 `merchant` 组成主键。 |
| `merchant` | TEXT NOT NULL | 与 `trades.merchant` 精确匹配的名字。同名交易对方在不同平台可以各自设规则。 |
| `category` | TEXT NOT NULL | 匹配后的用途。个别订单有单笔标注时优先采用单笔值。 |

### included_exceptions

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `trade_id` | INTEGER PRIMARY KEY，外键 | 指向 `trades.id`。有这一行表示用户允许该笔消费超过上限仍计入，取消时删除此行。 |

### daily_choices

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `trade_id` | INTEGER PRIMARY KEY，外键 | 被手工标记支出的 `trades.id`，每笔至多一个手工决定。 |
| `choice` | TEXT NOT NULL | 只能取 `yes`（计入日常）或 `no`（非日常）。读取时优先于 `initial_daily`。退回待确认时删除此行并在原单标记 `pending`。 |

### aa_links

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `receipt_id` | INTEGER PRIMARY KEY，外键 | 已到账群收款的 `trades.id`。每笔回款只能关联一笔付款，改关联时更新已有行。 |
| `expense_id` | INTEGER NOT NULL，外键 | 被抵扣原付款的 `trades.id`。多笔回款可以指向同一付款，`aa_expense` 索引便于按原付款找回款。 |

例如，自己付 120 元，两位朋友各还 40 元。库中保留一笔 `cents=12000` 的付款和两笔 `cents=4000` 的回款。`aa_links` 有两行，两行的 `expense_id` 相同。若无退款，查询时算出个人实付 40 元，原付款仍保留 120 元。

### settings

| 字段 | SQLite 类型 | 含义 |
| --- | --- | --- |
| `name` | TEXT PRIMARY KEY | 设置名称。目前的 `cap` 是计入消费的单笔上限，作用于整个账本。 |
| `value` | INTEGER NOT NULL | 对应设置的整数值。初始化为 `cap` 填入 `10000`（100 元），再次启动保留用户已修改的值。 |

在 SQLite 命令行执行 `PRAGMA table_info(trades);` 可核对本地表的列、默认值和主键，用 `PRAGMA foreign_key_list(aa_links);` 可查看两个外键的实际指向。

### 月度生活费与收入

| 表 | 字段 | 含义 |
| --- | --- | --- |
| monthly_allowances | month, cents | 自然月和当月基础生活费（分）。没有设置的月份使用 2,000 元。 |
| income_supplements | id, month, label, cents | 补记编号、到账月份、来源说明和到账金额（分）。相同编号可安全重试。 |
| income_choices | trade_id, kind, supplement_id | 平台流水号、人工指定的额度归属和对应补记编号。每条补记最多关联一条转入。删除补记时对应的匹配会一并解除。 |
| settings | budget_lending 对应的 value | 1 表示借出占额度、还款补回，0 表示两者均排除。尚未选定时同时列出两种余额。 |
