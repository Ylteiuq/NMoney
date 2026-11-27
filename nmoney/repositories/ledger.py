"""账本的 SQLite 查询与写入。连接和事务由调用方提供。"""

from dataclasses import fields

from ..models.statement import Transaction


# Transaction 的前两列 platform、order_id 标识原单，更新快照时只改其余平台字段。
TRADE_FIELDS = tuple(field.name for field in fields(Transaction))
RAW_FIELDS = TRADE_FIELDS[2:]
SNAPSHOT_FIELDS = RAW_FIELDS + ("exported_at",)


class LedgerRepository:
    def __init__(self, conn):
        self.conn = conn

    def database_file(self):
        return self.conn.execute("PRAGMA database_list").fetchone()["file"]

    def cap(self):
        return self.conn.execute("SELECT value FROM settings WHERE name='cap'").fetchone()[0]

    def set_cap(self, cents):
        self.conn.execute("UPDATE settings SET value=? WHERE name='cap'", (cents,))

    def budget_lending(self):
        row = self.conn.execute("SELECT value FROM settings WHERE name='budget_lending'").fetchone()
        return row["value"] if row else None

    def set_budget_lending(self, value):
        self.conn.execute("INSERT INTO settings VALUES ('budget_lending', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                          (value,))

    def allowance(self, month):
        row = self.conn.execute("SELECT cents FROM monthly_allowances WHERE month=?", (month,)).fetchone()
        return row["cents"] if row else None

    def set_allowance(self, month, cents):
        self.conn.execute("INSERT INTO monthly_allowances VALUES (?,?) ON CONFLICT(month) DO UPDATE SET cents=excluded.cents",
                          (month, cents))

    def supplements(self, month):
        return [dict(row) for row in self.conn.execute("""
            SELECT s.*, c.trade_id FROM income_supplements s LEFT JOIN income_choices c ON c.supplement_id=s.id
            WHERE s.month=? ORDER BY s.rowid""", (month,))]

    def add_supplement(self, key, month, label, cents):
        self.conn.execute("INSERT OR IGNORE INTO income_supplements VALUES (?,?,?,?)", (key, month, label, cents))

    def remove_supplement(self, key, month):
        self.conn.execute("DELETE FROM income_supplements WHERE id=? AND month=?", (key, month))

    def set_income_choice(self, trade_id, kind, supplement_id):
        if kind == "auto":
            self.conn.execute("DELETE FROM income_choices WHERE trade_id=?", (trade_id,))
        else:
            self.conn.execute("""INSERT INTO income_choices VALUES (?,?,?) ON CONFLICT(trade_id)
                              DO UPDATE SET kind=excluded.kind, supplement_id=excluded.supplement_id""",
                              (trade_id, kind, supplement_id))

    def trade(self, trade_id):
        return self.conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()

    def order(self, platform, order_id):
        return self.conn.execute("SELECT * FROM trades WHERE platform=? AND order_id=?",
                                 (platform, order_id)).fetchone()

    def insert_trade(self, raw):
        names = TRADE_FIELDS + ("exported_at",)
        placeholders = ", ".join(":" + name for name in names)
        self.conn.execute(f"INSERT INTO trades ({', '.join(names)}) VALUES ({placeholders})", raw)

    def update_snapshot(self, raw):
        updates = ", ".join(f"{name}=:{name}" for name in SNAPSHOT_FIELDS)
        self.conn.execute(f"UPDATE trades SET {updates} WHERE platform=:platform AND order_id=:order_id", raw)

    def annotate(self, trade_id, category, note):
        self.conn.execute("UPDATE trades SET manual_category=?, note=? WHERE id=?", (category, note, trade_id))

    def include_over_cap(self, trade_id):
        self.conn.execute("INSERT OR IGNORE INTO included_exceptions VALUES (?)", (trade_id,))

    def remove_exception(self, trade_id):
        return self.conn.execute("DELETE FROM included_exceptions WHERE trade_id=?", (trade_id,)).rowcount

    def set_merchant_rule(self, platform, merchant, category):
        self.conn.execute("""
            INSERT INTO merchant_rules VALUES (?, ?, ?)
            ON CONFLICT(platform, merchant) DO UPDATE SET category=excluded.category
        """, (platform, merchant, category))

    def remove_merchant_rule(self, platform, merchant):
        self.conn.execute("DELETE FROM merchant_rules WHERE platform=? AND merchant=?", (platform, merchant))

    def has_daily_choice(self, trade_id):
        return self.conn.execute("SELECT 1 FROM daily_choices WHERE trade_id=?", (trade_id,)).fetchone() is not None

    def reset_daily_choice(self, trade_id):
        """将初分标为 pending 并撤销手动决定，返回这一笔是否发生了变化。"""
        cleared = self.conn.execute("""UPDATE trades SET initial_daily='pending'
                                       WHERE id=? AND initial_daily IS NOT 'pending'""", (trade_id,)).rowcount
        removed = self.conn.execute("DELETE FROM daily_choices WHERE trade_id=?", (trade_id,)).rowcount
        return bool(cleared or removed)

    def insert_daily_choice(self, trade_id, choice):
        return self.conn.execute("INSERT OR IGNORE INTO daily_choices VALUES (?,?)", (trade_id, choice)).rowcount

    def upsert_daily_choice(self, trade_id, choice):
        return self.conn.execute("""INSERT INTO daily_choices VALUES (?,?)
            ON CONFLICT(trade_id) DO UPDATE SET choice=excluded.choice WHERE choice != excluded.choice""",
                                 (trade_id, choice)).rowcount

    def set_initial_classification(self, trade_id, choice, category, source):
        self.conn.execute("UPDATE trades SET initial_daily=?, initial_category=?, daily_source=? WHERE id=?",
                          (choice, category, source, trade_id))

    def loan_repayments(self):
        return self.conn.execute("""SELECT t.*, l.loan_id, l.cents AS allocated FROM loan_repayments l
            JOIN trades t ON t.id=l.receipt_id ORDER BY t.time, t.id""").fetchall()

    def settled_loans(self):
        return {row[0] for row in self.conn.execute("SELECT loan_id FROM loan_settlements")}

    def link_loan(self, receipt_id, loan_id, cents):
        self.conn.execute("""INSERT INTO loan_repayments VALUES (?,?,?) ON CONFLICT(receipt_id)
            DO UPDATE SET loan_id=excluded.loan_id, cents=excluded.cents""", (receipt_id, loan_id, cents))

    def unlink_loan(self, receipt_id):
        self.conn.execute("DELETE FROM loan_repayments WHERE receipt_id=?", (receipt_id,))

    def settle_loan(self, loan_id, closed):
        if closed:
            self.conn.execute("INSERT OR IGNORE INTO loan_settlements VALUES (?)", (loan_id,))
        else:
            self.conn.execute("DELETE FROM loan_settlements WHERE loan_id=?", (loan_id,))

    def receipt_links(self):
        return self.conn.execute("""
            SELECT a.expense_id, t.id, t.time, t.merchant, t.cents, t.source_category, t.status, t.direction
            FROM aa_links a JOIN trades t ON t.id=a.receipt_id ORDER BY t.time
        """).fetchall()

    def link_receipt(self, receipt_id, expense_id):
        self.conn.execute("""INSERT INTO aa_links(receipt_id, expense_id) VALUES (?, ?)
            ON CONFLICT(receipt_id) DO UPDATE SET expense_id=excluded.expense_id""", (receipt_id, expense_id))

    def unlink_receipt(self, receipt_id):
        self.conn.execute("DELETE FROM aa_links WHERE receipt_id=?", (receipt_id,))

    def available_months(self):
        return [r[0] for r in self.conn.execute(
            """SELECT substr(time,1,7) AS month FROM trades UNION SELECT month FROM monthly_allowances
               UNION SELECT month FROM income_supplements ORDER BY month DESC""")]

    def trades(self, start, end, platform, loans_only=False):
        """按范围取流水，附上商户规则、日常选择、上限例外和回款所对应的原单。"""
        clauses, params = [], []
        if start:
            clauses.append("t.time >= ?")
            params.append(start)
        if end:
            clauses.append("t.time <= ?")
            params.append(end + " 23:59:59")
        if platform:
            clauses.append("t.platform = ?")
            params.append(platform)
        if loans_only:
            clauses.append("COALESCE(t.manual_category, r.category) = '借出'")
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        # 手工标注和回款关联都可以缺省。LEFT JOIN 让尚未分类的流水也出现在列表中。
        return self.conn.execute("""
            SELECT t.*, r.category AS merchant_category, x.trade_id IS NOT NULL AS include_over_cap, d.choice AS daily_choice,
                   a.expense_id AS linked_expense_id, e.merchant AS linked_merchant, e.time AS linked_time,
                   e.status AS linked_status, ic.kind AS income_choice, ic.supplement_id, lr.loan_id AS linked_loan_id
            FROM trades t LEFT JOIN merchant_rules r
                ON t.merchant=r.merchant AND t.platform=r.platform
            LEFT JOIN included_exceptions x ON x.trade_id=t.id
            LEFT JOIN daily_choices d ON d.trade_id=t.id
            LEFT JOIN income_choices ic ON ic.trade_id=t.id
            LEFT JOIN loan_repayments lr ON lr.receipt_id=t.id
            LEFT JOIN aa_links a ON a.receipt_id=t.id
            LEFT JOIN trades e ON e.id=a.expense_id
        """ + where + " ORDER BY t.time DESC, t.id DESC", params).fetchall()
