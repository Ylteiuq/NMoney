"""SQLite 连接、事务与数据库初始化。"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from ..repositories.ledger import LedgerRepository


DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "nmoney.sqlite3"
# 新账本一次建好全部字段。已有账本由 initialize() 检查并补齐历史缺列。
SCHEMA = """
-- 每条平台流水一行。重导时更新平台快照，保留本地标注。
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,              -- 本地流水主键。日常选择、上限例外和群收款关联均引用此 ID。
    platform TEXT NOT NULL,              -- 来源平台，如「微信」「支付宝」。同一订单号可以出现在不同平台。
    order_id TEXT NOT NULL,              -- 平台交易单号。按文本保留长号码与前导零，与 platform 共同用于去重。
    time TEXT NOT NULL,                  -- 平台交易时间，格式为 YYYY-MM-DD HH:MM:SS，用于日期筛选和月份归属。
    merchant TEXT NOT NULL,              -- 交易对方的原始显示名，也是同平台商户规则的匹配键。
    product TEXT NOT NULL,               -- 平台商品说明或转账说明，可用于搜索和推断用途。
    source_category TEXT NOT NULL,       -- 平台原始交易类型，如「商户消费」「群收款」「投资理财」。
    direction TEXT NOT NULL,             -- 平台收支标记，常见值有「支出」「收入」「不计收支」和「/」。
    cents INTEGER NOT NULL,              -- 平台原金额，单位为分。退回金额和朋友的分摊在查询时另算。
    status TEXT NOT NULL,                -- 平台交易状态，如「支付成功」或带退款金额的状态文字。
    exported_at TEXT NOT NULL,           -- 含此流水的最新账单导出时间。缺失时存空串，重导比较此值判定快照新旧。
    manual_category TEXT,                -- 用户指定的单笔用途，如「餐饮」。NULL 表示尚未单独指定。
    note TEXT NOT NULL DEFAULT '',       -- 用户填写的单笔备注，默认空串，重导账单时保留。
    -- 初分的 yes/no 表示日常/非日常。手动退回待确认记 pending，NULL 表示没有初分值。
    initial_daily TEXT CHECK(initial_daily IN ('yes','no','pending')),
    initial_category TEXT,               -- 相似支出模型推断的用途。NULL 表示未推断，用于补充原本未知的用途。
    UNIQUE(platform, order_id)
);
-- 概览和明细常按日期范围查询。
CREATE INDEX IF NOT EXISTS trades_time ON trades(time);

-- 用户为同一平台的同名交易对方保存的用途规则。
CREATE TABLE IF NOT EXISTS merchant_rules (
    platform TEXT NOT NULL,              -- 规则的有效平台，与 merchant 共同构成主键。
    merchant TEXT NOT NULL,              -- 精确匹配 trades.merchant 的交易对方名称。
    category TEXT NOT NULL,              -- 匹配后采用的用途，单笔 manual_category 的优先级更高。
    PRIMARY KEY(platform, merchant)
);

-- 每条例外只需记录一次。对应行存在时，这笔消费可绕过单笔上限。
CREATE TABLE IF NOT EXISTS included_exceptions (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id) -- 获准计入的付款对应的本地流水 ID。
);

-- 用户逐笔确定的日常归属。日常开销与消费用途分别记录。
CREATE TABLE IF NOT EXISTS daily_choices (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id), -- 被标记支出的本地 ID，每笔最多一个手动选择。
    choice TEXT NOT NULL CHECK(choice IN ('yes','no'))  -- yes 计入日常，no 归为非日常，优先于初分结果。
);

-- 多笔群收款可以抵扣同一笔原付款，每笔回款只能使用一次。
CREATE TABLE IF NOT EXISTS aa_links (
    receipt_id INTEGER PRIMARY KEY REFERENCES trades(id), -- 回款流水的本地 ID。主键约束防止同笔回款重复关联。
    expense_id INTEGER NOT NULL REFERENCES trades(id)     -- 被抵扣的原付款流水 ID，可跨月、跨平台。
);
CREATE INDEX IF NOT EXISTS aa_expense ON aa_links(expense_id);

-- 生活费按自然月设置。没有设置的月份沿用默认生活费。
CREATE TABLE IF NOT EXISTS monthly_allowances (
    month TEXT PRIMARY KEY,               -- YYYY-MM，独立于交易平台。
    cents INTEGER NOT NULL CHECK(cents >= 0) -- 这个月可使用的基础生活费，单位为分。
);
-- 用户补记未出现在平台账单中的收入，例如打进银行卡的劳务费。
CREATE TABLE IF NOT EXISTS income_supplements (
    id TEXT PRIMARY KEY,                  -- 客户端为本次补记生成的稳定标识，重试时不会重复入账。
    month TEXT NOT NULL,                  -- 该笔收入归属的自然月 YYYY-MM。
    label TEXT NOT NULL,                  -- 用户填写的来源或说明，例如「劳务费」。
    cents INTEGER NOT NULL CHECK(cents > 0) -- 已收到的金额，单位为分。
);
CREATE TABLE IF NOT EXISTS income_choices (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id), -- 对应的一条平台收入流水，重导沿用同一个 ID。
    kind TEXT NOT NULL,                   -- extra 增加额度，base 已含在生活费，ignore 忽略，repayment 归还借款，matched 对应手工补记。
    supplement_id TEXT UNIQUE REFERENCES income_supplements(id) ON DELETE CASCADE -- matched 对应的补记，每笔最多认领一次。
);

-- 全账本共用的整数设置。
CREATE TABLE IF NOT EXISTS settings (
    name TEXT PRIMARY KEY,               -- 设置键。cap 为单笔上限，budget_lending 决定借出是否占用月度额度。
    value INTEGER NOT NULL               -- 键对应的整数值。cap 的单位为分，10000 表示 100 元。
);
INSERT OR IGNORE INTO settings VALUES ('cap', 10000);
"""


@contextmanager
def database(path=DEFAULT_DB):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    # 仓储和业务规则均按列名读取数据，例如 row["cents"]。
    conn.row_factory = sqlite3.Row
    # SQLite 的外键开关只作用于当前连接，每次新建连接时都要开启。
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize(path=DEFAULT_DB):
    with database(path) as conn:
        conn.executescript(SCHEMA)
        # CREATE TABLE IF NOT EXISTS 会保留已有表。先取写锁再检查列，避免两个启动进程重复加列。
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
