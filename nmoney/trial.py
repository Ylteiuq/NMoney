"""按日期试分账单。运行 python3 -m nmoney.trial --help。"""

import argparse
from datetime import date
import json
from pathlib import Path

from .services.classification import classify
from .infrastructure.database import DEFAULT_DB, initialize, repository_on, repository_session


def first_pass(conn, start, end, apply=False):
    return classify(repository_on(conn, immediate=apply), start, end, apply)


def main():
    parser = argparse.ArgumentParser(description="按原用途和相似交易试分所选日期的支出")
    parser.add_argument("--start", type=date.fromisoformat, required=True)
    parser.add_argument("--end", type=date.fromisoformat, required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--apply", action="store_true", help="将初分写入账本")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("开始日期不能晚于结束日期")
    initialize(args.db)
    with repository_session(args.db, immediate=args.apply) as repo:
        result = classify(repo, args.start.isoformat(), args.end.isoformat(), args.apply)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
