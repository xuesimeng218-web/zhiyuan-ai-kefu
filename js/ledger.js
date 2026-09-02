(function () {
  "use strict";

  const ENTRIES_KEY = "zy_kb_ledger_entries_v1";
  const PARTNERS_KEY = "zy_kb_ledger_partners_v1";
  const STATE_KEY = "zy_kb_ledger_state_v1";
  const CUSTOMER_CODES_KEY = "zy_kb_customer_codes_v1";
  const BACKUP_TYPE = "zy-kb-ledger-backup";
  const SCHEMA_VERSION = 1;
  const CUSTOMER_CODE_PATTERN = /^C\d{6}$/;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_PATTERN = /^\d{2}:\d{2}$/;
  const VIEWS = new Set(["overview", "expenses", "income"]);
  const EXPENSE_CATEGORIES = new Set(["第三方代充", "其他支出"]);
  const INVOICE_ELIGIBILITY = new Set(["unknown", "available", "unavailable"]);
  const INVOICE_STATUS = new Set(["unissued", "issued", "not_applicable"]);
  const DEFAULT_FILTERS = Object.freeze({
    expenses: {
      dateFrom: "",
      dateTo: "",
      category: "all",
      partner: "",
      invoiceStatus: "all",
      keyword: "",
    },
    income: {
      dateFrom: "",
      dateTo: "",
      customer: "",
      product: "",
      paymentMethod: "",
      keyword: "",
    },
  });

  let initialized = false;
  let entries = [];
  let partners = [];
  let state = createDefaultState();
  let storageMessage = "";
  let importPreview = null;

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function two(value) {
    return String(value).padStart(2, "0");
  }

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  }

  function localTime(date = new Date()) {
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  function currentMonth() {
    return localDate().slice(0, 7);
  }

  function createDefaultState() {
    return {
      version: SCHEMA_VERSION,
      view: "overview",
      month: currentMonth(),
      filters: structuredClone(DEFAULT_FILTERS),
    };
  }

  function validDate(value) {
    if (!DATE_PATTERN.test(String(value || ""))) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function validTime(value) {
    if (value === "") return true;
    if (!TIME_PATTERN.test(String(value || ""))) return false;
    const [hour, minute] = value.split(":").map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  }

  function validMonth(value) {
    if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return false;
    const month = Number(value.slice(5));
    return month >= 1 && month <= 12;
  }

  function safeText(value, max = 500) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function createId(prefix) {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${suffix}`;
  }

  function parseAmountToCents(value) {
    const raw = String(value ?? "").trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) return null;
    const [whole, decimal = ""] = raw.split(".");
    const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function money(cents) {
    return `¥${(Number(cents || 0) / 100).toFixed(2)}`;
  }

  function notify(message) {
    if (typeof globalThis.toast === "function") globalThis.toast(message);
    else alert(message);
  }

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? { missing: true, value: null } : { missing: false, value: JSON.parse(raw) };
    } catch (error) {
      return { error };
    }
  }

  function writeJson(key, value, quiet = false) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      storageMessage = "记账台数据保存失败，请检查浏览器存储空间或权限。";
      if (!quiet) alert(storageMessage);
      return false;
    }
  }

  function normalizePartner(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = safeText(raw.id, 160);
    const name = safeText(raw.name, 100);
    const createdAt = safeText(raw.createdAt, 60);
    const updatedAt = safeText(raw.updatedAt || raw.createdAt, 60);
    if (!id || !name || !createdAt || Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
    return { id, name, createdAt, updatedAt };
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const type = raw.type;
    const category = safeText(raw.category, 40);
    const id = safeText(raw.id, 180);
    const amountCents = Number(raw.amountCents);
    const date = safeText(raw.date, 10);
    const time = safeText(raw.time, 5);
    const createdAt = safeText(raw.createdAt, 60);
    const updatedAt = safeText(raw.updatedAt, 60);
    if (
      !id ||
      !["income", "expense"].includes(type) ||
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      !validDate(date) ||
      !validTime(time) ||
      !createdAt ||
      !updatedAt ||
      Number.isNaN(Date.parse(createdAt)) ||
      Number.isNaN(Date.parse(updatedAt))
    ) return null;
    if (type === "expense" && !EXPENSE_CATEGORIES.has(category)) return null;
    if (type === "income" && category !== "客户付款") return null;
    const customerCode = safeText(raw.customerCode, 20);
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) return null;
    const invoiceEligibility = type === "expense" ? safeText(raw.invoiceEligibility, 30) : "";
    const invoiceStatus = type === "expense" ? safeText(raw.invoiceStatus, 30) : "";
    if (type === "expense") {
      if (!INVOICE_ELIGIBILITY.has(invoiceEligibility) || !INVOICE_STATUS.has(invoiceStatus)) return null;
      if (invoiceEligibility === "unavailable" && invoiceStatus !== "not_applicable") return null;
      if (invoiceEligibility === "available" && !["unissued", "issued"].includes(invoiceStatus)) return null;
    }
    return {
      id,
      type,
      category,
      amountCents,
      date,
      time,
      partnerId: safeText(raw.partnerId, 180),
      payee: safeText(raw.payee, 160),
      customerCode,
      customerName: safeText(raw.customerName, 120),
      product: safeText(raw.product, 160),
      paymentMethod: safeText(raw.paymentMethod, 100),
      invoiceEligibility,
      invoiceStatus,
      orderDescription: safeText(raw.orderDescription, 300),
      remark: safeText(raw.remark, 500),
      createdAt,
      updatedAt,
    };
  }

  function loadCollection(key, field, normalize) {
    const result = readJson(key);
    if (result.error) {
      storageMessage = "记账台数据读取失败，已停止写入以保护原数据。";
      return [];
    }
    if (result.missing) {
      writeJson(key, { version: SCHEMA_VERSION, [field]: [] }, true);
      return [];
    }
    const documentValue = result.value;
    if (!documentValue || typeof documentValue !== "object" || documentValue.version !== SCHEMA_VERSION || !Array.isArray(documentValue[field])) {
      storageMessage = "记账台数据结构异常，已停止写入以保护原数据。";
      return [];
    }
    const normalized = [];
    const seen = new Set();
    for (const item of documentValue[field]) {
      const next = normalize(item);
      if (!next || seen.has(next.id)) {
        storageMessage = "记账台存在无法识别的数据，已停止写入以保护原数据。";
        return [];
      }
      seen.add(next.id);
      normalized.push(next);
    }
    return normalized;
  }

  function loadState() {
    const fallback = createDefaultState();
    const result = readJson(STATE_KEY);
    if (result.error || result.missing) {
      if (result.missing) writeJson(STATE_KEY, fallback, true);
      return fallback;
    }
    const raw = result.value;
    if (!raw || typeof raw !== "object" || raw.version !== SCHEMA_VERSION) return fallback;
    const next = createDefaultState();
    if (VIEWS.has(raw.view)) next.view = raw.view;
    if (validMonth(raw.month)) next.month = raw.month;
    for (const view of ["expenses", "income"]) {
      if (!raw.filters?.[view] || typeof raw.filters[view] !== "object") continue;
      for (const key of Object.keys(next.filters[view])) {
        if (typeof raw.filters[view][key] === "string") next.filters[view][key] = raw.filters[view][key].slice(0, 300);
      }
    }
    return next;
  }

  function ensureInitialized() {
    if (initialized) return;
    storageMessage = "";
    entries = loadCollection(ENTRIES_KEY, "entries", normalizeEntry);
    partners = loadCollection(PARTNERS_KEY, "partners", normalizePartner);
    state = loadState();
    initialized = true;
  }

  function canWrite() {
    if (!storageMessage) return true;
    alert(storageMessage);
    return false;
  }

  function saveEntries(next) {
    if (!canWrite() || !writeJson(ENTRIES_KEY, { version: SCHEMA_VERSION, entries: next })) return false;
    entries = next;
    return true;
  }

  function savePartners(next) {
    if (!canWrite() || !writeJson(PARTNERS_KEY, { version: SCHEMA_VERSION, partners: next })) return false;
    partners = next;
    return true;
  }

  function saveState() {
    writeJson(STATE_KEY, state, true);
  }

  function partnerName(id) {
    return partners.find((partner) => partner.id === id)?.name || "";
  }

  function invoiceEligibilityLabel(value) {
    return { unknown: "未确认", available: "可开票", unavailable: "不可开票" }[value] || "";
  }

  function invoiceStatusLabel(value) {
    return { unissued: "未开具", issued: "已开具", not_applicable: "不适用" }[value] || "";
  }

  function entryTimestamp(entry) {
    return `${entry.date}T${entry.time || "00:00"}`;
  }

  function sortEntries(records) {
    return [...records].sort((a, b) => entryTimestamp(b).localeCompare(entryTimestamp(a)) || b.createdAt.localeCompare(a.createdAt));
  }

  function monthEntries(type) {
    return entries.filter((entry) => entry.type === type && entry.date.startsWith(state.month));
  }

  function sumCents(records) {
    return records.reduce((total, entry) => total + entry.amountCents, 0);
  }

  function monthLabel(month = state.month) {
    const [year, number] = month.split("-");
    return `${year} 年 ${Number(number)} 月`;
  }

  function changeMonth(delta) {
    const [year, month] = state.month.split("-").map(Number);
    const date = new Date(year, month - 1 + delta, 1);
    state.month = `${date.getFullYear()}-${two(date.getMonth() + 1)}`;
    saveState();
    render();
  }

  function statCard(label, value, tone = "") {
    return `<article class="ledger-stat-card ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`;
  }

  function headerActions() {
    return `<div class="ledger-page-actions"><button class="btn ledger-month-button" type="button" data-ledger-action="previous-month" aria-label="上一个月">←</button><label class="ledger-month-picker"><span>月份</span><input type="month" value="${esc(state.month)}" data-ledger-month></label><button class="btn ledger-month-button" type="button" data-ledger-action="next-month" aria-label="下一个月">→</button><button class="btn ledger-income-button" type="button" data-ledger-action="new-entry" data-entry-type="income">＋ 记收入</button><button class="btn primary" type="button" data-ledger-action="new-entry" data-entry-type="expense">＋ 记支出</button></div>`;
  }

  function renderShell(content) {
    const titles = {
      overview: ["账单概览", "收入、支出与结余按明细实时汇总。"],
      expenses: ["支出明细", "登记第三方代充与其他经营支出。"],
      income: ["收入明细", "记录客户付款及关联业务信息。"],
    };
    const [title, description] = titles[state.view];
    return `<div class="ledger-page"><header class="ledger-page-header"><div><span class="section-kicker">LEDGER WORKBENCH</span><h1>${title}</h1><p>${description}</p></div>${headerActions()}</header>${storageMessage ? `<div class="ledger-storage-warning" role="alert">${esc(storageMessage)}</div>` : ""}${content}</div>`;
  }

  function trendChart(records) {
    const [year, month] = state.month.split("-").map(Number);
    const days = new Date(year, month, 0).getDate();
    const income = Array(days).fill(0);
    const expense = Array(days).fill(0);
    for (const entry of records) {
      const day = Number(entry.date.slice(8, 10)) - 1;
      if (day >= 0 && day < days) (entry.type === "income" ? income : expense)[day] += entry.amountCents;
    }
    const max = Math.max(1, ...income, ...expense);
    const points = (values) => values.map((value, index) => {
      const x = days === 1 ? 300 : 24 + (index / (days - 1)) * 552;
      const y = 148 - (value / max) * 118;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<section class="ledger-card ledger-trend-card"><header><div><span class="section-kicker">MONTHLY TREND</span><h2>本月收入与支出趋势</h2></div><div class="ledger-legend"><span class="is-income">收入</span><span class="is-expense">支出</span></div></header><svg class="ledger-trend-chart" viewBox="0 0 600 170" role="img" aria-label="${esc(monthLabel())}收入与支出趋势"><line x1="24" y1="148" x2="576" y2="148"/><line x1="24" y1="89" x2="576" y2="89"/><line x1="24" y1="30" x2="576" y2="30"/><polyline class="income-line" points="${points(income)}"/><polyline class="expense-line" points="${points(expense)}"/></svg><div class="ledger-chart-axis"><span>1 日</span><span>${Math.ceil(days / 2)} 日</span><span>${days} 日</span></div></section>`;
  }

  function categoryChart(expenses) {
    const thirdParty = sumCents(expenses.filter((entry) => entry.category === "第三方代充"));
    const other = sumCents(expenses.filter((entry) => entry.category === "其他支出"));
    const total = thirdParty + other;
    const percentage = total ? Math.round((thirdParty / total) * 1000) / 10 : 0;
    const emptyClass = total ? "" : " is-empty";
    const centerLabel = total ? "第三方代充" : "暂无支出";
    return `<section class="ledger-card ledger-category-card"><header><span class="section-kicker">EXPENSE SHARE</span><h2>支出分类占比</h2></header><div class="ledger-donut-wrap"><div class="ledger-donut${emptyClass}" style="--ledger-share:${percentage}%"><span><strong>${percentage}%</strong><small>${centerLabel}</small></span></div><dl><div><dt><i class="third-party"></i>第三方代充</dt><dd>${money(thirdParty)}</dd></div><div><dt><i class="other-expense"></i>其他支出</dt><dd>${money(other)}</dd></div></dl></div></section>`;
  }

  function recentEntries(records) {
    const recent = sortEntries(records).slice(0, 6);
    return `<section class="ledger-card ledger-recent-card"><header><span class="section-kicker">RECENT</span><h2>最近收支记录</h2></header><div class="ledger-recent-list">${recent.length ? recent.map((entry) => `<button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}"><span class="ledger-entry-icon ${entry.type}">${entry.type === "income" ? "收" : "支"}</span><span><strong>${esc(entry.type === "income" ? (entry.customerName || entry.customerCode || "客户付款") : (partnerName(entry.partnerId) || entry.payee || entry.category))}</strong><small>${esc(entry.date)} ${esc(entry.time)}</small></span><b class="${entry.type}">${entry.type === "income" ? "+" : "−"}${money(entry.amountCents)}</b></button>`).join("") : '<div class="ledger-empty compact">本月暂无收支记录</div>'}</div></section>`;
  }

  function monthlySummary() {
    const months = new Map();
    for (const entry of entries) {
      const month = entry.date.slice(0, 7);
      const item = months.get(month) || { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 };
      item[entry.type] += entry.amountCents;
      item[`${entry.type}Count`] += 1;
      months.set(month, item);
    }
    if (!months.has(state.month)) months.set(state.month, { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 });
    const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    return `<section class="ledger-card ledger-summary-card"><header><span class="section-kicker">MONTHLY SUMMARY</span><h2>月度汇总表</h2></header><div class="ledger-table-wrap"><table class="ledger-table"><thead><tr><th>月份</th><th>收入</th><th>支出</th><th>结余</th><th>收入笔数</th><th>支出笔数</th></tr></thead><tbody>${rows.map(([month, item]) => `<tr><td data-label="月份">${esc(monthLabel(month))}</td><td data-label="收入" class="income">${money(item.income)}</td><td data-label="支出" class="expense">${money(item.expense)}</td><td data-label="结余">${money(item.income - item.expense)}</td><td data-label="收入笔数">${item.incomeCount}</td><td data-label="支出笔数">${item.expenseCount}</td></tr>`).join("")}</tbody></table></div></section>`;
  }

  function renderOverview() {
    const records = entries.filter((entry) => entry.date.startsWith(state.month));
    const income = records.filter((entry) => entry.type === "income");
    const expenses = records.filter((entry) => entry.type === "expense");
    return renderShell(`<section class="ledger-overview-toolbar"><div><strong>${esc(monthLabel())}</strong><span>共 ${records.length} 笔明细</span></div><button class="btn" type="button" data-ledger-action="data-manager">数据管理</button></section><section class="ledger-stats">${statCard("本月收入", money(sumCents(income)), "income")}${statCard("本月支出", money(sumCents(expenses)), "expense")}${statCard("本月结余", money(sumCents(income) - sumCents(expenses)), "balance")}${statCard("本月总笔数", String(records.length))}</section><div class="ledger-overview-grid">${trendChart(records)}${categoryChart(expenses)}${recentEntries(records)}</div>${monthlySummary()}`);
  }

  function matchesText(entry, fields, query) {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || fields.some((field) => String(entry[field] || "").toLocaleLowerCase().includes(needle));
  }

  function filteredExpenses() {
    const filters = state.filters.expenses;
    return sortEntries(monthEntries("expense").filter((entry) => {
      const partner = `${partnerName(entry.partnerId)} ${entry.payee}`.toLocaleLowerCase();
      return (!filters.dateFrom || entry.date >= filters.dateFrom) &&
        (!filters.dateTo || entry.date <= filters.dateTo) &&
        (filters.category === "all" || entry.category === filters.category) &&
        (!filters.partner || partner.includes(filters.partner.toLocaleLowerCase())) &&
        (filters.invoiceStatus === "all" || entry.invoiceStatus === filters.invoiceStatus) &&
        matchesText(entry, ["category", "payee", "customerCode", "product", "paymentMethod", "remark"], filters.keyword);
    }));
  }

  function filteredIncome() {
    const filters = state.filters.income;
    return sortEntries(monthEntries("income").filter((entry) =>
      (!filters.dateFrom || entry.date >= filters.dateFrom) &&
      (!filters.dateTo || entry.date <= filters.dateTo) &&
      matchesText(entry, ["customerCode", "customerName"], filters.customer) &&
      matchesText(entry, ["product"], filters.product) &&
      matchesText(entry, ["paymentMethod"], filters.paymentMethod) &&
      matchesText(entry, ["customerCode", "customerName", "product", "paymentMethod", "orderDescription", "remark"], filters.keyword)
    ));
  }

  function filterField(label, name, value, options = {}) {
    if (options.select) {
      return `<label><span>${esc(label)}</span><select data-ledger-filter="${esc(name)}" data-filter-view="${esc(options.view)}">${options.select.map(([key, text]) => `<option value="${esc(key)}"${value === key ? " selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
    }
    return `<label><span>${esc(label)}</span><input type="${options.type || "text"}" value="${esc(value)}" placeholder="${esc(options.placeholder || "")}" data-ledger-filter="${esc(name)}" data-filter-view="${esc(options.view)}"></label>`;
  }

  function detailToolbar(type) {
    const isExpense = type === "expense";
    return `<div class="ledger-detail-toolbar"><button class="btn primary" type="button" data-ledger-action="new-entry" data-entry-type="${type}">＋ 记${isExpense ? "支出" : "收入"}</button>${isExpense ? '<button class="btn" type="button" data-ledger-action="partners">第三方管理</button>' : ""}</div>`;
  }

  function expenseRows(records) {
    if (!records.length) return '<tr><td colspan="10"><div class="ledger-empty">当前筛选条件下暂无支出记录</div></td></tr>';
    return records.map((entry) => `<tr><td data-label="日期和时间"><strong>${esc(entry.date)}</strong><small>${esc(entry.time || "未填写时间")}</small></td><td data-label="支出分类">${esc(entry.category)}</td><td data-label="第三方/对象">${esc(partnerName(entry.partnerId) || entry.payee || "—")}</td><td data-label="产品/业务">${esc(entry.product || "—")}</td><td data-label="客户编码">${esc(entry.customerCode || "—")}</td><td data-label="金额" class="expense">${money(entry.amountCents)}</td><td data-label="发票"><span class="ledger-invoice ${esc(entry.invoiceStatus)}">${esc(invoiceEligibilityLabel(entry.invoiceEligibility))} · ${esc(invoiceStatusLabel(entry.invoiceStatus))}</span></td><td data-label="备注">${esc(entry.remark || "—")}</td><td data-label="操作" class="ledger-row-actions" colspan="2"><button type="button" data-ledger-action="copy-entry" data-entry-id="${esc(entry.id)}">复制</button><button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}">编辑</button><button type="button" class="danger" data-ledger-action="delete-entry" data-entry-id="${esc(entry.id)}">删除</button></td></tr>`).join("");
  }

  function incomeRows(records) {
    if (!records.length) return '<tr><td colspan="9"><div class="ledger-empty">当前筛选条件下暂无收入记录</div></td></tr>';
    return records.map((entry) => `<tr><td data-label="日期和时间"><strong>${esc(entry.date)}</strong><small>${esc(entry.time || "未填写时间")}</small></td><td data-label="客户编码">${esc(entry.customerCode || "—")}</td><td data-label="客户名称">${esc(entry.customerName || "—")}</td><td data-label="产品/业务">${esc(entry.product || "—")}</td><td data-label="收款方式">${esc(entry.paymentMethod || "—")}</td><td data-label="金额" class="income">${money(entry.amountCents)}</td><td data-label="备注">${esc(entry.remark || entry.orderDescription || "—")}</td><td data-label="操作" class="ledger-row-actions" colspan="2"><button type="button" data-ledger-action="copy-entry" data-entry-id="${esc(entry.id)}">复制</button><button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}">编辑</button><button type="button" class="danger" data-ledger-action="delete-entry" data-entry-id="${esc(entry.id)}">删除</button></td></tr>`).join("");
  }

  function renderExpenses() {
    const records = monthEntries("expense");
    const today = localDate();
    const filters = state.filters.expenses;
    const filtered = filteredExpenses();
    const filterHtml = filterField("开始日期", "dateFrom", filters.dateFrom, { type: "date", view: "expenses" }) + filterField("结束日期", "dateTo", filters.dateTo, { type: "date", view: "expenses" }) + filterField("支出分类", "category", filters.category, { view: "expenses", select: [["all", "全部分类"], ["第三方代充", "第三方代充"], ["其他支出", "其他支出"]] }) + filterField("第三方或支付对象", "partner", filters.partner, { view: "expenses", placeholder: "搜索名称" }) + filterField("发票状态", "invoiceStatus", filters.invoiceStatus, { view: "expenses", select: [["all", "全部状态"], ["unissued", "未开具"], ["issued", "已开具"], ["not_applicable", "不适用"]] }) + filterField("关键词", "keyword", filters.keyword, { view: "expenses", placeholder: "产品、客户编码或备注" });
    return renderShell(`<section class="ledger-stats">${statCard("本月支出", money(sumCents(records)), "expense")}${statCard("今日支出", money(sumCents(entries.filter((entry) => entry.type === "expense" && entry.date === today))), "expense")}${statCard("本月支出笔数", String(records.length))}${statCard("可开票但未开具", String(records.filter((entry) => entry.invoiceEligibility === "available" && entry.invoiceStatus === "unissued").length))}</section><section class="ledger-card ledger-filter-card"><div class="ledger-filter-grid">${filterHtml}</div><div class="ledger-filter-footer"><span>筛选结果：${filtered.length} 笔</span><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="expenses">清除筛选</button>${detailToolbar("expense")}</div></section><section class="ledger-card ledger-list-card"><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>支出分类</th><th>第三方群或支付对象</th><th>产品/业务</th><th>关联客户编码</th><th>金额</th><th>发票状态</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${expenseRows(filtered)}</tbody></table></div></section>`);
  }

  function renderIncome() {
    const records = monthEntries("income");
    const today = localDate();
    const filters = state.filters.income;
    const filtered = filteredIncome();
    const filterHtml = filterField("开始日期", "dateFrom", filters.dateFrom, { type: "date", view: "income" }) + filterField("结束日期", "dateTo", filters.dateTo, { type: "date", view: "income" }) + filterField("客户编码或名称", "customer", filters.customer, { view: "income", placeholder: "搜索客户" }) + filterField("产品/业务", "product", filters.product, { view: "income", placeholder: "搜索产品或业务" }) + filterField("收款方式", "paymentMethod", filters.paymentMethod, { view: "income", placeholder: "例如：微信" }) + filterField("关键词", "keyword", filters.keyword, { view: "income", placeholder: "订单说明或备注" });
    const total = sumCents(records);
    return renderShell(`<section class="ledger-stats">${statCard("本月收入", money(total), "income")}${statCard("今日收入", money(sumCents(entries.filter((entry) => entry.type === "income" && entry.date === today))), "income")}${statCard("本月收款笔数", String(records.length))}${statCard("本月平均每笔收入", money(records.length ? Math.round(total / records.length) : 0))}</section><section class="ledger-card ledger-filter-card"><div class="ledger-filter-grid">${filterHtml}</div><div class="ledger-filter-footer"><span>筛选结果：${filtered.length} 笔</span><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="income">清除筛选</button>${detailToolbar("income")}</div></section><section class="ledger-card ledger-list-card"><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>客户编码</th><th>客户名称</th><th>产品/业务</th><th>收款方式</th><th>金额</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${incomeRows(filtered)}</tbody></table></div></section>`);
  }

  function render() {
    const main = $("#main");
    if (!main) return;
    main.innerHTML = state.view === "expenses" ? renderExpenses() : state.view === "income" ? renderIncome() : renderOverview();
    document.querySelectorAll("[data-ledger-view]").forEach((button) => button.classList.toggle("on", button.dataset.ledgerView === state.view));
  }

  function open(view) {
    ensureInitialized();
    if (VIEWS.has(view)) state.view = view;
    saveState();
    globalThis.setMode?.("ledger");
    globalThis.renderNav?.();
    globalThis.renderList?.([], "记账台");
    render();
    globalThis.persistUiState?.();
  }

  function closeAll(silent = false) {
    document.querySelectorAll(".ledger-modal-backdrop").forEach((modal) => modal.remove());
    importPreview = null;
    if (!silent) render();
  }

  function modal(html, className = "") {
    closeAll(true);
    const backdrop = document.createElement("div");
    backdrop.className = `ledger-modal-backdrop ${className}`.trim();
    backdrop.innerHTML = html;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
    const focusTarget = $("input:not([type='hidden']), select, button", backdrop);
    focusTarget?.focus();
  }

  function customerCodes() {
    try {
      const raw = localStorage.getItem(CUSTOMER_CODES_KEY);
      if (!raw) return [];
      const documentValue = JSON.parse(raw);
      if (documentValue?.version !== 1 || !Array.isArray(documentValue.records)) return [];
      return documentValue.records.map((record) => record?.code).filter((code) => typeof code === "string" && CUSTOMER_CODE_PATTERN.test(code));
    } catch (error) {
      return [];
    }
  }

  function field(label, name, value = "", options = {}) {
    const required = options.required ? " required" : "";
    const wide = options.wide ? " ledger-form-wide" : "";
    if (options.select) {
      return `<label class="${wide.trim()}"><span>${esc(label)}${options.required ? " *" : ""}</span><select name="${esc(name)}"${required}>${options.select.map(([key, text]) => `<option value="${esc(key)}"${String(value) === key ? " selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
    }
    if (options.textarea) {
      return `<label class="${wide.trim()}"><span>${esc(label)}</span><textarea name="${esc(name)}" maxlength="${options.max || 500}" placeholder="${esc(options.placeholder || "")}">${esc(value)}</textarea></label>`;
    }
    return `<label class="${wide.trim()}"><span>${esc(label)}${options.required ? " *" : ""}</span><input name="${esc(name)}" type="${options.type || "text"}" value="${esc(value)}"${required}${options.step ? ` step="${options.step}"` : ""}${options.min ? ` min="${options.min}"` : ""}${options.list ? ` list="${options.list}"` : ""} maxlength="${options.max || 200}" placeholder="${esc(options.placeholder || "")}"></label>`;
  }

  function openEntryForm(type, id = "") {
    const editing = entries.find((entry) => entry.id === id);
    const recordType = editing?.type || type;
    if (!['income', 'expense'].includes(recordType)) return;
    const record = editing || {
      date: localDate(), time: localTime(), category: recordType === "income" ? "客户付款" : "第三方代充", amountCents: 0,
      partnerId: "", payee: "", customerCode: "", customerName: "", product: "", paymentMethod: "",
      invoiceEligibility: "unknown", invoiceStatus: "unissued", orderDescription: "", remark: "",
    };
    const amount = record.amountCents ? (record.amountCents / 100).toFixed(2) : "";
    const partnerOptions = [["", "请选择第三方（可留空）"], ...partners.map((partner) => [partner.id, partner.name])];
    const codeOptions = customerCodes().map((code) => `<option value="${esc(code)}"></option>`).join("");
    let fields = field(recordType === "income" ? "收款日期" : "支出日期", "date", record.date, { type: "date", required: true }) + field(recordType === "income" ? "收款时间" : "支出时间", "time", record.time, { type: "time" }) + field(recordType === "income" ? "收款金额（元）" : "支出金额（元）", "amount", amount, { type: "number", required: true, min: "0.01", step: "0.01", placeholder: "0.00" });
    if (recordType === "expense") {
      fields += field("支出分类", "category", record.category, { required: true, select: [["第三方代充", "第三方代充"], ["其他支出", "其他支出"]] }) + field("第三方群", "partnerId", record.partnerId, { select: partnerOptions }) + field("支付对象", "payee", record.payee, { placeholder: "可填写未纳入第三方管理的对象" }) + field("产品或业务", "product", record.product) + field("关联客户编码", "customerCode", record.customerCode, { list: "ledgerCustomerCodes", placeholder: "例如 C000006" }) + field("支付方式", "paymentMethod", record.paymentMethod) + field("是否可开票", "invoiceEligibility", record.invoiceEligibility, { select: [["unknown", "未确认"], ["available", "可开票"], ["unavailable", "不可开票"]] }) + field("发票状态", "invoiceStatus", record.invoiceStatus, { select: [["unissued", "未开具"], ["issued", "已开具"], ["not_applicable", "不适用"]] }) + field("备注", "remark", record.remark, { textarea: true, wide: true });
    } else {
      fields += field("客户编码", "customerCode", record.customerCode, { list: "ledgerCustomerCodes", placeholder: "可留空，格式 C＋6位数字" }) + field("客户名称/备注名", "customerName", record.customerName) + field("产品或业务", "product", record.product) + field("收款方式", "paymentMethod", record.paymentMethod) + field("订单说明", "orderDescription", record.orderDescription, { wide: true }) + field("备注", "remark", record.remark, { textarea: true, wide: true });
    }
    modal(`<section class="ledger-modal ledger-entry-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerEntryTitle"><header><div><span class="section-kicker">${recordType === "income" ? "INCOME" : "EXPENSE"}</span><h2 id="ledgerEntryTitle">${editing ? "编辑" : "记录"}${recordType === "income" ? "收入" : "支出"}</h2></div><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><form data-ledger-form="entry" data-entry-type="${recordType}" data-entry-id="${esc(id)}"><div class="ledger-form-grid">${fields}</div><datalist id="ledgerCustomerCodes">${codeOptions}</datalist><p class="ledger-form-error" role="alert"></p><footer><button type="button" class="btn" data-ledger-action="close-modal">取消</button><button type="submit" class="btn primary">${editing ? "保存修改" : "保存记录"}</button></footer></form></section>`);
    syncInvoiceFields();
  }

  function syncInvoiceFields() {
    const form = $("[data-ledger-form='entry'][data-entry-type='expense']");
    if (!form) return;
    const eligibility = form.elements.invoiceEligibility.value;
    const status = form.elements.invoiceStatus;
    if (eligibility === "unavailable") {
      status.innerHTML = '<option value="not_applicable">不适用</option>';
    } else if (eligibility === "available") {
      const current = ["unissued", "issued"].includes(status.value) ? status.value : "unissued";
      status.innerHTML = `<option value="unissued"${current === "unissued" ? " selected" : ""}>未开具</option><option value="issued"${current === "issued" ? " selected" : ""}>已开具</option>`;
    } else {
      status.innerHTML = '<option value="unissued">未开具</option>';
    }
  }

  function formError(form, message) {
    const target = $(".ledger-form-error", form);
    if (target) target.textContent = message;
  }

  function saveEntryForm(form) {
    if (!canWrite()) return;
    const data = new FormData(form);
    const type = form.dataset.entryType;
    const id = form.dataset.entryId;
    const amountCents = parseAmountToCents(data.get("amount"));
    const date = safeText(data.get("date"), 10);
    const time = safeText(data.get("time"), 5);
    const customerCode = safeText(data.get("customerCode"), 20);
    if (!amountCents) return formError(form, "金额必须是大于 0、最多两位小数的合法数值。");
    if (!validDate(date) || !validTime(time)) return formError(form, "请填写有效的本地日期和时间。");
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) return formError(form, "客户编码必须严格使用 C＋6位数字格式，或留空。");
    const existing = entries.find((entry) => entry.id === id);
    let invoiceEligibility = type === "expense" ? safeText(data.get("invoiceEligibility"), 30) : "";
    let invoiceStatus = type === "expense" ? safeText(data.get("invoiceStatus"), 30) : "";
    if (invoiceEligibility === "unavailable") invoiceStatus = "not_applicable";
    if (invoiceEligibility === "available" && !["unissued", "issued"].includes(invoiceStatus)) invoiceStatus = "unissued";
    if (invoiceEligibility === "unknown") invoiceStatus = "unissued";
    const next = normalizeEntry({
      id: existing?.id || createId(type), type, category: type === "income" ? "客户付款" : safeText(data.get("category"), 40), amountCents,
      date, time, partnerId: type === "expense" ? safeText(data.get("partnerId"), 180) : "", payee: type === "expense" ? safeText(data.get("payee"), 160) : "",
      customerCode, customerName: type === "income" ? safeText(data.get("customerName"), 120) : "", product: safeText(data.get("product"), 160), paymentMethod: safeText(data.get("paymentMethod"), 100),
      invoiceEligibility, invoiceStatus, orderDescription: type === "income" ? safeText(data.get("orderDescription"), 300) : "", remark: safeText(data.get("remark"), 500),
      createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(),
    });
    if (!next) return formError(form, "记录字段存在冲突或无效内容，请检查后重试。");
    const nextEntries = existing ? entries.map((entry) => entry.id === existing.id ? next : entry) : [...entries, next];
    if (!saveEntries(nextEntries)) return;
    closeAll(true);
    render();
    notify(existing ? "记录已更新" : `${type === "income" ? "收入" : "支出"}已记录`);
  }

  function deleteEntry(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry || !confirm(`确定删除这笔${entry.type === "income" ? "收入" : "支出"}吗？删除后无法撤销。`)) return;
    if (!saveEntries(entries.filter((item) => item.id !== id))) return;
    render();
    notify("记录已删除");
  }

  function openPartners() {
    const rows = partners.map((partner) => {
      const count = entries.filter((entry) => entry.type === "expense" && entry.partnerId === partner.id).length;
      return `<li><span><strong>${esc(partner.name)}</strong><small>${count} 笔关联支出</small></span><div><button class="btn" type="button" data-ledger-action="rename-partner" data-partner-id="${esc(partner.id)}">重命名</button><button class="btn danger" type="button" data-ledger-action="delete-partner" data-partner-id="${esc(partner.id)}"${count ? " disabled title=\"已有支出记录使用，不能删除\"" : ""}>删除</button></div></li>`;
    }).join("");
    modal(`<section class="ledger-modal ledger-partner-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerPartnerTitle"><header><div><span class="section-kicker">PARTNERS</span><h2 id="ledgerPartnerTitle">第三方管理</h2></div><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><form data-ledger-form="partner"><label><span>第三方名称</span><input name="name" maxlength="100" required placeholder="例如：第三方合作群 A"></label><button class="btn primary" type="submit">新增第三方</button><p class="ledger-form-error" role="alert"></p></form><ul class="ledger-partner-list">${rows || '<li class="ledger-empty compact">暂无第三方</li>'}</ul></section>`);
  }

  function addPartner(form) {
    const name = safeText(new FormData(form).get("name"), 100);
    if (!name) return;
    if (partners.some((partner) => partner.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return formError(form, "该第三方已存在。");
    const timestamp = nowIso();
    if (!savePartners([...partners, { id: createId("partner"), name, createdAt: timestamp, updatedAt: timestamp }])) return;
    openPartners();
    notify("第三方已新增");
  }

  function renamePartner(id) {
    const partner = partners.find((item) => item.id === id);
    if (!partner) return;
    const name = safeText(prompt("请输入新的第三方名称", partner.name), 100);
    if (!name || name === partner.name) return;
    if (partners.some((item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert("该第三方名称已存在。");
    if (!savePartners(partners.map((item) => item.id === id ? { ...item, name, updatedAt: nowIso() } : item))) return;
    openPartners();
    notify("第三方已重命名");
  }

  function deletePartner(id) {
    const partner = partners.find((item) => item.id === id);
    if (!partner) return;
    const count = entries.filter((entry) => entry.type === "expense" && entry.partnerId === id).length;
    if (count) return alert(`该第三方关联了 ${count} 笔支出，不能直接删除。`);
    if (!confirm(`确定删除第三方“${partner.name}”吗？`)) return;
    if (!savePartners(partners.filter((item) => item.id !== id))) return;
    openPartners();
    notify("第三方已删除");
  }

  function downloadBackup() {
    const backup = { backupType: BACKUP_TYPE, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), entries, partners };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zhiyuan-ledger-backup-${localDate()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    notify(`记账台已导出，共 ${entries.length} 笔记录`);
  }

  function openDataManager() {
    modal(`<section class="ledger-modal ledger-data-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerDataTitle"><header><div><span class="section-kicker">DATA</span><h2 id="ledgerDataTitle">记账台数据管理</h2></div><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><div class="ledger-data-actions"><button class="btn primary" type="button" data-ledger-action="export">导出记账台备份</button><button class="btn" type="button" data-ledger-action="select-import">导入记账台备份</button><input type="file" accept="application/json,.json" data-ledger-import hidden><p>导入采用安全合并：根据稳定 ID 去重，不覆盖、不清空现有记录。</p></div><div class="ledger-import-preview" aria-live="polite"></div></section>`);
  }

  async function previewImport(file) {
    const target = $(".ledger-import-preview");
    if (!target || !file) return;
    importPreview = null;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("备份文件不能超过 10MB。");
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.backupType !== BACKUP_TYPE || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries) || !Array.isArray(parsed.partners) || typeof parsed.exportedAt !== "string" || Number.isNaN(Date.parse(parsed.exportedAt))) throw new Error("文件结构不正确，不是有效的记账台备份。");
      const entryIds = new Set(entries.map((entry) => entry.id));
      const partnerIds = new Set(partners.map((partner) => partner.id));
      const additions = { entries: [], partners: [] };
      let invalid = 0;
      let duplicate = 0;
      for (const raw of parsed.entries) {
        const entry = normalizeEntry(raw);
        if (!entry) invalid += 1;
        else if (entryIds.has(entry.id)) duplicate += 1;
        else { entryIds.add(entry.id); additions.entries.push(entry); }
      }
      for (const raw of parsed.partners) {
        const partner = normalizePartner(raw);
        if (!partner) invalid += 1;
        else if (partnerIds.has(partner.id)) duplicate += 1;
        else { partnerIds.add(partner.id); additions.partners.push(partner); }
      }
      importPreview = { ...additions, invalid, duplicate };
      target.innerHTML = `<h3>导入预览</h3><div class="ledger-preview-stats"><span><strong>${additions.entries.length + additions.partners.length}</strong>可导入</span><span><strong>${duplicate}</strong>重复</span><span><strong>${invalid}</strong>无效</span></div><p>其中 ${additions.entries.length} 笔收支记录、${additions.partners.length} 个第三方可安全合并；重复项不会覆盖，无效数据会跳过。</p><button class="btn primary" type="button" data-ledger-action="confirm-import"${additions.entries.length + additions.partners.length ? "" : " disabled"}>确认安全合并</button>`;
    } catch (error) {
      target.innerHTML = `<p class="ledger-import-error">${esc(error.message || "备份文件读取失败。")}</p>`;
    }
  }

  function confirmImport() {
    if (!importPreview || !confirm(`确认合并 ${importPreview.entries.length} 笔记录和 ${importPreview.partners.length} 个第三方吗？现有数据不会被覆盖。`)) return;
    if (!canWrite()) return;
    const nextEntries = [...entries, ...importPreview.entries];
    const nextPartners = [...partners, ...importPreview.partners];
    if (!writeJson(ENTRIES_KEY, { version: SCHEMA_VERSION, entries: nextEntries }) || !writeJson(PARTNERS_KEY, { version: SCHEMA_VERSION, partners: nextPartners })) return;
    entries = nextEntries;
    partners = nextPartners;
    const importedCount = importPreview.entries.length + importPreview.partners.length;
    const skipped = importPreview.invalid;
    importPreview = null;
    closeAll(true);
    render();
    alert(`安全合并完成：导入 ${importedCount} 项${skipped ? `，跳过 ${skipped} 项无效数据` : ""}。`);
  }

  function copyEntryText(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const lines = entry.type === "income" ? [
      `收款时间：${entry.date} ${entry.time || ""}`.trim(), `客户编码：${entry.customerCode || "未关联"}`, `客户名称：${entry.customerName || "未填写"}`,
      `产品/业务：${entry.product || "未填写"}`, `收款方式：${entry.paymentMethod || "未填写"}`, `收入金额：${money(entry.amountCents)}`,
      entry.orderDescription ? `订单说明：${entry.orderDescription}` : "", entry.remark ? `备注：${entry.remark}` : "",
    ] : [
      `支出时间：${entry.date} ${entry.time || ""}`.trim(), `支出分类：${entry.category}`, `第三方/对象：${partnerName(entry.partnerId) || entry.payee || "未填写"}`,
      `产品/业务：${entry.product || "未填写"}`, `支出金额：${money(entry.amountCents)}`, `发票：${invoiceEligibilityLabel(entry.invoiceEligibility)} · ${invoiceStatusLabel(entry.invoiceStatus)}`,
      entry.remark ? `备注：${entry.remark}` : "",
    ];
    const text = lines.filter(Boolean).join("\n");
    if (typeof globalThis.copyText === "function") globalThis.copyText(text);
    else navigator.clipboard?.writeText(text).then(() => notify("已复制"));
  }

  function handleClick(event) {
    const button = event.target.closest("[data-ledger-action]");
    if (!button) return;
    const action = button.dataset.ledgerAction;
    if (action === "previous-month") changeMonth(-1);
    else if (action === "next-month") changeMonth(1);
    else if (action === "new-entry") openEntryForm(button.dataset.entryType);
    else if (action === "edit-entry") openEntryForm("", button.dataset.entryId);
    else if (action === "copy-entry") copyEntryText(button.dataset.entryId);
    else if (action === "delete-entry") deleteEntry(button.dataset.entryId);
    else if (action === "partners") openPartners();
    else if (action === "rename-partner") renamePartner(button.dataset.partnerId);
    else if (action === "delete-partner") deletePartner(button.dataset.partnerId);
    else if (action === "close-modal") closeAll(true);
    else if (action === "data-manager") openDataManager();
    else if (action === "export") downloadBackup();
    else if (action === "select-import") $("[data-ledger-import]")?.click();
    else if (action === "confirm-import") confirmImport();
    else if (action === "clear-filters") {
      const view = button.dataset.filterView;
      state.filters[view] = structuredClone(DEFAULT_FILTERS[view]);
      saveState();
      render();
    }
  }

  function handleChange(event) {
    const monthInput = event.target.closest("[data-ledger-month]");
    if (monthInput && validMonth(monthInput.value)) {
      state.month = monthInput.value;
      saveState();
      render();
      return;
    }
    const filter = event.target.closest("[data-ledger-filter]");
    if (filter) {
      const view = filter.dataset.filterView;
      state.filters[view][filter.dataset.ledgerFilter] = filter.value.slice(0, 300);
      saveState();
      render();
      return;
    }
    if (event.target.matches("[data-ledger-import]")) previewImport(event.target.files?.[0]);
    if (event.target.matches("[data-ledger-form='entry'] [name='invoiceEligibility']")) syncInvoiceFields();
  }

  function handleInput(event) {
    const filter = event.target.closest("[data-ledger-filter]");
    if (!filter || ["date", "select-one"].includes(filter.type)) return;
    const view = filter.dataset.filterView;
    state.filters[view][filter.dataset.ledgerFilter] = filter.value.slice(0, 300);
    saveState();
    const cursor = filter.selectionStart;
    const name = filter.dataset.ledgerFilter;
    render();
    const replacement = $(`[data-ledger-filter="${CSS.escape(name)}"][data-filter-view="${CSS.escape(view)}"]`);
    replacement?.focus();
    if (replacement && Number.isInteger(cursor)) replacement.setSelectionRange(cursor, cursor);
  }

  function handleSubmit(event) {
    const form = event.target.closest("[data-ledger-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.ledgerForm === "entry") saveEntryForm(form);
    if (form.dataset.ledgerForm === "partner") addPartner(form);
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", handleInput);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $(".ledger-modal-backdrop")) closeAll(true);
  });

  globalThis.openLedgerWorkbench = open;
  globalThis.LedgerWorkbench = { open, closeAll };
})();
