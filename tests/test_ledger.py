"""使用虚构账单覆盖真实入口。直接运行 python3 -m unittest discover -s tests。"""

import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from wsgiref.util import setup_testing_defaults
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from app import application
from nmoney.ledger import database, import_statement, initialize
from nmoney.statements import Statement, Transaction


def alipay(orders, exported="2026-11-23 06:00:00"):
    header = ("交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支",
              "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号")
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["支付宝交易明细"])
    writer.writerow(["导出时间：[" + exported + "]"])
    writer.writerow(header)
    for order, category, price, status in orders:
        writer.writerow(["2026-11-08 12:30:00", category, "甲商户", "", "商品", "支出",
                         price, "余额", status, order + "\t", ""])
    return buffer.getvalue().encode("gb18030")


def wechat(order):
    # 模拟 Excel 的共享文本、缺省单元格、序列日期和长文本订单号。
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    sheet = ET.Element("worksheet", xmlns=ns)
    content = ET.SubElement(sheet, "sheetData")
    strings = ET.Element("sst", xmlns=ns)
    header = ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号"]
    values = ["46334.5", "商户消费", "便利店", "日用品", "支出", "9.00", "", "支付成功", order]
    for num, items in enumerate((["导出时间：[2026-11-23 07:00:00]"], header, values), 1):
        row = ET.SubElement(content, "row")
        for col, value in enumerate(items):
            if value == "":
                continue
            cell = ET.SubElement(row, "c", r=chr(65 + col) + str(num))
            if num != 3 or col not in (0, 5):
                cell.set("t", "s")
                ET.SubElement(ET.SubElement(strings, "si"), "t").text = value
                value = str(len(strings) - 1)
            ET.SubElement(cell, "v").text = value
    data = io.BytesIO()
    with ZipFile(data, "w") as book:
        book.writestr("xl/worksheets/sheet1.xml", ET.tostring(sheet))
        book.writestr("xl/sharedStrings.xml", ET.tostring(strings))
        book.writestr("xl/workbook.xml", '<workbook xmlns="' + ns + '"/>')
    return data.getvalue()


class LedgerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "ledger.db"
        initialize(self.path)
        self.app = application(self.path)

    def fetch(self, path, body=None, query=None, status="200 OK"):
        env = {}
        setup_testing_defaults(env)
        env.update(PATH_INFO=path, QUERY_STRING=urlencode(query or {}))
        if body is not None:
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            env.update(REQUEST_METHOD="POST", HTTP_X_NMONEY="1", CONTENT_LENGTH=str(len(body)))
            env["wsgi.input"] = io.BytesIO(body)
        response = []
        raw = b"".join(self.app(env, lambda code, headers: response.append(code)))
        self.assertEqual(response, [status], raw[:500])
        return json.loads(raw) if path.startswith("/api/") else raw

    def upload(self, name, data, status="200 OK"):
        return self.fetch("/api/import", data, {"filename": name}, status)

    def mark(self, row, category, rule="keep"):
        self.fetch("/api/annotate", {"id": row["id"], "category": category, "note": "手工备注", "rule": rule})

    def test_overlap_snapshot_and_refund(self):
        order = "202611080000000000000001"
        original = [(order, "餐饮美食", "20.00", "交易成功"),
                    ("second", "餐饮美食", "20.00", "交易成功")]
        first = alipay(original, "2026-11-09 00:00:00")
        self.assertEqual(self.upload("支付宝.csv", first)["added"], 2)
        self.assertEqual(self.upload("微信.xlsx", wechat(order))["added"], 1)
        self.assertEqual(self.upload("微信.xlsx", wechat(order))["skipped"], 1)
        current = self.fetch("/api/ledger")
        self.assertEqual(current["groups"]["已计入"], {"count": 3, "cents": 4900})
        self.assertEqual(next(r["time"] for r in current["rows"] if r["platform"] == "微信"), "2026-11-08 12:00:00")
        self.mark(next(r for r in current["rows"] if r["order_id"] == order and r["platform"] == "支付宝"), "休闲")
        latest = alipay([(order, "餐饮美食", "20.00", "已全额退款")])
        self.assertEqual(self.upload("支付宝.csv", latest)["changed"], 1)
        self.assertEqual(self.upload("支付宝.csv", first)["skipped"], 2)
        self.app = application(self.path)  # 重开同一个数据库
        current = self.fetch("/api/ledger")
        self.assertEqual(current["groups"]["已计入"]["cents"], 2900)
        refunded = next(r for r in current["rows"] if r["category"] == "已退款")
        self.assertEqual((refunded["note"], refunded["manual_category"]), ("手工备注", "休闲"))
        self.assertEqual(self.fetch("/api/ledger", query={"start":"2026-11-09"})["rows"], [])

    def test_cap_manual_and_merchant_rule(self):
        self.upload("支付宝.csv", alipay([("a", "其他", "100.00", "交易成功"), ("b", "其他", "100.01", "交易成功"),
                                         ("c", "其他", "7.00", "交易成功")]))
        initial = self.fetch("/api/ledger")
        self.assertEqual(initial["groups"]["待分类"], {"count": 2, "cents": 10700})
        a, b, c = sorted(initial["rows"], key=lambda r: r["order_id"])
        self.mark(a, "日用", "set")
        self.mark(c, "借出")
        self.fetch("/api/cap", {"cents": 10001})
        state = self.fetch("/api/ledger")
        self.assertEqual(state["groups"]["已计入"], {"count": 2, "cents": 20001})
        self.mark(a, "日用", "remove")
        state = self.fetch("/api/ledger", query={"platform":"支付宝", "end":"2026-11-08"})
        self.assertEqual(state["groups"]["已计入"], {"count": 1, "cents": 10000})
        self.assertEqual(state["groups"]["待分类"]["count"], 1)
        self.assertEqual(self.fetch("/api/ledger", query={"platform":"微信"})["rows"], [])

    def test_partial_refund_and_invalid_file(self):
        good = alipay([("a", "餐饮美食", "20.00", "已退款(￥3.25)"),
                       ("b", "餐饮美食", "11.00", "部分退款"), ("c", "餐饮美食", "11.00", "交易关闭")])
        self.upload("支付宝.csv", good)
        state = self.fetch("/api/ledger")
        self.assertEqual(state["groups"]["已计入"], {"count": 1, "cents": 1675})
        self.assertEqual({r["category"] for r in state["rows"]}, {"餐饮", "退款待核对", "未成交"})
        bad = alipay([("new", "餐饮美食", "2.00", "交易成功"), ("", "餐饮美食", "4.00", "交易成功")])
        self.upload("不完整.csv", bad, "400 Bad Request")
        self.assertEqual(len(self.fetch("/api/ledger")["rows"]), 3)
        self.assertIn(b"NMoney", self.fetch("/"))
        for path in ("/style.css", "/app.js", "/favicon.svg"):
            self.assertTrue(self.fetch(path))

    def add_trades(self, *trades):
        with database(self.path) as conn:
            for trade in trades:
                import_statement(conn, Statement(trade.platform, "2026-12-03 14:00:00", [trade]))
            return {r["order_id"]: r["id"] for r in conn.execute("SELECT id, order_id FROM trades")}

    def test_cross_month_aa_and_over_cap_exception(self):
        payment = Transaction("支付宝", "meal", "2026-11-30 18:00:00", "小厨", "聚餐", "餐饮美食", "支出", 11200, "交易成功")
        other = Transaction("微信", "other", "2026-11-29 12:00:00", "小厨", "聚餐", "商户消费", "支出", 22000, "支付成功")
        receipts = [Transaction("微信", order, "2026-12-01 08:00:00", order, "/", "群收款", "收入", 3734, "已存入零钱")
                    for order in ("A", "B", "C")]
        ids = self.add_trades(payment, other, *receipts)
        november = {"start":"2026-11-01", "end":"2026-11-30", "platform":"支付宝"}
        for friend in ("A", "B", "A"):
            self.fetch("/api/aa", {"receipt_id": ids[friend], "expense_id": ids["meal"]})
        month = self.fetch("/api/ledger", query=november)
        self.assertEqual(month["groups"]["已计入"], {"count": 1, "cents": 3732})
        self.assertEqual(month["groups"]["日常生活"]["cents"], 3732)
        self.assertEqual((month["known_spending"], month["deducted_receipts"]), (3732, 7468))
        self.assertEqual(len(month["rows"][0]["receipts"]), 2)
        self.fetch("/api/aa", {"receipt_id": ids["C"], "expense_id": ids["meal"]}, status="400 Bad Request")
        candidates = self.fetch("/api/aa-options", query={"receipt_id":ids["A"]})
        self.assertEqual(candidates[0]["id"], ids["meal"])
        self.fetch("/api/aa", {"receipt_id": ids["B"], "expense_id": ids["other"]})
        self.fetch("/api/aa", {"receipt_id": ids["A"], "expense_id": None})
        before_override = self.fetch("/api/ledger", query=november)
        self.assertEqual(before_override["known_over_cap"], 11200)
        self.assertEqual(before_override["deducted_receipts"], 0)
        annotation = {"id": ids["meal"], "category":"餐饮", "rule":"keep", "note":"聚餐", "include_over_cap":True}
        self.fetch("/api/annotate", annotation)
        self.add_trades(payment)
        included = self.fetch("/api/ledger", query=november)
        self.assertEqual(included["groups"]["已计入"]["cents"], 11200)
        self.assertEqual(included["known_spending"], before_override["known_spending"])
        self.assertEqual(included["known_over_cap"], 0)
        self.fetch("/api/annotate", dict(annotation, include_over_cap=False))
        self.assertEqual(self.fetch("/api/ledger", query=november)["groups"]["已计入"]["count"],0)

    def test_funds_and_meituan(self):
        def fund(order, product, status="交易成功"):
            return Transaction("支付宝", order, "2026-11-01 12:00:00", "蚂蚁财富", product, "投资理财",
                               "不计收支", 10000, status)
        def groupbuy(order, cents, product="团购-美团App-订单"):
            return Transaction("微信", order, "2026-11-01 09:00:00", "美团", product, "商户消费", "支出", cents, "支付成功")
        self.add_trades(fund("f1","甲基金-买入"), fund("f2","甲基金-买入","付款成功，基金份额确认中"),
                        fund("f3","甲基金-赎回"), fund("f4","甲基金-买入","交易关闭"), fund("f5","甲基金-买入","未支付"),
                        groupbuy("m1",461), groupbuy("m2",485), groupbuy("m3",461,"火锅买单"))
        data = self.fetch("/api/ledger")
        self.assertEqual(data["funds"], [["甲基金", {"count":2, "cents":20000}]])
        self.assertEqual(data["months"][0][1]["invested"],data["invested"])
        self.assertEqual(dict(data["categories"]), {"咖啡":461,"美团":485,"餐饮":461})
        self.assertEqual(data["groups"]["日常生活"]["cents"],922)
        self.assertEqual(data["groups"]["已计入"]["cents"],1407)
        self.assertEqual(data["known_spending"],1407)

    def test_known_spending_excludes_unknown_over_cap_and_loans(self):
        self.upload("支付宝.csv", alipay([("meal", "餐饮美食", "135.00", "交易成功"),
                                         ("unknown", "其他", "200.00", "交易成功"),
                                         ("loan", "其他", "500.00", "交易成功")]))
        rows = self.fetch("/api/ledger")["rows"]
        self.mark(next(r for r in rows if r["order_id"] == "loan"), "借出")
        state = self.fetch("/api/ledger")
        self.assertEqual(state["groups"]["超上限"]["cents"], 33500)
        self.assertEqual((state["known_spending"], state["known_over_cap"]), (13500, 13500))
