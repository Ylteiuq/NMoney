"""按自然月、全部平台核算可支配额度。金额均为整数分。"""

from datetime import date

from .rules import payment_state


def validate_month(month):
    try:
        first = date.fromisoformat(month + "-01")
    except (TypeError, ValueError):
        raise ValueError("请选择有效月份。") from None
    if first.isoformat()[:7] != month:
        raise ValueError("请选择有效月份。")


def income_status(row):
    """退款、群收款、提现和理财已有各自口径。未完成的交易只供查看。"""
    if payment_state(row) != "收入" or row["source_category"] == "群收款":
        return None
    status = row["status"]
    if any(word in status for word in ("关闭", "撤销", "失败", "退还", "退回", "退款")):
        return None
    if "等待" in status or status.startswith("待"):
        return "waiting"
    if any(word in status for word in ("已存入", "已到账", "收款成功", "交易成功", "已收钱", "已收款", "交易完成")):
        return "settled"
    return "waiting"


def default_income_kind(row, supplements):
    description = " ".join(row[k] for k in ("merchant", "product", "source_category"))
    if "生活费" in description:
        return "base"
    if any(k in description for k in ("闲鱼", "二手交易", "劳务费", "工资")):
        # 同金额的银行卡补记可能就是这笔转入，交由用户核对，避免双计。
        if any(s["cents"] == row["cents"] and s["trade_id"] is None for s in supplements):
            return "pending"
        return "extra"
    return "pending"


def budget_report(repo, month, rows, loans):
    base = repo.allowance(month)
    base = 200000 if base is None else base
    supplements = repo.supplements(month)
    manual = sum(s["cents"] for s in supplements)
    extra = 0
    incomes = []
    spent = lent = returned = unpriced = medical = loan_loss = 0
    for row in rows:
        if row["payment"]:
            if row["category"] == "医疗":
                medical += row["personal"] or 0
            elif row["personal"] is None:
                unpriced += 1
            else:
                spent += row["personal"]
                if row["category"] == "借出":
                    lent += row["personal"]
                    loan_loss += row["daily_cents"] or 0
        status = row["income_status"]
        if not status:
            continue
        kind = row["income_choice"] or default_income_kind(row, supplements)
        if status == "settled" and kind == "extra":
            extra += row["cents"]
        if status == "settled" and kind == "repayment":
            # 旧账本可能只有“还款”标记，没有本金关联，继续沿用其原到账金额。
            returned += row["repayment_cents"] if row["repayment_loan"] else row["cents"]
        incomes.append({k: row[k] for k in ("id", "time", "platform", "merchant", "product", "order_id", "cents", "supplement_id", "repayment_loan", "repayment_cents")} |
                       {"kind": kind, "choice": row["income_choice"] or "auto", "status": status})
    total = base + manual + extra
    lending = repo.budget_lending()
    # 默认采用生活费口径。借款本金挂账，只有确认放弃收回的差额占用预算。
    lending = 0 if lending is None else lending
    cash_left = total + returned - spent
    spending_left = total - spent + lent - loan_loss
    remaining = cash_left if lending else spending_left
    visible_loans = [loan for loan in loans.values() if loan["time"][:7] <= month and
                     (not loan["closed"] or loan["time"][:7] == month or
                      any(r["time"][:7] == month for r in loan["repayments"]))]
    return dict(medical=medical, loan_loss=loan_loss, loans=visible_loans, month=month, base=base, manual=manual, extra=extra, total=total, spent=spent, lent=lent, returned=returned, lending=lending,
                remaining=remaining, cash_left=cash_left, spending_left=spending_left, unpriced=unpriced, incomes=incomes, supplements=supplements)
