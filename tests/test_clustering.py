"""Python 后端的文本聚类不依赖输入顺序、用途或已有日常标记。"""

import unittest
from nmoney.services.clustering import clustered_rows


class ClusteringTest(unittest.TestCase):
    def test_groups(self):
        def row(i, merchant, product, cents=1200, outflow=True):
            return dict(id=i, merchant=merchant, product=product, cents=cents, outflow=outflow)
        rows = [row(1,"校内食堂","午餐订单183746"), row(2,"校内食堂","午餐订单856493",1250),
                row(3,"社区医院","门诊挂号"), row(4,"","/"), row(5,"","/"),
                row(6,"校内食堂","午餐订单734921",outflow=False)]
        for source in (rows, reversed(rows), [dict(r, daily_choice="yes", category="医疗") for r in rows]):
            self.assertEqual([[r["id"] for r in g] for g in clustered_rows(source)], [[1,2],[3],[4],[5]])
        self.assertEqual(clustered_rows([]), [])
