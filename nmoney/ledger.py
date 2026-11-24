"""兼容已有的连接式 Python 调用，由连接的持有者负责提交或回滚。"""

from contextlib import nullcontext

from .infrastructure.database import DEFAULT_DB, SCHEMA, database, initialize, repository_on
from .repositories.ledger import RAW_FIELDS, TRADE_FIELDS
from .services.ledger import LedgerService, build_dashboard, linked_receipts as collect_receipts


def _service(conn):
    def session(immediate=False):
        return nullcontext(repository_on(conn, immediate))
    return LedgerService(session)


def dashboard(conn, start="", end="", platform=""):
    return build_dashboard(repository_on(conn), start, end, platform)


def linked_receipts(conn):
    return collect_receipts(repository_on(conn))


def import_statement(conn, statement):
    return _service(conn).import_statement(statement)


def set_cap(conn, cents):
    return _service(conn).set_cap(cents)


def mark_daily(conn, ids, choice, pending_only=False, sync_staged=False):
    return _service(conn).mark_daily(ids, choice, pending_only, sync_staged)


def annotate(conn, trade_id, category, note="", rule="keep", include_over_cap=None):
    return _service(conn).annotate(trade_id, category, note, rule, include_over_cap)


def link_receipt(conn, receipt_id, expense_id):
    return _service(conn).link_receipt(receipt_id, expense_id)
