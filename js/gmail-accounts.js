(function () {
  "use strict";

  const STORAGE_KEY = "zy_kb_gmail_accounts_v1";
  const FIELDS = ["id", "email", "password", "twoFactor", "customerCode", "deliveryDate", "status", "sourceBatch", "remark", "createdAt", "updatedAt"];
  let integration = { getCustomerCodes: () => [], isCustomerCode: (value) => /^C\d{6}$/.test(value), notify: () => {}, rerender: () => {} };
  let store;
  let draft = null;
  let editingRecord = null;
  let returnFocus = null;
  const revealed = new Set();
  const filters = { status: "all", batch: "", keyword: "" };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const normalizeEmail = (value) => String(value).trim().toLowerCase();
  const safeText = (value, max, required = false) => typeof value === "string" && value.length <= max && (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
  const validEmail = (value) => safeText(value, 200, true) && /^[a-z0-9]+(?:[a-z0-9.+_-]*[a-z0-9])?@gmail\.com$/.test(value);
  function validDate(value) {
    if (value === "") return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validateRecord(record) {
    return record && typeof record === "object" && !Array.isArray(record) &&
      Object.keys(record).length === FIELDS.length && FIELDS.every((key) => Object.hasOwn(record, key)) &&
      safeText(record.id, 200, true) && validEmail(record.email) &&
      safeText(record.password, 500, true) && safeText(record.twoFactor, 500, true) &&
      safeText(record.customerCode, 7) && (!record.customerCode || /^C\d{6}$/.test(record.customerCode)) &&
      typeof record.deliveryDate === "string" && validDate(record.deliveryDate) &&
      ["pending", "delivered"].includes(record.status) && safeText(record.sourceBatch, 120) && safeText(record.remark, 500) &&
      [record.createdAt, record.updatedAt].every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)));
  }
  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return { ok: true, records: [], raw };
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || Object.keys(data).length !== 2 || !Array.isArray(data.records)) throw new Error();
      const ids = new Set(), emails = new Set();
      for (const record of data.records) {
        if (!validateRecord(record) || ids.has(record.id) || emails.has(record.email)) throw new Error();
        ids.add(record.id);
        emails.add(record.email);
      }
      return { ok: true, records: data.records, raw };
    } catch (_) {
      return { ok: false, records: [], message: "Gmail 数据读取或校验失败，已锁定写入并保留原始内容。" };
    }
  }
  // 仅写入 Gmail 独立 key；异常存储不当作空库，保存失败不更新内存。
  function saveRecords(records, base) {
    if (!base.ok || !records.every(validateRecord) || new Set(records.map((r) => r.email)).size !== records.length || new Set(records.map((r) => r.id)).size !== records.length) return false;
    try {
      if (localStorage.getItem(STORAGE_KEY) !== base.raw) {
        integration.notify("Gmail 数据已变化，请重新预览或打开编辑。");
        return false;
      }
      const raw = JSON.stringify({ version: 1, records });
      localStorage.setItem(STORAGE_KEY, raw);
      store = { ok: true, records, raw };
      return true;
    } catch (_) {
      integration.notify("Gmail 保存失败，请检查浏览器存储空间后重试。");
      return false;
    }
  }
  function analyzeBatch(text, existing = []) {
    const known = new Set(existing.map((r) => r.email));
    const seen = new Set();
    const result = { additions: [], duplicates: [], errors: [], empty: 0 };
    String(text).split(/\r\n|\n|\r/).forEach((line, index) => {
      const lineNumber = index + 1;
      if (!line.trim()) { result.empty++; return; }
      const fields = line.split("----").map((part) => part.trim());
      let reason = "";
      if (fields.length === 2) reason = "缺少 2FA；格式应为 邮箱----密码----2FA";
      else if (fields.length !== 3) reason = "需要三个字段，使用连续四个短横线 ---- 分隔";
      const [rawEmail = "", password = "", twoFactor = ""] = fields;
      const email = normalizeEmail(rawEmail);
      if (!reason && !validEmail(email)) reason = "Gmail 邮箱格式不正确（需为 @gmail.com，地址内不能有空格）";
      if (!reason && !safeText(password, 500, true)) reason = "密码为空、超长或包含控制字符";
      if (!reason && !safeText(twoFactor, 500, true)) reason = "缺少 2FA，或 2FA 超长、包含控制字符";
      if (reason) { result.errors.push({ line: lineNumber, reason }); return; }
      if (known.has(email) || seen.has(email)) {
        result.duplicates.push({ line: lineNumber, email, reason: known.has(email) ? "已有重复" : "批内重复" });
      } else result.additions.push({ line: lineNumber, email, password, twoFactor });
      seen.add(email);
    });
    return result;
  }
  function getSummary(now = new Date()) {
    store = readStore();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return { ok: store.ok, available: store.records.filter((r) => r.status === "pending").length,
      delivered: store.records.filter((r) => r.status === "delivered").length,
      monthDelivered: store.records.filter((r) => r.status === "delivered" && r.deliveryDate.startsWith(month + "-")).length, total: store.records.length };
  }
  function filteredRecords() {
    const keyword = filters.keyword.trim().toLowerCase();
    return store.records.filter((r) => (filters.status === "all" || r.status === filters.status) &&
      (!filters.batch || r.sourceBatch === filters.batch) &&
      (!keyword || [r.email, r.customerCode, r.sourceBatch, r.remark].some((value) => value.toLowerCase().includes(keyword))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function button(action, label, id = "", field = "") {
    return `<button type="button" class="btn" data-gmail-action="${action}" data-gmail-id="${esc(id)}" data-gmail-field="${field}">${label}</button>`;
  }
  function renderRows(records) {
    return records.map((r) => `<article class="gmail-record" data-gmail-record="${esc(r.id)}"><div data-label="Gmail 邮箱"><strong>${esc(r.email)}</strong></div>${["password", "twoFactor"].map((field) => {
      const visible = revealed.has(r.id + ":" + field);
      return `<div data-label="${field === "password" ? "密码" : "2FA"}" class="gmail-secret"><code>${visible ? esc(r[field]) : "••••••••"}</code>${button("reveal", visible ? "隐藏" : "查看", r.id, field)}</div>`;
    }).join("")}<div data-label="使用客户">${esc(r.customerCode || "待补录")}</div><div data-label="交付日期">${esc(r.deliveryDate || "待补录")}</div><div data-label="状态"><span class="manager-status ${r.status === "delivered" ? "is-delivered" : "is-pending"}">${r.status === "delivered" ? "已交付" : "未交付"}</span></div><div data-label="操作" class="gmail-actions">${button("copy", "一键复制", r.id)}${button("edit", "编辑", r.id)}</div></article>`).join("") || '<div class="manager-empty">当前筛选条件下暂无 Gmail 邮箱</div>';
  }
  function renderPane() {
    const summary = getSummary();
    if (!summary.ok) return `<section class="manager-panel recharge-code-error" role="alert">${esc(store.message)}</section>`;
    const batches = [...new Set(store.records.map((r) => r.sourceBatch).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const records = filteredRecords();
    return `<section class="mail-manager-pane gmail-pane" role="tabpanel" aria-labelledby="mailManagerGmailTab"><div class="recharge-code-toolbar"><div><span class="section-kicker">GMAIL ACCOUNTS</span><h2>Gmail 邮箱</h2><p>密码与 2FA 默认隐藏；复制不会改变交付状态。</p></div><div>${button("add", "单条录入 Gmail")}${button("batch", "批量录入 Gmail")}</div></div><section class="recharge-code-stats" aria-label="Gmail 统计">${[["可用 Gmail", summary.available], ["已交付", summary.delivered], ["本月交付", summary.monthDelivered], ["全部 Gmail", summary.total]].map(([label, count]) => `<article><span>${label}</span><strong>${count}</strong></article>`).join("")}</section><section class="manager-panel recharge-code-list-panel"><div class="recharge-code-filters gmail-filters" role="search" aria-label="Gmail 筛选"><label><span>状态</span><select data-gmail-filter="status">${[["all", "全部状态"], ["pending", "未交付"], ["delivered", "已交付"]].map(([value, label]) => `<option value="${value}"${filters.status === value ? " selected" : ""}>${label}</option>`).join("")}</select></label><label><span>来源批次</span><select data-gmail-filter="batch"><option value="">全部批次</option>${batches.map((b) => `<option value="${esc(b)}"${filters.batch === b ? " selected" : ""}>${esc(b)}</option>`).join("")}</select></label><label class="recharge-code-keyword"><span>关键词</span><input type="search" data-gmail-filter="keyword" maxlength="300" value="${esc(filters.keyword)}" placeholder="Gmail、客户编码、来源批次或备注"></label></div><div class="recharge-code-list-summary" aria-live="polite">筛选结果：<strong id="gmailResultCount">${records.length}</strong> 条</div><div class="gmail-list-head" aria-hidden="true">${["Gmail 邮箱", "密码", "2FA", "使用客户", "交付日期", "状态", "操作"].map((label) => `<span>${label}</span>`).join("")}</div><div id="gmailRecords">${renderRows(records)}</div></section></section>`;
  }
  function updateList() {
    const list = document.querySelector("#gmailRecords");
    if (!list) return;
    const records = filteredRecords();
    list.innerHTML = renderRows(records);
    document.querySelector("#gmailResultCount").textContent = records.length;
  }
  function closeModal(clear = true) {
    document.querySelector("#gmailModal")?.remove();
    if (clear) { draft = null; editingRecord = null; returnFocus?.focus?.(); returnFocus = null; }
  }
  function openModal(title, content) {
    if (!document.querySelector("#gmailModal")) returnFocus = document.activeElement;
    closeModal(false);
    const backdrop = document.createElement("div");
    backdrop.id = "gmailModal";
    backdrop.className = "recharge-code-modal-backdrop";
    backdrop.innerHTML = `<section class="recharge-code-modal" role="dialog" aria-modal="true" aria-labelledby="gmailModalTitle"><header><h2 id="gmailModalTitle">${title}</h2>${button("close", "×")}</header>${content}</section>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
    backdrop.querySelector("input, textarea, select, button")?.focus();
  }
  function openBatch() {
    const values = draft || { text: "", sourceBatch: "" };
    openModal("批量录入 Gmail", `<form data-gmail-form="batch"><div class="recharge-code-form-grid"><label class="is-wide"><span>来源批次（选填）</span><input name="sourceBatch" maxlength="120" value="${esc(values.sourceBatch)}"></label><label class="is-wide"><span>Gmail 列表（邮箱----密码----2FA）</span><textarea name="accounts" maxlength="200000" required spellcheck="false" placeholder="demo1@gmail.com----DemoPass123----ABCDEFGHIJKLMNOP">${esc(values.text)}</textarea></label></div><p>一行一条，空行自动忽略。检查后预览，确认后才保存。</p><p class="recharge-code-form-error" role="alert"></p><footer>${button("close", "取消")}<button type="submit" class="btn primary">检查并预览</button></footer></form>`);
  }
  function showPreview(message = "") {
    const p = draft.preview;
    openModal("Gmail 录入预览", `${message ? `<p role="alert">${esc(message)}</p>` : ""}<div class="recharge-code-preview-stats gmail-preview-stats"><span>待新增<strong>${p.additions.length}</strong></span><span>重复<strong>${p.duplicates.length}</strong></span><span>错误<strong>${p.errors.length}</strong></span></div><p>来源批次：${esc(draft.sourceBatch || "未填写")} · 忽略空行 ${p.empty} 行</p><div class="gmail-preview-list">${p.additions.map((r) => `<p>第 ${r.line} 行：${esc(r.email)} · 密码 / 2FA：••••••••</p>`).join("")}${p.duplicates.map((r) => `<p>第 ${r.line} 行：${esc(r.email)} · ${r.reason}</p>`).join("")}${p.errors.map((r) => `<p class="recharge-code-form-error">第 ${r.line} 行：${esc(r.reason)}</p>`).join("")}</div><p>只追加有效且不重复的记录；错误行不会写入。</p><footer>${button("batch", "返回修改")}<button type="button" class="btn primary" data-gmail-action="confirm"${p.additions.length ? "" : " disabled"}>确认新增 ${p.additions.length} 条</button></footer>`);
  }
  function newRecord(values, ids) {
    let id;
    do { id = "gmail-" + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`); } while (ids.has(id));
    ids.add(id);
    const now = new Date().toISOString();
    return { id, email: values.email, password: values.password, twoFactor: values.twoFactor, customerCode: "", deliveryDate: "", status: "pending", sourceBatch: "", remark: "", createdAt: now, updatedAt: now, ...values };
  }
  function confirmBatch() {
    if (!draft?.preview.additions.length) return;
    const fresh = readStore();
    if (!fresh.ok) { integration.notify(fresh.message); return; }
    const preview = analyzeBatch(draft.text, fresh.records);
    if (JSON.stringify(preview) !== JSON.stringify(draft.preview)) {
      draft.preview = preview;
      showPreview("Gmail 数据已变化，已重新检查，请再次确认。");
      return;
    }
    const ids = new Set(fresh.records.map((r) => r.id));
    const additions = preview.additions.map(({ email, password, twoFactor }) => newRecord({ email, password, twoFactor, sourceBatch: draft.sourceBatch }, ids));
    if (!saveRecords([...fresh.records, ...additions], fresh)) return;
    closeModal(); integration.rerender(); integration.notify(`已新增 ${additions.length} 条 Gmail`);
  }
  function openEdit(id) {
    store = readStore();
    if (!store.ok) { integration.notify(store.message); return; }
    const record = id ? store.records.find((r) => r.id === id) : null;
    if (id && !record) return;
    editingRecord = record ? { ...record } : null;
    const r = record || { email: "", password: "", twoFactor: "", customerCode: "", deliveryDate: "", status: "pending", sourceBatch: "", remark: "" };
    const field = (name, label, type = "text", max = 500) => `<label><span>${label}</span><div class="mail-edit-field-actions"><input name="${name}" type="${type}" maxlength="${max}" value="${esc(r[name])}"${["email", "password", "twoFactor"].includes(name) ? " required" : ""} autocomplete="${type === "password" ? "new-password" : "off"}">${type === "password" ? button("edit-reveal", "查看", "", name) : ""}</div></label>`;
    openModal(record ? "编辑 Gmail" : "单条录入 Gmail", `<form data-gmail-form="edit"><div class="recharge-code-form-grid">${field("email", "Gmail 邮箱", "email", 200)}${field("password", "密码", "password")}${field("twoFactor", "2FA", "password")}<label><span>使用客户</span><input name="customerCode" list="gmailCustomerCodes" maxlength="7" value="${esc(r.customerCode)}" placeholder="C000123"><datalist id="gmailCustomerCodes">${integration.getCustomerCodes().filter(integration.isCustomerCode).map((code) => `<option value="${esc(code)}"></option>`).join("")}</datalist></label>${field("deliveryDate", "交付日期", "date")}<label><span>状态</span><select name="status"><option value="pending"${r.status === "pending" ? " selected" : ""}>未交付</option><option value="delivered"${r.status === "delivered" ? " selected" : ""}>已交付</option></select></label>${field("sourceBatch", "来源批次（选填）", "text", 120)}${field("remark", "备注（选填）")}</div><p>交付后请手动填写客户、交付日期并修改状态。</p><p class="recharge-code-form-error" role="alert"></p><footer>${button("close", "取消")}<button type="submit" class="btn primary">保存 Gmail</button></footer></form>`);
  }
  function formError(form, message) { form.querySelector('[role="alert"]').textContent = message; }
  function saveEdit(form) {
    const values = Object.fromEntries(["email", "password", "twoFactor", "customerCode", "deliveryDate", "status", "sourceBatch", "remark"].map((name) => [name, form.elements.namedItem(name).value.trim()]));
    values.email = normalizeEmail(values.email);
    if (!validEmail(values.email)) return formError(form, "请输入有效的 @gmail.com 邮箱，地址内不能有空格。");
    if (values.customerCode && !integration.isCustomerCode(values.customerCode)) return formError(form, "客户编码必须为 C + 6 位数字，或留空。");
    const fresh = readStore();
    if (!fresh.ok) return formError(form, fresh.message);
    if (editingRecord && JSON.stringify(fresh.records.find((r) => r.id === editingRecord.id)) !== JSON.stringify(editingRecord)) return formError(form, "此 Gmail 已被其他页面修改，请关闭后重新编辑。");
    if (fresh.records.some((r) => r.email === values.email && r.id !== editingRecord?.id)) return formError(form, "重复 Gmail，未保存。请检查邮箱地址。");
    const record = editingRecord ? { ...editingRecord, ...values, updatedAt: new Date().toISOString() } : newRecord(values, new Set(fresh.records.map((r) => r.id)));
    if (!validateRecord(record)) return formError(form, "请检查必填密码、2FA、日期及字段长度；不允许控制字符。");
    const records = editingRecord ? fresh.records.map((r) => r.id === record.id ? record : r) : [...fresh.records, record];
    if (!saveRecords(records, fresh)) return;
    revealed.clear(); closeModal(); integration.rerender(); integration.notify("Gmail 已保存");
  }
  const deliveryText = (record) => `账号：${record.email}\n密码：${record.password}\n2Fa：${record.twoFactor}`;
  async function copyRecord(id) {
    const fresh = readStore();
    const record = fresh.ok && fresh.records.find((r) => r.id === id);
    if (!record) { integration.notify("Gmail 数据不可用，请刷新后重试。"); return; }
    const text = deliveryText(record);
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(input); input.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (_) { /* 显示失败提示 */ }
      input.remove();
      if (!copied) { integration.notify("复制失败，请检查剪贴板权限后重试。"); return; }
    }
    integration.notify("已复制");
  }
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-gmail-action]");
    if (!target) return;
    const { gmailAction: action, gmailId: id, gmailField: field } = target.dataset;
    if (action === "close") closeModal();
    if (action === "add") openEdit();
    if (action === "edit") openEdit(id);
    if (action === "batch") openBatch();
    if (action === "confirm") confirmBatch();
    if (action === "copy") void copyRecord(id);
    if (action === "reveal" && ["password", "twoFactor"].includes(field)) {
      const key = id + ":" + field;
      if (revealed.has(key)) revealed.delete(key); else revealed.add(key);
      updateList();
    }
    if (action === "edit-reveal" && ["password", "twoFactor"].includes(field)) {
      const input = target.closest("form").elements.namedItem(field);
      input.type = input.type === "password" ? "text" : "password";
      target.textContent = input.type === "password" ? "查看" : "隐藏";
    }
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.matches("[data-gmail-form]")) return;
    event.preventDefault();
    if (form.dataset.gmailForm === "edit") { saveEdit(form); return; }
    const text = form.elements.namedItem("accounts").value;
    const sourceBatch = form.elements.namedItem("sourceBatch").value.trim();
    if (text.length > 200000 || !safeText(sourceBatch, 120)) return formError(form, "内容超长或来源批次包含控制字符。");
    const fresh = readStore();
    if (!fresh.ok) return formError(form, fresh.message);
    draft = { text, sourceBatch, preview: analyzeBatch(text, fresh.records) };
    showPreview();
  });
  function filterEvent(event) {
    const field = event.target.dataset.gmailFilter;
    if (!Object.hasOwn(filters, field)) return;
    filters[field] = event.target.value;
    updateList();
  }
  document.addEventListener("input", filterEvent);
  document.addEventListener("change", filterEvent);
  document.addEventListener("keydown", (event) => {
    const modal = document.querySelector("#gmailModal");
    if (!modal) return;
    if (event.key === "Escape") { event.preventDefault(); closeModal(); }
    if (event.key === "Tab") {
      const nodes = [...modal.querySelectorAll("button:not(:disabled), input, textarea, select")];
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  store = readStore();
  globalThis.GmailAccounts = Object.freeze({
    configure(options) { integration = { ...integration, ...options }; },
    getSummary, renderPane,
    conceal() { revealed.clear(); closeModal(); },
  });
})();
