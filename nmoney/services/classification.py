"""初分服务。沿用相似支出模型，使用同一事务读取和保存分类。"""

from collections import Counter
import re
import unicodedata

from .clustering import clustered_rows
from .rules import SPENDING, daily_default, evaluate, is_outflow, receipts_by_expense


def text_key(value):
    return re.sub(r"\d{4,}", "#", unicodedata.normalize("NFKC", value).strip().casefold())


def neighbor_category(target, group, labels):
    """隐去目标自身。先看同商户、同商品描述、同价位的订单，再看整组的一致性。"""
    peers = [r for r in group if r["id"] != target["id"] and labels.get(r["id"])]
    exact = [r for r in peers if r["merchant"] == target["merchant"] and r["cents"] == target["cents"]
             and text_key(r["product"]) == text_key(target["product"])]
    evidence = exact if len(exact) >= 2 and target["merchant"].strip(" /") else peers
    votes = {labels[r["id"]] for r in evidence}
    if len(evidence) >= 2 and len(votes) == 1:
        category = next(iter(votes))
        if category in SPENDING:
            return category
    return None


def preference_key(row):
    """同平台同商户、同类商品才共享人工偏好，过滤占位说明和无用途转账。"""
    merchant, product = text_key(row["merchant"]), text_key(row["product"])
    if (not merchant.strip(" /") or not product.strip(" /") or product in {"商品", "其他"}
            or any(k in row["source_category"] for k in ("转账", "红包", "群收款"))):
        return None
    # 没有具体商品名的美团团购仅允许同一价位共享人工选择。
    price = row["cents"] if merchant == "美团" and product.startswith("团购-美团") else None
    return row["platform"], merchant, product, price


def classify(repo, start, end, apply=False):
    cap = repo.cap()
    # 复算时从平台字段和人工标注重建用途，旧预测不能投票给新预测。
    rows = []
    existing = {}
    receipts = receipts_by_expense(repo.receipt_links())
    for tx in repo.trades(start, end, ""):
        if is_outflow(tx):
            existing[tx["id"]] = (tx["initial_daily"], tx["initial_category"], tx["daily_source"])
            rows.append(evaluate(dict(tx, initial_category=None), cap, receipts.get(tx["id"], ())))
    groups = clustered_rows(rows)
    manual = {r["id"]: r["manual_category"] for r in rows if r["editable"] and r["manual_category"]}
    # 只让单笔标注或用户保存的商户规则为未知用途投票。
    anchors = {r["id"]: r["category"] for r in rows if r["editable"] and r["category"] in SPENDING
               and (r["manual_category"] or r["merchant_category"])}
    preferences = {}
    for row in rows:
        key = preference_key(row)
        if key and row["manual_daily"] in ("yes", "no") and not row["daily_lock"]:
            preferences.setdefault(key, Counter())[row["manual_daily"]] += 1
    stats = Counter(manual_labels=len(manual), outflows=len(rows), clusters=sum(len(g) > 1 for g in groups))
    for group in groups:
        for row in group:
            i = row["id"]
            if i in manual:
                predicted = neighbor_category(row, group, manual)
                if predicted:
                    stats["predicted_on_holdout"] += 1
                    stats["correct_on_holdout"] += predicted == manual[i]
            category = row["category"]
            inferred = None
            if (category == "未知" and not row["manual_category"] and not row["merchant_category"]
                    and not any(k in row["source_category"] for k in ("转账", "红包", "群收款"))):
                inferred = neighbor_category(row, group, anchors)
                category = inferred or category
            prior_daily, prior_category, prior_source = existing[i]
            choice = daily_default(category)
            votes = preferences.get(preference_key(row), {})
            source = None
            if row["daily_lock"]:
                choice = "no"
            elif len(votes) > 1:
                choice, source = None, "conflict"
            elif sum(votes.values()) >= 2:
                choice, source = next(iter(votes)), "peers"
            if not row["manual_daily"]:
                stats[choice or "uncertain"] += 1
            if prior_daily == "pending":
                choice = "pending"
            if apply and (choice, inferred, source) != (prior_daily, prior_category, prior_source):
                repo.set_initial_classification(i, choice, inferred, source)
    return dict(stats)
