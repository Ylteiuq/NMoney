"""SQLite 持久化。平台原始字段和手工标注分别存储，重新导入不会覆盖标注。"""

import sqlite3
from contextlib import contextmanager
from dataclasses import asdict, fields
from pathlib import Path

from .rules import CHOICES, LEGACY_CATEGORIES, SPENDING, after_refund, evaluate, is_group_receipt, payment_state, summarize
from .statements import Transaction


DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "nmoney.sqlite3"
SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL, order_id TEXT NOT NULL, time TEXT NOT NULL,
    merchant TEXT NOT NULL, product TEXT NOT NULL, source_category TEXT NOT NULL,
    direction TEXT NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL,
    exported_at TEXT NOT NULL, manual_category TEXT, note TEXT NOT NULL DEFAULT '',
    UNIQUE(platform, order_id)
);
CREATE INDEX IF NOT EXISTS trades_time ON trades(time);
CREATE TABLE IF NOT EXISTS merchant_rules (
    platform TEXT NOT NULL, merchant TEXT NOT NULL, category TEXT NOT NULL,
    PRIMARY KEY(platform, merchant)
);
CREATE TABLE IF NOT EXISTS included_exceptions (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id)
);
CREATE TABLE IF NOT EXISTS aa_links (
    receipt_id INTEGER PRIMARY KEY REFERENCES trades(id),
    expense_id INTEGER NOT NULL REFERENCES trades(id)
);
CREATE INDEX IF NOT EXISTS aa_expense ON aa_links(expense_id);
CREATE TABLE IF NOT EXISTS settings (
    name TEXT PRIMARY KEY, value INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings VALUES ('cap', 10000);
"""
TRADE_FIELDS = tuple(field.name for field in fields(Transaction))
RAW_FIELDS = TRADE_FIELDS[2:]


@contextmanager
def database(path=DEFAULT_DB):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize(path=DEFAULT_DB):
    with database(path) as conn:
        conn.executescript(SCHEMA)


def import_statement(conn, statement):
    counts = {"added": 0, "changed": 0, "skipped": 0}
    for trade in statement.transactions:
        raw = asdict(trade)
        raw["exported_at"] = statement.exported_at
        old = conn.execute("SELECT * FROM trades WHERE platform=:platform AND order_id=:order_id", raw).fetchone()
        if old is None:
            names = TRADE_FIELDS + ("exported_at",)
            conn.execute(f"INSERT INTO trades ({', '.join(names)}) VALUES ({', '.join(':' + n for n in names)})", raw)
            counts["added"] += 1
            continue
        # 用导出时间比较快照，而不是用本次上传时间。即使字段没变化，也记住最新快照。
        if statement.exported_at <= old["exported_at"]:
            counts["skipped"] += 1
            continue
        changed = any(old[name] != raw[name] for name in RAW_FIELDS)
        updates = ", ".join(f"{name}=:{name}" for name in RAW_FIELDS + ("exported_at",))
        conn.execute(f"UPDATE trades SET {updates} WHERE platform=:platform AND order_id=:order_id", raw)
        counts["changed" if changed else "skipped"] += 1
    return counts


def set_cap(conn, cents):
    if type(cents) is not int or cents < 0:
        raise ValueError("上限必须是非负金额。")
    conn.execute("UPDATE settings SET value=? WHERE name='cap'", (cents,))


def annotate(conn, trade_id, category, note="", rule="keep", include_over_cap=None):
    row = conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
    if row is None or payment_state(row) != "支出":
        raise ValueError("只有付款记录可以补用途。")
    if isinstance(category, str):
        category = LEGACY_CATEGORIES.get(category, category)
    if category not in CHOICES:
        raise ValueError("请选择列表中的用途。")
    conn.execute("UPDATE trades SET manual_category=?, note=? WHERE id=?", (category, note.strip(), trade_id))
    if include_over_cap is not None:
        if include_over_cap and category not in SPENDING:
            raise ValueError("请先选择一项消费用途，再手动计入。")
        if include_over_cap:
            conn.execute("INSERT OR IGNORE INTO included_exceptions VALUES (?)", (trade_id,))
        else:
            conn.execute("DELETE FROM included_exceptions WHERE trade_id=?", (trade_id,))
    if rule == "remove":
        conn.execute("DELETE FROM merchant_rules WHERE platform=? AND merchant=?", (row["platform"], row["merchant"]))
    elif rule == "set" and row["merchant"] not in {"", "/"}:
        # 规则限定到同一平台、同名商户，且永远让单笔手工标注优先。
        conn.execute("""
            INSERT INTO merchant_rules VALUES (?, ?, ?)
            ON CONFLICT(platform, merchant) DO UPDATE SET category=excluded.category
        """, (row["platform"], row["merchant"], category))


def linked_receipts(conn):
    """先读取所有日期的回款，再筛原支出，允许跨月、跨平台分摊。"""
    by_expense = {}
    for row in conn.execute("""
        SELECT a.expense_id, t.id, t.time, t.merchant, t.cents, t.source_category, t.status, t.direction
        FROM aa_links a JOIN trades t ON t.id=a.receipt_id ORDER BY t.time
    """):
        if is_group_receipt(row):
            by_expense.setdefault(row["expense_id"], []).append(dict(row))
    return by_expense


def link_receipt(conn, receipt_id, expense_id):
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    receipt = conn.execute("SELECT * FROM trades WHERE id=?", (receipt_id,)).fetchone()
    if not receipt or not is_group_receipt(receipt):
        raise ValueError("请选择已到账的群收款。")
    if expense_id is None:
        conn.execute("DELETE FROM aa_links WHERE receipt_id=?", (receipt_id,))
        return
    expense = conn.execute("SELECT * FROM trades WHERE id=?", (expense_id,)).fetchone()
    if not expense or payment_state(expense) != "支出":
        raise ValueError("请选择一笔已付款的支出。")
    others = linked_receipts(conn).get(expense_id, ())
    used = sum(r["cents"] for r in others if r["id"] != receipt_id)
    if used + receipt["cents"] > after_refund(expense):
        raise ValueError("累计回款将超过这笔付款的金额，请核对原付款。")
    # 一笔回款最多对应一笔付款。重选原单时移动关联，避免在两边同时抵扣。
    conn.execute("""INSERT INTO aa_links(receipt_id, expense_id) VALUES (?, ?)
                    ON CONFLICT(receipt_id) DO UPDATE SET expense_id=excluded.expense_id""",
                 (receipt_id, expense_id))


def dashboard(conn, start="", end="", platform=""):
    cap = conn.execute("SELECT value FROM settings WHERE name='cap'").fetchone()[0]
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
    receipts = linked_receipts(conn)
    records = conn.execute("""
        SELECT t.*, r.category AS merchant_category, x.trade_id IS NOT NULL AS include_over_cap,
               a.expense_id AS linked_expense_id, e.merchant AS linked_merchant, e.time AS linked_time,
               e.status AS linked_status
        FROM trades t LEFT JOIN merchant_rules r
            ON t.merchant=r.merchant AND t.platform=r.platform
        LEFT JOIN included_exceptions x ON x.trade_id=t.id
        LEFT JOIN aa_links a ON a.receipt_id=t.id
        LEFT JOIN trades e ON e.id=a.expense_id
    """ + where + " ORDER BY t.time DESC, t.id DESC", params)
    rows = [evaluate(row, cap, receipts.get(row["id"], [])) for row in records]
    months = [r[0] for r in conn.execute("SELECT DISTINCT substr(time,1,7) AS month FROM trades ORDER BY month DESC")]
    return dict(cap=cap, rows=rows, choices=CHOICES, available_months=months, **summarize(rows))
