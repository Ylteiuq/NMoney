"""将两个平台不同的导出格式转换成同一种交易记录。"""

import csv
import io
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


from ..models.statement import Statement, Transaction


# XLSX 内的工作表以 XML 保存。只读取微信导出的第一张表和共享文本，
# 不需要处理公式、样式等通用表格功能。订单号始终保留原始文本。
NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _text(element):
    return "".join(node.text or "" for node in element.findall(".//x:t", NS))


def _wechat_rows(data):
    with ZipFile(io.BytesIO(data)) as book:
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            strings = [_text(item) for item in ET.fromstring(book.read("xl/sharedStrings.xml"))]
        sheet = ET.fromstring(book.read("xl/worksheets/sheet1.xml"))
        properties = ET.fromstring(book.read("xl/workbook.xml")).find("x:workbookPr", NS)
        uses_1904 = properties is not None and properties.get("date1904") in {"1", "true"}
    rows = []
    for row in sheet.findall(".//x:sheetData/x:row", NS):
        fields = []
        for cell in row.findall("x:c", NS):
            # Excel 可以省略中间的空格子。根据 A1 坐标补齐，后面的列才不会错位。
            letters = re.match(r"[A-Z]+", cell.attrib["r"]).group()
            column = 0
            for char in letters:
                column = column * 26 + ord(char) - ord("A") + 1
            fields.extend([""] * (column - len(fields) - 1))
            value = cell.findtext("x:v", "", NS)
            if cell.get("t") == "s":
                value = strings[int(value)]
            elif cell.get("t") == "inlineStr":
                value = _text(cell)
            fields.append(value)
        rows.append(fields)
    return rows, datetime(1904, 1, 1) if uses_1904 else datetime(1899, 12, 30)


def _alipay_rows(data):
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = data.decode("gb18030")
    return list(csv.reader(io.StringIO(content, newline="")))


# 映射顺序对应 Transaction 的字段。只保存记账需要的列，不保存对方账号。
COLUMNS = {
    "微信": ("交易单号", "交易时间", "交易对方", "商品", "交易类型", "收/支", "金额(元)", "当前状态"),
    "支付宝": ("交易订单号", "交易时间", "交易对方", "商品说明", "交易分类", "收/支", "金额", "交易状态"),
}
STAMP = re.compile(r"\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d")


def _trade_time(value, excel_epoch):
    if excel_epoch and re.fullmatch(r"\d+(\.\d+)?", value):
        seconds = round(Decimal(value) * 86400)
        return (excel_epoch + timedelta(seconds=seconds)).isoformat(sep=" ")
    return datetime.fromisoformat(value.replace("/", "-")).isoformat(sep=" ", timespec="seconds")


def parse_statement(filename, data):
    """找到真正的表头再读取。整份文件解析成功后，调用方才会开始写库。"""
    suffix = Path(filename).suffix.lower()
    if suffix not in {".xlsx", ".csv"}:
        raise ValueError("请解压账单后，选择微信 XLSX 或支付宝 CSV 文件。")
    platform = "微信" if suffix == ".xlsx" else "支付宝"
    try:
        rows, epoch = _wechat_rows(data) if platform == "微信" else (_alipay_rows(data), None)
    except (BadZipFile, KeyError, ET.ParseError, UnicodeError, csv.Error, IndexError) as exc:
        raise ValueError("无法读取文件，请使用支付平台导出的原始明细。") from exc

    exported_at = ""
    positions = None
    transactions = []
    for number, raw in enumerate(rows, 1):
        values = [str(value).strip() for value in raw]
        if positions is None:
            if values and values[0] == "交易时间":
                try:
                    positions = [values.index(name) for name in COLUMNS[platform]]
                except ValueError as exc:
                    raise ValueError(f"{platform}表头不完整，请使用包含订单号的交易明细。") from exc
            elif any("导出时间" in value for value in values):
                match = STAMP.search(" ".join(values))
                if match:
                    exported_at = match.group().replace("T", " ")
            continue
        if not any(values) or (values and values[0].startswith(("-", "="))):
            continue
        try:
            order, date, merchant, product, category, direction, amount, status = (
                values[index] for index in positions
            )
            if not order or order == "/":
                raise ValueError("缺少订单号")
            when = _trade_time(date, epoch)
            amount_text = amount.replace("¥", "").replace("￥", "").replace(",", "")
            cents = int(Decimal(amount_text) * 100)
            transactions.append(Transaction(platform, order, when, merchant, product, category, direction, cents, status))
        except (ValueError, IndexError, InvalidOperation) as exc:
            raise ValueError(f"第 {number} 行无法读取，请检查时间、金额和订单号。") from exc
    if positions is None:
        raise ValueError(f"没有找到{platform}交易明细的表头。")
    return Statement(platform, exported_at, transactions)
