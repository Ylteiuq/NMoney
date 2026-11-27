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
  receiptId: null, category: "", merchant: null, tradeId: null, tradeBasis: "net", fund: null };
const pageSize = 40;

function notice(message, error = false) {
  const output = document.querySelector("#trade-sheet[open] .sheet-notice") ||
    document.querySelector("#overview-sheet[open] .sheet-notice") || $("notice");
  output.textContent = message;
  output.hidden = !message;
  output.classList.toggle("error", error);
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

// 迁移旧版浏览器留下的手工标记。所有新决定直接写入服务端。
const dailyKey = row => JSON.stringify([row.platform, row.order_id]);
const choicePrefix = "NMoney.daily.v1:";
let storeName;
let migratingChoices = false;
async function choiceStore() {
  if (!storeName) {
    const ping = await request("/api/ping");
    storeName = choicePrefix + ping.database;
  }
  return storeName;
}

function stagedChoices(key) {
  return new Map(JSON.parse(localStorage.getItem(key) || "[]"));
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

async function migrateStoredChoices() {
  if (migratingChoices) return;
  migratingChoices = true;
  try {
    if (!Object.keys(localStorage).some(key => key.startsWith(choicePrefix))) return;
    if (await syncChoices(await choiceStore())) await refresh();
  } catch (error) {
    notice("旧版日常选择尚未同步：" + error.message, true);
  } finally {
    migratingChoices = false;
  }
}

function navigate(page) {
  state.page = page;
  for (const tab of document.querySelectorAll("nav button")) {
    const active = tab.dataset.page === page;
    $(tab.dataset.page).hidden = !active;
    if (active) {
      tab.setAttribute("aria-current", "page");
      $("title").textContent = tab.querySelector("span").textContent;
    } else {
      tab.removeAttribute("aria-current");
    }
  }
  $("filters").hidden = page === "imports";
  $("cap-control").hidden = page === "clusters";
  $("cap-control").open = false;
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
  const query = periodQuery();
  const period = $("period").value;
  if (period && period !== "custom") query.set("budget_month", query.get("start").slice(0, 7));
  const url = "/api/ledger?" + query;
  const data = await request(url);
  if (version !== state.request) return;
  if (!Array.isArray(data.daily_categories)) {
    $(state.page).hidden = true;
    throw new Error("正在运行旧版后端。请重启 NMoney 服务后刷新，读取更新后的账本。");
  }
  $(state.page).hidden = false;
  state.ledger = data;
  const selected = $("period").value;
  const now = new Date();
  const currentMonth = now.getFullYear() + "年" + (now.getMonth() + 1) + "月（本月）";
  const options = [new Option(currentMonth, "current"), new Option("全部日期", ""), new Option("自选日期", "custom")];
  for (const month of data.available_months) options.push(new Option(month, month));
  if (!options.some(o => o.value === selected)) options.push(new Option(selected, selected));
  $("period").replaceChildren(...options);
  $("period").value = selected;
  $("cap").value = data.cap / 100;
  renderBudget(data.budget);
  renderOverview(data);
  renderDetails();
  if (state.page === "clusters") renderClusters();
  if ($("trade-sheet").open) renderTradeDetails();
  if ($("overview-sheet").open && !$("fund-orders").hidden) renderFundOrders();
  // 先显示 SQLite 已返回的账本。只有旧浏览器留有暂存标记时才核对数据库路径。
  void migrateStoredChoices();
}

function renderClusters() {
  const byId = new Map(state.ledger.rows.map(row => [row.id, row]));
  const groups = state.ledger.clusters.map(ids => ids.map(id => byId.get(id)));
  const onlyPending = $("review-only").checked;
  state.clusters = groups.filter(rows => rows.length > 1)
    .map(rows => onlyPending ? rows.filter(r => !r.daily_choice) : rows).filter(rows => rows.length);
  const singleRows = groups.filter(rows => rows.length === 1).flat().filter(r => !onlyPending || !r.daily_choice);
  const singles = singleRows.length;
  $("cluster-count").textContent = state.clusters.length + " 组相似支出 · " + singles + " 笔单列";
  const list = $("cluster-list");
  const opened = new Set([...list.querySelectorAll("details.cluster[open]")].map(el => el.dataset.first));
  const renderGroup = (rows, idx) => {
    const names = [...new Set(rows.map(merchantLabel))];
    const pending = rows.filter(r => !r.daily_choice).length;
    const title = idx === -1 ? "未找到相似项" : names.slice(0, 2).join("、") + (names.length > 2 ? "等" : "");
    const total = rows.reduce((sum, r) => sum + r.cents, 0);
    const items = sortedRows(rows, "recent").map(r => tradeRow(r, {gross: true})).join("");
    return `<details class="panel cluster" data-first="${rows[0].id}" ${opened.has(String(rows[0].id)) ? "open" : ""}>
      <summary><strong>${escapeHTML(title)}</strong><span>${rows.length} 笔 · 原付 ${money(total)} · ${pending} 笔待确认</span></summary>
      ${idx >= 0 && pending ? `<div class="cluster-actions"><button class="quiet" data-group="${idx}" data-choice="yes">将待确认的 ${pending} 笔计入日常</button>
      <button class="quiet" data-group="${idx}" data-choice="no">将这 ${pending} 笔标为非日常</button></div>` : ""}
      <div class="bill-list">${items}</div>
    </details>`;
  };
  list.innerHTML = state.clusters.map(renderGroup).join("") + (singles ? renderGroup(singleRows, -1) : "");
  if (groups.length && !state.clusters.length && !singles) list.innerHTML = '<p class="hint">这个范围的支出都已有日常归属。</p>';
  if (!groups.length) list.innerHTML = '<div class="panel empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-clusters"/></svg><strong>当前范围没有支出流水</strong><p>选择其他时间范围，或先导入一份账单。</p></div>';
}

function renderBudget(budget) {
  $("budget").hidden = !budget;
  if (!budget) return;
  if ($("budget").dataset.month !== budget.month) {
    $("income-form").reset();
    $("income-form").removeAttribute("data-entry-key");
    $("budget").dataset.month = budget.month;
  }
  const [year, month] = budget.month.split("-");
  $("budget-period").textContent = year + " 年 " + Number(month) + " 月 · 全平台";
  $("sheet-income").textContent = money(budget.total);
  const left = budget.remaining;
  $("budget-title").textContent = left < 0 ? "本月日常预算已超支" : "本月日常还能花";
  $("budget-left").textContent = money(Math.abs(left));
  $("budget-status").textContent = budget.unpriced ? budget.unpriced + " 笔退款待核，金额暂计" : "";
  $("budget").classList.toggle("over", left < 0);
  const used = budget.spent;
  const percent = budget.total ? used / budget.total * 100 : null;
  $("budget-usage").textContent = percent === null ? "本月额度为零" : "已用 " + percent.toFixed(1) + "%";
  $("budget-meter").style.width = Math.min(100, percent ?? (used > 0 ? 100 : 0)) + "%";
  $("budget-equation").textContent = "本月收入 " + money(budget.total) +
    " − 日常开支 " + money(used);
  $("budget-medical").hidden = !budget.medical;
  $("budget-medical").textContent = "医疗另计 " + money(budget.medical || 0) + " ›";
  $("budget-medical").href = "#" + new URLSearchParams({period: budget.month, bucket: "医疗单列"});
  $("base-amount").value = budget.base / 100;
  $("budget-lending").value = budget.lending;
  $("reconciliation-left").textContent = money(budget.reconciliation_remaining);
  $("supplements").innerHTML = budget.supplements.map(s => '<div class="income-item"><div>' +
    escapeHTML(s.label) + " · " + money(s.cents) + (s.trade_id ? " · 已匹配流水" : "") +
    '</div><button class="row-action" data-remove-income="' + escapeHTML(s.id) + '">撤销补记</button></div>').join("");
  const loans = budget.loans || [];
  $("budget-loans").innerHTML = loans.map(loan => {
    const repayments = loan.repayments.map(r => '<li>' + escapeHTML(r.time.slice(0, 10)) + " · 还款 " + money(r.credited) + "</li>").join("");
    return '<div class="income-item"><div>' + escapeHTML(loan.merchant) + " · 借出 " + money(loan.principal) +
      '<small>' + escapeHTML(loan.time.slice(0, 10)) + " · 已还 " + money(loan.repaid) + (loan.closed ?
        " · 已结清，差额计日常 " + money(loan.daily_loss) : " · 待还 " + money(loan.outstanding)) + '</small>' +
      (repayments ? '<ul>' + repayments + '</ul>' : '') + '</div><button class="row-action" data-settle-loan="' +
      loan.id + '">' + (loan.closed ? "重新打开" : loan.outstanding ? "结清，差额 " + money(loan.outstanding) + " 计日常" : "确认结清") + '</button></div>';
  }).join("") || '<p class="hint">没有待核对的借款。</p>';
  const items = [];
  for (const income of budget.incomes) {
    const item = document.createElement("div");
    item.className = "income-item";
    const label = document.createElement("div");
    label.textContent = income.merchant + " · " + money(income.cents);
    const info = document.createElement("small");
    info.textContent = [income.time, income.platform, income.product !== "/" && income.product,
      income.status === "waiting" ? "待到账" : "已到账"].filter(Boolean).join(" · ");
    label.append(info);
    const original = document.createElement("a");
    original.textContent = "查看原始流水";
    original.href = "#" + new URLSearchParams({page: "details", period: budget.month, platform: income.platform,
      q: income.order_id || income.time});
    label.append(original);
    const kinds = {extra:"计入额外收入", base:"已含在生活费", ignore:"不计额度", pending:"待核对", repayment:"归还借款"};
    const select = document.createElement("select");
    select.setAttribute("aria-label", income.merchant + " 收入归属");
    select.dataset.incomeId = income.id;
    select.add(new Option(income.choice === "auto" ? "自动 · " + kinds[income.kind] : "恢复自动判断", "auto"));
    for (const k of ["extra", "base", "ignore"]) select.add(new Option(kinds[k], k));
    for (const s of budget.supplements) {
      if (s.cents === income.cents && (!s.trade_id || s.trade_id === income.id))
        select.add(new Option("对应补记 · " + s.label, "matched:" + s.id));
    }
    if (income.status === "settled" || income.repayment_loan) {
      for (const loan of loans) {
        if (loan.id === income.repayment_loan || (!loan.closed && loan.outstanding && loan.time <= income.time)) {
          select.add(new Option("归还 " + loan.time.slice(5,10) + " · " + money(loan.principal) + " · " + loan.merchant, "loan:" + loan.id));
        }
      }
    }
    if (income.choice === "repayment" && !income.repayment_loan) select.add(new Option("归还借款（未关联）","repayment"));
    if (income.repayment_loan && income.cents > income.repayment_cents) info.textContent += " · 未抵本金 " + money(income.cents - income.repayment_cents);
    select.value = income.repayment_loan ? "loan:" + income.repayment_loan : income.choice === "matched" ? "matched:" + income.supplement_id : income.choice;
    const control = document.createElement("label");
    control.className = "income-kind";
    control.append("收入归属", select);
    if (income.repayment_loan) {
      const loan = loans.find(item => item.id === income.repayment_loan);
      if (loan) {
        const match = document.createElement("small");
        match.textContent = "已关联 " + loan.time.slice(0,10) + " 借给 " + loan.merchant + " 的 " + money(loan.principal);
        label.append(match);
      }
    }
    item.append(label, control);
    items.push(item);
  }
  $("budget-incomes").replaceChildren(...items);
  if (!items.length) $("budget-incomes").textContent = "本月没有需要归属的转入。";
}

function renderOverview(data) {
  const out = data.outflow;
  const paid = data.payments;
  $("outflow-total").textContent = money(paid.cents);
  const adjustments = [["付款原额", money(paid.gross)]];
  if (paid.refunds !== undefined) {
    adjustments.push(["已退款", "− " + money(paid.refunds)], ["已关联群收款", "− " + money(paid.repaid)]);
  } else {
    adjustments.push(["退款及群收款", "− " + money(paid.gross - paid.cents - paid.unpriced_gross)]);
  }
  if (paid.unpriced) adjustments.push([paid.unpriced + " 笔退款待核对（暂不计入）", "− " + money(paid.unpriced_gross)]);
  $("outflow-equation").innerHTML = adjustments.map(([label, amount]) =>
    `<div><dt>${label}</dt><dd>${amount}</dd></div>`).join("");
  const scope = ["其中已识别消费 " + money(data.known_spending) + "（含超上限）"];
  for (const category of ["借出", "代付待回款"]) {
    const amount = data.rows.reduce((sum, row) => sum + (row.payment && row.category === category ? row.personal ?? 0 : 0), 0);
    if (amount) scope.push(category + " " + money(amount));
  }
  $("coverage").textContent = data.rows.length ? "最近一笔 " + data.rows[0].time.slice(0, 10) : "";
  $("payment-scope").textContent = scope.join(" · ");
  $("all-outflows").textContent = "查看 " + paid.count + " 笔实付 ›";
  $("all-outflows").href = rangedHref(new URLSearchParams({bucket: "实际支付"}));
  $("review-count").textContent = out.pending + " 笔";
  const cards = { "已计入": "included", "日常生活": "daily", "超上限": "over" };
  for (const [key, id] of Object.entries(cards)) {
    const group = data.groups[key];
    $(id).textContent = money(group.cents);
    $(id + "-count").textContent = group.count + " 笔" + (id === "daily" && out.daily_unpriced ?
      " · " + out.daily_unpriced + " 笔退款待核对" : "");
  }
  const total = data.groups["日常生活"].cents;
  $("category-platform").textContent = $("platform").value || "全平台";
  let offset = 0;
  const stops = data.daily_categories.map(([name, cents]) => {
    const start = offset;
    offset += total ? cents / total * 100 : 0;
    return `${categoryColor(name)} ${start}% ${offset}%`;
  });
  const ring = $("category-ring");
  if (!total) ring.style.background = "var(--line)";
  else if (stops.length === 1) ring.style.background = categoryColor(data.daily_categories[0][0]);
  else ring.style.background = `conic-gradient(${stops.join(", ")})`;
  previewCategory(null);
  $("categories").innerHTML = categoryBars(data.daily_categories, "已确认日常");
  $("recent-list").innerHTML = data.rows.slice(0, 5).map(row => tradeRow(row)).join("") || '<p class="hint">当前范围没有交易。</p>';
  $("recent-all").href = rangedHref(new URLSearchParams({page: "details"}));
  $("invested").textContent = money(data.invested);
  $("funds").innerHTML = data.funds.length ? `<table>
    <thead><tr><th>产品</th><th>笔数</th><th class="money">买入金额</th></tr></thead><tbody>${
      data.funds.map(([name, fund]) => `<tr><td><button class="fund-link" data-fund="${escapeHTML(name)}" aria-haspopup="dialog">${escapeHTML(name)} ›</button></td>
        <td>${fund.count}</td><td class="money">${money(fund.cents)}</td></tr>`).join("")}</tbody></table>` :
    '<div class="empty-state compact"><svg class="icon" aria-hidden="true"><use href="#icon-trend"/></svg><p>当前范围内没有理财买入。</p></div>';
  const receipts = data.rows.filter((row) => row.group_receipt);
  const pendingReceipts = receipts.filter((row) => !row.linked_expense_id).length;
  $("aa-count").textContent = pendingReceipts ? pendingReceipts + " 笔待关联" : receipts.length ? "全部已关联" : "";
  $("aa-list").innerHTML = receipts.map((row) => `
    <div class="aa-item"><div>${escapeHTML(row.merchant)} · ${money(row.cents)}
      <small>${escapeHTML(row.time.slice(0, 16))}</small>
      <small>${row.linked_expense_id ? escapeHTML(row.linked_time.slice(5, 10) + " " + row.linked_merchant + " · " + row.linked_status) : "尚未抵扣消费"}</small></div>
      <button class="row-action" data-receipt="${row.id}">${row.linked_expense_id ? "修改关联" : "关联付款"}</button></div>`
  ).join("") || '<div class="empty-state compact"><svg class="icon" aria-hidden="true"><use href="#icon-users"/></svg><p>当前范围内没有收到群收款。</p></div>';
  renderDrill();
  const periods = data.months.map(([month, values]) => `
    <tr><td>${escapeHTML(month)}</td><td class="money">${money(values.daily)}</td><td class="money">${money(values.paid)}${values.paid_unpriced ? `<small>${values.paid_unpriced} 笔退款待核对</small>` : ""}</td>
      <td class="money">${money(values.invested)}</td></tr>`).join("");
  $("months").innerHTML = periods ? `<div class="table-scroll"><table>
    <thead><tr><th>月份</th><th class="money">日常开支</th><th class="money">实际支付</th><th class="money">理财买入</th></tr></thead>
    <tbody>${periods}</tbody></table></div>` : '<p class="hint">当前范围内没有交易。</p>';
}

const categoryColors = {
  "餐饮": "#1973eb", "校园消费": "#52a9f6", "日用": "#33a5a4", "美团": "#efb24e",
  "医疗": "#8371c4", "交通": "#5185ac", "休闲": "#db8768", "会员订阅": "#9d78a5",
  "人情": "#bd8f55", "其他消费": "#70889a"
};

function categoryColor(name) {
  return categoryColors[name] || "#7b8b9c";
}

function categoryBars(categories, bucket, showTrack = false) {
  const total = categories.reduce((sum, [, cents]) => sum + cents, 0);
  return categories.map(([name, value], index) => `
    <a class="category-row" data-category-index="${index}" href="${escapeHTML(rangedHref(new URLSearchParams({category: name, bucket})))}">
      <i style="background:${categoryColor(name)}" aria-hidden="true"></i><span>${escapeHTML(name)}</span>
      <small>${total ? (100 * value / total).toFixed(1) : "0.0"}%</small>
      <strong>${money(value)}</strong><span class="arrow" aria-hidden="true">›</span>
      ${showTrack ? `<span class="daily-track" aria-hidden="true"><i style="width:${total ? 100 * value / total : 0}%;background:${categoryColor(name)}"></i></span>` : ""}
    </a>`).join("") || '<p class="hint">当前范围没有对应的开支。</p>';
}

// 分类列表既是图例也是明细入口。预览只改变圆环，不修改当前筛选。
function previewCategory(link) {
  if (!state.ledger) return;
  const categories = state.ledger.daily_categories;
  const total = state.ledger.groups["日常生活"].cents;
  const index = link ? Number(link.dataset.categoryIndex) : -1;
  const ring = $("category-ring");
  ring.classList.toggle("preview", index >= 0 && total > 0);
  if (index >= 0 && total > 0) {
    const before = categories.slice(0, index).reduce((sum, [, cents]) => sum + cents, 0);
    ring.style.setProperty("--slice-start", before / total * 100 + "%");
    ring.style.setProperty("--slice-end", (before + categories[index][1]) / total * 100 + "%");
  }
  $("ring-label").textContent = index < 0 ? "日常开支" : categories[index][0];
  $("ring-total").textContent = money(index < 0 ? total : categories[index][1]);
}

function sortedRows(rows, mode, amount = row => row.net) {
  return [...rows].sort((a, b) => {
    const byTime = a.time.localeCompare(b.time) || a.id - b.id;
    if (mode === "highest") return amount(b) - amount(a) || -byTime;
    if (mode === "lowest") return amount(a) - amount(b) || -byTime;
    return mode === "oldest" ? byTime : -byTime;
  });
}

// 列表在保存分类后会重新渲染，关闭面板时按流水找到原来的入口。
const sheetOrigins = new WeakMap();

function openSheet(dialog, trigger) {
  if (!dialog.open) {
    sheetOrigins.set(dialog, {trigger, container: trigger.closest("[id]"), hash: location.hash});
    dialog.showModal();
  }
  dialog.querySelector(".sheet-notice").hidden = true;
  dialog.querySelector(".sheet-scroll").scrollTop = 0;
  dialog.querySelector("[data-dismiss]").focus({preventScroll: true});
}

function restoreSheetFocus(dialog) {
  const origin = sheetOrigins.get(dialog);
  if (!origin || origin.hash !== location.hash || dialog.open) return;
  let target = origin.trigger;
  if (!target.isConnected) {
    const key = target.hasAttribute("data-trade") ? "trade" : "fund";
    target = [...origin.container.querySelectorAll(`[data-${key}]`)].find(el => el.dataset[key] === origin.trigger.dataset[key]);
  }
  const fallback = document.querySelector("#overview-sheet[open] [data-dismiss]") || $("title");
  (target || fallback).focus({preventScroll: true});
}

function overviewSheet(section, title, trigger) {
  for (const panel of $("sheet-scroll").children) panel.hidden = panel.id !== section;
  $("sheet-title").textContent = title;
  const period = $("period");
  const range = period.value === "custom" ? [$("start").value || "最早", $("end").value || "今天"].join(" 至 ") :
    period.selectedOptions[0].textContent;
  $("sheet-range").textContent = section === "budget-manage" ? $("budget-period").textContent : range + " · " + ($("platform").value || "全平台");
  openSheet($("overview-sheet"), trigger);
}

function budgetTab(tab) {
  for (const item of tab.parentElement.children) {
    const active = item === tab;
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
    $(item.getAttribute("aria-controls")).hidden = !active;
  }
  $("sheet-scroll").scrollTop = 0;
}

function openDrill(kind, trigger) {
  state.drill = kind;
  $("drill-category").value = "";
  $("back-audit").hidden = kind !== "included";
  overviewSheet("drill", kind === "daily" ? "日常开支明细" : "已计入消费明细", trigger);
  renderDrill();
}

function renderFundOrders() {
  const fund = state.ledger.funds.find(([name]) => name === state.fund);
  const rows = state.ledger.rows.filter(row => row.fund === state.fund);
  $("fund-name").textContent = state.fund;
  $("fund-total").textContent = money(fund ? fund[1].cents : 0);
  $("fund-list").innerHTML = rows.map(row => tradeRow(row, {gross: true})).join("");
}

function renderDrill(selectedCategory = $("drill-category").value) {
  if (!state.drill || $("drill").hidden || !$("overview-sheet").open) return;
  const daily = state.drill === "daily";
  const rows = state.ledger.rows.filter((r) => daily ? r.daily : r.bucket === "已计入");
  const category = r => daily ? (r.daily_category || r.category) : r.category;
  const names = new Set(rows.map(category));
  $("drill-category").replaceChildren(new Option("全部用途", ""), ...Array.from(names).sort().map(n => new Option(n, n)));
  $("drill-category").value = names.has(selectedCategory) ? selectedCategory : "";
  $("drill-chart-title").textContent = daily ? "日常开支构成" : "已计入消费构成";
  $("daily-bars").innerHTML = daily ? categoryBars(state.ledger.daily_categories, "已确认日常", true) :
    categoryBars(state.ledger.categories, "已计入", true);
  const visible = rows.filter((r) => !$("drill-category").value || category(r) === $("drill-category").value);
  const amount = r => daily ? (r.daily_cents ?? r.personal ?? 0) : r.net;
  $("drill-total").textContent = visible.length + " 笔 · " + money(visible.reduce((total, r) => total + amount(r), 0));
  $("drill-trades").innerHTML = sortedRows(visible, $("drill-sort").value, amount).map(r => tradeRow(r, {dailyView: daily})).join("") ||
    '<p class="hint">当前范围没有符合条件的消费。</p>';
}

function displayedAmount(row, basis) {
  const net = row.outflow ? row.personal : row.net;
  const amount = basis === "daily" ? row.daily_cents ?? net : basis === "gross" ? row.cents : net;
  const incoming = row.direction === "收入" && row.income_status !== "waiting";
  const sign = amount > 0 ? (incoming ? "+" : row.outflow ? "−" : "") : "";
  return {net, incoming, text: amount === null ? "退款待核对" : sign + money(amount)};
}

function renderTradeDetails() {
  const row = state.ledger.rows.find(item => item.id === state.tradeId);
  if (!row) { $("trade-sheet").close(); return; }
  const info = [];
  if (row.product && row.product !== "/") info.push(["商品说明", row.product]);
  info.push(["交易时间", row.time], ["支付平台", row.platform], ["收支类型", row.direction],
    ["交易状态", row.status], ["订单号", row.order_id], ["原始金额", money(row.cents)]);
  const ledger = [["用途", row.category], ["统计状态", row.bucket]];
  if (row.outflow) info.push(["个人实付", row.personal === null ? "退款待核对" : money(row.personal)]);
  if (row.loan) {
    ledger.push(["已还本金", money(row.loan.repaid)], ["待还本金", money(row.loan.outstanding)]);
    if (row.loan.closed) ledger.push(["结清差额计日常", money(row.loan.daily_loss)]);
  }
  if (row.note) ledger.push(["备注", row.note]);
  if (row.outflow) ledger.push(["日常归属", row.daily_choice === "yes" ? "日常" : row.daily_choice === "no" ? "非日常" : "待确认"],
    ["判断来源", row.daily_lock || (row.manual_daily ? "手动选择" : row.over_daily_cap ? "超过单笔上限，默认非日常" : row.daily_source === "peers" ? "同商户同类商品的人工标记一致" : row.daily_source === "conflict" ? "人工标记有分歧" : row.daily_choice ? "自动初分" : "证据不足")]);
  for (const receipt of row.receipts) ledger.push(["群收款抵扣", receipt.time.slice(0, 10) + " · " + receipt.merchant + " · " + money(receipt.cents)]);
  if (row.over_daily_cap && row.daily && !row.daily_lock) ledger.push(["上限例外", "已手动计入"]);
  if (row.group_receipt && row.linked_expense_id) ledger.push(["关联付款", row.linked_merchant]);
  let edit = "";
  if (row.editable) {
    edit = `<button class="quiet" data-edit="${row.id}">编辑用途</button>`;
  } else if (row.group_receipt) {
    edit = `<button class="quiet" data-receipt="${row.id}">关联付款</button>`;
  }
  if (row.outflow && !row.daily_lock) {
    const choices = [["", "待确认"], ["yes", "计入日常"], ["no", "非日常"]];
    edit += `<select class="daily-select" data-daily="${row.id}" aria-label="日常归属 · ${escapeHTML(row.merchant)}">${choices.map(
      ([value, label]) => `<option value="${value}"${value === (row.daily_choice || "") ? " selected" : ""}>${label}</option>`
    ).join("")}</select>`;
  }
  const shown = displayedAmount(row, state.tradeBasis);
  const basisLabel = state.tradeBasis === "gross" ? "账单原额" : state.tradeBasis === "daily" ? "计入日常" :
    row.outflow ? "个人实付" : row.direction === "收入" ? (row.income_status === "waiting" ? "待到账金额" : "收入金额") : "流水金额";
  const body = $("trade-content");
  const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset : null;
  const facts = entries => `<dl class="sheet-facts">${entries.map(([label,value]) =>
    `<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join("")}</dl>`;
  body.innerHTML = `<div class="amount-block receipt-head"><h3>${escapeHTML(merchantLabel(row))}</h3>
    <strong class="${shown.incoming ? "income" : ""}">${shown.text}</strong><small>${basisLabel}</small></div>
    <section class="receipt-section"><h3>账本归属</h3>${facts(ledger)}${edit ? `<div class="bill-actions">${edit}</div>` : ""}</section>
    <section class="receipt-section"><h3>交易信息</h3>${facts(info)}</section>`;
  if (focusKey) {
    const selector = focusKey.daily ? "[data-daily]" : focusKey.edit ? "[data-edit]" : "[data-receipt]";
    body.querySelector(selector)?.focus({preventScroll: true});
  }
}

function tradeRow(row, {gross = false, dailyView = false, columns = false} = {}) {
  const basis = dailyView ? "daily" : gross ? "gross" : "net";
  const {net, incoming, text} = displayedAmount(row, basis);
  const waiting = row.income_status === "waiting";
  const badge = ({"餐饮":"meal", "校园消费":"meal", "日用":"bag", "美团":"bag", "医疗":"health",
    "交通":"transit", "休闲":"ticket", "投资理财":"trend", "收入":"transfer", "内部划转":"transfer"})[row.category] || "wallet";
  const product = row.product && row.product !== "/" ? row.product : row.category;
  const platform = escapeHTML(row.platform);
  const time = escapeHTML(row.time.slice(5, 16));
  return `<button type="button" class="bill" data-trade="${row.id}" data-basis="${basis}" aria-haspopup="dialog"><span class="bill-icon bill-${badge}" aria-hidden="true"><svg class="icon"><use href="#icon-${badge}"/></svg></span>
      <span class="bill-text"><strong>${escapeHTML(merchantLabel(row))}</strong><small>${waiting ? "待到账 · " : ""}<span class="inline-context">${platform} · </span>${escapeHTML(product)}<span class="inline-context"> · ${time}</span></small></span>
      ${columns ? `<span class="bill-platform">${platform}<small>${time}</small></span>` : ""}
      <span class="bill-amount${incoming ? " income" : ""}">${text}${net !== row.cents ?
        `<small>${gross ? (net === null ? "退款待核对" : "实付 " + money(net)) : "原付 " + money(row.cents)}</small>` : ""}</span>
      <span class="arrow" aria-hidden="true">›</span></button>`;
}

function merchantLabel(row) {
  const name = row.merchant.trim();
  return name && name !== "/" ? name : "未标明商户";
}

function renderMerchants(rows, amount) {
  const merchants = new Map();
  for (const row of rows) {
    const name = merchantLabel(row);
    const group = merchants.get(name) || {count: 0, cents: 0};
    group.count++;
    group.cents += amount(row);
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
    const text = normalize([row.merchant, row.product, row.category, row.daily_category, row.note, row.order_id,
      row.time, row.platform, row.direction, row.bucket, row.status, row.source_category].join(" "));
    return terms.every(term => term.cents === row.cents || term.cents === row.net || term.cents === row.personal || (row.daily && term.cents === row.daily_cents) ||
      (!term.amountOnly && text.includes(term.word)));
  };
}

function renderDetails() {
  if (!state.ledger) return;
  const bucket = $("bucket").value;
  const matchesSearch = transactionSearch($("search").value);
  const dailyFilters = {"日常待确认": null, "已确认日常": "yes", "已确认非日常": "no"};
  const gross = bucket === "全部支出" || bucket === "日常待确认" || bucket === "已确认非日常";
  const dailyView = bucket === "已确认日常";
  const amount = r => dailyView ? (r.daily_cents ?? r.personal ?? 0) : gross ? r.cents : r.outflow ? r.personal || 0 : r.net;
  const matchesBucket = row => {
    if (bucket === "实际支付") return row.payment;
    if (bucket === "全部支出") return row.outflow;
    if (Object.hasOwn(dailyFilters, bucket)) return row.outflow && row.daily_choice === dailyFilters[bucket];
    return !bucket || row.bucket === bucket;
  };
  const matching = state.ledger.rows.filter((row) => matchesBucket(row) &&
    (!state.category || (dailyView ? row.daily_category || row.category : row.category) === state.category) && matchesSearch(row));
  if (state.category) {
    $("merchant-amount").textContent = dailyView ? "日常开支" : "个人实付";
    renderMerchants(matching, amount);
  }
  const rows = state.merchant === null ? matching : matching.filter(row => merchantLabel(row) === state.merchant);
  $("clear-merchant").hidden = state.merchant === null;
  if (state.merchant !== null) $("clear-merchant").textContent = "清除商户筛选 · " + state.merchant + " ×";
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.listPage = Math.min(state.listPage, pages);
  const offset = (state.listPage - 1) * pageSize;
  const sort = $("detail-sort").value;
  let previousDay = "";
  $("trades").innerHTML = sortedRows(rows, sort, amount).slice(offset, offset + pageSize).map(row => {
    const day = row.time.slice(0, 10);
    const heading = (sort === "recent" || sort === "oldest") && day !== previousDay
      ? `<h3 class="bill-date">${escapeHTML(day)}</h3>` : "";
    previousDay = day;
    return heading + tradeRow(row, {gross, dailyView, columns: true});
  }).join("") || '<p class="hint">没有符合条件的交易。</p>';
  $("row-count").textContent = rows.length + " 笔交易" + (gross || state.category || bucket === "已确认日常" || bucket === "医疗单列" || bucket === "实际支付" ?
    (gross ? " · 原付合计 " : dailyView ? " · 日常开支合计 " : " · 已知实付合计 ") + money(rows.reduce((sum, row) => sum + amount(row), 0)) : "");
  if (bucket === "实际支付") {
    const unpriced = rows.filter(row => row.personal === null).length;
    if (unpriced) $("row-count").textContent += " · " + unpriced + " 笔退款待核对，暂未计入";
  }
  $("pager").hidden = pages <= 1;
  $("previous").disabled = state.listPage === 1;
  $("next").disabled = state.listPage === pages;
  $("page-number").textContent = state.listPage + " / " + pages;
}

function setExceptionVisibility(row) {
  $("exception-field").hidden = !state.ledger.over_cap_categories.includes($("category").value) ||
    !(row.over_daily_cap || row.include_over_cap);
}

function openEditor(id) {
  const row = state.ledger.rows.find((item) => item.id === id);
  state.editId = id;
  $("trade-label").textContent = row.time + " · " + row.merchant + " · " + money(row.cents);
  $("category").replaceChildren(...state.ledger.choices.map((item) => new Option(item, item)));
  $("category").value = row.category;
  $("note").value = row.note;
  setExceptionVisibility(row);
  $("exception").defaultChecked = row.over_daily_cap ? row.daily && !row.daily_lock : Boolean(row.include_over_cap && row.daily);
  $("exception").checked = $("exception").defaultChecked;
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
  const trade = event.target.closest("[data-trade]");
  if (trade) {
    state.tradeId = Number(trade.dataset.trade);
    state.tradeBasis = trade.dataset.basis;
    renderTradeDetails();
    const parentSheet = trade.closest("dialog");
    $("trade-sheet").querySelector("[data-dismiss]").setAttribute("aria-label", parentSheet ? "返回" + $("sheet-title").textContent : "关闭交易详情");
    openSheet($("trade-sheet"), trade);
    return;
  }
  const edit = event.target.closest("[data-edit]");
  if (edit) return openEditor(Number(edit.dataset.edit));
  const receipt = event.target.closest("[data-receipt]");
  if (receipt) await openReceipt(Number(receipt.dataset.receipt));
}

// 文件选择器每次只返回本次选择。队列允许从不同目录继续追加微信和支付宝文件。
const importQueue = new Map();
function queueFiles(files) {
  for (const file of files) {
    const key = JSON.stringify([file.name, file.size, file.lastModified]);
    importQueue.set(key, file);
  }
  $("files").value = "";
  renderImportQueue();
}

function renderImportQueue() {
  const items = [];
  for (const [key, file] of importQueue) {
    const item = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "row-action";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", "移除 " + file.name);
    remove.onclick = () => { importQueue.delete(key); renderImportQueue(); };
    item.append(name, remove);
    items.push(item);
  }
  $("selected-files").replaceChildren(...items);
  $("selected-files").hidden = !items.length;
  $("file-label").textContent = items.length ? "继续添加文件" : "选择账单文件";
  $("upload").textContent = items.length ? "导入 " + items.length + " 份账单" : "导入所选文件";
  $("upload").disabled = !items.length;
}

async function importFiles() {
  const batch = [...importQueue];
  if (!batch.length || $("upload").disabled) return;
  $("upload").disabled = true;
  $("upload").setAttribute("aria-busy", "true");
  $("upload").textContent = "正在导入 " + batch.length + " 份账单…";
  $("files").disabled = true;
  $("selected-files").inert = true;
  $("import-results").replaceChildren();
  try {
    await Promise.all(batch.map(async ([key, file]) => {
      const line = document.createElement("p");
      $("import-results").append(line);
      line.textContent = file.name + " · 正在导入…";
      try {
        const result = await request("/api/import?" + new URLSearchParams({filename: file.name}), {
          method: "POST", headers: {"X-NMoney": "1", "Content-Type": "application/octet-stream"}, body: file
        });
        line.textContent = file.name + " · 新增 " + result.added + " 笔，更新 " + result.changed + " 笔，重复 " + result.skipped + " 笔。";
        importQueue.delete(key);
      } catch (error) {
        line.textContent = file.name + " · " + error.message;
        line.className = "error";
      }
    }));
    await refresh();
  } finally {
    $("upload").removeAttribute("aria-busy");
    $("files").disabled = false;
    $("selected-files").inert = false;
    renderImportQueue();
  }
}

function on(id, event, action) {
  $(id).addEventListener(event, async (e) => {
    if (event === "submit") e.preventDefault();
    try { await action(e); } catch (error) { notice(error.message, true); }
  });
}

function bindLedger() {
  for (const tab of document.querySelectorAll("nav button")) tab.onclick = () => {
    location.hash = tab.dataset.page === "clusters" ? rangedHref(new URLSearchParams({page: "clusters"})) : tab.dataset.page;
  };
  window.addEventListener("hashchange", () => {
    for (const dialog of [...document.querySelectorAll("dialog[open]")].reverse()) dialog.close();
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
  on("base-form", "submit", async () => {
    await post("/api/budget/base", {month: state.ledger.budget.month, cents: Math.round(Number($("base-amount").value) * 100)});
    await refresh();
  });
  on("budget-lending", "change", async () => {
    await post("/api/budget/lending", {value: Number($("budget-lending").value)});
    await refresh();
  });
  on("income-form", "input", () => $("income-form").removeAttribute("data-entry-key"));
  on("income-form", "submit", async () => {
    const form = $("income-form");
    const month = state.ledger.budget.month;
    const button = form.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    form.dataset.entryKey ??= crypto.randomUUID();
    try {
      await post("/api/budget/supplement", {month, id: form.dataset.entryKey, label: $("income-label").value,
        cents: Math.round(Number($("income-amount").value) * 100)});
      form.reset();
      form.removeAttribute("data-entry-key");
      await refresh();
    } finally { button.disabled = false; }
  });
  on("supplements", "click", async e => {
    const button = e.target.closest("[data-remove-income]");
    if (!button) return;
    await post("/api/budget/supplement", {id: button.dataset.removeIncome, month: state.ledger.budget.month, cents: null});
    await refresh();
  });
  on("budget-loans", "click", async e => {
    const button = e.target.closest("[data-settle-loan]");
    if (!button) return;
    const loan = state.ledger.budget.loans.find(item => item.id === Number(button.dataset.settleLoan));
    await post("/api/loans/settle", {loan_id: loan.id, closed: !loan.closed});
    await refresh();
  });
  on("budget-incomes", "change", async e => {
    const select = e.target.closest("[data-income-id]");
    if (!select) return;
    const [kind, id] = select.value.split(":");
    try { await post("/api/budget/income", {id: Number(select.dataset.incomeId), kind: kind === "loan" ? "repayment" : kind, loan_id: kind === "loan" ? Number(id) : null, supplement_id: id}); }
    finally { await refresh(); }
  });
  const capControl = $("cap-control");
  document.addEventListener("pointerdown", e => {
    if (capControl.open && !capControl.contains(e.target)) capControl.open = false;
  });
  capControl.addEventListener("keydown", e => {
    if (e.key === "Escape" && capControl.open) {
      capControl.open = false;
      capControl.querySelector("summary").focus();
    }
  });
  on("cap-form", "submit", async () => {
    await post("/api/cap", {cents: Math.round(Number($("cap").value) * 100)});
    await refresh();
    $("cap-control").open = false;
    notice("已保存上限，合计已重新计算。");
  });
  on("review-only", "change", renderClusters);
  const legend = $("categories");
  const focusedCategory = () => legend.querySelector(".category-row:focus");
  legend.addEventListener("pointerover", event => {
    if (event.pointerType !== "touch") previewCategory(event.target.closest(".category-row") || focusedCategory());
  });
  legend.addEventListener("pointerleave", () => previewCategory(focusedCategory()));
  legend.addEventListener("focusin", event => previewCategory(event.target.closest(".category-row")));
  legend.addEventListener("focusout", event => {
    previewCategory(legend.contains(event.relatedTarget) ? event.relatedTarget.closest(".category-row") : null);
  });
  on("open-budget", "click", e => {
    budgetTab($("tab-income"));
    overviewSheet("budget-manage", "收入明细与预算设置", e.currentTarget);
  });
  on("open-audit", "click", e => overviewSheet("payment-audit", "支付流水对账", e.currentTarget));
  on("back-audit", "click", e => {
    overviewSheet("payment-audit", "支付流水对账", e.currentTarget);
    $("open-included").focus();
  });
  on("open-included", "click", e => openDrill("included", e.currentTarget));
  on("open-daily", "click", e => openDrill("daily", e.currentTarget));
  on("funds", "click", e => {
    const trigger = e.target.closest("[data-fund]");
    if (!trigger) return;
    state.fund = trigger.dataset.fund;
    renderFundOrders();
    overviewSheet("fund-orders", "理财买入明细", trigger);
  });
  const tabs = [...document.querySelectorAll(".sheet-tabs [role=tab]")];
  for (const [i, tab] of tabs.entries()) {
    tab.onclick = () => budgetTab(tab);
    tab.onkeydown = e => {
      const next = {ArrowRight: (i+1) % tabs.length, ArrowLeft: (i+tabs.length-1) % tabs.length, Home: 0, End: tabs.length-1}[e.key];
      if (next === undefined) return;
      e.preventDefault();
      budgetTab(tabs[next]);
      tabs[next].focus();
    };
  }
  for (const dialog of document.querySelectorAll("dialog.sheet")) {
    dialog.querySelector("[data-dismiss]").onclick = () => dialog.close();
    dialog.addEventListener("close", () => restoreSheetFocus(dialog));
  }
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
  for (const id of ["trades", "trade-content", "fund-list", "drill-trades", "aa-list", "cluster-list", "recent-list"]) on(id, "click", rowAction);
  on("cluster-list", "click", async event => {
    const button = event.target.closest("[data-group]");
    if (!button) return;
    const rows = state.clusters[Number(button.dataset.group)];
    const ids = rows.filter(r => !r.daily_choice).map(r => r.id);
    const buttons = button.parentElement.querySelectorAll("button");
    buttons.forEach(b => b.disabled = true);
    try {
      const result = await post("/api/daily", {ids, choice: button.dataset.choice, pending_only: true});
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
      await post("/api/daily", {ids: [id], choice: select.value || null});
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
  on("dialog-close", "click", () => $("editor").close());
  on("aa-dialog-close", "click", () => $("aa-editor").close());
  for (const id of ["editor", "aa-editor", "overview-sheet", "trade-sheet"]) {
    $(id).addEventListener("click", event => {
      if (event.target !== $(id)) return;
      const bounds = $(id).getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $(id).close();
    });
  }
  on("category", "change", () => setExceptionVisibility(state.ledger.rows.find(r => r.id === state.editId)));
  on("edit-form", "submit", async () => {
    try {
      await post("/api/annotate", { id: state.editId, category: $("category").value,
        note: $("note").value, rule: $("rule").value,
        include_over_cap: !$("exception-field").hidden && $("exception").checked !== $("exception").defaultChecked
          ? $("exception").checked : null });
    } catch (error) {
      $("edit-error").textContent = error.message;
      return;
    }
    $("editor").close();
    await refresh();
    notice("用途已保存。");
  });
  on("files", "change", () => queueFiles($("files").files));
  for (const eventName of ["dragenter", "dragover"]) {
    $("file-drop").addEventListener(eventName, event => {
      event.preventDefault();
      $("file-drop").classList.add("dragging");
    });
  }
  $("file-drop").addEventListener("dragleave", () => $("file-drop").classList.remove("dragging"));
  $("file-drop").addEventListener("drop", event => {
    event.preventDefault();
    $("file-drop").classList.remove("dragging");
    if (!$("files").disabled) queueFiles(event.dataTransfer.files);
  });
  on("import-form", "submit", importFiles);
  Promise.resolve().then(applyRoute).catch((error) => notice(error.message, true));
}

bindLedger();
