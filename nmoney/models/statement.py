"""从平台文件中读取的原始流水与账单快照。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Transaction:
    """平台文件中的一条流水，金额以整数分表示。平台和订单号共同标识原单。"""

    platform: str
    order_id: str
    time: str
    merchant: str
    product: str
    source_category: str
    direction: str
    cents: int
    status: str


@dataclass(frozen=True)
class Statement:
    """一次导出的完整账单，exported_at 是这批流水共享的快照时间。"""

    platform: str
    exported_at: str
    transactions: list[Transaction]
