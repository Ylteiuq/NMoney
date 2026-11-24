"""SQLite 连接、事务与数据库初始化。"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .repository import LedgerRepository


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
CREATE TABLE IF NOT EXISTS daily_choices (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id),
    choice TEXT NOT NULL CHECK(choice IN ('yes','no'))
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
        conn.execute("BEGIN IMMEDIATE")
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(trades)")}
        if "initial_daily" not in columns:
            conn.execute("ALTER TABLE trades ADD COLUMN initial_daily TEXT CHECK(initial_daily IN ('yes','no','pending'))")
        if "initial_category" not in columns:
            conn.execute("ALTER TABLE trades ADD COLUMN initial_category TEXT")


def repository_on(conn, immediate=False):
    """复用调用方的连接，按需在第一次读取前取得写锁。"""
    if immediate and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    return LedgerRepository(conn)


@contextmanager
def repository_session(path, immediate=False):
    """一个用例一条连接。正常退出提交，异常回滚，最后关闭连接。"""
    with database(path) as conn:
        yield repository_on(conn, immediate)
