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
  notice("");
}

function categoryHref(name) {
  const params = new URLSearchParams({category: name, period: $("period").value});
  if ($("platform").value) params.set("platform", $("platform").value);
  if ($("period").value === "custom") {
    for (const id of ["start", "end"]) if ($(id).value) params.set(id, $(id).value);
  }
  return "#" + params;
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
  $("search").value = "";
  $("bucket").value = state.category ? "已计入" : params.get("bucket") || "";
  $("bucket-field").hidden = Boolean(state.category);
  $("back-overview").hidden = !state.category;
  if (state.category) {
    const period = params.get("period") ?? "current";
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && !Array.from($("period").options).some(o => o.value === period)) {
      $("period").add(new Option(period, period));
    }
    $("period").value = period;
    $("platform").value = params.get("platform") || "";
    for (const id of ["start", "end"]) $(id).value = params.get(id) || "";
    $("custom-dates").hidden = period !== "custom";
    navigate("details");
    $("title").textContent = state.category + "明细";
  } else {
    const detail = hash === "details" || params.has("bucket");
    navigate(detail ? "details" : hash === "imports" ? "imports" : "overview");
  }
  const changedRange = rangeIds.some((id, i) => $(id).value !== previousRange[i]);
  if (!state.ledger || changedRange) return refresh();
  renderDetails();
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
  const data = await request("/api/ledger?" + periodQuery());
  if (version !== state.request) return;
  if (!Number.isInteger(data.known_spending)) {
    throw new Error("账本服务需要重启。请在运行账本的终端按 Ctrl+C，再双击「启动账本.command」。");
  }
  mergeLegacyCategories(data);
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
}

function renderOverview(data) {
  $("known-spending").textContent = money(data.known_spending);
  $("spending-equation").textContent = "已计入 " + money(data.groups["已计入"].cents) +
    " ＋ 超上限且用途已知 " + money(data.known_over_cap);
  $("receipt-deduction").textContent = "已扣除原付款关联的群收款 " + money(data.deducted_receipts) +
    "。理财买入、借出和代付另记。";
  const cards = { "已计入": "included", "日常生活": "daily", "待分类": "pending", "超上限": "over" };
  for (const [key, id] of Object.entries(cards)) {
    const group = data.groups[key];
    $(id).textContent = money(group.cents);
    $(id + "-count").textContent = group.count + " 笔" + (id === "pending" || id === "over" ? " · 未计入" : " · 查看明细");
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
    <tr><td>${escapeHTML(month)}</td><td>${values.count}</td>
      <td class="money">${money(values.cents)}</td><td class="money">${money(values.invested)}</td></tr>`).join("");
  $("months").innerHTML = periods ? `<div class="table-scroll"><table>
    <thead><tr><th>月份</th><th>计入笔数</th><th class="money">个人消费</th><th class="money">理财买入</th></tr></thead>
    <tbody>${periods}</tbody></table></div>` : '<p class="hint">当前范围内没有交易。</p>';
}

// 同一份分类汇总绘制概览和日常生活的条形图，标签始终显示精确到分的金额。
function bars(categories) {
  const total = categories.reduce((sum, [, cents]) => sum + cents, 0);
  return categories.map(([name, value]) => `
    <a class="bar-row" href="${escapeHTML(categoryHref(name))}" title="查看${escapeHTML(name)}明细">
      <span>${escapeHTML(name)}</span>
      <span class="track"><span class="bar" style="width:${total ? 100 * value / total : 0}%"></span></span>
      <span class="share">${total ? (100 * value / total).toFixed(1) : "0.0"}%</span>
      <span class="money">${money(value)}</span>
      <span class="bar-arrow" aria-hidden="true">›</span>
    </a>`).join("") || '<p class="hint">当前范围内没有符合条件的消费。</p>';
}

function sortedRows(rows, mode) {
  return [...rows].sort((a, b) => {
    const byTime = a.time.localeCompare(b.time) || a.id - b.id;
    if (mode === "highest") return b.net - a.net || -byTime;
    if (mode === "lowest") return a.net - b.net || -byTime;
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
  $("drill-title").textContent = daily ? "日常生活明细" : "已计入消费明细";
  $("daily-chart").hidden = !daily;
  if (daily) $("daily-bars").innerHTML = bars(state.ledger.categories.filter(([name]) => names.has(name)));
  const visible = rows.filter((r) => !$("drill-category").value || r.category === $("drill-category").value);
  $("drill-total").textContent = visible.length + " 笔 · " + money(visible.reduce((total, r) => total + r.net, 0));
  $("drill-trades").innerHTML = sortedRows(visible, $("drill-sort").value).map(tradeRow).join("") ||
    '<tr><td colspan="6">当前范围内没有符合条件的消费。</td></tr>';
}

function tradeRow(row) {
  const tagClass = { "待分类": "pending", "已计入": "included" }[row.bucket] || "";
  const info = [row.platform, row.direction, row.status, "订单号 " + row.order_id];
  if (row.note) info.push("备注 " + row.note);
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
  return `<tr>
    <td><time>${escapeHTML(row.time.slice(0, 10))}</time>
      <small>${escapeHTML(row.platform)} · ${escapeHTML(row.time.slice(11))}</small></td>
    <td><details><summary>${escapeHTML(row.merchant)}</summary>
      <small>${info.map(escapeHTML).join("<br>")}</small></details><small>${escapeHTML(row.product)}</small></td>
    <td>${escapeHTML(row.category)}</td>
    <td><span class="tag ${tagClass}">${escapeHTML(row.bucket)}</span></td>
    <td class="money">${money(row.net)}${row.net !== row.cents ? `<small>原付 ${money(row.cents)}</small>` : ""}</td><td>${edit}</td>
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
    group.cents += row.net;
    merchants.set(name, group);
  }
  $("merchant-list").innerHTML = [...merchants].sort((a, b) => b[1].cents - a[1].cents ||
    a[0].localeCompare(b[0], "zh-CN")).map(([name, group]) => `<tr>
      <td><button class="row-action" data-merchant="${escapeHTML(name)}">${escapeHTML(name)}</button></td>
      <td class="money">${group.count}</td><td class="money">${money(group.cents)}</td></tr>`).join("") ||
    '<tr><td colspan="3">当前范围内没有商户交易。</td></tr>';
}

function renderDetails() {
  if (!state.ledger) return;
  const bucket = $("bucket").value;
  const term = $("search").value.trim().toLowerCase();
  const matching = state.ledger.rows.filter((row) => (!bucket || row.bucket === bucket) &&
    (!state.category || row.category === state.category) &&
    [row.merchant, row.product, row.category, row.note, row.order_id, row.status].join(" ").toLowerCase().includes(term));
  if (state.category) renderMerchants(matching);
  const rows = state.merchant === null ? matching : matching.filter(row => merchantLabel(row) === state.merchant);
  $("clear-merchant").hidden = state.merchant === null;
  if (state.merchant !== null) $("clear-merchant").textContent = "清除商户筛选 · " + state.merchant + " ×";
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.listPage = Math.min(state.listPage, pages);
  const offset = (state.listPage - 1) * pageSize;
  $("trades").innerHTML = sortedRows(rows, $("detail-sort").value).slice(offset, offset + pageSize).map(tradeRow).join("") ||
    '<tr><td colspan="6">没有符合条件的交易。</td></tr>';
  $("row-count").textContent = rows.length + " 笔交易" + (state.category ?
    " · 个人实付合计 " + money(rows.reduce((sum, row) => sum + row.net, 0)) : "");
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

for (const tab of document.querySelectorAll("nav button")) tab.onclick = () => { location.hash = tab.dataset.page; };
window.addEventListener("hashchange", () => {
  Promise.resolve().then(applyRoute).catch(error => notice(error.message, true));
  $("title").focus();
  window.scrollTo(0, 0);
});
for (const id of ["period", "start", "end", "platform"]) {
  on(id, "change", () => {
    notice("");
    state.listPage = 1;
    if (state.category) history.replaceState(null, "", categoryHref(state.category));
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
on("open-pending", "click", () => { location.hash = new URLSearchParams({bucket: "待分类"}); });
on("open-over", "click", () => { location.hash = new URLSearchParams({bucket: "超上限"}); });
on("bucket", "change", () => { state.listPage = 1; renderDetails(); });
on("search", "input", () => { state.listPage = 1; renderDetails(); });
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
for (const id of ["trades", "drill-trades", "aa-list"]) on(id, "click", rowAction);
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
