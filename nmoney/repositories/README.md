# SQLite 数据访问

[ledger.py](ledger.py) 的 `LedgerRepository` 接收一条已打开的连接。查询返回可按列名访问的 SQLite 行，写操作使用绑定参数。连接的提交和回滚由 [基础设施层](../infrastructure/README.md) 管理。

| 方法 | 何时使用 |
| --- | --- |
| `order(platform, order_id)`、`trade(trade_id)` | 导入对账用平台和原订单号查重，页面编辑用本地流水 ID 找记录。 |
| `insert_trade`、`update_snapshot` | 新单插入一行。重导新快照时只更新平台字段和导出时间，原行 ID、手工备注和用途继续有效。 |
| `trades` | 按日期和平台取流水，用 `LEFT JOIN` 附上商户规则、上限例外、日常选择及回款的原单。没有标注的流水也能出现在明细中。 |
| `receipt_links`、`link_receipt`、`unlink_receipt` | 查询关联、设定原付款或解除关联。再次给同一回款指定原单会更新已有关系。 |
| `set_initial_classification`、`upsert_daily_choice`、`reset_daily_choice` | 分别保存模型初分、写入手工日常选择、退回待确认。后者会清除手工行并留下 `pending` 标记。 |

例如导入重复订单时，`order` 读取原快照，[LedgerService.import_statement](../services/ledger.py) 判断哪次导出更新，仓储接到决定后才执行 `update_snapshot`。要查某列怎样计算或关联，参阅[数据库字段字典](../infrastructure/README.md)。
