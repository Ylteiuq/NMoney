// 页面只负责交互和展示。统计数字统一由 Python 根据 SQLite 账本计算。
"use strict";
const $ = (id) => document.getElementById(id);
const money = (cents) => "¥" + (cents / 100).toLocaleString("zh-CN", {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
const state = { ledger: null, page: "overview", editId: null, listPage: 1, request: 0, drill: null,
  receiptId: null, category: "", merchant: null };
const pageSize = 40;

// 字符二元组适合没有空格的中文商品名，订单流水号不参与相似度。
function clusterOutflows(rows) {
  const documents = [];
  const frequency = new Map();
  const terms = value => {
    const words = String(value || "").normalize("NFKC").toLowerCase().replace(/\d{4,}/g, " ")
      .match(/[\p{L}\d]+/gu) || [];
    const grams = new Set();
    for (const w of words) {
      if (w.length === 1) grams.add(w);
      for (let i = 1; i < w.length; i++) grams.add(w.slice(i - 1, i + 1));
    }
    return [...grams];
  };
  for (const row of rows.filter(r => r.outflow).sort((a, b) => a.id - b.id)) {
    const text = new Map();
    for (const [prefix, value, weight] of [["商", row.merchant, 1], ["品", row.product, 1.25]]) {
      const grams = terms(value);
      for (const g of grams) text.set(prefix + g, weight / Math.sqrt(grams.length));
    }
    for (const key of text.keys()) frequency.set(key, (frequency.get(key) || 0) + 1);
    documents.push({row, text});
  }
  const clusters = [];
  const index = new Map();
  for (const {row, text} of documents) {
    const vector = new Map();
    for (const [key, tf] of text) {
      const idf = 1 + Math.log((1 + documents.length) / (1 + frequency.get(key)));
      vector.set(key, tf * idf);
    }
    // 对数金额让相近价位平滑过渡。只有共享商户或商品文本的交易才互为候选。
    const price = Math.log2(1 + row.cents / 100);
    const band = Math.floor(price);
    vector.set("价" + band, 1 - (price - band));
    vector.set("价" + (band + 1), price - band);
    const norm = Math.hypot(...vector.values());
    for (const [key, value] of vector) vector.set(key, value / norm);
    const candidates = new Set();
    for (const key of text.keys()) for (const c of index.get(key) || []) candidates.add(c);
    let best = null;
    let bestScore = 0.68;
    let bestDot = 0;
    for (const c of candidates) {
      let dot = 0;
      for (const [key, value] of vector) dot += value * (c.sum.get(key) || 0);
      const cosine = dot / Math.sqrt(c.squaredNorm);
      if (cosine < bestScore) continue;
      best = c;
      bestScore = cosine;
      bestDot = dot;
    }
    if (!best) {
      best = {rows: [], sum: new Map(), squaredNorm: 0};
      clusters.push(best);
    }
    best.rows.push(row);
    best.squaredNorm += 1 + 2 * bestDot;
    for (const [key, value] of vector) best.sum.set(key, (best.sum.get(key) || 0) + value);
    for (const key of text.keys()) {
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(best);
    }
  }
  return clusters.map(c => c.rows).sort((a, b) => b.length - a.length || a[0].id - b[0].id);
}

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  $("notice").classList.toggle("error", error);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取失败，请重试。");
  return data;
}

function post(url, payload) {
  return request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-NMoney": "1" },
    body: JSON.stringify(payload) });
}

// 老服务仍在运行时先把新标记留在当前浏览器。按平台和订单号衔接重启后的数据库。
const dailyKey = row => JSON.stringify([row.platform, row.order_id]);
const initialDaily = row => ["yes", "no"].includes(row.initial_daily) ? row.initial_daily : null;
let storeName;
async function choiceStore() {
  if (!storeName) {
    const ping = await request("/api/ping");
    storeName = "NMoney.daily.v1:" + ping.database;
  }
  return storeName;
}

function stagedChoices(key) {
  return new Map(JSON.parse(localStorage.getItem(key) || "[]"));
}

async function saveDaily(payload) {
  if (!state.ledger.legacy_daily) return post("/api/daily", payload);
  const key = await choiceStore();
  return navigator.locks.request(key, () => {
    const staged = stagedChoices(key);
    let changed = 0;
    const ids = new Set(payload.ids);
    for (const row of state.ledger.rows) {
      if (!ids.has(row.id) || !row.outflow) continue;
      const identity = dailyKey(row);
      const previous = staged.has(identity) ? staged.get(identity) : initialDaily(row);
      if (payload.pending_only && previous) continue;
      if (payload.choice === previous) continue;
      if (payload.choice || row.initial_daily) staged.set(identity, payload.choice);
      else staged.delete(identity);
      changed++;
    }
    localStorage.setItem(key, JSON.stringify([...staged]));
    return {changed};
  });
}

async function syncChoices(key) {
  if (!localStorage.getItem(key)) return false;
  return navigator.locks.request(key, async () => {
    const staged = stagedChoices(key);
    if (!staged.size) { localStorage.removeItem(key); return false; }
    const all = await request("/api/ledger");
    if (!all.outflow) return false;
    const known = all.rows.filter(r => staged.has(dailyKey(r)) && r.outflow);
    for (const choice of ["yes", "no", null]) {
      const ids = known.filter(r => staged.get(dailyKey(r)) === choice &&
        !(Object.hasOwn(r, "manual_daily") ? r.manual_daily : r.daily_choice)).map(r => r.id);
      if (ids.length) await post("/api/daily", {ids, choice, pending_only: true, sync_staged: true});
    }
    for (const r of known) staged.delete(dailyKey(r));
    if (staged.size) localStorage.setItem(key, JSON.stringify([...staged]));
    else localStorage.removeItem(key);
    return known.length > 0;
  });
}

function legacyDailyReport(data, staged) {
  data.legacy_daily = true;
  const out = data.outflow = {count: 0, cents: 0, pending: 0, daily_unpriced: 0, extra_invested: 0};
  const daily = data.groups["日常生活"] = {count: 0, cents: 0};
  const months = new Map(data.months);
  for (const month of months.values()) { month.outflow = 0; month.daily = 0; }
  for (const row of data.rows) {
    const unpaid = /关闭|撤销|失败|待付款|等待付款|待支付|未支付|未付款/.test(row.status);
    row.outflow = row.direction === "支出" ? row.status.includes("退款") || !unpaid : Boolean(row.fund);
    const key = dailyKey(row);
    row.manual_daily = staged.get(key) || null;
    row.daily_choice = row.outflow ? (staged.has(key) ? staged.get(key) : initialDaily(row)) : null;
    row.daily = row.daily_choice === "yes";
    row.personal = row.outflow ? row.net : null;
    if (!row.outflow) continue;
    if (row.category === "退款待核对") row.personal = null;
    if (row.category === "已退款") row.personal = 0;
    const month = months.get(row.time.slice(0, 7));
    month.outflow += row.cents;
    out.count++;
    out.cents += row.cents;
    if (row.direction !== "支出") out.extra_invested += row.cents;
    if (!row.daily_choice) out.pending++;
    if (row.daily) {
      daily.count++;
      if (row.personal === null) out.daily_unpriced++;
      daily.cents += row.personal || 0;
      month.daily += row.personal || 0;
    }
  }
}

// 已启动的旧服务没有实付汇总，但逐笔 personal 已扣除退款和关联回款。
function legacyPaymentReport(data) {
  const totals = {count: 0, gross: 0, cents: 0, unpriced: 0, unpriced_gross: 0};
  const months = new Map(data.months);
  for (const month of months.values()) { month.paid = 0; month.paid_unpriced = 0; }
  for (const row of data.rows) {
    row.payment = row.outflow && !["投资理财", "内部划转"].includes(row.category);
    if (!row.payment) continue;
    totals.count++;
    totals.gross += row.cents;
    const month = months.get(row.time.slice(0, 7));
    if (row.personal === null) {
      totals.unpriced++;
      totals.unpriced_gross += row.cents;
      month.paid_unpriced++;
    } else {
      totals.cents += row.personal;
      month.paid += row.personal;
    }
  }
  data.payments = totals;
}

// 正在运行的旧版服务仍会返回细分类。刷新页面即可使用相同的分类口径。
function mergeLegacyCategories(data) {
  const aliases = new Map([["咖啡", "餐饮"], ["洗衣", "日用"], ["数码", "休闲"]]);
  if (!data.choices.some(name => aliases.has(name))) return;
  const category = name => aliases.get(name) || name;
  data.choices = [...new Set(data.choices.map(category))];
  for (const row of data.rows) {
    row.category = category(row.category);
    row.manual_category = category(row.manual_category);
    row.merchant_category = category(row.merchant_category);
  }
  const totals = new Map();
  for (const [name, cents] of data.categories) {
    const merged = category(name);
    totals.set(merged, (totals.get(merged) || 0) + cents);
  }
  data.categories = [...totals].sort((a, b) => b[1] - a[1]);
}

function navigate(page) {
  state.page = page;
  for (const tab of document.querySelectorAll("nav button")) {
    const active = tab.dataset.page === page;
    $(tab.dataset.page).hidden = !active;
    if (active) {
      tab.setAttribute("aria-current", "page");
      $("title").textContent = tab.textContent;
    } else {
      tab.removeAttribute("aria-current");
    }
  }
  $("filters").hidden = page === "imports";
  $("cap-form").hidden = page === "clusters";
  notice("");
}

function rangedHref(params) {
  params.set("period", $("period").value);
  if ($("platform").value) params.set("platform", $("platform").value);
  if ($("period").value === "custom") {
    for (const id of ["start", "end"]) if ($(id).value) params.set(id, $(id).value);
  }
  return "#" + params;
}

function saveDetailFilters() {
  if (state.page !== "details") return;
  const params = new URLSearchParams(state.category ? {category: state.category} : {page: "details"});
  if ($("bucket").value && (!state.category || $("bucket").value !== "已计入")) params.set("bucket", $("bucket").value);
  if ($("search").value.trim()) params.set("q", $("search").value.trim());
  history.replaceState(null, "", rangedHref(params));
}

function applyRoute() {
  const hash = location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const rangeIds = ["period", "start", "end", "platform"];
  const previousRange = rangeIds.map(id => $(id).value);
  state.category = params.get("category") || "";
  state.merchant = null;
  $("merchant-summary").open = false;
  $("merchant-summary").hidden = !state.category;
  state.listPage = 1;
  $("search").value = params.get("q") || "";
  $("bucket").value = params.get("bucket") || (state.category ? "已计入" : "");
  $("bucket-field").hidden = Boolean(state.category);
  $("back-overview").hidden = !state.category;
  if (state.category || params.has("period")) {
    const period = params.get("period") ?? "current";
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && !Array.from($("period").options).some(o => o.value === period)) {
      $("period").add(new Option(period, period));
    }
    $("period").value = period;
    $("platform").value = params.get("platform") || "";
    for (const id of ["start", "end"]) $(id).value = params.get(id) || "";
    $("custom-dates").hidden = period !== "custom";
  }
  if (state.category) {
    navigate("details");
    $("title").textContent = state.category + "明细";
  } else {
    const detail = hash === "details" || params.get("page") === "details" || params.has("bucket") || params.has("q");
    const page = hash === "clusters" || params.get("page") === "clusters" ? "clusters" : "overview";
    navigate(detail ? "details" : hash === "imports" ? "imports" : page);
  }
  const changedRange = rangeIds.some((id, i) => $(id).value !== previousRange[i]);
  if (!state.ledger || changedRange) return refresh();
  renderDetails();
  if (state.page === "clusters") renderClusters();
}

function periodQuery() {
  const query = new URLSearchParams();
  const period = $("period").value;
  $("custom-dates").hidden = period !== "custom";
  if (period === "custom") {
    if ($("start").value && $("end").value && $("start").value > $("end").value) {
      throw new Error("开始日期不能晚于结束日期。");
    }
    if ($("start").value) query.set("start", $("start").value);
    if ($("end").value) query.set("end", $("end").value);
  } else if (period) {
    const today = new Date();
    const selected = period === "current"
      ? today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") : period;
    const [year, month] = selected.split("-").map(Number);
    query.set("start", selected + "-01");
    const lastDay = period === "current" ? today.getDate() : new Date(year, month, 0).getDate();
    query.set("end", selected + "-" + String(lastDay).padStart(2, "0"));
  }
  if ($("platform").value) query.set("platform", $("platform").value);
  return query;
}

async function refresh() {
  // 快速切换月份时，慢返回的旧查询不能覆盖最后一次选择。
  const version = ++state.request;
  const url = "/api/ledger?" + periodQuery();
  let data = await request(url);
  if (version !== state.request) return;
  const key = await choiceStore();
  if (!data.outflow) {
    legacyDailyReport(data, stagedChoices(key));
  } else if (await syncChoices(key)) {
    data = await request(url);
  }
  if (version !== state.request) return;
  $("sync-info").hidden = !data.legacy_daily;
  mergeLegacyCategories(data);
  if (!data.payments) legacyPaymentReport(data);
  state.ledger = data;
  const selected = $("period").value;
  const options = [new Option("本月", "current"), new Option("全部日期", ""), new Option("自选日期", "custom")];
  for (const month of data.available_months) options.push(new Option(month, month));
  if (!options.some(o => o.value === selected)) options.push(new Option(selected, selected));
  $("period").replaceChildren(...options);
  $("period").value = selected;
  $("cap").value = data.cap / 100;
  renderOverview(data);
  renderDetails();
  if (state.page === "clusters") renderClusters();
}

function renderClusters() {
  const groups = clusterOutflows(state.ledger.rows);
  state.clusters = groups.filter(rows => rows.length > 1);
  const singles = groups.length - state.clusters.length;
  $("cluster-count").textContent = state.clusters.length + " 组相似支出 · " + singles + " 笔单列";
  const list = $("cluster-list");
  const opened = new Set([...list.querySelectorAll("details.cluster[open]")].map(el => el.dataset.first));
  const renderGroup = (rows, idx) => {
    const names = [...new Set(rows.map(merchantLabel))];
    const pending = rows.filter(r => !r.daily_choice).length;
    const title = idx === -1 ? "未找到相似项" : names.slice(0, 2).join("、") + (names.length > 2 ? "等" : "");
    const total = rows.reduce((sum, r) => sum + r.cents, 0);
    const items = sortedRows(rows, "recent").map(r => tradeRow(r, true)).join("");
    return `<details class="panel cluster" data-first="${rows[0].id}" ${opened.has(String(rows[0].id)) ? "open" : ""}>
      <summary><strong>${escapeHTML(title)}</strong><span>${rows.length} 笔 · 原付 ${money(total)} · ${pending} 笔待确认</span></summary>
      ${idx >= 0 && pending ? `<div class="cluster-actions"><button class="quiet" data-group="${idx}" data-choice="yes">将待确认的 ${pending} 笔计入日常</button>
      <button class="quiet" data-group="${idx}" data-choice="no">将这 ${pending} 笔标为非日常</button></div>` : ""}
      <div class="table-scroll"><table><thead><tr><th>交易时间</th><th>交易对方 / 商品</th><th>用途</th>
      <th>用途统计</th><th class="money">原付金额</th><th>操作 / 日常归属</th></tr></thead><tbody>${items}</tbody></table></div>
    </details>`;
  };
  const singleRows = groups.filter(rows => rows.length === 1).flat();
  list.innerHTML = state.clusters.map(renderGroup).join("") + (singles ? renderGroup(singleRows, -1) : "");
  if (!groups.length) list.textContent = "当前范围没有支出流水。";
}

function renderOverview(data) {
  const out = data.outflow;
  const paid = data.payments;
  $("outflow-total").textContent = money(paid.cents);
  let equation = "付款原额 " + money(paid.gross);
  if (paid.refunds !== undefined) {
    equation += " − 退款 " + money(paid.refunds) + " − 已关联群收款 " + money(paid.repaid);
  } else {
    equation += " − 退款及已关联群收款 " + money(paid.gross - paid.cents - paid.unpriced_gross);
  }
  if (paid.unpriced) equation += " − 暂未计入的 " + paid.unpriced + " 笔退款待核对原额 " + money(paid.unpriced_gross);
  $("outflow-equation").textContent = equation;
  const scope = ["其中已识别消费 " + money(data.known_spending) + "（含超上限）"];
  for (const category of ["借出", "代付待回款"]) {
    const amount = data.rows.reduce((sum, row) => sum + (row.payment && row.category === category ? row.personal ?? 0 : 0), 0);
    if (amount) scope.push(category + " " + money(amount));
  }
  if ($("period").value === "current" && data.rows.length) scope.push("最近一笔 " + data.rows[0].time.slice(0, 10));
  $("payment-scope").textContent = scope.join(" · ");
  $("all-outflows").textContent = "查看实付明细（" + paid.count + " 笔） →";
  $("all-outflows").href = rangedHref(new URLSearchParams({bucket: "实际支付"}));
  $("review-count").textContent = out.pending + " 笔";
  const cards = { "已计入": "included", "日常生活": "daily", "超上限": "over" };
  for (const [key, id] of Object.entries(cards)) {
    const group = data.groups[key];
    $(id).textContent = money(group.cents);
    $(id + "-count").textContent = group.count + " 笔" + (id === "daily" && out.daily_unpriced ?
      " · " + out.daily_unpriced + " 笔退款待核对" : " · 查看明细");
  }
  $("categories").innerHTML = bars(data.categories);
  $("invested").textContent = money(data.invested);
  const purchases = new Map();
  for (const row of data.rows) {
    if (!row.fund) continue;
    if (!purchases.has(row.fund)) purchases.set(row.fund, []);
    purchases.get(row.fund).push(row);
  }
  $("funds").innerHTML = data.funds.length ? `<table>
    <thead><tr><th>产品</th><th>笔数</th><th class="money">买入金额</th></tr></thead><tbody>${
      data.funds.map(([name, fund]) => `<tr><td><details><summary>${escapeHTML(name)}</summary><ul class="fund-orders">${
        purchases.get(name).map(r => `<li>${escapeHTML(r.time.slice(0, 10))} · ${money(r.cents)}
          <small>${escapeHTML(r.status)}</small></li>`).join("")}</ul></details></td><td>${fund.count}</td>
        <td class="money">${money(fund.cents)}</td></tr>`).join("")}</tbody></table>` :
    '<p class="hint">当前范围内没有理财买入。</p>';
  const receipts = data.rows.filter((row) => row.group_receipt);
  $("aa-count").textContent = receipts.filter((row) => !row.linked_expense_id).length + " 笔待关联";
  $("aa-list").innerHTML = receipts.map((row) => `
    <div class="aa-item"><div>${escapeHTML(row.merchant)} · ${money(row.cents)}
      <small>${escapeHTML(row.time.slice(0, 16))}</small>
      <small>${row.linked_expense_id ? escapeHTML(row.linked_time.slice(5, 10) + " " + row.linked_merchant + " · " + row.linked_status) : "尚未抵扣消费"}</small></div>
      <button class="row-action" data-receipt="${row.id}">${row.linked_expense_id ? "修改关联" : "关联付款"}</button></div>`
  ).join("") || '<p class="hint">当前范围内没有收到群收款。</p>';
  renderDrill();
  const periods = data.months.map(([month, values]) => `
    <tr><td>${escapeHTML(month)}</td><td class="money">${money(values.paid)}${values.paid_unpriced ? `<small>${values.paid_unpriced} 笔退款待核对</small>` : ""}</td>
      <td class="money">${money(values.daily)}</td><td class="money">${money(values.invested)}</td></tr>`).join("");
  $("months").innerHTML = periods ? `<div class="table-scroll"><table>
    <thead><tr><th>月份</th><th class="money">实际支付</th><th class="money">确认日常</th><th class="money">理财买入</th></tr></thead>
    <tbody>${periods}</tbody></table></div>` : '<p class="hint">当前范围内没有交易。</p>';
}

// 同一份分类汇总绘制概览和日常生活的条形图，标签始终显示精确到分的金额。
function bars(categories, bucket = "已计入") {
  const total = categories.reduce((sum, [, cents]) => sum + cents, 0);
  return categories.map(([name, value]) => `
    <a class="bar-row" href="${escapeHTML(rangedHref(new URLSearchParams({category: name, bucket})))}" title="查看${escapeHTML(name)}明细">
      <span>${escapeHTML(name)}</span>
      <span class="track"><span class="bar" style="width:${total ? 100 * value / total : 0}%"></span></span>
      <span class="share">${total ? (100 * value / total).toFixed(1) : "0.0"}%</span>
      <span class="money">${money(value)}</span>
      <span class="bar-arrow" aria-hidden="true">›</span>
    </a>`).join("") || '<p class="hint">当前范围内没有符合条件的消费。</p>';
}

function sortedRows(rows, mode, amount = row => row.net) {
  return [...rows].sort((a, b) => {
    const byTime = a.time.localeCompare(b.time) || a.id - b.id;
    if (mode === "highest") return amount(b) - amount(a) || -byTime;
    if (mode === "lowest") return amount(a) - amount(b) || -byTime;
    return mode === "oldest" ? byTime : -byTime;
  });
}

function toggleDrill(kind) {
  state.drill = state.drill === kind ? null : kind;
  $("drill-category").value = "";
  renderDrill();
}

function renderDrill(selectedCategory = $("drill-category").value) {
  $("drill").hidden = !state.drill;
  for (const kind of ["included", "daily"]) {
    $("open-" + kind).setAttribute("aria-expanded", String(state.drill === kind));
  }
  if (!state.drill || !state.ledger) return;
  const daily = state.drill === "daily";
  const rows = state.ledger.rows.filter((r) => daily ? r.daily : r.bucket === "已计入");
  const names = new Set(rows.map((r) => r.category));
  $("drill-category").replaceChildren(new Option("全部用途", ""), ...Array.from(names).sort().map(n => new Option(n, n)));
  $("drill-category").value = names.has(selectedCategory) ? selectedCategory : "";
  $("drill-title").textContent = daily ? "日常开销明细" : "已计入消费明细";
  $("daily-chart").hidden = !daily;
  if (daily) {
    const totals = new Map();
    for (const r of rows) totals.set(r.category, (totals.get(r.category) || 0) + (r.personal || 0));
    $("daily-bars").innerHTML = bars([...totals].sort((a, b) => b[1] - a[1]), "已确认日常");
  }
  const visible = rows.filter((r) => !$("drill-category").value || r.category === $("drill-category").value);
  const amount = r => daily ? r.personal || 0 : r.net;
  $("drill-total").textContent = visible.length + " 笔 · " + money(visible.reduce((total, r) => total + amount(r), 0));
  $("drill-trades").innerHTML = sortedRows(visible, $("drill-sort").value, amount).map(r => tradeRow(r)).join("") ||
    '<tr><td colspan="6">当前范围内没有符合条件的消费。</td></tr>';
}

function tradeRow(row, gross = false) {
  const tagClass = { "待分类": "pending", "已计入": "included" }[row.bucket] || "";
  const info = [row.platform, row.direction, row.status, "订单号 " + row.order_id];
  if (row.note) info.push("备注 " + row.note);
  if (row.daily_choice && row.initial_daily && !row.manual_daily) info.push("日常归属来自本次初分，可手动调整");
  for (const receipt of row.receipts) {
    info.push("群收款 " + receipt.time.slice(0, 10) + " · " + receipt.merchant + " · " + money(receipt.cents));
  }
  if (row.include_over_cap) info.push("已手动允许超上限计入");
  if (row.group_receipt && row.linked_expense_id) info.push("已关联 " + row.linked_merchant);
  let edit = "";
  if (row.editable) {
    edit = `<button class="row-action" data-edit="${row.id}">${row.bucket === "超上限" ? "手动计入…" : "编辑"}</button>`;
  } else if (row.group_receipt) {
    edit = `<button class="row-action" data-receipt="${row.id}">关联付款</button>`;
  }
  if (row.outflow) {
    const choices = [["", "待确认"], ["yes", "计入日常"], ["no", "非日常"]];
    edit += `<select class="daily-select" data-daily="${row.id}" aria-label="日常归属 · ${escapeHTML(row.merchant)}">${choices.map(
      ([value, label]) => `<option value="${value}"${value === (row.daily_choice || "") ? " selected" : ""}>${label}</option>`
    ).join("")}</select>`;
  }
  const net = row.outflow ? row.personal : row.net;
  const personal = net === null ? "退款待核对" : money(net);
  return `<tr>
    <td><time>${escapeHTML(row.time.slice(0, 10))}</time>
      <small>${escapeHTML(row.platform)} · ${escapeHTML(row.time.slice(11))}</small></td>
    <td><details><summary>${escapeHTML(row.merchant)}</summary>
      <small>${info.map(escapeHTML).join("<br>")}</small></details><small>${escapeHTML(row.product)}</small></td>
    <td>${escapeHTML(row.category)}</td>
    <td><span class="tag ${tagClass}">${escapeHTML(row.bucket)}</span></td>
    <td class="money">${gross ? money(row.cents) : personal}${net !== row.cents ?
      `<small>${gross ? "实付 " + personal : "原付 " + money(row.cents)}</small>` : ""}</td><td>${edit}</td>
  </tr>`;
}

function merchantLabel(row) {
  const name = row.merchant.trim();
  return name && name !== "/" ? name : "未标明商户";
}

function renderMerchants(rows) {
  const merchants = new Map();
  for (const row of rows) {
    const name = merchantLabel(row);
    const group = merchants.get(name) || {count: 0, cents: 0};
    group.count++;
    group.cents += row.outflow ? row.personal || 0 : row.net;
    merchants.set(name, group);
  }
  $("merchant-list").innerHTML = [...merchants].sort((a, b) => b[1].cents - a[1].cents ||
    a[0].localeCompare(b[0], "zh-CN")).map(([name, group]) => `<tr>
      <td><button class="row-action" data-merchant="${escapeHTML(name)}">${escapeHTML(name)}</button></td>
      <td class="money">${group.count}</td><td class="money">${money(group.cents)}</td></tr>`).join("") ||
    '<tr><td colspan="3">当前范围内没有商户交易。</td></tr>';
}

function transactionSearch(input) {
  const normalize = value => value.normalize("NFKC").toLowerCase();
  const terms = normalize(input).trim().split(/\s+/).filter(Boolean).map(word => {
    const amount = /^(¥)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(元)?$/.exec(word);
    if (!amount) return {word};
    const cents = Number(amount[2].replace(/,/g, "")) * 100 + Number((amount[3] || "").padEnd(2, "0"));
    return {word, cents, amountOnly: Boolean(amount[1] || amount[4])};
  });
  if (!terms.length) return () => true;
  return row => {
    const text = normalize([row.merchant, row.product, row.category, row.note, row.order_id,
      row.time, row.platform, row.direction, row.bucket, row.status, row.source_category].join(" "));
    return terms.every(term => term.cents === row.cents || term.cents === row.net || term.cents === row.personal ||
      (!term.amountOnly && text.includes(term.word)));
  };
}

function renderDetails() {
  if (!state.ledger) return;
  const bucket = $("bucket").value;
  const matchesSearch = transactionSearch($("search").value);
  const dailyFilters = {"日常待确认": null, "已确认日常": "yes", "已确认非日常": "no"};
  const gross = bucket === "全部支出" || bucket === "日常待确认" || bucket === "已确认非日常";
  const amount = r => gross ? r.cents : r.outflow ? r.personal || 0 : r.net;
  const matchesBucket = row => {
    if (bucket === "实际支付") return row.payment;
    if (bucket === "全部支出") return row.outflow;
    if (Object.hasOwn(dailyFilters, bucket)) return row.outflow && row.daily_choice === dailyFilters[bucket];
    return !bucket || row.bucket === bucket;
  };
  const matching = state.ledger.rows.filter((row) => matchesBucket(row) &&
    (!state.category || row.category === state.category) && matchesSearch(row));
  if (state.category) renderMerchants(matching);
  const rows = state.merchant === null ? matching : matching.filter(row => merchantLabel(row) === state.merchant);
  $("clear-merchant").hidden = state.merchant === null;
  if (state.merchant !== null) $("clear-merchant").textContent = "清除商户筛选 · " + state.merchant + " ×";
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.listPage = Math.min(state.listPage, pages);
  const offset = (state.listPage - 1) * pageSize;
  $("trades").innerHTML = sortedRows(rows, $("detail-sort").value, amount).slice(offset, offset + pageSize).map(r => tradeRow(r, gross)).join("") ||
    '<tr><td colspan="6">没有符合条件的交易。</td></tr>';
  $("row-count").textContent = rows.length + " 笔交易" + (gross || state.category || bucket === "已确认日常" || bucket === "实际支付" ?
    (gross ? " · 原付合计 " : " · 已知实付合计 ") + money(rows.reduce((sum, row) => sum + amount(row), 0)) : "");
  if (bucket === "实际支付") {
    const unpriced = rows.filter(row => row.personal === null).length;
    if (unpriced) $("row-count").textContent += " · " + unpriced + " 笔退款待核对，暂未计入";
  }
  $("pager").hidden = pages <= 1;
  $("previous").disabled = state.listPage === 1;
  $("next").disabled = state.listPage === pages;
  $("page-number").textContent = state.listPage + " / " + pages;
}

function openEditor(id) {
  const row = state.ledger.rows.find((item) => item.id === id);
  state.editId = id;
  $("trade-label").textContent = row.time + " · " + row.merchant + " · " + money(row.cents);
  $("category").replaceChildren(...state.ledger.choices.map((item) => new Option(item, item)));
  $("category").value = row.category;
  $("note").value = row.note;
  $("exception-field").hidden = row.net <= state.ledger.cap && !row.include_over_cap;
  $("exception").checked = Boolean(row.include_over_cap) || row.bucket === "超上限";
  $("edit-error").textContent = "";
  $("rule").value = "keep";
  $("rule").disabled = !row.merchant || row.merchant === "/";
  $("rule-info").textContent = row.merchant_category ? "该商户已有规则：" + row.merchant_category :
    "商户规则会作用于已有和以后导入的同名交易，单笔手工标注优先。";
  $("editor").showModal();
}

async function openReceipt(id) {
  const row = state.ledger.rows.find((r) => r.id === id);
  const candidates = await request("/api/aa-options?" + new URLSearchParams({receipt_id: id}));
  state.receiptId = id;
  $("aa-label").textContent = row.time + " · " + row.merchant + " · 收到 " + money(row.cents);
  const options = candidates.map((r) => new Option(
    r.time.slice(0,16) + " · " + r.platform + " · " + r.merchant + " · " + money(r.cents) + " · " + r.product, r.id));
  $("aa-target").replaceChildren(new Option("暂不关联", ""), ...options);
  $("aa-target").value = row.linked_expense_id || "";
  $("aa-error").textContent = "";
  $("aa-editor").showModal();
}

async function rowAction(event) {
  const edit = event.target.closest("[data-edit]");
  if (edit) return openEditor(Number(edit.dataset.edit));
  const receipt = event.target.closest("[data-receipt]");
  if (receipt) await openReceipt(Number(receipt.dataset.receipt));
}

async function importFiles() {
  const files = Array.from($("files").files);
  $("upload").disabled = true;
  $("import-results").replaceChildren();
  try {
    for (const file of files) {
      const line = document.createElement("p");
      $("import-results").appendChild(line);
      line.textContent = file.name + " · 正在导入…";
      try {
        const result = await request("/api/import?" + new URLSearchParams({filename: file.name}), {
          method: "POST", headers: {"X-NMoney": "1", "Content-Type": "application/octet-stream"}, body: file
        });
        line.textContent = file.name + " · 新增 " + result.added + " 笔，更新 " + result.changed + " 笔，重复 " + result.skipped + " 笔。";
      } catch (error) {
        line.textContent = file.name + " · " + error.message;
        line.className = "error";
      }
    }
    await refresh();
  } finally {
    $("upload").disabled = false;
  }
}

function on(id, event, action) {
  $(id).addEventListener(event, async (e) => {
    if (event === "submit") e.preventDefault();
    try { await action(e); } catch (error) { notice(error.message, true); }
  });
}

function bindLedger() {
  window.addEventListener("storage", event => {
    if (event.key === storeName && state.ledger?.legacy_daily) refresh().catch(error => notice(error.message, true));
  });
  for (const tab of document.querySelectorAll("nav button")) tab.onclick = () => {
    location.hash = tab.dataset.page === "clusters" ? rangedHref(new URLSearchParams({page: "clusters"})) : tab.dataset.page;
  };
  window.addEventListener("hashchange", () => {
    Promise.resolve().then(applyRoute).catch(error => notice(error.message, true));
    $("title").focus();
    window.scrollTo(0, 0);
  });
  for (const id of ["period", "start", "end", "platform"]) {
    on(id, "change", () => {
      notice("");
      state.listPage = 1;
      saveDetailFilters();
      if (state.page === "clusters") history.replaceState(null, "", rangedHref(new URLSearchParams({page: "clusters"})));
      return refresh();
    });
  }
  on("cap-form", "submit", async () => {
    await post("/api/cap", {cents: Math.round(Number($("cap").value) * 100)});
    await refresh();
    notice("已保存上限，合计已重新计算。");
  });
  on("open-included", "click", () => toggleDrill("included"));
  on("open-daily", "click", () => toggleDrill("daily"));
  on("fold-drill", "click", () => toggleDrill(state.drill));
  on("drill-sort", "change", () => renderDrill());
  on("drill-category", "change", () => renderDrill());
  on("detail-sort", "change", () => { state.listPage = 1; renderDetails(); });
  for (const [id, bucket] of [["open-pending", "待分类"], ["open-over", "超上限"], ["open-review", "日常待确认"]]) {
    on(id, "click", () => { location.hash = rangedHref(new URLSearchParams({bucket})); });
  }
  for (const [id, event] of [["bucket", "change"], ["search", "input"]]) {
    on(id, event, () => {
      state.listPage = 1;
      saveDetailFilters();
      renderDetails();
    });
  }
  on("merchant-list", "click", event => {
    const button = event.target.closest("[data-merchant]");
    if (!button) return;
    state.merchant = button.dataset.merchant;
    state.listPage = 1;
    $("merchant-summary").open = false;
    renderDetails();
    $("clear-merchant").focus();
  });
  on("clear-merchant", "click", () => {
    state.merchant = null;
    state.listPage = 1;
    renderDetails();
    $("merchant-summary").querySelector("summary").focus();
  });
  on("previous", "click", () => { state.listPage--; renderDetails(); });
  on("next", "click", () => { state.listPage++; renderDetails(); });
  for (const id of ["trades", "drill-trades", "aa-list", "cluster-list"]) on(id, "click", rowAction);
  on("cluster-list", "click", async event => {
    const button = event.target.closest("[data-group]");
    if (!button) return;
    const rows = state.clusters[Number(button.dataset.group)];
    const ids = rows.filter(r => !r.daily_choice).map(r => r.id);
    const buttons = button.parentElement.querySelectorAll("button");
    buttons.forEach(b => b.disabled = true);
    try {
      const result = await saveDaily({ids, choice: button.dataset.choice, pending_only: true});
      await refresh();
      notice("已更新 " + result.changed + " 笔支出的日常归属。");
    } finally { buttons.forEach(b => b.disabled = false); }
  });
  document.addEventListener("change", async event => {
    const select = event.target.closest("[data-daily]");
    if (!select) return;
    const id = Number(select.dataset.daily);
    const previous = state.ledger.rows.find(row => row.id === id)?.daily_choice;
    select.disabled = true;
    try {
      await saveDaily({ids: [id], choice: select.value || null});
    } catch (error) {
      select.disabled = false;
      select.value = previous || "";
      notice(error.message, true);
      return;
    }
    try {
      await refresh();
      notice("已保存这笔支出的日常归属。");
    } catch (error) { notice(error.message, true); }
  });
  on("aa-close", "click", () => $("aa-editor").close());
  on("aa-form", "submit", async () => {
    try {
      await post("/api/aa", {receipt_id: state.receiptId, expense_id: Number($("aa-target").value) || null});
    } catch (error) {
      $("aa-error").textContent = error.message;
      return;
    }
    $("aa-editor").close();
    await refresh();
    notice("已更新群收款关联和个人实付。");
  });
  on("close", "click", () => $("editor").close());
  on("edit-form", "submit", async () => {
    try {
      await post("/api/annotate", { id: state.editId, category: $("category").value,
        note: $("note").value, rule: $("rule").value, include_over_cap: $("exception").checked });
    } catch (error) {
      $("edit-error").textContent = error.message;
      return;
    }
    $("editor").close();
    await refresh();
    notice("用途已保存。");
  });
  on("import-form", "submit", importFiles);
  Promise.resolve().then(applyRoute).catch((error) => notice(error.message, true));
}

if (typeof document !== "undefined") bindLedger();
if (typeof module !== "undefined") module.exports = {clusterOutflows};
