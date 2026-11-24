"""账本的 SQLite 查询与写入。连接和事务由调用方提供。"""

from dataclasses import fields

from ..models.statement import Transaction


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
        self.conn.execute("DELETE FROM included_exceptions WHERE trade_id=?", (trade_id,))

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

    def set_initial_classification(self, trade_id, choice, category):
        self.conn.execute("UPDATE trades SET initial_daily=?, initial_category=COALESCE(?,initial_category) WHERE id=?",
                          (choice, category, trade_id))

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
            "SELECT DISTINCT substr(time,1,7) AS month FROM trades ORDER BY month DESC")]

    def trades(self, start, end, platform):
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
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return self.conn.execute("""
            SELECT t.*, r.category AS merchant_category, x.trade_id IS NOT NULL AS include_over_cap, d.choice AS daily_choice,
                   a.expense_id AS linked_expense_id, e.merchant AS linked_merchant, e.time AS linked_time,
                   e.status AS linked_status
            FROM trades t LEFT JOIN merchant_rules r
                ON t.merchant=r.merchant AND t.platform=r.platform
            LEFT JOIN included_exceptions x ON x.trade_id=t.id
            LEFT JOIN daily_choices d ON d.trade_id=t.id
            LEFT JOIN aa_links a ON a.receipt_id=t.id
            LEFT JOIN trades e ON e.id=a.expense_id
        """ + where + " ORDER BY t.time DESC, t.id DESC", params).fetchall()
