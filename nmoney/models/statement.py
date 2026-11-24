"""从平台文件中读取的原始流水与账单快照。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Transaction:
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
    platform: str
    exported_at: str
    transactions: list[Transaction]
