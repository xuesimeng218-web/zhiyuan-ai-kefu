(function () {
  "use strict";

  const ENTRIES_KEY = "zy_kb_ledger_entries_v1";
  const PARTNERS_KEY = "zy_kb_ledger_partners_v1";
  const CATEGORIES_KEY = "zy_kb_ledger_categories_v1";
  const MANUAL_PARTNER_PREFIX = "manual-group:";
  const STATE_KEY = "zy_kb_ledger_state_v1";
  const CUSTOMER_CODES_KEY = "zy_kb_customer_codes_v1";
  const BACKUP_TYPE = "zy-kb-ledger-backup";
  const SCHEMA_VERSION = 1;
  const CUSTOMER_CODE_PATTERN = /^C\d{6}$/;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_PATTERN = /^\d{2}:\d{2}$/;
  const VIEWS = new Set(["overview", "manual", "import", "data", "expenses", "income"]);
  const EXPENSE_CATEGORIES = new Set(["第三方代充", "其他支出"]);
  const INVOICE_ELIGIBILITY = new Set(["unknown", "available", "unavailable"]);
  const INVOICE_STATUS = new Set(["unissued", "issued", "not_applicable"]);
  const ENTRY_SOURCES = new Set(["manual", "statement-import"]);
  const SOURCE_PLATFORMS = new Set(["alipay", "wecom"]);
  const SOURCE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
  const DEFAULT_FILTERS = Object.freeze({
    overview: {
      source: "all",
      monthScope: "current",
    },
    manual: {
      monthScope: "current",
      type: "all",
    },
    import: {
      monthScope: "current",
    },
    data: {
    },
    expenses: {
      source: "all",
      monthScope: "current",
      dateFrom: "",
      dateTo: "",
      category: "all",
      partner: "",
      invoiceStatus: "all",
      keyword: "",
    },
    income: {
      category: "all",
      source: "all",
      monthScope: "current",
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
  let categories = [];
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

  function defaultCategories(type) {
    return type === "income" ? ["客户付款"] : [...EXPENSE_CATEGORIES];
  }

  function normalizeCategory(raw) {
    if (!raw || !["income", "expense"].includes(raw.type) || typeof raw.name !== "string" ||
        !raw.name.trim() || raw.name.trim().length > 40 || typeof raw.active !== "boolean") return null;
    const base = normalizePartner(raw);
    if (!base || defaultCategories(raw.type).includes(base.name)) return null;
    return { ...base, type: raw.type, active: raw.active };
  }

  function categoryOptions(type, historical = "", filter = false) {
    const names = new Set(defaultCategories(type));
    categories.filter((item) => item.type === type && (filter || item.active)).forEach((item) => names.add(item.name));
    if (filter) entries.filter((entry) => entry.type === type).forEach((entry) => names.add(entryCategoryName(entry)));
    if (historical) names.add(historical);
    return [...names].map((name) => [name, name]);
  }

  function saveCategories(next) {
    if (!canWrite() || !writeJson(CATEGORIES_KEY, { version: SCHEMA_VERSION, categories: next })) return false;
    categories = next;
    return true;
  }

  function openCategories(id = "") {
    const editing = categories.find((item) => item.id === id);
    const sections = ["income", "expense"].map((type) => `<h3>${type === "income" ? "收入分类" : "支出分类"}</h3><p>系统分类：${defaultCategories(type).map(esc).join("、")}</p><ul class="ledger-partner-list">${categories.filter((item) => item.type === type).map((item) => `<li><span><strong>${esc(item.name)}</strong><small>${item.active ? "使用中" : "已停用"}</small></span><div><button type="button" class="btn" data-ledger-action="edit-category" data-category-id="${esc(item.id)}">编辑</button><button type="button" class="btn" data-ledger-action="toggle-category" data-category-id="${esc(item.id)}">${item.active ? "停用" : "启用"}</button><button type="button" class="btn danger" data-ledger-action="delete-category" data-category-id="${esc(item.id)}">删除</button></div></li>`).join("") || '<li>暂无自定义分类</li>'}</ul>`).join("");
    modal(`<section class="ledger-modal ledger-category-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerCategoryTitle"><header><h2 id="ledgerCategoryTitle">分类管理</h2><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><p>分类名称为 1–40 个字符。已关联此分类的记录随名称更新；仅保存分类文字的历史记录保持原样。已使用分类只能停用，系统分类不可删除。</p><form data-ledger-form="category" data-category-id="${esc(id)}"><div class="ledger-form-grid">${field("分类名称", "name", editing?.name || "", { required: true, max: 40 })}${field("分类类型", "type", editing?.type || "expense", { select: editing ? [[editing.type, editing.type === "income" ? "收入" : "支出"]] : [["income", "收入"], ["expense", "支出"]] })}</div><p class="ledger-form-error" role="alert"></p><footer><button type="button" class="btn" data-ledger-action="${editing ? "categories" : "close-modal"}">取消</button><button type="submit" class="btn primary">${editing ? "保存修改" : "新增分类"}</button></footer></form>${sections}</section>`);
  }

  function saveCategoryForm(form) {
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const id = form.dataset.categoryId;
    const type = categories.find((item) => item.id === id)?.type || data.get("type");
    if (!name || name.length > 40 || !["income", "expense"].includes(type)) return formError(form, "请填写 1–40 个字符的分类名称及有效类型。");
    const same = (value) => value.toLocaleLowerCase() === name.toLocaleLowerCase();
    if (defaultCategories(type).some(same) || categories.some((item) => item.id !== id && item.type === type && same(item.name))) return formError(form, "该分类名称已存在（包括已停用分类）。");
    const existing = categories.find((item) => item.id === id);
    const next = { id: existing?.id || createId("category"), name, type, active: existing?.active ?? true, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso() };
    if (!saveCategories(existing ? categories.map((item) => item.id === id ? next : item) : [...categories, next])) return;
    render();
    openCategories();
    notify(existing ? "分类已更新，历史记录数据保持不变" : "分类已新增，可在对应记账表单选择");
  }

  function entryCategoryName(entry) {
    return categories.find((item) => item.id === entry?.categoryId && item.type === entry.type)?.name || entry?.category || "";
  }

  function partnerUsage(partner) {
    return entries.filter((entry) => entry.type === "expense" && (
      entry.partnerId === partner.id || entry.partnerId === MANUAL_PARTNER_PREFIX + partner.name ||
      entry.partnerDisplayName === partner.name || (!entry.partnerId && entry.payee === partner.name)
    )).length;
  }

  function deleteManaged(kind, id) {
    const isCategory = kind === "category";
    const list = isCategory ? categories : partners;
    const item = list.find((item) => item.id === id);
    if (!item) return;
    const count = isCategory ? entries.filter((entry) => entry.type === item.type &&
      (entry.categoryId === id || (!entry.categoryId && entry.category === item.name))).length : partnerUsage(item);
    const label = isCategory ? "分类" : "第三方群";
    let next;
    if (count) {
      const message = `该${label}已有 ${count} 条${isCategory ? "" : "支出"}记录使用，不能直接删除。可先停用，历史记录仍会保留。`;
      if (!item.active) { notify(message + "当前已停用。"); return; }
      if (!confirm(message + "\n是否停用？取消将保持不变。")) return;
      next = list.map((row) => row.id === id ? { ...row, active: false, updatedAt: nowIso() } : row);
    } else {
      if (!confirm(`确定删除${label}“${item.name}”吗？此操作无法撤销。`)) return;
      next = list.filter((row) => row.id !== id);
    }
    if (!(isCategory ? saveCategories(next) : savePartners(next))) return;
    render();
    if (isCategory) openCategories(); else openPartners();
    notify(count ? `${label}已停用，历史记录仍会保留` : `${label}已删除`);
  }

  function syncPartnerFields() {
    const form = $("[data-ledger-form='entry'][data-entry-type='expense']");
    if (!form) return;
    const show = form.elements.category.value === "第三方代充";
    form.elements.partnerId.closest("label").hidden = !show;
    form.elements.partnerId.disabled = !show;
    form.elements.partnerId.required = show;
    form.elements.payee.closest("label").hidden = show;
  }

  function normalizePartner(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = safeText(raw.id, 160);
    const name = safeText(raw.name, 100);
    const createdAt = safeText(raw.createdAt, 60);
    const updatedAt = safeText(raw.updatedAt || raw.createdAt, 60);
    if (!id || !name || !createdAt || Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
    return { id, name, active: raw.active !== false, createdAt, updatedAt };
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
    // Category names are snapshots: renamed/disabled categories remain valid in history.
    if (!category || typeof raw.category !== "string" || raw.category.trim().length > 40) return null;
    const customerCode = safeText(raw.customerCode, 20);
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) return null;
    const invoiceEligibility = type === "expense" ? safeText(raw.invoiceEligibility, 30) : "";
    const invoiceStatus = type === "expense" ? safeText(raw.invoiceStatus, 30) : "";
    if (type === "expense") {
      if (!INVOICE_ELIGIBILITY.has(invoiceEligibility) || !INVOICE_STATUS.has(invoiceStatus)) return null;
      if (invoiceEligibility === "unavailable" && invoiceStatus !== "not_applicable") return null;
      if (invoiceEligibility === "available" && !["unissued", "issued"].includes(invoiceStatus)) return null;
    }
    const normalized = {
      id,
      type,
      category,
      ...(safeText(raw.categoryId, 160) ? { categoryId: safeText(raw.categoryId, 160) } : {}),
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
    // An explicit empty name must stay empty; absence retains legacy display fallback.
    if (Object.prototype.hasOwnProperty.call(raw, "partnerDisplayName")) {
      if (typeof raw.partnerDisplayName !== "string" || raw.partnerDisplayName.trim().length > 160) return null;
      normalized.partnerDisplayName = safeText(raw.partnerDisplayName, 160);
    }
    const hasEntrySource = Object.prototype.hasOwnProperty.call(raw, "source");
    const source = safeText(raw.source, 30);
    if (hasEntrySource && !ENTRY_SOURCES.has(source)) return null;
    const hasSourceFields = ["sourcePlatform", "sourceTransactionId", "sourceImportBatchId", "sourceImportedAt", "sourceRawSummary", "sourceFingerprint"]
      .some((key) => Object.prototype.hasOwnProperty.call(raw, key));
    if (!hasSourceFields) {
      if (source === "statement-import") return null;
      return hasEntrySource ? { ...normalized, source } : normalized;
    }
    if (source === "manual") return null;
    const sourcePlatform = safeText(raw.sourcePlatform, 20);
    const sourceTransactionId = safeText(raw.sourceTransactionId, 180);
    const sourceImportBatchId = safeText(raw.sourceImportBatchId, 180);
    const sourceImportedAt = safeText(raw.sourceImportedAt, 60);
    const sourceRawSummary = safeText(raw.sourceRawSummary, 300);
    const sourceFingerprint = safeText(raw.sourceFingerprint, 64).toLowerCase();
    if (
      !SOURCE_PLATFORMS.has(sourcePlatform) ||
      !sourceImportBatchId ||
      !sourceImportedAt ||
      Number.isNaN(Date.parse(sourceImportedAt)) ||
      !sourceRawSummary ||
      !SOURCE_FINGERPRINT_PATTERN.test(sourceFingerprint)
    ) return null;
    return {
      ...normalized,
      ...(hasEntrySource ? { source } : {}),
      sourcePlatform,
      ...(sourceTransactionId ? { sourceTransactionId } : {}),
      sourceImportBatchId,
      sourceImportedAt,
      sourceRawSummary,
      sourceFingerprint,
    };
  }

  function loadCollection(key, field, normalize) {
    const result = readJson(key);
    if (result.error) {
      storageMessage = "记账台数据读取失败，已停止写入以保护原数据。";
      return [];
    }
    if (result.missing) {
      if (key === CATEGORIES_KEY) return [];
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
    if (VIEWS.has(raw.view)) next.view = ["expenses", "income"].includes(raw.view) ? "overview" : raw.view;
    if (validMonth(raw.month)) next.month = raw.month;
    for (const view of Object.keys(DEFAULT_FILTERS)) {
      if (!raw.filters?.[view] || typeof raw.filters[view] !== "object") continue;
      for (const key of Object.keys(next.filters[view])) {
        if (typeof raw.filters[view][key] === "string") next.filters[view][key] = raw.filters[view][key].slice(0, 300);
      }
    }
    for (const filters of Object.values(next.filters)) {
      if (Object.prototype.hasOwnProperty.call(filters, "source") && !["all", "manual", "statement-import"].includes(filters.source)) filters.source = "all";
      if (Object.prototype.hasOwnProperty.call(filters, "monthScope") && !["current", "all"].includes(filters.monthScope)) filters.monthScope = "current";
    }
    if (!["all", "income", "expense"].includes(next.filters.manual.type)) next.filters.manual.type = "all";
    return next;
  }

  function ensureInitialized() {
    if (initialized) return;
    storageMessage = "";
    entries = loadCollection(ENTRIES_KEY, "entries", normalizeEntry);
    partners = loadCollection(PARTNERS_KEY, "partners", normalizePartner);
    categories = loadCollection(CATEGORIES_KEY, "categories", normalizeCategory);
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

  // Manual names live only on the entry; managed partner IDs always take precedence.
  function isManualPartner(id) {
    return typeof id === "string" && id.startsWith(MANUAL_PARTNER_PREFIX) && !partners.some((partner) => partner.id === id);
  }

  function partnerName(id) {
    return partners.find((partner) => partner.id === id)?.name || (isManualPartner(id) ? id.slice(MANUAL_PARTNER_PREFIX.length) : "");
  }

  function entryPartnerName(entry) {
    const managed = partners.find((partner) => partner.id === entry.partnerId);
    // Explicit historical overrides remain visible until this entry is deliberately reassigned.
    return entry.partnerDisplayName ?? (managed?.name || partnerName(entry.partnerId) || entry.payee || "");
  }

  function entryPartnerValue(entry) {
    if (!entry) return "";
    if (Object.prototype.hasOwnProperty.call(entry, "partnerDisplayName")) return "historical-current";
    return entry.partnerId || (entry.payee ? "historical-current" : "");
  }

  function partnerOptions(entry) {
    const options = [["", "请选择第三方群或支付对象"], ...partners.filter((item) => item.active).map((item) => [item.id, item.name])];
    const current = entryPartnerValue(entry);
    if (current && !options.some(([id]) => id === current)) options.push([current, `${entryPartnerName(entry) || entry.partnerId || "未填写"}（历史值）`]);
    return options;
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

  function entrySource(entry) {
    if (ENTRY_SOURCES.has(entry?.source)) return entry.source;
    return entry?.sourcePlatform ? "statement-import" : "manual";
  }

  function entrySourceLabel(entry) {
    return entrySource(entry) === "statement-import" ? "流水导入" : "手动记录";
  }

  function matchesSource(entry, source) {
    return source === "all" || entrySource(entry) === source;
  }

  function scopedEntries(records, monthScope = "current") {
    return monthScope === "all" ? records : records.filter((entry) => entry.date.startsWith(state.month));
  }

  function monthEntries(type, source = "all", monthScope = "current") {
    return scopedEntries(entries.filter((entry) => entry.type === type && matchesSource(entry, source)), monthScope);
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
    for (const filters of Object.values(state.filters)) {
      if (Object.prototype.hasOwnProperty.call(filters, "monthScope")) filters.monthScope = "current";
    }
    saveState();
    render();
  }

  function statCard(label, value, tone = "") {
    return `<article class="ledger-stat-card ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`;
  }

  function monthActions() {
    return `<button class="btn ledger-month-button" type="button" data-ledger-action="previous-month" aria-label="上一个月">←</button><label class="ledger-month-picker"><span>当前月份</span><input type="month" value="${esc(state.month)}" data-ledger-month></label><button class="btn ledger-month-button" type="button" data-ledger-action="next-month" aria-label="下一个月">→</button>`;
  }

  function headerActions() {
    if (state.view === "data") return "";
    const manualActions = state.view === "manual" || state.view === "expenses" || state.view === "income"
      ? `<button class="btn ledger-income-button" type="button" data-ledger-action="new-entry" data-entry-type="income">＋ 记收入</button><button class="btn primary" type="button" data-ledger-action="new-entry" data-entry-type="expense">＋ 记支出</button>`
      : "";
    const importAction = state.view === "import" ? '<button class="btn primary" type="button" data-ledger-action="external-import">选择流水文件</button>' : "";
    return `<div class="ledger-page-actions">${monthActions()}${manualActions}${importAction}</div>`;
  }

  function renderShell(content) {
    const titles = {
      overview: ["记账概览", "查看当前筛选范围内的收入、支出、结余与来源构成。"],
      manual: ["手动记账", "日常登记与交接使用；这里只展示手动记录。"],
      import: ["流水导入", "导入支付宝或企业微信流水，并核对已导入记录。"],
      data: ["数据管理", "集中管理记账台备份、导入和数据来源说明。"],
      expenses: ["支出明细", "登记第三方代充与其他经营支出。"],
      income: ["收入明细", "记录客户付款及关联业务信息。"],
    };
    const [title, description] = titles[state.view];
    return `<div class="ledger-page"><header class="ledger-page-header"><div><span class="section-kicker">LEDGER WORKBENCH</span><h1>${title}</h1><p>${description}</p></div>${headerActions()}</header>${storageMessage ? `<div class="ledger-storage-warning" role="alert">${esc(storageMessage)}</div>` : ""}${content}</div>`;
  }

  function trendChart(records, monthScope = "current") {
    let income;
    let expense;
    let labels;
    let title;
    let ariaLabel;
    if (monthScope === "all") {
      const months = [...new Set(records.map((entry) => entry.date.slice(0, 7)))].sort().slice(-12);
      const keys = months.length ? months : [state.month];
      income = keys.map((month) => sumCents(records.filter((entry) => entry.type === "income" && entry.date.startsWith(month))));
      expense = keys.map((month) => sumCents(records.filter((entry) => entry.type === "expense" && entry.date.startsWith(month))));
      labels = [keys[0], keys[Math.floor((keys.length - 1) / 2)], keys[keys.length - 1]];
      title = "全部月份收入与支出趋势";
      ariaLabel = "全部月份收入与支出趋势";
    } else {
      const [year, month] = state.month.split("-").map(Number);
      const days = new Date(year, month, 0).getDate();
      income = Array(days).fill(0);
      expense = Array(days).fill(0);
      for (const entry of records) {
        const day = Number(entry.date.slice(8, 10)) - 1;
        if (day >= 0 && day < days) (entry.type === "income" ? income : expense)[day] += entry.amountCents;
      }
      labels = ["1 日", `${Math.ceil(days / 2)} 日`, `${days} 日`];
      title = "本月收入与支出趋势";
      ariaLabel = `${monthLabel()}收入与支出趋势`;
    }
    const max = Math.max(1, ...income, ...expense);
    const points = (values) => values.map((value, index) => {
      const x = values.length === 1 ? 300 : 24 + (index / (values.length - 1)) * 552;
      const y = 148 - (value / max) * 118;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<section class="ledger-card ledger-trend-card"><header><div><span class="section-kicker">MONTHLY TREND</span><h2>${esc(title)}</h2></div><div class="ledger-legend"><span class="is-income">收入</span><span class="is-expense">支出</span></div></header><svg class="ledger-trend-chart" viewBox="0 0 600 170" role="img" aria-label="${esc(ariaLabel)}"><line x1="24" y1="148" x2="576" y2="148"/><line x1="24" y1="89" x2="576" y2="89"/><line x1="24" y1="30" x2="576" y2="30"/><polyline class="income-line" points="${points(income)}"/><polyline class="expense-line" points="${points(expense)}"/></svg><div class="ledger-chart-axis"><span>${esc(labels[0])}</span><span>${esc(labels[1])}</span><span>${esc(labels[2])}</span></div></section>`;
  }

  function categoryChart(expenses) {
    const totals = new Map(defaultCategories("expense").map((name) => [name, 0]));
    expenses.forEach((entry) => totals.set(entryCategoryName(entry), (totals.get(entryCategoryName(entry)) || 0) + entry.amountCents));
    const total = sumCents(expenses);
    let offset = 0;
    const stops = [];
    const rows = [...totals].map(([name, amount], index) => {
      const color = ["#7b6ee1", "#f2b38e", "#719e74", "#a38bc2", "#ca7e97"][index % 5];
      const share = total ? amount / total * 100 : 0;
      stops.push(`${color} ${offset}% ${offset + share}%`);
      offset += share;
      return `<div><dt><i style="background:${color}"></i>${esc(name)}</dt><dd>${money(amount)} · ${share.toFixed(1)}%</dd></div>`;
    }).join("");
    return `<section class="ledger-card ledger-category-card"><header><span class="section-kicker">EXPENSE SHARE</span><h2>支出分类占比</h2></header><div class="ledger-donut-wrap"><div class="ledger-donut" style="background:${total ? `conic-gradient(${stops.join(",")})` : "#e8edf0"}"><span><strong>${expenses.length} 笔</strong><small>全部支出</small></span></div><dl>${rows}</dl></div></section>`;
  }

  function recentEntries(records) {
    const recent = sortEntries(records).slice(0, 6);
    return `<section class="ledger-card ledger-recent-card"><header><span class="section-kicker">RECENT</span><h2>最近收支记录</h2></header><div class="ledger-recent-list">${recent.length ? recent.map((entry) => `<button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}"><span class="ledger-entry-icon ${entry.type}">${entry.type === "income" ? "收" : "支"}</span><span><strong>${esc(entry.type === "income" ? (entry.customerName || entry.customerCode || entryCategoryName(entry)) : (entryPartnerName(entry) || entryCategoryName(entry)))}</strong><small>${esc(entry.date)} ${esc(entry.time)} · ${esc(entrySourceLabel(entry))}</small></span><b class="${entry.type}">${entry.type === "income" ? "+" : "−"}${money(entry.amountCents)}</b></button>`).join("") : '<div class="ledger-empty compact">当前筛选下暂无收支记录</div>'}</div></section>`;
  }

  function monthlySummary(source = "all", monthScope = "all") {
    const months = new Map();
    for (const entry of scopedEntries(entries.filter((item) => matchesSource(item, source)), monthScope)) {
      const month = entry.date.slice(0, 7);
      const item = months.get(month) || { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 };
      item[entry.type] += entry.amountCents;
      item[`${entry.type}Count`] += 1;
      months.set(month, item);
    }
    if (!months.size || (monthScope === "current" && !months.has(state.month))) months.set(state.month, { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 });
    const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    return `<section class="ledger-card ledger-summary-card"><header><span class="section-kicker">MONTHLY SUMMARY</span><h2>月度汇总表</h2></header><div class="ledger-table-wrap"><table class="ledger-table"><thead><tr><th>月份</th><th>收入</th><th>支出</th><th>结余</th><th>收入笔数</th><th>支出笔数</th></tr></thead><tbody>${rows.map(([month, item]) => `<tr><td data-label="月份">${esc(monthLabel(month))}</td><td data-label="收入" class="income">${money(item.income)}</td><td data-label="支出" class="expense">${money(item.expense)}</td><td data-label="结余">${money(item.income - item.expense)}</td><td data-label="收入笔数">${item.incomeCount}</td><td data-label="支出笔数">${item.expenseCount}</td></tr>`).join("")}</tbody></table></div></section>`;
  }

  function renderOverview() {
    const source = state.filters.overview.source;
    const monthScope = state.filters.overview.monthScope === "all" ? "all" : "current";
    const allRecords = scopedEntries(entries, monthScope);
    const records = allRecords.filter((entry) => matchesSource(entry, source));
    const income = records.filter((entry) => entry.type === "income");
    const expenses = records.filter((entry) => entry.type === "expense");
    const manualIncome = allRecords.filter((entry) => entry.type === "income" && entrySource(entry) === "manual");
    const importedIncome = allRecords.filter((entry) => entry.type === "income" && entrySource(entry) === "statement-import");
    const manualExpenses = allRecords.filter((entry) => entry.type === "expense" && entrySource(entry) === "manual");
    const importedExpenses = allRecords.filter((entry) => entry.type === "expense" && entrySource(entry) === "statement-import");
    const currentMonthImported = entries.filter((entry) => entry.date.startsWith(state.month) && entrySource(entry) === "statement-import").length;
    const allImported = entries.filter((entry) => entrySource(entry) === "statement-import").length;
    const sourceFilter = filterField("记录来源", "source", source, { view: "overview", select: [["all", "全部记录"], ["manual", "手动记录"], ["statement-import", "流水导入"]] });
    const monthFilter = filterField("月份范围", "monthScope", monthScope, { view: "overview", select: [["current", `当前月份（${state.month}）`], ["all", "全部月份"]] });
    const sourceLabel = source === "manual" ? "手动记录" : source === "statement-import" ? "流水导入" : "全部记录";
    const scopeLabel = monthScope === "all" ? "全部月份" : monthLabel();
    const empty = records.length ? "" : '<div class="ledger-empty-state" role="status"><strong>当前筛选条件下没有记录</strong><span>原有数据未被删除，可以清除筛选或切换月份查看。</span></div>';
    return renderShell(`<section class="ledger-overview-toolbar"><div><strong>${esc(scopeLabel)}</strong><span>当前生效：${esc(sourceLabel)} · 筛选结果 ${records.length} 笔</span></div><div class="ledger-overview-links"><button class="btn" type="button" data-ledger-action="open-details" data-entry-type="income">收入明细</button><button class="btn" type="button" data-ledger-action="open-details" data-entry-type="expense">支出明细</button></div></section><section class="ledger-card ledger-overview-source-filter"><div class="ledger-filter-grid">${monthFilter}${sourceFilter}</div><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="overview">清除筛选，查看全部记录</button></section><section class="ledger-filter-status" aria-label="当前筛选与导入统计"><span>当前月份：<strong>${esc(state.month)}</strong></span><span>记录来源：<strong>${esc(sourceLabel)}</strong></span><span>当前月份导入：<strong>${currentMonthImported} 笔</strong></span><span>全部月份流水导入：<strong>${allImported} 笔</strong></span><span>当前筛选结果：<strong>${records.length} 笔</strong></span></section>${empty}<section class="ledger-stats">${statCard("全部收入", money(sumCents(income)), "income")}${statCard("全部支出", money(sumCents(expenses)), "expense")}${statCard("当前结余", money(sumCents(income) - sumCents(expenses)), "balance")}${statCard("记录数量", String(records.length))}</section><section class="ledger-source-stats" aria-label="按记录来源汇总">${statCard("手动收入", money(sumCents(manualIncome)), "income manual")}${statCard("流水导入收入", money(sumCents(importedIncome)), "income imported")}${statCard("手动支出", money(sumCents(manualExpenses)), "expense manual")}${statCard("流水导入支出", money(sumCents(importedExpenses)), "expense imported")}</section><div class="ledger-overview-grid">${trendChart(records, monthScope)}${categoryChart(expenses)}${recentEntries(records)}</div>${monthlySummary(source, monthScope)}`);
  }

  function matchesText(entry, fields, query) {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || fields.some((field) => String(entry[field] || "").toLocaleLowerCase().includes(needle));
  }

  function filteredExpenses() {
    const filters = state.filters.expenses;
    return sortEntries(monthEntries("expense", "all", filters.monthScope).filter((entry) => {
      const partner = entryPartnerName(entry).toLocaleLowerCase();
      return matchesSource(entry, filters.source) &&
        (!filters.dateFrom || entry.date >= filters.dateFrom) &&
        (!filters.dateTo || entry.date <= filters.dateTo) &&
        (filters.category === "all" || entryCategoryName(entry) === filters.category) &&
        (!filters.partner || partner.includes(filters.partner.toLocaleLowerCase())) &&
        (filters.invoiceStatus === "all" || entry.invoiceStatus === filters.invoiceStatus) &&
        matchesText(entry, ["category", "payee", "customerCode", "product", "paymentMethod", "remark"], filters.keyword);
    }));
  }

  function filteredIncome() {
    const filters = state.filters.income;
    return sortEntries(monthEntries("income", "all", filters.monthScope).filter((entry) =>
      matchesSource(entry, filters.source) &&
      (!filters.dateFrom || entry.date >= filters.dateFrom) &&
      (!filters.dateTo || entry.date <= filters.dateTo) &&
      (filters.category === "all" || entryCategoryName(entry) === filters.category) &&
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

  function sourceBadge(entry) {
    const source = entrySource(entry);
    return `<span class="ledger-source-badge ${source === "statement-import" ? "imported" : "manual"}">${esc(entrySourceLabel(entry))}</span>`;
  }

  function expenseRows(records) {
    if (!records.length) return '<tr><td colspan="11"><div class="ledger-empty"><span><strong>当前筛选条件下没有支出记录</strong><br>原有数据未被删除，可以清除筛选或切换月份查看。</span></div></td></tr>';
    return records.map((entry) => `<tr><td data-label="日期和时间"><strong>${esc(entry.date)}</strong><small>${esc(entry.time || "未填写时间")}</small></td><td data-label="来源">${sourceBadge(entry)}</td><td data-label="支出分类">${esc(entryCategoryName(entry))}</td><td data-label="第三方群或支付对象">${esc(entryPartnerName(entry) || "—")}</td><td data-label="产品/业务">${esc(entry.product || "—")}</td><td data-label="客户编码">${esc(entry.customerCode || "—")}</td><td data-label="金额" class="expense">${money(entry.amountCents)}</td><td data-label="发票"><span class="ledger-invoice ${esc(entry.invoiceStatus)}">${esc(invoiceEligibilityLabel(entry.invoiceEligibility))} · ${esc(invoiceStatusLabel(entry.invoiceStatus))}</span></td><td data-label="备注">${esc(entry.remark || "—")}</td><td data-label="操作" class="ledger-row-actions" colspan="2"><button type="button" data-ledger-action="copy-entry" data-entry-id="${esc(entry.id)}">复制</button><button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}">编辑</button><button type="button" class="danger" data-ledger-action="delete-entry" data-entry-id="${esc(entry.id)}">删除</button></td></tr>`).join("");
  }

  function incomeRows(records) {
    if (!records.length) return '<tr><td colspan="11"><div class="ledger-empty"><span><strong>当前筛选条件下没有收入记录</strong><br>原有数据未被删除，可以清除筛选或切换月份查看。</span></div></td></tr>';
    return records.map((entry) => `<tr><td data-label="日期和时间"><strong>${esc(entry.date)}</strong><small>${esc(entry.time || "未填写时间")}</small></td><td data-label="来源">${sourceBadge(entry)}</td><td data-label="收入分类">${esc(entryCategoryName(entry))}</td><td data-label="客户编码">${esc(entry.customerCode || "—")}</td><td data-label="客户名称">${esc(entry.customerName || "—")}</td><td data-label="产品/业务">${esc(entry.product || "—")}</td><td data-label="收款方式">${esc(entry.paymentMethod || "—")}</td><td data-label="金额" class="income">${money(entry.amountCents)}</td><td data-label="备注">${esc(entry.remark || entry.orderDescription || "—")}</td><td data-label="操作" class="ledger-row-actions" colspan="2"><button type="button" data-ledger-action="copy-entry" data-entry-id="${esc(entry.id)}">复制</button><button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}">编辑</button><button type="button" class="danger" data-ledger-action="delete-entry" data-entry-id="${esc(entry.id)}">删除</button></td></tr>`).join("");
  }

  function renderExpenses() {
    const today = localDate();
    const filters = state.filters.expenses;
    const filtered = filteredExpenses();
    const filterHtml = filterField("月份范围", "monthScope", filters.monthScope, { view: "expenses", select: [["current", `当前月份（${state.month}）`], ["all", "全部月份"]] }) + filterField("记录来源", "source", filters.source, { view: "expenses", select: [["all", "全部记录"], ["manual", "手动记录"], ["statement-import", "流水导入"]] }) + filterField("开始日期", "dateFrom", filters.dateFrom, { type: "date", view: "expenses" }) + filterField("结束日期", "dateTo", filters.dateTo, { type: "date", view: "expenses" }) + filterField("支出分类", "category", filters.category, { view: "expenses", select: [["all", "全部分类"], ...categoryOptions("expense", "", true)] }) + filterField("第三方群或支付对象", "partner", filters.partner, { view: "expenses", placeholder: "搜索名称" }) + filterField("发票状态", "invoiceStatus", filters.invoiceStatus, { view: "expenses", select: [["all", "全部状态"], ["unissued", "未开具"], ["issued", "已开具"], ["not_applicable", "不适用"]] }) + filterField("关键词", "keyword", filters.keyword, { view: "expenses", placeholder: "产品、客户编码或备注" });
    const activeScope = filters.monthScope === "all" ? "全部月份" : monthLabel();
    const activeSource = filters.source === "manual" ? "手动记录" : filters.source === "statement-import" ? "流水导入" : "全部记录";
    return renderShell(`<section class="ledger-filter-status"><span>当前月份：<strong>${esc(state.month)}</strong></span><span>查看范围：<strong>${esc(activeScope)}</strong></span><span>记录来源：<strong>${esc(activeSource)}</strong></span><span>筛选结果：<strong>${filtered.length} 笔</strong></span></section><section class="ledger-stats">${statCard("筛选后支出", money(sumCents(filtered)), "expense")}${statCard("筛选后今日支出", money(sumCents(filtered.filter((entry) => entry.date === today))), "expense")}${statCard("筛选后支出笔数", String(filtered.length))}${statCard("可开票但未开具", String(filtered.filter((entry) => entry.invoiceEligibility === "available" && entry.invoiceStatus === "unissued").length))}</section><section class="ledger-card ledger-filter-card"><div class="ledger-filter-grid">${filterHtml}</div><div class="ledger-filter-footer"><span>筛选结果：${filtered.length} 笔</span><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="expenses">清除筛选，查看全部记录</button>${detailToolbar("expense")}</div></section><section class="ledger-card ledger-list-card"><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>来源</th><th>支出分类</th><th>第三方群或支付对象</th><th>产品/业务</th><th>关联客户编码</th><th>金额</th><th>发票状态</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${expenseRows(filtered)}</tbody></table></div></section>`);
  }

  function renderIncome() {
    const today = localDate();
    const filters = state.filters.income;
    const filtered = filteredIncome();
    const filterHtml = filterField("月份范围", "monthScope", filters.monthScope, { view: "income", select: [["current", `当前月份（${state.month}）`], ["all", "全部月份"]] }) + filterField("记录来源", "source", filters.source, { view: "income", select: [["all", "全部记录"], ["manual", "手动记录"], ["statement-import", "流水导入"]] }) + filterField("开始日期", "dateFrom", filters.dateFrom, { type: "date", view: "income" }) + filterField("结束日期", "dateTo", filters.dateTo, { type: "date", view: "income" }) + filterField("收入分类", "category", filters.category, { view: "income", select: [["all", "全部分类"], ...categoryOptions("income", "", true)] }) + filterField("客户编码或名称", "customer", filters.customer, { view: "income", placeholder: "搜索客户" }) + filterField("产品/业务", "product", filters.product, { view: "income", placeholder: "搜索产品或业务" }) + filterField("收款方式", "paymentMethod", filters.paymentMethod, { view: "income", placeholder: "例如：微信" }) + filterField("关键词", "keyword", filters.keyword, { view: "income", placeholder: "订单说明或备注" });
    const total = sumCents(filtered);
    const activeScope = filters.monthScope === "all" ? "全部月份" : monthLabel();
    const activeSource = filters.source === "manual" ? "手动记录" : filters.source === "statement-import" ? "流水导入" : "全部记录";
    return renderShell(`<section class="ledger-filter-status"><span>当前月份：<strong>${esc(state.month)}</strong></span><span>查看范围：<strong>${esc(activeScope)}</strong></span><span>记录来源：<strong>${esc(activeSource)}</strong></span><span>筛选结果：<strong>${filtered.length} 笔</strong></span></section><section class="ledger-stats">${statCard("筛选后收入", money(total), "income")}${statCard("筛选后今日收入", money(sumCents(filtered.filter((entry) => entry.date === today))), "income")}${statCard("筛选后收款笔数", String(filtered.length))}${statCard("筛选后平均每笔", money(filtered.length ? Math.round(total / filtered.length) : 0))}</section><section class="ledger-card ledger-filter-card"><div class="ledger-filter-grid">${filterHtml}</div><div class="ledger-filter-footer"><span>筛选结果：${filtered.length} 笔</span><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="income">清除筛选，查看全部记录</button>${detailToolbar("income")}</div></section><section class="ledger-card ledger-list-card"><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>来源</th><th>收入分类</th><th>客户编码</th><th>客户名称</th><th>产品/业务</th><th>收款方式</th><th>金额</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${incomeRows(filtered)}</tbody></table></div></section>`);
  }

  function renderManual() {
    const filters = state.filters.manual;
    const monthScope = filters.monthScope === "all" ? "all" : "current";
    const type = ["income", "expense"].includes(filters.type) ? filters.type : "all";
    const records = sortEntries(scopedEntries(entries.filter((entry) => entrySource(entry) === "manual"), monthScope))
      .filter((entry) => type === "all" || entry.type === type);
    const income = records.filter((entry) => entry.type === "income");
    const expenses = records.filter((entry) => entry.type === "expense");
    const monthFilter = filterField("月份范围", "monthScope", monthScope, { view: "manual", select: [["current", `当前月份（${state.month}）`], ["all", "全部月份"]] });
    const typeFilter = filterField("记录类型", "type", type, { view: "manual", select: [["all", "全部收支"], ["income", "仅收入"], ["expense", "仅支出"]] });
    const empty = records.length ? "" : '<div class="ledger-empty-state" role="status"><strong>当前筛选条件下没有手动记录</strong><span>原有数据未被删除，可以清除筛选或切换月份查看。</span></div>';
    return renderShell(`<section class="ledger-card ledger-manual-intro"><div><span class="section-kicker">DAILY HANDOFF</span><h2>客服日常登记与交接</h2><p>新增记录固定写入“手动记录”，不会与支付宝或企业微信流水混淆。</p></div><div class="ledger-overview-links"><button class="btn" type="button" data-ledger-action="categories">分类管理</button><button class="btn primary" type="button" data-ledger-action="partners">新增第三方群</button><button class="btn" type="button" data-ledger-action="open-details" data-entry-type="income" data-source="manual">查看收入明细</button><button class="btn" type="button" data-ledger-action="open-details" data-entry-type="expense" data-source="manual">查看支出明细</button></div></section><section class="ledger-card ledger-overview-source-filter"><div class="ledger-filter-grid">${monthFilter}${typeFilter}</div><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="manual">清除筛选，查看全部记录</button></section><section class="ledger-filter-status"><span>当前月份：<strong>${esc(state.month)}</strong></span><span>记录来源：<strong>手动记录</strong></span><span>当前筛选结果：<strong>${records.length} 笔</strong></span></section>${empty}<section class="ledger-stats">${statCard("手动收入", money(sumCents(income)), "income manual")}${statCard("手动支出", money(sumCents(expenses)), "expense manual")}${statCard("手动结余", money(sumCents(income) - sumCents(expenses)), "balance")}${statCard("手动记录", String(records.length))}</section>${type !== "expense" ? `<section class="ledger-card ledger-list-card"><header><div><span class="section-kicker">MANUAL INCOME</span><h2>手动收入</h2></div></header><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>来源</th><th>收入分类</th><th>客户编码</th><th>客户名称</th><th>产品/业务</th><th>收款方式</th><th>金额</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${incomeRows(income)}</tbody></table></div></section>` : ""}${type !== "income" ? `<section class="ledger-card ledger-list-card"><header><div><span class="section-kicker">MANUAL EXPENSE</span><h2>手动支出</h2></div></header><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table"><thead><tr><th>日期和时间</th><th>来源</th><th>支出分类</th><th>第三方群或支付对象</th><th>产品/业务</th><th>关联客户编码</th><th>金额</th><th>发票状态</th><th>备注</th><th colspan="2">操作</th></tr></thead><tbody>${expenseRows(expenses)}</tbody></table></div></section>` : ""}`);
  }

  function statementRows(records) {
    if (!records.length) return '<tr><td colspan="7"><div class="ledger-empty"><span><strong>当前筛选条件下没有流水导入记录</strong><br>原有数据未被删除，可以查看全部月份或重新选择月份。</span></div></td></tr>';
    return records.map((entry) => `<tr><td data-label="日期和时间"><strong>${esc(entry.date)}</strong><small>${esc(entry.time || "未填写时间")}</small></td><td data-label="平台"><span class="ledger-source-badge imported">${entry.sourcePlatform === "wecom" ? "企业微信" : "支付宝"}</span></td><td data-label="收支">${entry.type === "income" ? "收入" : "支出"}</td><td data-label="分类">${esc(entryCategoryName(entry))}</td><td data-label="产品/业务">${esc(entry.product || entry.sourceRawSummary || "—")}</td><td data-label="金额" class="${entry.type}">${entry.type === "income" ? "+" : "−"}${money(entry.amountCents)}</td><td data-label="操作" class="ledger-row-actions"><button type="button" data-ledger-action="edit-entry" data-entry-id="${esc(entry.id)}">编辑</button><button type="button" data-ledger-action="copy-entry" data-entry-id="${esc(entry.id)}">复制</button></td></tr>`).join("");
  }

  function renderImport() {
    const monthScope = state.filters.import.monthScope === "all" ? "all" : "current";
    const allImported = sortEntries(entries.filter((entry) => entrySource(entry) === "statement-import"));
    const currentImported = allImported.filter((entry) => entry.date.startsWith(state.month));
    const records = monthScope === "all" ? allImported : currentImported;
    const income = records.filter((entry) => entry.type === "income");
    const expenses = records.filter((entry) => entry.type === "expense");
    const monthFilter = filterField("流水月份范围", "monthScope", monthScope, { view: "import", select: [["current", `当前月份（${state.month}）`], ["all", "全部月份"]] });
    return renderShell(`<section class="ledger-import-journey" aria-label="流水导入流程"><span><b>1</b>上传文件</span><i>→</i><span><b>2</b>识别平台</span><i>→</i><span><b>3</b>自动分类或人工对应</span><i>→</i><span><b>4</b>预览确认</span><i>→</i><span><b>5</b>完成导入</span></section><section class="ledger-card ledger-import-entry"><div><span class="section-kicker">STATEMENT IMPORT</span><h2>支付宝 / 企业微信流水</h2><p>文件仅在当前页面内存解析；完成后只追加合法记录，不保存文件名或完整原始行。</p></div><button class="btn primary" type="button" data-ledger-action="external-import">上传并识别流水</button></section><section class="ledger-card ledger-overview-source-filter"><div class="ledger-filter-grid">${monthFilter}</div><button class="btn" type="button" data-ledger-action="clear-filters" data-filter-view="import">查看全部月份流水</button></section><section class="ledger-filter-status"><span>当前月份：<strong>${esc(state.month)}</strong></span><span>记录来源：<strong>流水导入</strong></span><span>当前月份导入：<strong>${currentImported.length} 笔</strong></span><span>全部月份导入：<strong>${allImported.length} 笔</strong></span><span>当前显示：<strong>${records.length} 笔</strong></span></section><section class="ledger-stats">${statCard("导入收入", money(sumCents(income)), "income imported")}${statCard("导入支出", money(sumCents(expenses)), "expense imported")}${statCard("当前显示", String(records.length))}${statCard("全部导入", String(allImported.length))}</section><section class="ledger-card ledger-list-card"><header><div><span class="section-kicker">IMPORTED RECORDS</span><h2>已导入流水列表</h2></div></header><div class="ledger-table-wrap"><table class="ledger-table ledger-detail-table ledger-statement-table"><thead><tr><th>日期和时间</th><th>平台</th><th>收支</th><th>分类</th><th>产品/业务</th><th>金额</th><th>操作</th></tr></thead><tbody>${statementRows(records)}</tbody></table></div></section>`);
  }

  function renderData() {
    const manualCount = entries.filter((entry) => entrySource(entry) === "manual").length;
    const importedCount = entries.length - manualCount;
    return renderShell(`<section class="ledger-stats">${statCard("全部记账记录", String(entries.length))}${statCard("手动记录", String(manualCount), "manual")}${statCard("流水导入", String(importedCount), "imported")}${statCard("第三方", String(partners.length))}</section><section class="ledger-card ledger-data-page"><header><div><span class="section-kicker">BACKUP & RESTORE</span><h2>JSON 备份与安全导入</h2></div></header><div class="ledger-data-actions"><button class="btn primary" type="button" data-ledger-action="export">导出记账台备份</button><button class="btn" type="button" data-ledger-action="select-import">导入记账台备份</button><input type="file" accept="application/json,.json" data-ledger-import hidden><p>备份保留受控来源字段；导入只安全追加，不覆盖、不清空现有记录。</p></div><div class="ledger-import-preview" aria-live="polite"></div></section><section class="ledger-card ledger-source-guide"><header><div><span class="section-kicker">DATA SOURCE</span><h2>数据来源说明</h2></div></header><div><article><strong>手动记录</strong><p>历史无来源字段及新建人工收支均按手动记录显示。</p></article><article><strong>流水导入</strong><p>支付宝、企业微信导入记录保留 source 与 sourcePlatform，用于筛选和去重。</p></article></div></section>`);
  }

  function render() {
    const main = $("#main");
    if (!main) return;
    const renderers = { overview: renderOverview, manual: renderManual, import: renderImport, data: renderData, expenses: renderExpenses, income: renderIncome };
    main.innerHTML = (renderers[state.view] || renderOverview)();
    const navView = ["expenses", "income"].includes(state.view) && state.filters[state.view].source === "manual" ? "manual" : ["expenses", "income"].includes(state.view) ? "overview" : state.view;
    document.querySelectorAll("[data-ledger-view]").forEach((button) => button.classList.toggle("on", button.dataset.ledgerView === navView));
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
    globalThis.LedgerStatementImport?.close?.();
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
    const codeOptions = customerCodes().map((code) => `<option value="${esc(code)}"></option>`).join("");
    let fields = field(recordType === "income" ? "收款日期" : "支出日期", "date", record.date, { type: "date", required: true }) + field(recordType === "income" ? "收款时间" : "支出时间", "time", record.time, { type: "time" }) + field(recordType === "income" ? "收款金额（元）" : "支出金额（元）", "amount", amount, { type: "number", required: true, min: "0.01", step: "0.01", placeholder: "0.00" });
    if (recordType === "expense") {
      fields += field("支出分类", "category", entryCategoryName(record), { required: true, select: categoryOptions("expense", entryCategoryName(editing)) }) + field("第三方群或支付对象", "partnerId", entryPartnerValue(editing), { select: partnerOptions(editing) }) + field("支付对象", "payee", record.payee, { placeholder: "可填写未纳入第三方管理的对象" }) + field("产品或业务", "product", record.product) + field("关联客户编码", "customerCode", record.customerCode, { list: "ledgerCustomerCodes", placeholder: "例如 C000006" }) + field("支付方式", "paymentMethod", record.paymentMethod) + field("是否可开票", "invoiceEligibility", record.invoiceEligibility, { select: [["unknown", "未确认"], ["available", "可开票"], ["unavailable", "不可开票"]] }) + field("发票状态", "invoiceStatus", record.invoiceStatus, { select: [["unissued", "未开具"], ["issued", "已开具"], ["not_applicable", "不适用"]] }) + field("备注", "remark", record.remark, { textarea: true, wide: true });
    } else {
      fields += field("收入分类", "category", entryCategoryName(record), { required: true, select: categoryOptions("income", entryCategoryName(editing)) }) + field("客户编码", "customerCode", record.customerCode, { list: "ledgerCustomerCodes", placeholder: "可留空，格式 C＋6位数字" }) + field("客户名称/备注名", "customerName", record.customerName) + field("产品或业务", "product", record.product) + field("收款方式", "paymentMethod", record.paymentMethod) + field("订单说明", "orderDescription", record.orderDescription, { wide: true }) + field("备注", "remark", record.remark, { textarea: true, wide: true });
    }
    modal(`<section class="ledger-modal ledger-entry-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerEntryTitle"><header><div><span class="section-kicker">${recordType === "income" ? "INCOME" : "EXPENSE"}</span><h2 id="ledgerEntryTitle">${editing ? "编辑" : "记录"}${recordType === "income" ? "收入" : "支出"}</h2></div><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><form data-ledger-form="entry" data-entry-type="${recordType}" data-entry-id="${esc(id)}"><div class="ledger-form-grid">${fields}</div><datalist id="ledgerCustomerCodes">${codeOptions}</datalist><p class="ledger-form-error" role="alert"></p><footer><button type="button" class="btn" data-ledger-action="close-modal">取消</button><button type="submit" class="btn primary">${editing ? "保存修改" : "保存记录"}</button></footer></form></section>`);
    syncInvoiceFields(true);
    syncPartnerFields();
  }

  function syncInvoiceFields(preserveHistorical = false) {
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
      const current = preserveHistorical && INVOICE_STATUS.has(status.value) ? status.value : "unissued";
      status.innerHTML = `<option value="${esc(current)}">${esc(invoiceStatusLabel(current))}</option>`;
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
    const category = safeText(data.get("category"), 40);
    if (!categoryOptions(type, entryCategoryName(existing)).some(([name]) => name === category)) return formError(form, "请选择当前可用的分类。");
    let partnerId = existing?.partnerId || "";
    let displayFields = existing && Object.prototype.hasOwnProperty.call(existing, "partnerDisplayName")
      ? { partnerDisplayName: existing.partnerDisplayName } : {};
    if (type === "expense" && category === "第三方代充") {
      const selected = String(data.get("partnerId") || "");
      const historical = existing && selected === entryPartnerValue(existing);
      const managed = partners.find((item) => item.id === selected && item.active);
      if (!selected || (!historical && !managed)) return formError(form, "请选择启用的第三方群或支付对象。");
      if (managed && !historical) { partnerId = managed.id; displayFields = {}; }
      else if (managed && !Object.prototype.hasOwnProperty.call(existing || {}, "partnerDisplayName")) { partnerId = managed.id; displayFields = {}; }
    }
    let invoiceEligibility = type === "expense" ? safeText(data.get("invoiceEligibility"), 30) : "";
    let invoiceStatus = type === "expense" ? safeText(data.get("invoiceStatus"), 30) : "";
    if (invoiceEligibility === "unavailable") invoiceStatus = "not_applicable";
    if (invoiceEligibility === "available" && !["unissued", "issued"].includes(invoiceStatus)) invoiceStatus = "unissued";
    if (invoiceEligibility === "unknown" && !(existing?.invoiceEligibility === "unknown" && invoiceStatus === existing.invoiceStatus)) invoiceStatus = "unissued";
    const sourceFields = existing?.sourcePlatform ? {
      source: "statement-import",
      sourcePlatform: existing.sourcePlatform,
      ...(existing.sourceTransactionId ? { sourceTransactionId: existing.sourceTransactionId } : {}),
      sourceImportBatchId: existing.sourceImportBatchId,
      sourceImportedAt: existing.sourceImportedAt,
      sourceRawSummary: existing.sourceRawSummary,
      sourceFingerprint: existing.sourceFingerprint,
    } : existing ? (existing.source ? { source: existing.source } : {}) : { source: "manual" };
    const next = normalizeEntry({
      id: existing?.id || createId(type), type, category, amountCents,
      ...(existing?.categoryId && category === entryCategoryName(existing) ? { categoryId: existing.categoryId } : {}),
      date, time, partnerId, ...displayFields, payee: type === "expense" ? (category === "第三方代充" ? existing?.payee || "" : safeText(data.get("payee"), 160)) : existing?.payee || "",
      customerCode, customerName: type === "income" ? safeText(data.get("customerName"), 120) : existing?.customerName || "", product: safeText(data.get("product"), 160), paymentMethod: safeText(data.get("paymentMethod"), 100),
      invoiceEligibility, invoiceStatus, orderDescription: type === "income" ? safeText(data.get("orderDescription"), 300) : existing?.orderDescription || "", remark: safeText(data.get("remark"), 500),
      createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(), ...sourceFields,
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

  function openPartners(id = "") {
    const editing = partners.find((item) => item.id === id);
    const rows = partners.map((partner) => {
      const count = partnerUsage(partner);
      return `<li><span><strong>${esc(partner.name)}</strong><small>${partner.active ? "使用中" : "已停用"} · ${count} 笔关联支出</small></span><div><button class="btn" type="button" data-ledger-action="rename-partner" data-partner-id="${esc(partner.id)}">编辑</button><button class="btn" type="button" data-ledger-action="toggle-partner" data-partner-id="${esc(partner.id)}">${partner.active ? "停用" : "启用"}</button><button type="button" class="btn danger" data-ledger-action="delete-partner" data-partner-id="${esc(partner.id)}">删除</button></div></li>`;
    }).join("");
    modal(`<section class="ledger-modal ledger-partner-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerPartnerTitle"><header><h2 id="ledgerPartnerTitle">第三方群管理</h2><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><p>维护常用第三方群或支付对象；停用后保留历史关联。名称为 1–100 个字符。</p><form data-ledger-form="partner" data-partner-id="${esc(editing?.id || "")}"><label><span>第三方群名称</span><input name="name" maxlength="100" required value="${esc(editing?.name || "")}" placeholder="例如：Claude 成品号供货群"></label><div class="ledger-partner-form-actions"><button class="btn" type="button" data-ledger-action="${editing ? "partners" : "close-modal"}">取消</button><button class="btn primary" type="submit">${editing ? "保存修改" : "新增第三方群"}</button></div><p class="ledger-form-error" role="alert"></p></form><ul class="ledger-partner-list">${rows || '<li class="ledger-empty compact">暂无第三方群，请先新增</li>'}</ul></section>`);
  }

  function addPartner(form) {
    const name = String(new FormData(form).get("name") || "").trim();
    const existing = partners.find((item) => item.id === form.dataset.partnerId);
    if (!name || name.length > 100) return formError(form, "请填写 1–100 个字符的第三方群名称。");
    if (partners.some((item) => item.id !== existing?.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return formError(form, "该第三方群名称已存在（包括已停用群）。");
    const timestamp = nowIso();
    const next = { id: existing?.id || createId("partner"), name, active: existing?.active ?? true, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
    if (!savePartners(existing ? partners.map((item) => item.id === existing.id ? next : item) : [...partners, next])) return formError(form, "保存失败，原数据保持不变，请重试。");
    render();
    openPartners();
    notify(existing ? "第三方群名称已更新" : "第三方群已新增，可在支出下拉框选择");
  }

  function togglePartner(id) {
    const partner = partners.find((item) => item.id === id);
    if (!partner) return;
    if (!savePartners(partners.map((item) => item.id === id ? { ...item, active: !item.active, updatedAt: nowIso() } : item))) return;
    render();
    openPartners();
    notify(partner.active ? "第三方群已停用，历史记录保持不变" : "第三方群已启用");
  }

  function downloadBackup() {
    const backup = { backupType: BACKUP_TYPE, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), entries, partners, categories };
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
    modal(`<section class="ledger-modal ledger-data-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerDataTitle"><header><div><span class="section-kicker">DATA</span><h2 id="ledgerDataTitle">记账台数据管理</h2></div><button type="button" class="ledger-modal-close" data-ledger-action="close-modal" aria-label="关闭">×</button></header><div class="ledger-data-actions"><button class="btn primary" type="button" data-ledger-action="external-import">导入支付宝/企业微信流水</button><button class="btn" type="button" data-ledger-action="export">导出记账台备份</button><button class="btn" type="button" data-ledger-action="select-import">导入记账台备份</button><input type="file" accept="application/json,.json" data-ledger-import hidden><p>流水和备份均采用安全追加，不覆盖、不清空现有记录。</p></div><div class="ledger-import-preview" aria-live="polite"></div></section>`);
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
      const additions = { entries: [], partners: [], categories: [] };
      if (parsed.categories !== undefined && !Array.isArray(parsed.categories)) throw new Error("分类备份格式无效。");
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
      for (const raw of parsed.categories || []) {
        const category = normalizeCategory(raw);
        if (!category) invalid += 1;
        else if ([...categories, ...additions.categories].some((item) => item.id === category.id || (item.type === category.type && item.name.toLocaleLowerCase() === category.name.toLocaleLowerCase()))) duplicate += 1;
        else additions.categories.push(category);
      }
      importPreview = { ...additions, invalid, duplicate };
      target.innerHTML = `<h3>导入预览</h3><div class="ledger-preview-stats"><span><strong>${additions.entries.length + additions.partners.length + additions.categories.length}</strong>可导入</span><span><strong>${duplicate}</strong>重复</span><span><strong>${invalid}</strong>无效</span></div><p>其中 ${additions.entries.length} 笔收支记录、${additions.partners.length} 个第三方、${additions.categories.length} 个分类可安全合并；重复项不会覆盖，无效数据会跳过。</p><button class="btn primary" type="button" data-ledger-action="confirm-import"${additions.entries.length + additions.partners.length + additions.categories.length ? "" : " disabled"}>确认安全合并</button>`;
    } catch (error) {
      target.innerHTML = `<p class="ledger-import-error">${esc(error.message || "备份文件读取失败。")}</p>`;
    }
  }

  function confirmImport() {
    if (!importPreview || !confirm(`确认合并 ${importPreview.entries.length} 笔记录、${importPreview.partners.length} 个第三方和 ${importPreview.categories.length} 个分类吗？现有数据不会被覆盖。`)) return;
    if (!canWrite()) return;
    const nextEntries = [...entries, ...importPreview.entries];
    const nextPartners = [...partners, ...importPreview.partners];
    const nextCategories = [...categories, ...importPreview.categories];
    // Roll back exact stored bytes if any part of this multi-key append fails.
    const writes = [[ENTRIES_KEY, { version: SCHEMA_VERSION, entries: nextEntries }], [PARTNERS_KEY, { version: SCHEMA_VERSION, partners: nextPartners }], [CATEGORIES_KEY, { version: SCHEMA_VERSION, categories: nextCategories }]];
    const previous = [];
    try {
      for (const [key] of writes) previous.push([key, localStorage.getItem(key)]);
      for (const [key, value] of writes) localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      for (const [key, value] of previous) {
        try { if (localStorage.getItem(key) !== value) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } }
        catch (rollbackError) { storageMessage = "备份恢复失败且存储回滚受阻，请保留备份并检查浏览器存储权限。"; }
      }
      alert(storageMessage || "备份保存失败，未更改页面数据，请重试。");
      return;
    }
    categories = nextCategories;
    entries = nextEntries;
    partners = nextPartners;
    const importedCount = importPreview.entries.length + importPreview.partners.length + importPreview.categories.length;
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
      `记录来源：${entrySourceLabel(entry)}`, `收入分类：${entryCategoryName(entry)}`, `收款时间：${entry.date} ${entry.time || ""}`.trim(), `客户编码：${entry.customerCode || "未关联"}`, `客户名称：${entry.customerName || "未填写"}`,
      `产品/业务：${entry.product || "未填写"}`, `收款方式：${entry.paymentMethod || "未填写"}`, `收入金额：${money(entry.amountCents)}`,
      entry.orderDescription ? `订单说明：${entry.orderDescription}` : "", entry.remark ? `备注：${entry.remark}` : "",
    ] : [
      `记录来源：${entrySourceLabel(entry)}`, `支出时间：${entry.date} ${entry.time || ""}`.trim(), `支出分类：${entryCategoryName(entry)}`, `第三方/对象：${entryPartnerName(entry) || "未填写"}`,
      `产品/业务：${entry.product || "未填写"}`, `支出金额：${money(entry.amountCents)}`, `发票：${invoiceEligibilityLabel(entry.invoiceEligibility)} · ${invoiceStatusLabel(entry.invoiceStatus)}`,
      entry.remark ? `备注：${entry.remark}` : "",
    ];
    const text = lines.filter(Boolean).join("\n");
    if (typeof globalThis.copyText === "function") globalThis.copyText(text);
    else navigator.clipboard?.writeText(text).then(() => notify("已复制"));
  }

  function readEntriesFreshStrict() {
    const result = readJson(ENTRIES_KEY);
    if (result.error) throw new Error("记账台数据读取失败，未执行导入。");
    if (result.missing) return [];
    const documentValue = result.value;
    if (!documentValue || typeof documentValue !== "object" || documentValue.version !== SCHEMA_VERSION || !Array.isArray(documentValue.entries)) {
      throw new Error("记账台数据结构异常，未执行导入。");
    }
    const normalized = [];
    const seen = new Set();
    for (const raw of documentValue.entries) {
      const entry = normalizeEntry(raw);
      if (!entry || seen.has(entry.id)) throw new Error("记账台存在无法识别的数据，未执行导入。");
      seen.add(entry.id);
      normalized.push(entry);
    }
    return normalized;
  }

  function externalCandidateToEntry(candidate) {
    if (!candidate || typeof candidate !== "object" || candidate.fatalReason) {
      return { status: "invalid", reason: candidate?.fatalReason || "流水字段无效" };
    }
    if (candidate.target === "ignore") return { status: "ignored", reason: candidate.ignoreReason || "已忽略" };
    if (!["income", "third_party", "other"].includes(candidate.target)) return { status: "needsSupplement", reason: "请选择导入目标" };
    const customerCode = safeText(candidate.customerCode, 20);
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) return { status: "needsSupplement", reason: "客户编码格式应为 C＋6位数字" };
    const timestamp = safeText(candidate.sourceImportedAt, 60);
    const common = {
      id: safeText(candidate.id, 180),
      source: "statement-import",
      amountCents: Number(candidate.amountCents),
      date: safeText(candidate.date, 10),
      time: safeText(candidate.time, 5),
      customerCode,
      product: safeText(candidate.product, 160),
      paymentMethod: safeText(candidate.paymentMethod, 100),
      remark: safeText(candidate.remark, 500),
      createdAt: timestamp,
      updatedAt: timestamp,
      sourcePlatform: safeText(candidate.sourcePlatform, 20),
      sourceTransactionId: safeText(candidate.sourceTransactionId, 180),
      sourceImportBatchId: safeText(candidate.sourceImportBatchId, 180),
      sourceImportedAt: safeText(candidate.sourceImportedAt, 60),
      sourceRawSummary: safeText(candidate.sourceRawSummary, 300),
      sourceFingerprint: safeText(candidate.sourceFingerprint, 64),
    };
    let raw;
    if (candidate.target === "income") {
      const customerName = safeText(candidate.customerName, 120);
      if (!common.product || (!customerCode && !customerName)) return { status: "needsSupplement", reason: "收入需补充产品以及客户名称或客户编码" };
      raw = {
        ...common, type: "income", category: "客户付款", partnerId: "", payee: "", customerName,
        invoiceEligibility: "", invoiceStatus: "", orderDescription: safeText(candidate.orderDescription || candidate.sourceRawSummary, 300),
      };
    } else {
      const partnerId = candidate.target === "third_party" ? safeText(candidate.partnerId, 180) : "";
      if (candidate.target === "third_party" && !partners.some((partner) => partner.id === partnerId && partner.active)) {
        return { status: "needsSupplement", reason: "第三方代充需选择已有第三方" };
      }
      raw = {
        ...common, type: "expense", category: candidate.target === "third_party" ? "第三方代充" : "其他支出",
        partnerId, payee: candidate.target === "other" ? safeText(candidate.counterparty, 160) : "", customerName: "",
        invoiceEligibility: "unknown", invoiceStatus: "unissued", orderDescription: "",
      };
    }
    const entry = normalizeEntry(raw);
    return entry ? { status: "addition", entry } : { status: "invalid", reason: "字段未通过记账台严格校验" };
  }

  function sameExternalCore(left, right) {
    return left.type === right.type && left.amountCents === right.amountCents && left.date === right.date && left.time === right.time;
  }

  function analyzeExternalEntries(candidates, currentEntries) {
    const working = [...currentEntries];
    const rows = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const converted = externalCandidateToEntry(candidate);
      if (converted.status !== "addition") {
        rows.push({ clientId: candidate?.clientId || "", ...converted });
        continue;
      }
      const entry = converted.entry;
      const transactionMatch = entry.sourceTransactionId && working.find((item) => item.sourcePlatform === entry.sourcePlatform && item.sourceTransactionId === entry.sourceTransactionId);
      if (transactionMatch) {
        rows.push({ clientId: candidate.clientId, status: sameExternalCore(transactionMatch, entry) ? "duplicate" : "conflict", reason: sameExternalCore(transactionMatch, entry) ? "同平台交易号已导入" : "同平台交易号与金额、时间或方向冲突", entry });
        continue;
      }
      const fingerprintMatch = !entry.sourceTransactionId && working.find((item) => item.sourcePlatform === entry.sourcePlatform && item.sourceFingerprint === entry.sourceFingerprint);
      if (fingerprintMatch) {
        rows.push({ clientId: candidate.clientId, status: sameExternalCore(fingerprintMatch, entry) ? "duplicate" : "conflict", reason: "稳定指纹已存在", entry });
        continue;
      }
      const idMatch = working.find((item) => item.id === entry.id);
      if (idMatch) {
        rows.push({ clientId: candidate.clientId, status: sameExternalCore(idMatch, entry) ? "duplicate" : "conflict", reason: "记录 ID 已存在", entry });
        continue;
      }
      const entryObject = entry.payee || partnerName(entry.partnerId) || entry.customerName;
      const possibleDuplicate = working.some((item) => !item.sourcePlatform && item.type === entry.type && item.amountCents === entry.amountCents && item.date === entry.date && (item.payee || partnerName(item.partnerId) || item.customerName) === entryObject);
      rows.push({ clientId: candidate.clientId, status: possibleDuplicate ? "possibleDuplicate" : "addition", reason: possibleDuplicate ? "可能与现有手工记录重复，请确认" : "可导入", entry });
      working.push(entry);
    }
    const signature = JSON.stringify([
      currentEntries.map((entry) => [entry.id, entry.updatedAt, entry.type, entry.amountCents, entry.date, entry.time, entry.source || "", entry.sourcePlatform || "", entry.sourceTransactionId || "", entry.sourceFingerprint || ""]),
      rows.map((row) => [row.clientId, row.status, row.reason || "", row.entry || null]),
    ]);
    return {
      rows,
      signature,
      counts: rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {}),
    };
  }

  function previewExternalEntries(candidates) {
    ensureInitialized();
    if (storageMessage) return { ok: false, error: storageMessage };
    try {
      return { ok: true, ...analyzeExternalEntries(candidates, readEntriesFreshStrict()) };
    } catch (error) {
      return { ok: false, error: error.message || "无法读取当前记账台数据。" };
    }
  }

  function mergeExternalEntries(candidates, previewSignature) {
    ensureInitialized();
    if (storageMessage) return { ok: false, error: storageMessage };
    try {
      const currentEntries = readEntriesFreshStrict();
      const analysis = analyzeExternalEntries(candidates, currentEntries);
      if (analysis.signature !== previewSignature) return { ok: false, changed: true, error: "记账台数据或导入内容已变化，请重新核对预览。", ...analysis };
      const additions = analysis.rows.filter((row) => ["addition", "possibleDuplicate"].includes(row.status)).map((row) => row.entry);
      if (!additions.length) return { ok: true, imported: 0, ...analysis };
      const nextEntries = [...currentEntries, ...additions];
      if (!writeJson(ENTRIES_KEY, { version: SCHEMA_VERSION, entries: nextEntries })) return { ok: false, error: storageMessage || "记账台保存失败。" };
      entries = nextEntries;
      const importedMonths = additions.map((entry) => entry.date.slice(0, 7)).sort();
      const latestImportedMonth = importedMonths[importedMonths.length - 1];
      if (validMonth(latestImportedMonth)) {
        state.month = latestImportedMonth;
        state.filters.import.monthScope = "current";
        saveState();
      }
      render();
      return { ok: true, imported: additions.length, ...analysis };
    } catch (error) {
      return { ok: false, error: error.message || "流水导入失败，未写入任何记录。" };
    }
  }

  function getImportPartners() {
    ensureInitialized();
    return partners.filter((partner) => partner.active).map(({ id, name }) => ({ id, name }));
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
    else if (action === "delete-category") deleteManaged("category", button.dataset.categoryId);
    else if (action === "delete-partner") deleteManaged("partner", button.dataset.partnerId);
    else if (action === "categories") openCategories();
    else if (action === "edit-category") openCategories(button.dataset.categoryId);
    else if (action === "toggle-category") {
      const item = categories.find((item) => item.id === button.dataset.categoryId);
      if (item && saveCategories(categories.map((entry) => entry.id === item.id ? { ...entry, active: !entry.active, updatedAt: nowIso() } : entry))) {
        render(); openCategories(); notify(item.active ? "分类已停用，历史记录保持不变" : "分类已启用");
      }
    }
    else if (action === "partners") openPartners();
    else if (action === "rename-partner") openPartners(button.dataset.partnerId);
    else if (action === "toggle-partner") togglePartner(button.dataset.partnerId);
    else if (action === "close-modal") closeAll(true);
    else if (action === "data-manager") {
      state.view = "data";
      saveState();
      render();
    }
    else if (action === "open-details") {
      const view = button.dataset.entryType === "expense" ? "expenses" : "income";
      const sourceView = state.view;
      state.filters[view] = structuredClone(DEFAULT_FILTERS[view]);
      state.filters[view].source = button.dataset.source || (sourceView === "overview" ? state.filters.overview.source : "all");
      state.filters[view].monthScope = sourceView === "manual" ? state.filters.manual.monthScope : sourceView === "overview" ? state.filters.overview.monthScope : "current";
      state.view = view;
      saveState();
      render();
    }
    else if (action === "external-import") {
      closeAll(true);
      if (globalThis.LedgerStatementImport?.open) globalThis.LedgerStatementImport.open();
      else alert("流水导入模块尚未加载，请刷新页面后重试。");
    }
    else if (action === "export") downloadBackup();
    else if (action === "select-import") $("[data-ledger-import]")?.click();
    else if (action === "confirm-import") confirmImport();
    else if (action === "clear-filters") {
      const view = button.dataset.filterView;
      if (!DEFAULT_FILTERS[view]) return;
      state.filters[view] = structuredClone(DEFAULT_FILTERS[view]);
      if (Object.prototype.hasOwnProperty.call(state.filters[view], "monthScope")) state.filters[view].monthScope = "all";
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
    if (event.target.matches("[data-ledger-form='entry'] [name='category']")) syncPartnerFields();
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
    if (form.dataset.ledgerForm === "category") saveCategoryForm(form);
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
  globalThis.LedgerWorkbench = { open, closeAll, previewExternalEntries, mergeExternalEntries, getImportPartners };
})();
