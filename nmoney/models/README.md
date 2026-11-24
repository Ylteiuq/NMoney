# 账单导入的数据模型

[statement.py](statement.py) 定义两个数据类。微信 Excel 和支付宝 CSV 经过[文件解析器](../infrastructure/statements.py) 后，都能交给同一个导入服务。

| 对象 | 表示什么 | 包含的字段 |
| --- | --- | --- |
| `Statement` | 平台一次导出的整份账单 | `platform` 平台、`exported_at` 导出时间、`transactions` 本次读到的流水列表 |
| `Transaction` | 文件中的一行交易 | `platform` 和 `order_id` 标识原单，`time` 是交易时间，`merchant` 和 `product` 描述交易对方与商品，`source_category`、`direction`、`status` 保留平台分类、收支方向和状态，`cents` 是整数分 |

例如，文件里一笔 12.50 元的付款在 `Transaction` 中是 `cents=1250`。订单号 `"000123"` 仍然是字符串。本地 `id` 在入库时生成，用户之后填写的用途、备注及日常选择保存于数据库。字段的类型、单位和缺省值见[数据库字典](../infrastructure/README.md)。
