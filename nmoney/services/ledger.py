"""账本用例。每个用例在一个 repository session 内完成。"""

from calendar import monthrange
from dataclasses import asdict
from datetime import datetime

from .budget import budget_report, income_status, validate_month
from .classification import classify
from .clustering import clustered_rows
from .loans import loan_accounts

from .rules import (
    CHOICES, LEGACY_CATEGORIES, SPENDING, after_refund, evaluate, is_group_receipt,
    payment_state, receipts_by_expense, summarize,
)


def linked_receipts(repo):
    """先取所有日期的有效回款，再筛原支出，保留跨月、跨平台分摊。"""
    return receipts_by_expense(repo.receipt_links())


def build_dashboard(repo, start="", end="", platform="", loans=None):
    cap = repo.cap()
    receipts = linked_receipts(repo)
    if loans is None:
        loans = loan_accounts(repo, cap, receipts)
    repayments = {r["id"]: (loan["id"], r["credited"]) for loan in loans.values() for r in loan["repayments"]}
    rows = [evaluate(row, cap, receipts.get(row["id"], [])) for row in repo.trades(start, end, platform)]
    for row in rows:
        row["income_status"] = income_status(row)
        row["repayment_loan"], row["repayment_cents"] = repayments.get(row["id"], (row["linked_loan_id"], 0))
        loan = loans.get(row["id"])
        if loan:
            row["loan"] = loan
            if loan["daily_loss"]:
                row.update(daily=True, daily_choice="yes", daily_cents=loan["daily_loss"],
                           daily_category="借款结清差额", daily_lock="手动结清，仅差额计日常")
    return dict(cap=cap, rows=rows, choices=CHOICES, available_months=repo.available_months(), **summarize(rows))


class LedgerService:
    """session 提供一次用例共用的 Repository，immediate=True 表示在读取前取得写锁。"""

    def __init__(self, session):
        self.session = session

    def database_file(self):
        with self.session() as repo:
            return repo.database_file()

    def dashboard(self, start="", end="", platform="", budget_month=""):
        with self.session() as repo:
            loans = loan_accounts(repo, repo.cap(), linked_receipts(repo))
            data = build_dashboard(repo, start, end, platform, loans)
            if budget_month:
                validate_month(budget_month)
                year, month = map(int, budget_month.split("-"))
                first, last = budget_month + "-01", f"{budget_month}-{monthrange(year, month)[1]}"
                rows = data["rows"] if (start, end, platform) == (first, last, "") else build_dashboard(repo, first, last, loans=loans)["rows"]
                data["budget"] = budget_report(repo, budget_month, rows, loans)
            data["clusters"] = [[r["id"] for r in group] for group in clustered_rows(data["rows"])]
            return data

    def set_allowance(self, month, cents):
        validate_month(month)
        if type(cents) is not int or cents < 0:
            raise ValueError("生活费须为非负金额。")
        with self.session() as repo:
            repo.set_allowance(month, cents)

    def set_budget_lending(self, value):
        if type(value) is not int or value not in (0, 1):
            raise ValueError("请选择借出是否占用可用额度。")
        with self.session() as repo:
            repo.set_budget_lending(value)

    def supplement(self, month, key, label, cents):
        validate_month(month)
        if not isinstance(key, str) or not key.strip():
            raise ValueError("缺少补记编号。")
        with self.session(immediate=True) as repo:
            if cents is None:
                repo.remove_supplement(key, month)
            else:
                if type(cents) is not int or cents <= 0 or not isinstance(label, str) or not label.strip():
                    raise ValueError("请填写收入来源和正金额。")
                repo.add_supplement(key, month, label.strip(), cents)

    def classify_income(self, trade_id, kind, supplement_id=None, loan_id=None):
        with self.session(immediate=True) as repo:
            row = repo.trade(trade_id)
            if row is None or not income_status(row) or kind not in ("auto", "base", "extra", "ignore", "matched", "repayment"):
                raise ValueError("请选择有效的收入流水和归属。")
            accounts = loan_accounts(repo, repo.cap(), linked_receipts(repo))
            previous = next((loan for loan in accounts.values()
                             if any(r["id"] == trade_id for r in loan["repayments"])), None)
            if previous and previous["id"] == loan_id and kind == "repayment":
                return
            if previous and previous["closed"]:
                raise ValueError("请先重新打开借款，再修改已核对的回款。")
            repo.unlink_loan(trade_id)
            if loan_id is not None:
                if type(loan_id) is not int:
                    raise ValueError("请选择有效的借出流水。")
                loan = accounts.get(loan_id)
                if (kind != "repayment" or income_status(row) != "settled" or not loan or loan["closed"]
                        or not loan["outstanding"] or row["time"] < loan["time"]):
                    raise ValueError("请选择到账前已经借出、尚有待还本金的借款。")
                repo.link_loan(trade_id, loan_id, min(row["cents"], loan["outstanding"]))
                original = repo.trade(loan_id)
                if not original["manual_category"]:
                    repo.annotate(loan_id, "借出", original["note"])
            if kind == "matched":
                entries = repo.supplements(row["time"][:7])
                if not any(s["id"] == supplement_id and s["cents"] == row["cents"]
                           and s["trade_id"] in (None, trade_id) for s in entries):
                    raise ValueError("请选择本月尚未匹配的同金额补记。")
            repo.set_income_choice(trade_id, kind, supplement_id if kind == "matched" else None)

    def settle_loan(self, loan_id, closed):
        if type(closed) is not bool:
            raise ValueError("请选择结清或重新打开。")
        with self.session(immediate=True) as repo:
            accounts = loan_accounts(repo, repo.cap(), linked_receipts(repo))
            if loan_id not in accounts:
                raise ValueError("请选择一笔借出。")
            row = repo.trade(loan_id)
            if closed and not row["manual_category"]:
                repo.annotate(loan_id, "借出", row["note"])
            repo.settle_loan(loan_id, closed)

    def import_statement(self, statement):
        counts = {"added": 0, "changed": 0, "skipped": 0}
        with self.session(immediate=True) as repo:
            for trade in statement.transactions:
                old = repo.order(trade.platform, trade.order_id)
                raw = asdict(trade)
                if old is None:
                    repo.insert_trade(dict(raw, exported_at=statement.exported_at))
                    counts["added"] += 1
                elif statement.exported_at <= old["exported_at"]:
                    counts["skipped"] += 1
                else:
                    # 即使字段不变，也保存较新的导出时间，防止回退到旧快照。
                    changed = any(old[name] != value for name, value in raw.items())
                    repo.update_snapshot(dict(raw, exported_at=statement.exported_at))
                    counts["changed" if changed else "skipped"] += 1
            if counts["added"] or counts["changed"]:
                classify(repo, "", "", apply=True)
        return counts

    def set_cap(self, cents):
        if type(cents) is not int or cents < 0:
            raise ValueError("上限必须是非负金额。")
        with self.session() as repo:
            repo.set_cap(cents)
            classify(repo, "", "", apply=True)

    def mark_daily(self, ids, choice, pending_only=False, sync_staged=False):
        if (choice not in ("yes", "no", None) or type(pending_only) is not bool
                or type(sync_staged) is not bool or (sync_staged and not pending_only)):
            raise ValueError("请选择计入日常、非日常或待确认。")
        if not isinstance(ids, list) or not ids or any(type(i) is not int for i in ids):
            raise ValueError("请选择支出流水。")
        changed = 0
        with self.session(immediate=True) as repo:
            rows = {r["id"]: r for r in build_dashboard(repo)["rows"]}
            for trade_id in set(ids):
                tx = rows.get(trade_id)
                if tx is None or not tx["outflow"]:
                    raise ValueError("只能标记实际支出的流水。")
                if tx["daily_lock"] and not sync_staged:
                    if pending_only or choice == tx["daily_choice"]:
                        continue
                    raise ValueError(tx["daily_lock"] + "，当前规则不允许更改日常归属。")
                if pending_only and not sync_staged and tx["daily_choice"]:
                    continue
                if sync_staged and tx["initial_daily"] == "pending" and choice is not None:
                    continue
                if choice is None:
                    if pending_only and repo.has_daily_choice(trade_id):
                        continue
                    changed += repo.reset_daily_choice(trade_id)
                elif pending_only:
                    changed += repo.insert_daily_choice(trade_id, choice)
                else:
                    changed += repo.upsert_daily_choice(trade_id, choice)
            if changed:
                classify(repo, "", "", apply=True)
        return changed

    def annotate(self, trade_id, category, note="", rule="keep", include_over_cap=None):
        with self.session() as repo:
            row = repo.trade(trade_id)
            if row is None or payment_state(row) != "支出":
                raise ValueError("只有付款记录可以补用途。")
            if isinstance(category, str):
                category = LEGACY_CATEGORIES.get(category, category)
            if category not in CHOICES:
                raise ValueError("请选择列表中的用途。")
            if row["manual_category"] == "借出" and category != "借出":
                loan = loan_accounts(repo, repo.cap(), linked_receipts(repo)).get(trade_id)
                if loan and (loan["closed"] or loan["repayments"]):
                    raise ValueError("请先重新打开借款并解除还款关联，再修改用途。")
            repo.annotate(trade_id, category, note.strip())
            if include_over_cap is not None:
                if include_over_cap and (category not in SPENDING or category == "医疗"):
                    raise ValueError("请先选择一项消费用途，再手动计入。")
                if include_over_cap:
                    repo.include_over_cap(trade_id)
                else:
                    repo.remove_exception(trade_id)
            if rule == "remove":
                repo.remove_merchant_rule(row["platform"], row["merchant"])
            elif rule == "set" and row["merchant"] not in {"", "/"}:
                repo.set_merchant_rule(row["platform"], row["merchant"], category)
            classify(repo, "", "", apply=True)

    def link_receipt(self, receipt_id, expense_id):
        with self.session(immediate=True) as repo:
            receipt = repo.trade(receipt_id)
            if not receipt or not is_group_receipt(receipt):
                raise ValueError("请选择已到账的群收款。")
            if expense_id is None:
                repo.unlink_receipt(receipt_id)
                classify(repo, "", "", apply=True)
                return
            expense = repo.trade(expense_id)
            if not expense or payment_state(expense) != "支出":
                raise ValueError("请选择一笔已付款的支出。")
            others = linked_receipts(repo).get(expense_id, ())
            # 重新关联时，这笔回款可能已指向该原单，校验总额时只算它一次。
            used = sum(r["cents"] for r in others if r["id"] != receipt_id)
            if used + receipt["cents"] > after_refund(expense):
                raise ValueError("累计回款将超过这笔付款的金额，请核对原付款。")
            repo.link_receipt(receipt_id, expense_id)
            classify(repo, "", "", apply=True)

    def receipt_options(self, receipt_id):
        rows = self.dashboard()["rows"]
        target = next((r for r in rows if r["id"] == receipt_id and r["group_receipt"]), None)
        if not target:
            raise ValueError("找不到这笔群收款。")
        candidates = [r for r in rows if r["editable"]]
        when = datetime.fromisoformat(target["time"])
        candidates.sort(key=lambda r: abs((datetime.fromisoformat(r["time"]) - when).total_seconds()))
        fields = ("id", "time", "platform", "merchant", "product", "cents")
        return [{key: r[key] for key in fields} for r in candidates]
