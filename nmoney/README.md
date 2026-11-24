# 后端阅读指南

从项目入口 [app.py](../app.py) 的 `application(db_path)` 开始。它把数据库路径绑定到会话工厂，把会话交给 `LedgerService`，再把服务交给控制器。测试传入临时数据库路径，也会经过这套组装。

| 想了解的问题 | 从这里读 |
| --- | --- |
| 请求从哪里进来，按什么顺序检查，URL 如何匹配？ | [http/](http/README.md) |
| 前端要传什么参数，响应长什么样？ | [controllers/](controllers/README.md) |
| 哪些钱算支出，群收款抵扣到哪一天，模型怎样初分？ | [services/](services/README.md) |
| 一笔流水怎样入库，怎么把手工标注一起查出来？ | [repositories/](repositories/README.md) |
| 两种账单格式经过解析后，Python 对象是什么样子？ | [models/](models/README.md) |
| 表和字段各存什么，在哪儿建表、开连接、提交或回滚？ | [infrastructure/](infrastructure/README.md) |

## 跟一笔群收款走一遍

1. 用户在页面选中朋友的回款和自己垫付的原单。`router.py` 将 `POST /api/aa` 交给 `LedgerController.link_receipt`。
2. 控制器从 JSON 提取两笔流水的本地 ID。`LedgerService.link_receipt` 打开写事务，检查这笔钱已经到账，累计抵扣也没有超过原付款扣除已知退款后的金额。
3. `LedgerRepository.link_receipt` 把两个 ID 写入 `aa_links`。事务成功提交后，控制器返回 `{"ok": true}`。如果核对失败，事务回滚，API 中间件将错误转成响应。
4. 下次读概览时，服务先查所有日期的回款，再按原付款的日期和平台筛选。即使下个月才收到钱，个人实付也会更新在原付款那个月。

[trial.py](trial.py) 是初分命令行入口。[ledger.py](ledger.py) 保留供已有脚本传入 SQLite 连接的接口，事务由连接持有者管理。[statements.py](statements.py) 保留原有的账单对象和解析函数导入路径。
