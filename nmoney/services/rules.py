"""消费类别与统计口径。金额一律用分，显示时才转换为元。"""

from collections import defaultdict
from decimal import Decimal
import re


DAILY = ("餐饮", "校园消费", "日用", "交通")
SPENDING = DAILY + ("美团", "医疗", "会员订阅", "休闲", "人情", "其他消费")
LEGACY_CATEGORIES = {"咖啡": "餐饮", "数码": "休闲", "洗衣": "日用"}
EXCLUSIONS = ("借出", "代付待回款", "投资理财", "内部划转", "其他非消费")
CHOICES = ("未知",) + SPENDING + EXCLUSIONS

# 平台大类有时只是商户注册时填的，商品说明往往更具体。
KEYWORDS = (
    ("医疗", ("门诊", "挂号", "药房", "医院")),
    ("休闲", ("surface", "耳机", "触控笔", "键盘")),
    ("会员订阅", ("大会员", "订阅", "连续包月")),
    ("日用", ("洗衣机", "洗衣房")),
    ("校园消费", ("武汉大学-消费", "武汉大学离线方案-消费")),
    ("休闲", ("海伦司", "电影票")),
    ("餐饮", ("餐饮", "食堂", "烘焙", "鲜包", "包子", "烧肉", "卤味", "火锅", "小厨",
            "酸奶", "古茗", "奈雪", "煲珠公", "肉夹馍", "咖啡", "点餐")),
    ("日用", ("超市", "便利店", "综合商店")),
    ("人情", ("生日", "礼金")),
)
PLATFORM_CATEGORIES = {"餐饮美食": "餐饮", "日用百货": "日用", "交通出行": "交通", "医疗健康": "医疗"}


NON_DAILY = (set(SPENDING + EXCLUSIONS) - set(DAILY) - {"美团"}) | {"已退款"}


def daily_default(category):
    if category in DAILY:
        return "yes"
    if category in NON_DAILY:
        return "no"
    return None


def payment_state(tx):
    """先判定资金性质；退款入账与原支付的退款状态不能扣两次。"""
    kind, status = tx["source_category"], tx["status"]
    if tx["direction"] == "收入" and "退款" in kind + status:
        return "退款入账"
    if kind == "投资理财":
        return "投资理财"
    if "提现" in kind or tx["direction"] in {"/", "不计收支"}:
        return "内部划转" if "提现" in kind else "不计收支"
    if tx["direction"] == "收入":
        return "收入"
    if tx["direction"] != "支出":
        return "不计收支"
    if "全额退款" in status or status in {"已退款", "退款成功"}:
        return "已退款"
    if "部分退款" in status or "已退款" in status:
        if refunded_cents(status) is None:
            return "退款待核对"
    elif "退款" in status:
        return "退款待核对"
    if any(word in status for word in ("交易关闭", "已关闭", "已撤销", "支付失败", "待付款", "等待付款", "未支付")):
        return "未成交"
    return "支出"


def refunded_cents(status):
    match = re.search(r"(?:部分退款|已退款)[\s(（¥￥:：]*(\d+(?:\.\d{1,2})?)", status)
    return int(Decimal(match.group(1)) * 100) if match else None


def guess_category(tx):
    detail = (tx["product"] + " " + tx["merchant"]).lower()
    if "咖啡" in detail:
        return "餐饮"
    if tx["merchant"] == "美团" and tx["product"].startswith("团购-美团"):
        # 无商品名的团购单独展示；用户确认这类 4.61 元的团购是咖啡。
        return "餐饮" if tx["cents"] == 461 else "美团"
    for category, clues in KEYWORDS:
        if any(clue in detail for clue in clues):
            return category
    return PLATFORM_CATEGORIES.get(tx["source_category"], "美团" if tx["merchant"] == "美团" else "未知")


def is_group_receipt(tx):
    return (tx["source_category"] == "群收款" and payment_state(tx) == "收入"
            and not any(word in tx["status"] for word in ("待收", "失败", "退还", "关闭")))


def receipts_by_expense(links):
    """AA 分摊以有效到账为准，月份和平台不限制被抵扣的原单。"""
    by_expense = defaultdict(list)
    for row in links:
        if is_group_receipt(row):
            by_expense[row["expense_id"]].append(dict(row))
    return by_expense


def investment_product(tx):
    """只累计有买入动作的付款；赎回、分红与失败记录不增加投入。"""
    if tx["source_category"] != "投资理财" or tx["direction"] == "收入":
        return None
    if any(word in tx["status"] for word in ("失败", "关闭", "撤销", "退款", "待付款", "等待付款", "待支付", "未支付")):
        return None
    product = tx["product"].removeprefix("蚂蚁财富-")
    if any(word in product for word in ("赎回", "卖出", "分红", "转出", "退款")):
        return None
    for action in ("买入", "申购", "定投", "认购"):
        if action in product:
            return product.removesuffix("-" + action)
    return None


def after_refund(tx):
    return max(0, tx["cents"] - (refunded_cents(tx["status"]) or 0))


def is_outflow(tx):
    """平台支出按付款原额入账；不计收支的理财只有确认买入才是资金流出。"""
    if tx["direction"] != "支出":
        return bool(investment_product(tx))
    status = tx["status"]
    if "退款" in status:  # 退款流程发生在原付款之后。
        return True
    return not any(word in status for word in (
        "关闭", "撤销", "失败", "待付款", "等待付款", "待支付", "未支付", "未付款",
    ))


def evaluate(tx, cap, receipts=()):
    """AA 回款归到原付款日。个人实付先扣平台退款，再扣已关联的朋友回款。"""
    state = payment_state(tx)
    manual = LEGACY_CATEGORIES.get(tx["manual_category"], tx["manual_category"])
    merchant = LEGACY_CATEGORIES.get(tx["merchant_category"], tx["merchant_category"])
    # 单笔标注优先，再看商户规则和商品描述。模型只补仍然未知的用途。
    category = manual or merchant or guess_category(tx)
    if category == "未知" and not manual and not merchant and tx["initial_category"]:
        category = tx["initial_category"]
    received = sum(receipt["cents"] for receipt in receipts)
    net = tx["cents"]
    refund = 0
    if state == "支出":
        remaining = after_refund(tx)
        refund = tx["cents"] - remaining
        net = max(0, remaining - received)
    if state != "支出":
        bucket, category = "非消费", state
    elif category == "医疗":
        bucket = "医疗单列"
    elif category in EXCLUSIONS:
        bucket = "非消费"
    elif net > cap and not tx["include_over_cap"]:
        bucket = "超上限"
    elif category == "未知":
        bucket = "待分类"
    else:
        bucket = "已计入"
    outflow = is_outflow(tx)
    # 用途（如餐饮）和日常归属分别决定。pending 保留用户主动撤回选择的意图。
    initial = tx["initial_daily"]
    manual_daily = tx["daily_choice"] or ("pending" if initial == "pending" else None)
    # 规则也适用于旧流水。显式撤回为待确认优先于规则；用途更正后立即更新默认值。
    automatic = daily_default(category) or (initial if initial in ("yes", "no") else None)
    if tx["daily_source"] in ("peers", "conflict"):
        automatic = initial if initial in ("yes", "no") else None
    daily_choice = None if manual_daily == "pending" else tx["daily_choice"] or automatic
    if not outflow:
        daily_choice = None
    personal = net
    if state == "退款待核对":
        personal = None
        refund = None
    elif state == "已退款":
        personal = 0
        refund = tx["cents"]
    lock = None
    if outflow:
        if category in ("医疗", "借出", "投资理财"):
            lock = category + "单列"
        elif personal is not None and personal > cap:
            lock = "个人实付超过单笔上限"
        if lock:
            daily_choice = "no"
    return dict(tx, daily_lock=lock, daily_cents=personal if daily_choice == "yes" else 0, daily_category=category,
                manual_category=manual, merchant_category=merchant, category=category,
                bucket=bucket, net=net, editable=state == "支出",
                outflow=outflow, personal=personal if outflow else None,
                payment=outflow and category not in ("投资理财", "内部划转"), refund_cents=refund,
                manual_daily=manual_daily, daily_choice=daily_choice,
                daily=outflow and daily_choice == "yes", group_receipt=is_group_receipt(tx),
                receipts=receipts, received=received, fund=investment_product(tx))


def summarize(rows):
    groups = {key: {"count": 0, "cents": 0} for key in ("已计入", "日常生活", "待分类", "超上限")}
    categories = defaultdict(int)
    funds = defaultdict(lambda: {"count": 0, "cents": 0})
    months = defaultdict(lambda: {"cents": 0, "count": 0, "pending": 0, "invested": 0,
                                 "outflow": 0, "daily": 0, "paid": 0, "paid_unpriced": 0})
    payments = {"count": 0, "gross": 0, "cents": 0, "refunds": 0, "repaid": 0, "unpriced": 0, "unpriced_gross": 0}
    outflow = {"count": 0, "cents": 0, "pending": 0, "daily_unpriced": 0, "extra_invested": 0}
    known_over_cap = 0
    deducted_receipts = 0
    for row in rows:
        month = months[row["time"][:7]]
        if row["payment"]:
            payments["count"] += 1
            payments["gross"] += row["cents"]
            if row["personal"] is None:
                payments["unpriced"] += 1
                payments["unpriced_gross"] += row["cents"]
                month["paid_unpriced"] += 1
            else:
                # 先抵退款，再抵已关联回款。重导后退款增加时，两项合计至多抵完原付款。
                payments["refunds"] += row["refund_cents"]
                payments["repaid"] += row["cents"] - row["refund_cents"] - row["personal"]
                payments["cents"] += row["personal"]
                month["paid"] += row["personal"]
        if row["outflow"]:
            outflow["count"] += 1
            outflow["cents"] += row["cents"]
            month["outflow"] += row["cents"]
            if row["direction"] != "支出":
                outflow["extra_invested"] += row["cents"]
            if not row["daily_choice"]:
                outflow["pending"] += 1
            if row["daily"]:
                groups["日常生活"]["count"] += 1
                if row["personal"] is None:
                    outflow["daily_unpriced"] += 1
                else:
                    groups["日常生活"]["cents"] += row["daily_cents"]
                    month["daily"] += row["daily_cents"]
        if row["fund"]:
            fund = funds[row["fund"]]
            fund["count"] += 1
            fund["cents"] += row["cents"]
            month["invested"] += row["cents"]
        bucket = row["bucket"]
        if bucket == "超上限" and row["category"] in SPENDING:
            known_over_cap += row["net"]
        if bucket in ("已计入", "超上限") and row["category"] in SPENDING:
            # 重导后的退款可能变多，分摊按原单实际能抵扣的部分展示。
            deducted_receipts += min(after_refund(row), row["received"])
        if bucket in groups:
            groups[bucket]["count"] += 1
            groups[bucket]["cents"] += row["net"]
        if bucket == "待分类":
            month["pending"] += 1
        if bucket == "已计入":
            categories[row["category"]] += row["net"]
            month["count"] += 1
            month["cents"] += row["net"]
    return {"outflow": outflow, "payments": payments, "groups": groups, "known_over_cap": known_over_cap, "deducted_receipts": deducted_receipts,
            "known_spending": groups["已计入"]["cents"] + known_over_cap,
            "categories": sorted(categories.items(), key=lambda pair: -pair[1]),
            "funds": sorted(funds.items(), key=lambda pair: -pair[1]["cents"]),
            "invested": sum(item["cents"] for item in funds.values()),
            "months": sorted(months.items(), reverse=True)}
