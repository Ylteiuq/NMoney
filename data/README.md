# 本机账本

默认数据库文件是本目录下的 `nmoney.sqlite3`，首次启动时自动创建。它保存平台流水、手工备注、日常选择、商户规则、群收款关联和上限设置。目录中的账本及其他运行文件由 Git 忽略。

- **备份**时先退出 NMoney，再复制 `nmoney.sqlite3`。恢复时先保留目标账本的原件，再将备份放回同一路径。
- **试改**时在项目根目录运行 `python3 app.py --db /tmp/nmoney-demo.sqlite3 --port 8766 --open`。网页将使用独立的演示账本。
- **查字段**请看[数据库字典](../nmoney/infrastructure/README.md)。数据库仅保存解析后的记录，导入的 XLSX 和 CSV 原文件由用户自行保管。
