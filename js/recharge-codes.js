(function () {
  "use strict";

  const STORAGE_KEY = "zy_kb_recharge_codes_v1";
  const UI_STATE_KEY = "zy_kb_mail_recharge_ui_state_v1";
  const BACKUP_TYPE = "zy-kb-recharge-codes-backup";
  const SCHEMA_VERSION = 1;
  const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
  const CODE_MAX_LENGTH = 512;
  const CUSTOMER_CODE_PATTERN = /^C\d{6}$/;
  const STATUSES = new Set(["unused", "used"]);
  const RECORD_FIELDS = [
    "id", "code", "product", "batch", "status", "createdAt", "updatedAt", "usedAt", "customerCode", "note",
  ];
  const DEFAULT_UI_STATE = Object.freeze({
    version: 1,
    activeTab: "mail",
    mailStatus: "all",
    filters: { status: "all", product: "all", batch: "all", keyword: "" },
  });

  let integration = {
    getCustomerCodes: () => [],
    copyText: null,
    notify: null,
    rerender: null,
  };
  let uiState = loadUiState();
  let storeState = loadStore();
  let batchPreview = null;
  let importPayload = null;
  let importPreview = null;
  const revealedIds = new Set();
  const undoRecords = new Map();

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function cloneDefaultUiState() {
    return {
      ...DEFAULT_UI_STATE,
      filters: { ...DEFAULT_UI_STATE.filters },
    };
  }

  function loadUiState() {
    const fallback = cloneDefaultUiState();
    try {
      const raw = sessionStorage.getItem(UI_STATE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return fallback;
      const filters = parsed.filters && typeof parsed.filters === "object" ? parsed.filters : {};
      return {
        version: 1,
        activeTab: parsed.activeTab === "recharge" ? "recharge" : "mail",
        mailStatus: ["all", "pending", "delivered"].includes(parsed.mailStatus)
          ? parsed.mailStatus
          : "all",
        filters: {
          status: ["all", "unused", "used"].includes(filters.status) ? filters.status : "all",
          product: typeof filters.product === "string" ? filters.product.slice(0, 160) : "all",
          batch: typeof filters.batch === "string" ? filters.batch.slice(0, 120) : "all",
          keyword: typeof filters.keyword === "string" ? filters.keyword.slice(0, 300) : "",
        },
      };
    } catch (error) {
      return fallback;
    }
  }

  function saveUiState() {
    try {
      sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({
        version: 1,
        activeTab: uiState.activeTab,
        mailStatus: uiState.mailStatus,
        filters: { ...uiState.filters },
      }));
    } catch (error) {
      // 可选界面状态保存失败时，不影响卡密业务数据。
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isIsoTime(value) {
    const match = typeof value === "string" && value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    );
    if (!match || Number.isNaN(Date.parse(value))) return false;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return month >= 1 && month <= 12 && day >= 1 && day <= maxDay &&
      hour <= 23 && minute <= 59 && second <= 59;
  }

  function isSafeText(value, maxLength, allowEmpty = true) {
    return typeof value === "string" &&
      value.length <= maxLength &&
      (allowEmpty || value.length > 0) &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
  }

  function isValidCode(value) {
    return isSafeText(value, CODE_MAX_LENGTH, false) &&
      value === value.trim() &&
      !/[\r\n]/.test(value) &&
      !/^\s+$/.test(value);
  }

  function validateRecord(raw) {
    if (!isPlainObject(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((field) => Object.hasOwn(raw, field))) return null;
    const { id, code, product, batch, status, createdAt, updatedAt, usedAt, customerCode, note } = raw;
    if (!isSafeText(id, 200, false) || !isValidCode(code)) return null;
    if (!isSafeText(product, 160, false) || product !== product.trim()) return null;
    if (!isSafeText(batch, 120) || batch !== batch.trim()) return null;
    if (!STATUSES.has(status) || !isIsoTime(createdAt) || !isIsoTime(updatedAt)) return null;
    if (!isSafeText(usedAt, 40) || !isSafeText(customerCode, 20) || !isSafeText(note, 500)) return null;
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) return null;
    if (status === "unused" && usedAt !== "") return null;
    if (status === "used" && !isIsoTime(usedAt)) return null;
    return { id, code, product, batch, status, createdAt, updatedAt, usedAt, customerCode, note };
  }

  function loadStore() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return { ok: false, records: [], message: "卡密数据读取失败，所有写操作已锁定。" };
    }
    if (raw === null) return { ok: true, records: [], message: "" };
    let documentValue;
    try {
      documentValue = JSON.parse(raw);
    } catch (error) {
      return { ok: false, records: [], message: "卡密数据无法解析，已保留原始内容并锁定所有写操作。" };
    }
    if (
      !isPlainObject(documentValue) ||
      Object.keys(documentValue).length !== 2 ||
      !Object.hasOwn(documentValue, "version") ||
      !Object.hasOwn(documentValue, "records") ||
      documentValue.version !== 1 ||
      !Array.isArray(documentValue.records)
    ) {
      return { ok: false, records: [], message: "卡密数据结构异常，已保留原始内容并锁定所有写操作。" };
    }
    const ids = new Set();
    const codes = new Set();
    const records = [];
    for (const rawRecord of documentValue.records) {
      const record = validateRecord(rawRecord);
      if (!record || ids.has(record.id) || codes.has(record.code)) {
        return { ok: false, records: [], message: "卡密记录校验失败，已保留原始内容并锁定所有写操作。" };
      }
      ids.add(record.id);
      codes.add(record.code);
      records.push(record);
    }
    return { ok: true, records, message: "" };
  }

  function saveRecords(records) {
    if (!storeState.ok) return false;
    const documentValue = { version: 1, records };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(documentValue));
    } catch (error) {
      showMessage("卡密保存失败，原有数据未改变。", true);
      return false;
    }
    storeState = { ok: true, records, message: "" };
    return true;
  }

  function refreshStoreForWrite() {
    const fresh = loadStore();
    if (!fresh.ok) {
      storeState = fresh;
      closeModal();
      requestRender();
      return null;
    }
    storeState = fresh;
    return fresh;
  }

  function createId(existingIds) {
    let id;
    do {
      const suffix = globalThis.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      id = `recharge-${suffix}`;
    } while (existingIds.has(id));
    existingIds.add(id);
    return id;
  }

  function showMessage(message, isError = false) {
    if (typeof integration.notify === "function") {
      integration.notify(message);
      return;
    }
    if (isError) alert(message);
  }

  function requestRender() {
    if (typeof integration.rerender === "function") integration.rerender();
  }

  function currentMonthContains(value) {
    if (!isIsoTime(value)) return false;
    const date = new Date(value);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }

  function getSummary() {
    if (!storeState.ok) return { ok: false, available: null, used: null, monthUsed: null, total: null };
    return {
      ok: true,
      available: storeState.records.filter((record) => record.status === "unused").length,
      used: storeState.records.filter((record) => record.status === "used").length,
      monthUsed: storeState.records.filter((record) => record.status === "used" && currentMonthContains(record.usedAt)).length,
      total: storeState.records.length,
    };
  }

  function maskCode(code) {
    if (code.length <= 4) return `${code.slice(0, 1)}${"•".repeat(Math.max(2, code.length - 2))}${code.slice(-1)}`;
    const edge = Math.min(4, Math.max(2, Math.floor(code.length / 4)));
    return `${code.slice(0, edge)}${"•".repeat(Math.max(4, code.length - edge * 2))}${code.slice(-edge)}`;
  }

  function selectOptions(values, selected, emptyLabel) {
    return `<option value="all">${esc(emptyLabel)}</option>${values.map((value) => `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(value || "未填写")}</option>`).join("")}`;
  }

  function filteredRecords() {
    if (!storeState.ok) return [];
    const keyword = uiState.filters.keyword.toLocaleLowerCase();
    return [...storeState.records]
      .filter((record) =>
        (uiState.filters.status === "all" || record.status === uiState.filters.status) &&
        (uiState.filters.product === "all" || record.product === uiState.filters.product) &&
        (uiState.filters.batch === "all" || record.batch === uiState.filters.batch) &&
        (!keyword || [record.code, record.customerCode, record.note].some((value) => value.toLocaleLowerCase().includes(keyword))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function pruneUndoRecords() {
    const now = Date.now();
    for (const [id, undo] of undoRecords) {
      if (undo.expiresAt <= now) {
        clearTimeout(undo.timer);
        undoRecords.delete(id);
      }
    }
  }

  function renderRows(records) {
    pruneUndoRecords();
    if (!records.length) return '<div class="recharge-code-empty">当前筛选条件下暂无卡密</div>';
    return records.map((record) => {
      const revealed = revealedIds.has(record.id);
      const undo = undoRecords.get(record.id);
      return `<article class="recharge-code-row ${record.status === "used" ? "is-used" : "is-unused"}" data-recharge-id="${esc(record.id)}"><div class="recharge-code-value"><span class="recharge-code-mobile-label">卡密</span><code>${esc(revealed ? record.code : maskCode(record.code))}</code><button type="button" data-recharge-action="toggle-view" data-recharge-id="${esc(record.id)}">${revealed ? "隐藏" : "查看"}</button><button type="button" data-recharge-action="copy" data-recharge-id="${esc(record.id)}">复制</button></div><div data-label="产品/套餐">${esc(record.product)}</div><div data-label="来源批次">${esc(record.batch || "—")}</div><div data-label="状态"><span class="recharge-code-status ${record.status}">${record.status === "used" ? "已使用" : "未使用"}</span>${record.status === "used" && record.usedAt ? `<small>${esc(new Date(record.usedAt).toLocaleString("zh-CN", { hour12: false }))}</small>` : ""}</div><div class="recharge-code-row-actions" data-label="操作">${record.status === "unused" ? `<button type="button" class="btn primary" data-recharge-action="mark-used" data-recharge-id="${esc(record.id)}">标记已使用</button>` : `<button type="button" class="btn" data-recharge-action="edit-customer" data-recharge-id="${esc(record.id)}">${record.customerCode ? "修改客户" : "关联客户"}</button>`}${undo ? `<button type="button" class="btn recharge-code-undo" data-recharge-action="undo-used" data-recharge-id="${esc(record.id)}">撤销</button>` : ""}</div></article>`;
    }).join("");
  }

  function renderPane() {
    if (!storeState.ok) {
      return `<section class="recharge-code-pane" role="tabpanel" aria-labelledby="mailManagerRechargeTab"><div class="manager-panel recharge-code-error" role="alert"><h2>卡密数据异常</h2><p>${esc(storeState.message)}</p><small>未将异常数据视为空数据，所有新增、标记、关联和导入操作均已锁定。</small></div></section>`;
    }
    const summary = getSummary();
    const products = [...new Set(storeState.records.map((record) => record.product))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const batches = [...new Set(storeState.records.map((record) => record.batch))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const records = filteredRecords();
    return `<section class="recharge-code-pane" role="tabpanel" aria-labelledby="mailManagerRechargeTab"><div class="recharge-code-toolbar"><div><span class="section-kicker">RECHARGE CODES</span><h2>充值卡密</h2><p>卡密默认遮挡显示，复制不会改变使用状态。</p></div><div><button type="button" class="btn" data-recharge-action="data-manager">数据管理</button><button type="button" class="btn primary" data-recharge-action="open-batch">批量录入卡密</button></div></div><section class="recharge-code-stats" aria-label="卡密统计"><article><span>可用卡密</span><strong>${summary.available}</strong></article><article><span>已使用</span><strong>${summary.used}</strong></article><article><span>本月使用</span><strong>${summary.monthUsed}</strong></article><article><span>全部卡密</span><strong>${summary.total}</strong></article></section><section class="manager-panel recharge-code-list-panel"><div class="recharge-code-filters" role="search" aria-label="卡密筛选"><label><span>状态</span><select data-recharge-filter="status"><option value="all"${uiState.filters.status === "all" ? " selected" : ""}>全部</option><option value="unused"${uiState.filters.status === "unused" ? " selected" : ""}>未使用</option><option value="used"${uiState.filters.status === "used" ? " selected" : ""}>已使用</option></select></label><label><span>产品/套餐</span><select data-recharge-filter="product">${selectOptions(products, uiState.filters.product, "全部产品")}</select></label><label><span>来源批次</span><select data-recharge-filter="batch">${selectOptions(batches, uiState.filters.batch, "全部批次")}</select></label><label class="recharge-code-keyword"><span>关键词</span><input type="search" value="${esc(uiState.filters.keyword)}" data-recharge-filter="keyword" placeholder="卡密、客户编码或备注"></label></div><div class="recharge-code-list-summary">筛选结果：<strong>${records.length}</strong> 条</div><div class="recharge-code-list-head" aria-hidden="true"><span>卡密</span><span>产品/套餐</span><span>来源批次</span><span>状态</span><span>操作</span></div><div class="recharge-code-list">${renderRows(records)}</div></section></section>`;
  }

  function updateListOnly() {
    const list = document.querySelector(".recharge-code-list");
    const summary = document.querySelector(".recharge-code-list-summary strong");
    if (!list || !summary) return;
    const records = filteredRecords();
    list.innerHTML = renderRows(records);
    summary.textContent = String(records.length);
  }

  function openModal(html) {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.id = "rechargeCodeModal";
    backdrop.className = "recharge-code-modal-backdrop";
    backdrop.innerHTML = html;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
    backdrop.querySelector("input, textarea, select, button")?.focus();
  }

  function closeModal() {
    document.querySelector("#rechargeCodeModal")?.remove();
  }

  function openBatchModal() {
    if (!storeState.ok) return;
    batchPreview = null;
    openModal(`<section class="recharge-code-modal" role="dialog" aria-modal="true" aria-labelledby="rechargeBatchTitle"><header><div><span class="section-kicker">BATCH ENTRY</span><h2 id="rechargeBatchTitle">批量录入卡密</h2></div><button type="button" data-recharge-action="close-modal" aria-label="关闭">×</button></header><form data-recharge-form="batch"><div class="recharge-code-form-grid"><label><span>产品/套餐</span><input name="product" value="ChatGPT Plus" maxlength="160" required></label><label><span>来源批次</span><input name="batch" maxlength="120" required></label><label class="is-wide"><span>卡密列表（每行一个）</span><textarea name="codes" maxlength="200000" required spellcheck="false"></textarea></label><label class="is-wide"><span>备注（选填）</span><textarea name="note" maxlength="500"></textarea></label></div><p class="recharge-code-form-error" role="alert"></p><footer><button type="button" class="btn" data-recharge-action="close-modal">取消</button><button type="submit" class="btn primary">检查并预览</button></footer></form></section>`);
  }

  function analyzeBatch(values) {
    const existingCodes = new Set(storeState.records.map((record) => record.code));
    const seen = new Set();
    const additions = [];
    let empty = 0;
    let batchDuplicate = 0;
    let existingDuplicate = 0;
    let invalid = 0;
    const lines = values.codes.replace(/\r\n?/g, "\n").split("\n");
    for (const code of lines) {
      if (!code || /^\s+$/.test(code)) {
        empty += 1;
        continue;
      }
      if (!isValidCode(code)) {
        invalid += 1;
        continue;
      }
      if (seen.has(code)) {
        batchDuplicate += 1;
        continue;
      }
      seen.add(code);
      if (existingCodes.has(code)) {
        existingDuplicate += 1;
        continue;
      }
      additions.push(code);
    }
    return { values, additions, empty, batchDuplicate, existingDuplicate, invalid };
  }

  function renderBatchPreview() {
    const preview = batchPreview;
    openModal(`<section class="recharge-code-modal" role="dialog" aria-modal="true" aria-labelledby="rechargeBatchPreviewTitle"><header><div><span class="section-kicker">BATCH PREVIEW</span><h2 id="rechargeBatchPreviewTitle">录入预览</h2></div><button type="button" data-recharge-action="close-modal" aria-label="关闭">×</button></header><div class="recharge-code-preview-stats"><span>有效卡密<strong>${preview.additions.length}</strong></span><span>空行<strong>${preview.empty}</strong></span><span>批内重复<strong>${preview.batchDuplicate}</strong></span><span>已有重复<strong>${preview.existingDuplicate}</strong></span><span>无效卡密<strong>${preview.invalid}</strong></span></div><p>产品/套餐：${esc(preview.values.product)} · 来源批次：${esc(preview.values.batch)}</p><p class="recharge-code-security-note">预览不显示完整卡密。确认后仅追加有效且不重复的记录。</p><footer><button type="button" class="btn" data-recharge-action="open-batch">返回修改</button><button type="button" class="btn primary" data-recharge-action="confirm-batch"${preview.additions.length ? "" : " disabled"}>确认追加 ${preview.additions.length} 条</button></footer></section>`);
  }

  function confirmBatch() {
    if (!batchPreview || !batchPreview.additions.length || !storeState.ok) return;
    const fresh = refreshStoreForWrite();
    if (!fresh) return;
    const refreshedPreview = analyzeBatch(batchPreview.values);
    if (
      refreshedPreview.additions.length !== batchPreview.additions.length ||
      refreshedPreview.existingDuplicate !== batchPreview.existingDuplicate
    ) {
      batchPreview = refreshedPreview;
      renderBatchPreview();
      return;
    }
    const existingIds = new Set(storeState.records.map((record) => record.id));
    const now = new Date().toISOString();
    const additions = batchPreview.additions.map((code) => ({
      id: createId(existingIds),
      code,
      product: batchPreview.values.product,
      batch: batchPreview.values.batch,
      status: "unused",
      createdAt: now,
      updatedAt: now,
      usedAt: "",
      customerCode: "",
      note: batchPreview.values.note,
    }));
    if (!saveRecords([...storeState.records, ...additions])) return;
    const count = additions.length;
    batchPreview = null;
    closeModal();
    requestRender();
    showMessage(`已新增 ${count} 条卡密`);
  }

  function markUsed(id) {
    if (!storeState.ok) return;
    if (!refreshStoreForWrite()) return;
    const index = storeState.records.findIndex((record) => record.id === id);
    const record = storeState.records[index];
    if (!record || record.status !== "unused") return;
    const before = { ...record };
    const markedUpdatedAt = new Date().toISOString();
    const nextRecords = storeState.records.map((item, itemIndex) => itemIndex === index
      ? { ...item, status: "used", usedAt: markedUpdatedAt, updatedAt: markedUpdatedAt }
      : item);
    if (!saveRecords(nextRecords)) return;
    const previousUndo = undoRecords.get(id);
    if (previousUndo) clearTimeout(previousUndo.timer);
    const timer = setTimeout(() => {
      undoRecords.delete(id);
      requestRender();
    }, 9000);
    undoRecords.set(id, { before, markedUpdatedAt, expiresAt: Date.now() + 9000, timer });
    requestRender();
    showMessage("已标记使用，可在 9 秒内撤销");
  }

  function undoUsed(id) {
    const undo = undoRecords.get(id);
    if (!undo || undo.expiresAt <= Date.now() || !storeState.ok) return;
    if (!refreshStoreForWrite()) return;
    const current = storeState.records.find((record) => record.id === id);
    if (!current || current.status !== "used" || current.updatedAt !== undo.markedUpdatedAt) {
      undoRecords.delete(id);
      clearTimeout(undo.timer);
      requestRender();
      showMessage("记录已再次修改，无法撤销。", true);
      return;
    }
    const nextRecords = storeState.records.map((record) => record.id === id ? { ...undo.before } : record);
    if (!saveRecords(nextRecords)) return;
    clearTimeout(undo.timer);
    undoRecords.delete(id);
    requestRender();
    showMessage("已撤销标记使用");
  }

  function openCustomerModal(id) {
    const record = storeState.records.find((item) => item.id === id);
    if (!record || record.status !== "used") return;
    let customerCodes = [];
    try {
      customerCodes = integration.getCustomerCodes();
    } catch (error) {
      customerCodes = [];
    }
    const options = [...new Set(customerCodes.filter((code) => CUSTOMER_CODE_PATTERN.test(code)))];
    openModal(`<section class="recharge-code-modal recharge-code-customer-modal" role="dialog" aria-modal="true" aria-labelledby="rechargeCustomerTitle"><header><div><span class="section-kicker">CUSTOMER</span><h2 id="rechargeCustomerTitle">关联客户编码</h2></div><button type="button" data-recharge-action="close-modal" aria-label="关闭">×</button></header><form data-recharge-form="customer" data-recharge-id="${esc(record.id)}"><label><span>客户编码（可留空）</span><input name="customerCode" value="${esc(record.customerCode)}" list="rechargeCustomerCodes" maxlength="20" autocomplete="off" placeholder="例如 C000006"><datalist id="rechargeCustomerCodes">${options.map((code) => `<option value="${esc(code)}"></option>`).join("")}</datalist></label><small>候选项只读自客户编码库；此操作不会新增或修改客户编码。</small><p class="recharge-code-form-error" role="alert"></p><footer><button type="button" class="btn" data-recharge-action="close-modal">取消</button><button type="submit" class="btn primary">保存关联</button></footer></form></section>`);
  }

  function saveCustomerCode(form) {
    const id = form.dataset.rechargeId || "";
    const customerCode = String(form.elements.namedItem("customerCode")?.value || "");
    const error = form.querySelector(".recharge-code-form-error");
    if (customerCode && !CUSTOMER_CODE_PATTERN.test(customerCode)) {
      if (error) error.textContent = "客户编码必须严格使用 C＋6位数字格式，或留空。";
      return;
    }
    if (!refreshStoreForWrite()) return;
    const record = storeState.records.find((item) => item.id === id);
    if (!record || record.status !== "used") return;
    const nextRecords = storeState.records.map((item) => item.id === id
      ? { ...item, customerCode, updatedAt: new Date().toISOString() }
      : item);
    if (!saveRecords(nextRecords)) return;
    closeModal();
    requestRender();
    showMessage("客户编码已更新");
  }

  function downloadBackup() {
    if (!storeState.ok) return;
    const backup = {
      backupType: BACKUP_TYPE,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      records: storeState.records.map((record) => ({ ...record })),
    };
    const link = document.createElement("a");
    const date = new Date();
    const two = (value) => String(value).padStart(2, "0");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    link.download = `recharge-codes-backup-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 500);
    showMessage(`卡密备份已导出，共 ${backup.records.length} 条`);
  }

  function analyzeImport(records, existingRecords) {
    const existingById = new Map(existingRecords.map((record) => [record.id, record]));
    const existingByCode = new Map(existingRecords.map((record) => [record.code, record]));
    const incomingById = new Map();
    const incomingByCode = new Map();
    const additions = [];
    let duplicate = 0;
    let conflict = 0;
    let invalid = 0;
    for (const raw of records) {
      const record = validateRecord(raw);
      if (!record) {
        invalid += 1;
        continue;
      }
      const priorIncomingId = incomingById.get(record.id);
      const priorIncomingCode = incomingByCode.get(record.code);
      if (priorIncomingId || priorIncomingCode) {
        if (priorIncomingId?.code === record.code && priorIncomingCode?.id === record.id) duplicate += 1;
        else conflict += 1;
        continue;
      }
      incomingById.set(record.id, record);
      incomingByCode.set(record.code, record);
      const byId = existingById.get(record.id);
      const byCode = existingByCode.get(record.code);
      if (byId || byCode) {
        if (byId?.code === record.code && byCode?.id === record.id) duplicate += 1;
        else conflict += 1;
        continue;
      }
      additions.push(record);
    }
    return { additions, duplicate, conflict, invalid };
  }

  function importSignature(preview) {
    return JSON.stringify({
      ids: preview.additions.map((record) => record.id),
      codes: preview.additions.map((record) => record.code),
      duplicate: preview.duplicate,
      conflict: preview.conflict,
      invalid: preview.invalid,
    });
  }

  function renderDataModal(message = "") {
    const preview = importPreview;
    openModal(`<section class="recharge-code-modal" role="dialog" aria-modal="true" aria-labelledby="rechargeDataTitle"><header><div><span class="section-kicker">DATA</span><h2 id="rechargeDataTitle">卡密数据管理</h2></div><button type="button" data-recharge-action="close-modal" aria-label="关闭">×</button></header><p class="recharge-code-security-note"><strong>备份文件包含完整卡密，请妥善保管。</strong></p><div class="recharge-code-data-actions"><button type="button" class="btn" data-recharge-action="export">导出卡密备份</button><button type="button" class="btn" data-recharge-action="select-import">导入卡密备份</button><input id="rechargeCodeImportInput" type="file" accept="application/json,.json" hidden></div>${message ? `<p class="recharge-code-import-message" role="alert">${esc(message)}</p>` : ""}${preview ? `<section class="recharge-code-import-preview"><h3>导入预览</h3><div class="recharge-code-preview-stats"><span>新增<strong>${preview.additions.length}</strong></span><span>重复<strong>${preview.duplicate}</strong></span><span>冲突<strong>${preview.conflict}</strong></span><span>无效<strong>${preview.invalid}</strong></span></div><p>确认时会重新读取当前卡密数据并再次分析，只追加合法新记录。</p><button type="button" class="btn primary" data-recharge-action="confirm-import"${preview.additions.length ? "" : " disabled"}>确认安全合并</button></section>` : ""}<footer><button type="button" class="btn" data-recharge-action="close-modal">关闭</button></footer></section>`);
  }

  async function handleImportFile(file) {
    importPayload = null;
    importPreview = null;
    if (!file || !/\.json$/i.test(file.name || "")) return renderDataModal("请选择 JSON 格式的卡密备份文件。");
    if (file.size > BACKUP_MAX_BYTES) return renderDataModal("卡密备份文件超过 10MB，已停止导入。");
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      return renderDataModal("卡密备份文件损坏或无法解析，未写入任何数据。");
    }
    if (!isPlainObject(parsed) || parsed.backupType !== BACKUP_TYPE || parsed.schemaVersion !== SCHEMA_VERSION || !isIsoTime(parsed.exportedAt) || !Array.isArray(parsed.records)) {
      return renderDataModal("备份类型、版本或文档结构无效，未写入任何数据。");
    }
    const fresh = loadStore();
    if (!fresh.ok) {
      storeState = fresh;
      closeModal();
      requestRender();
      return;
    }
    storeState = fresh;
    importPayload = parsed.records;
    importPreview = analyzeImport(importPayload, fresh.records);
    renderDataModal();
  }

  function confirmImport() {
    if (!importPayload || !importPreview || !storeState.ok) return;
    const confirmedSignature = importSignature(importPreview);
    const fresh = loadStore();
    if (!fresh.ok) {
      storeState = fresh;
      closeModal();
      requestRender();
      return;
    }
    storeState = fresh;
    const latestPreview = analyzeImport(importPayload, fresh.records);
    importPreview = latestPreview;
    if (importSignature(latestPreview) !== confirmedSignature) {
      renderDataModal("现有卡密数据已变化，预览已刷新，请重新确认。");
      return;
    }
    if (!latestPreview.additions.length) {
      renderDataModal("没有可新增的卡密，现有数据未改变。");
      return;
    }
    if (!saveRecords([...fresh.records, ...latestPreview.additions])) return;
    const count = latestPreview.additions.length;
    importPayload = null;
    importPreview = null;
    closeModal();
    requestRender();
    showMessage(`安全合并完成，新增 ${count} 条卡密`);
  }

  function handleClick(event) {
    const button = event.target instanceof Element ? event.target.closest("[data-recharge-action]") : null;
    if (!button) return;
    const action = button.dataset.rechargeAction;
    const id = button.dataset.rechargeId || "";
    if (action === "close-modal") closeModal();
    else if (action === "open-batch") openBatchModal();
    else if (action === "confirm-batch") confirmBatch();
    else if (action === "toggle-view") {
      if (revealedIds.has(id)) revealedIds.delete(id);
      else revealedIds.add(id);
      updateListOnly();
    } else if (action === "copy") {
      const record = storeState.records.find((item) => item.id === id);
      if (record && typeof integration.copyText === "function") integration.copyText(record.code);
    } else if (action === "mark-used") markUsed(id);
    else if (action === "undo-used") undoUsed(id);
    else if (action === "edit-customer") openCustomerModal(id);
    else if (action === "data-manager") {
      importPayload = null;
      importPreview = null;
      renderDataModal();
    } else if (action === "export") downloadBackup();
    else if (action === "select-import") document.querySelector("#rechargeCodeImportInput")?.click();
    else if (action === "confirm-import") confirmImport();
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.rechargeForm === "batch") {
      event.preventDefault();
      const product = String(form.elements.namedItem("product")?.value || "").trim();
      const batch = String(form.elements.namedItem("batch")?.value || "").trim();
      const codes = String(form.elements.namedItem("codes")?.value || "");
      const note = String(form.elements.namedItem("note")?.value || "").trim();
      const error = form.querySelector(".recharge-code-form-error");
      if (!isSafeText(product, 160, false) || !isSafeText(batch, 120, false) || !isSafeText(note, 500) || !codes) {
        if (error) error.textContent = "请填写有效的产品、来源批次和卡密列表。";
        return;
      }
      batchPreview = analyzeBatch({ product, batch, codes, note });
      renderBatchPreview();
    } else if (form.dataset.rechargeForm === "customer") {
      event.preventDefault();
      saveCustomerCode(form);
    }
  }

  function handleChange(event) {
    const field = event.target instanceof Element ? event.target.closest("[data-recharge-filter]") : null;
    if (!field) return;
    const name = field.dataset.rechargeFilter;
    if (name === "status" && ["all", "unused", "used"].includes(field.value)) uiState.filters.status = field.value;
    if (name === "product") uiState.filters.product = String(field.value).slice(0, 160);
    if (name === "batch") uiState.filters.batch = String(field.value).slice(0, 120);
    saveUiState();
    requestRender();
  }

  function handleInput(event) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.dataset.rechargeFilter !== "keyword") return;
    uiState.filters.keyword = field.value.slice(0, 300);
    saveUiState();
    updateListOnly();
  }

  function handleFileChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "rechargeCodeImportInput") return;
    const file = input.files?.[0];
    input.value = "";
    if (file) handleImportFile(file);
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("change", handleChange);
  document.addEventListener("change", handleFileChange);
  document.addEventListener("input", handleInput);

  globalThis.RechargeCodes = Object.freeze({
    configure(options = {}) {
      integration = { ...integration, ...options };
    },
    getActiveTab() {
      return uiState.activeTab;
    },
    setActiveTab(value) {
      uiState.activeTab = value === "recharge" ? "recharge" : "mail";
      saveUiState();
    },
    getMailStatusFilter() {
      return uiState.mailStatus;
    },
    setMailStatusFilter(value) {
      uiState.mailStatus = ["all", "pending", "delivered"].includes(value) ? value : "all";
      saveUiState();
    },
    getSummary,
    renderPane,
  });
})();
