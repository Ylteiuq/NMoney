const assert = require("node:assert/strict");
const { clusterOutflows } = require("../web/app.js");

function trade(id, merchant, product, cents, outflow = true) {
  return { id, merchant, product, cents, outflow };
}

const rows = [
  trade(1, "校内食堂", "午餐订单183746", 1200),
  trade(2, "校内食堂", "午餐订单856493", 1250),
  trade(3, "社区医院", "门诊挂号", 1200),
  trade(4, "", "/", 1200),
  trade(5, "", "/", 1200),
  trade(6, "校内食堂", "午餐订单734921", 1200, false),
];
const ids = list => clusterOutflows(list).map(group => group.map(row => row.id));
assert.deepEqual(ids(rows), [[1, 2], [3], [4], [5]]);
assert.deepEqual(ids([...rows].reverse()), ids(rows));
assert.deepEqual(ids(rows.map(row => ({...row, daily_choice: "yes", category: "医疗"}))), ids(rows));
assert.deepEqual(ids([]), []);
