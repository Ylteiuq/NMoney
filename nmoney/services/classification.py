"""初分服务。沿用相似支出模型，使用同一事务读取和保存分类。"""

from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import unicodedata

from .rules import DAILY, EXCLUSIONS, SPENDING
from .ledger import build_dashboard


NON_DAILY = (set(SPENDING + EXCLUSIONS) - set(DAILY) - {"美团"}) | {"已退款"}


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


def clustered_rows(rows):
    # 与浏览器使用同一模型。只把建模特征送给本机 Node 子进程。
    model = Path(__file__).resolve().parents[2] / "web" / "clustering.js"
    script = """const {clusterOutflows} = require(process.argv[1]);
      const rows = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(clusterOutflows(rows).map(g => g.map(r => r.id))));"""
    features = [{k: r[k] for k in ("id", "outflow", "merchant", "product", "cents")} for r in rows]
    by_id = {r["id"]: r for r in rows}
    result = subprocess.run(["node", "-e", script, str(model)], input=json.dumps(features),
                            capture_output=True, text=True, check=True)
    return [[by_id[i] for i in ids] for ids in json.loads(result.stdout)]


def classify(repo, start, end, apply=False):
    rows = [r for r in build_dashboard(repo, start, end)["rows"] if r["outflow"]]
    groups = clustered_rows(rows)
    manual = {r["id"]: r["manual_category"] for r in rows if r["editable"] and r["manual_category"]}
    # 推断新用途时，排除已有模型预测的交易，避免一个猜测在同组中被当成新的证据。
    anchors = {r["id"]: r["category"] for r in rows if not r["initial_category"] and r["category"] != "未知"}
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
            if row["manual_daily"] or row["initial_daily"]:
                continue
            if category in DAILY:
                choice = "yes"
            elif category in NON_DAILY:
                choice = "no"
            else:
                choice = None
            stats[choice or "uncertain"] += 1
            if apply and (choice or inferred):
                repo.set_initial_classification(i, choice, inferred)
    return dict(stats)
