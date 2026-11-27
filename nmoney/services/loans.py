"""借出与还款逐笔对应。回款按到账日恢复现金，结清差额归入原借出日的日常开支。"""

from .budget import income_status
from .rules import evaluate


def loan_accounts(repo, cap, aa_receipts):
    settled = repo.settled_loans()
    accounts = {}
    for tx in repo.trades("", "", "", loans_only=True):
        row = evaluate(tx, cap, aa_receipts.get(tx["id"], ()))
        if row["category"] != "借出" or row["personal"] is None:
            continue
        accounts[row["id"]] = dict(id=row["id"], merchant=row["merchant"], time=row["time"],
                                   principal=row["personal"], repaid=0, outstanding=row["personal"],
                                   closed=row["id"] in settled, daily_loss=0, repayments=[])
    for row in repo.loan_repayments():
        loan = accounts.get(row["loan_id"])
        if loan is None:
            continue
        # 新平台快照可能撤销一笔入账或减少原单实付，每次核账都以有效金额为限。
        credited = 0
        if income_status(row) == "settled":
            credited = min(row["allocated"], row["cents"], loan["outstanding"])
        loan["repaid"] += credited
        loan["outstanding"] -= credited
        loan["repayments"].append(dict(id=row["id"], time=row["time"], credited=credited, cents=row["cents"]))
    for loan in accounts.values():
        if loan["closed"]:
            loan["daily_loss"] = loan["outstanding"]
            loan["outstanding"] = 0
    return accounts
