(function () {
  "use strict";

  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_ZIP_ENTRIES = 50;
  const MAX_ZIP_ENTRY_BYTES = 25 * 1024 * 1024;
  const MAX_ZIP_TOTAL_BYTES = 60 * 1024 * 1024;
  const MAX_ROWS = 10000;
  const MAX_COLUMNS = 100;
  const PAGE_SIZE = 50;
  const TARGETS = new Set(["income", "third_party", "other", "ignore"]);
  const FIELD_LABELS = {
    date: "日期时间", direction: "收支方向", amount: "金额", activityType: "动账类型", counterparty: "交易对象",
    summary: "商品或业务说明", transactionId: "交易单号", status: "交易状态", paymentMethod: "支付方式", note: "备注摘要",
    time: "独立时间",
  };
  const ALIASES = {
    date: ["动账时间", "交易时间", "完成时间", "创建时间", "收付款时间", "日期", "入账时间"],
    time: ["时间"], direction: ["收支", "收支类型", "资金流向", "交易类型", "方向"],
    amount: ["动账金额", "金额", "金额元", "交易金额", "收付款金额", "订单金额", "实收金额"],
    activityType: ["动账类型"],
    counterparty: ["交易对方", "交易对象", "对方", "付款方", "收款方", "商户名称"],
    summary: ["商品说明", "商品名称", "业务说明", "摘要", "用途", "交易内容"],
    transactionId: ["支付宝交易号", "交易号", "交易单号", "收付款单号", "订单号", "商家订单号"],
    status: ["交易状态", "状态", "收付款状态", "订单状态"], paymentMethod: ["支付方式", "付款方式", "资金渠道"],
    note: ["备注", "备注摘要", "附言", "说明"],
  };
  const SPECIAL_STATUS = /失败|关闭|取消|已撤销|交易关闭|未成功/;
  const REFUND_STATUS = /退款|退回|退票/;
  const FEE_TEXT = /手续费|服务费/;
  const WECOM_FUNDS_HEADERS = ["动账时间", "关联单号", "动账类型", "收支类型", "动账金额", "账户余额", "商户单号", "备注", "商户号", "操作人", "操作人所在部门", "所属管理规则"];
  const WECOM_PLACEHOLDER = /^(?:-|--|—|\/|无|暂无|空|n\/?a|null|none)$/i;
  let state = freshState();

  function freshState() {
    return { platform: "auto", file: null, rows: null, headers: [], mapping: {}, headerIndex: -1, candidates: [], analysis: null, page: 1, batchId: "", selectedSource: "", choices: null, wecomPreset: false, manualMapping: false, usedWecomPreset: false };
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function modalRoot() { return document.querySelector(".ledger-import-modal-backdrop"); }
  function contentRoot() { return modalRoot()?.querySelector(".ledger-import-content"); }
  function ledgerApi() { return globalThis.LedgerWorkbench; }
  function randomId(prefix) {
    const value = globalThis.crypto?.randomUUID?.();
    if (!value) throw new Error("当前浏览器缺少安全随机 UUID 能力，已停止导入。");
    return `${prefix}-${value}`;
  }

  function open() {
    close();
    state = freshState();
    const backdrop = document.createElement("div");
    backdrop.className = "ledger-import-modal-backdrop";
    backdrop.innerHTML = `<section class="ledger-import-modal" role="dialog" aria-modal="true" aria-labelledby="ledgerImportTitle"><header class="ledger-import-header"><div><span class="section-kicker">STATEMENT IMPORT</span><h2 id="ledgerImportTitle">导入支付宝/企业微信流水</h2></div><button type="button" class="ledger-import-close" data-ledger-import-action="close" aria-label="关闭">×</button></header><div class="ledger-import-steps" aria-label="导入步骤"><span class="active">1 选择文件</span><span>2 自动识别/字段对应</span><span>3 预览确认</span></div><div class="ledger-import-content"></div></section>`;
    document.body.appendChild(backdrop);
    renderChoose();
  }

  function close() {
    const root = modalRoot();
    if (root) root.remove();
    state = freshState();
  }

  function setStep(step) {
    modalRoot()?.querySelectorAll(".ledger-import-steps span").forEach((item, index) => item.classList.toggle("active", index < step));
  }

  function renderChoose(message = "") {
    setStep(1);
    const root = contentRoot();
    if (!root) return;
    root.innerHTML = `<div class="ledger-import-intro"><p>文件仅在当前页面内存中解析，确认前不会写入记账台。支持 CSV、XLSX 和未加密 ZIP；第一版不支持 XLS。</p><div class="ledger-import-source"><label><span>流水来源</span><select data-ledger-import-platform><option value="auto">自动识别</option><option value="alipay">支付宝</option><option value="wecom">企业微信</option></select></label><label class="ledger-import-file"><span>选择流水文件</span><input type="file" accept=".csv,.xlsx,.zip,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip" data-ledger-import-file><small>单个文件不超过 20MB，最多读取 10,000 行。</small></label></div>${message ? `<p class="ledger-import-error" role="alert">${esc(message)}</p>` : ""}<div class="ledger-import-security"><strong>隐私说明</strong><span>不保存原始文件名、完整文件或完整原始行；导入记录只保留限长摘要和不可逆 SHA-256 指纹。</span></div></div>`;
    root.querySelector("[data-ledger-import-platform]").value = state.platform;
  }

  function normalizeHeader(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[\s　_\-—:：/（）()\[\]【】￥¥,.，。]/g, "");
  }

  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === "") quoted = true;
      else if (char === delimiter) { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field); field = "";
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        if (rows.length > MAX_ROWS + 40) throw new Error(`文件超过 ${MAX_ROWS.toLocaleString()} 行上限。`);
      } else field += char;
    }
    if (quoted) throw new Error("CSV 存在未闭合的引号。");
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
    if (rows.some((item) => item.length > MAX_COLUMNS)) throw new Error(`文件超过 ${MAX_COLUMNS} 列上限。`);
    return rows;
  }

  function detectDelimiter(text) {
    const options = [",", "\t", ";"].map((delimiter) => {
      try {
        const sample = parseCsv(text.slice(0, 200000), delimiter).slice(0, 20);
        const widths = sample.filter((row) => row.length > 1).map((row) => row.length);
        const common = widths.length ? Math.max(...[...new Set(widths)].map((width) => widths.filter((item) => item === width).length)) : 0;
        return { delimiter, score: common * 10 + (widths[0] || 0) };
      } catch (_) { return { delimiter, score: -1 }; }
    });
    options.sort((a, b) => b.score - a.score);
    if (options[0].score <= 0) throw new Error("无法识别 CSV 分隔符，请确认文件使用逗号、制表符或分号。");
    return options[0].delimiter;
  }

  function decodeCsv(bytes) {
    if (typeof TextDecoder !== "function") throw new Error("当前浏览器不支持安全文本解码，无法导入 CSV。");
    const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const attempts = hasUtf8Bom ? ["utf-8"] : ["utf-8", "gb18030"];
    for (const encoding of attempts) {
      try { return new TextDecoder(encoding, { fatal: true }).decode(hasUtf8Bom ? bytes.slice(3) : bytes); } catch (_) { /* try next */ }
    }
    throw new Error("文件既不是有效 UTF-8，也无法按 GB18030 解码，已停止导入以避免乱码。");
  }

  function rowsFromWorkbook(bytes) {
    if (!globalThis.XLSX) throw new Error("XLSX 解析组件未加载。");
    let workbook;
    try {
      workbook = globalThis.XLSX.read(bytes, { type: "array", cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false, bookVBA: false, bookDeps: false, bookFiles: false });
    } catch (_) { throw new Error("XLSX 文件无法读取或已损坏。"); }
    const sheets = workbook.SheetNames || [];
    if (!sheets.length) throw new Error("XLSX 中没有可读取的工作表。");
    return { workbook, sheets };
  }

  function sheetRows(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    const rows = globalThis.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: false, range: sheet["!ref"] });
    if (rows.length > MAX_ROWS + 40) throw new Error(`工作表超过 ${MAX_ROWS.toLocaleString()} 行上限。`);
    if (rows.some((row) => row.length > MAX_COLUMNS)) throw new Error(`工作表超过 ${MAX_COLUMNS} 列上限。`);
    return rows.map((row) => row.map((value) => String(value ?? "")));
  }

  function inspectZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let index = Math.max(0, bytes.length - 65557); index <= bytes.length - 22; index += 1) if (view.getUint32(index, true) === 0x06054b50) eocd = index;
    if (eocd < 0) throw new Error("ZIP 文件结构无效或无法读取。");
    const count = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (count > MAX_ZIP_ENTRIES) throw new Error(`压缩包条目超过 ${MAX_ZIP_ENTRIES} 个安全上限。`);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries = [];
    let offset = centralOffset, total = 0;
    for (let i = 0; i < count; i += 1) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP 中央目录异常，已停止读取。");
      const flags = view.getUint16(offset + 8, true);
      if (flags & 1) throw new Error("该压缩包受到密码保护，请先在手机或电脑中解压，再选择其中的 CSV 或 XLSX 文件。");
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
      if ([compressedSize, uncompressedSize].includes(0xffffffff)) throw new Error("第一版不支持 ZIP64 压缩包。");
      if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error("压缩包内单个文件超过 25MB 安全上限。");
      total += uncompressedSize;
      if (total > MAX_ZIP_TOTAL_BYTES) throw new Error("压缩包解压总量超过 60MB 安全上限。");
      const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
      entries.push({ name, compressedSize, uncompressedSize });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries.filter((entry) => !entry.name.endsWith("/") && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").pop().startsWith(".") && /\.(csv|xlsx)$/i.test(entry.name));
  }

  async function extractZip(bytes) {
    if (!globalThis.fflate) throw new Error("ZIP 解析组件未加载。");
    const candidates = inspectZip(bytes);
    if (!candidates.length) throw new Error("压缩包中没有可读取的 CSV 或 XLSX 文件。");
    let unpacked;
    try { unpacked = globalThis.fflate.unzipSync(bytes); } catch (_) { throw new Error("ZIP 文件无法解压；如有密码保护，请先在设备中解压后选择 CSV 或 XLSX。"); }
    return { candidates, unpacked };
  }

  function fileKind(name) {
    const match = String(name || "").toLowerCase().match(/\.(csv|xlsx|zip)$/);
    return match?.[1] || "";
  }

  async function readSourceBytes(name, bytes) {
    const kind = fileKind(name);
    if (kind === "csv") {
      const text = decodeCsv(bytes);
      return { rows: parseCsv(text, detectDelimiter(text)), label: "CSV" };
    }
    if (kind === "xlsx") {
      const source = rowsFromWorkbook(bytes);
      if (source.sheets.length > 1) return { choiceType: "sheet", choices: source.sheets, workbook: source.workbook };
      return { rows: sheetRows(source.workbook, source.sheets[0]), label: `XLSX · ${source.sheets[0]}` };
    }
    throw new Error("第一版仅支持 CSV、XLSX 和未加密 ZIP，不支持 XLS。");
  }

  async function handleFile(file) {
    if (!file) return;
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) return renderChoose("当前浏览器缺少 Web Crypto SHA-256 或安全 UUID 能力，已停止导入。");
    if (file.size > MAX_FILE_BYTES) return renderChoose("文件超过 20MB 上限。");
    state.file = file;
    state.batchId = globalThis.crypto.randomUUID();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let source;
      if (fileKind(file.name) === "zip") {
        const zipped = await extractZip(bytes);
        if (zipped.candidates.length > 1) {
          state.choices = zipped;
          return renderChoice("zip", zipped.candidates.map((entry) => entry.name));
        }
        const name = zipped.candidates[0].name;
        source = await readSourceBytes(name, zipped.unpacked[name]);
        state.selectedSource = name;
      } else source = await readSourceBytes(file.name, bytes);
      if (source.choiceType) {
        state.choices = source;
        return renderChoice("sheet", source.choices);
      }
      acceptRows(source.rows, source.label);
    } catch (error) { renderChoose(error.message || "文件读取失败。"); }
  }

  function renderChoice(type, choices) {
    const root = contentRoot();
    if (!root) return;
    root.innerHTML = `<div class="ledger-import-choice"><h3>${type === "zip" ? "选择压缩包内文件" : "选择工作表"}</h3><p>检测到多个候选，请选择本次要解析的一项。</p><label><span>${type === "zip" ? "文件" : "工作表"}</span><select data-ledger-import-choice>${choices.map((choice, index) => `<option value="${index}">${esc(choice)}</option>`).join("")}</select></label><footer><button class="btn" type="button" data-ledger-import-action="back">返回</button><button class="btn primary" type="button" data-ledger-import-action="use-choice" data-choice-type="${type}">继续</button></footer></div>`;
  }

  async function useChoice(type) {
    const index = Number(contentRoot()?.querySelector("[data-ledger-import-choice]")?.value || 0);
    try {
      if (type === "zip") {
        const name = state.choices.candidates[index]?.name;
        if (!name) throw new Error("请选择有效文件。");
        const source = await readSourceBytes(name, state.choices.unpacked[name]);
        state.selectedSource = name;
        if (source.choiceType) { state.choices = source; return renderChoice("sheet", source.choices); }
        acceptRows(source.rows, source.label);
      } else {
        const name = state.choices.choices[index];
        acceptRows(sheetRows(state.choices.workbook, name), `XLSX · ${name}`);
      }
    } catch (error) { renderChoose(error.message || "所选内容无法读取。"); }
  }

  function scoreHeader(row) {
    const normalized = row.map(normalizeHeader);
    let score = 0;
    for (const values of Object.values(ALIASES)) if (values.some((alias) => normalized.includes(normalizeHeader(alias)))) score += 1;
    return score;
  }

  function detectPlatform(rows) {
    const sample = rows.slice(0, 30).flat().join(" ");
    const alipay = ["支付宝交易号", "支付宝", "商家订单号", "交易对方", "商品说明"].filter((term) => sample.includes(term)).length;
    const wecom = ["企业微信", "动账时间", "关联单号", "动账类型", "账户余额", "操作人所在部门", "收付款单号", "收付款状态", "付款方", "收款方"].filter((term) => sample.includes(term)).length;
    if (!alipay && !wecom) return "unknown";
    return alipay >= wecom ? "alipay" : "wecom";
  }

  function inferMapping(headers) {
    const normalized = headers.map(normalizeHeader);
    const mapping = {};
    for (const [field, aliases] of Object.entries(ALIASES)) {
      const exact = aliases.map(normalizeHeader).map((alias) => normalized.indexOf(alias)).find((index) => index >= 0);
      mapping[field] = Number.isInteger(exact) ? exact : -1;
    }
    return mapping;
  }

  function isWecomFundsHeader(headers) {
    if (headers.length !== WECOM_FUNDS_HEADERS.length) return false;
    const actual = new Set(headers.map(normalizeHeader));
    return WECOM_FUNDS_HEADERS.every((header) => actual.has(normalizeHeader(header)));
  }

  function applyWecomMapping() {
    const normalized = state.headers.map(normalizeHeader);
    const find = (header) => normalized.indexOf(normalizeHeader(header));
    state.mapping = {
      ...inferMapping(state.headers), date: find("动账时间"), time: -1, direction: find("收支类型"), amount: find("动账金额"),
      activityType: find("动账类型"), note: find("备注"), paymentMethod: -1, merchantOrder: find("商户单号"), relatedOrder: find("关联单号"),
      counterparty: -1, summary: -1, transactionId: -1, status: -1,
    };
  }

  function dataRows() {
    return state.rows.slice(state.headerIndex + 1).filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
  }

  function wecomRule(activityType, direction) {
    const activity = String(activityType || "").trim(), flow = String(direction || "").trim();
    if (activity === "收款" && flow === "收入") return { code: "income", label: "客户付款", target: "income", product: "企业微信收款", reason: "" };
    if (activity === "交易手续费" && flow === "支出") return { code: "fee", label: "交易手续费", target: "other", product: "企业微信交易手续费", reason: "" };
    if (activity === "退款" && flow === "支出") return { code: "refund", label: "客户退款", target: "other", product: "客户退款", reason: "" };
    if (activity === "提现" && flow === "支出") return { code: "withdrawal", label: "提现忽略", target: "ignore", product: "企业微信提现", reason: "提现属于账户到银行卡的内部资金移动，默认忽略" };
    return { code: "unmatched", label: "未匹配规则", target: "ignore", product: "企业微信流水", reason: "未匹配企业微信推荐规则，请在预览中确认" };
  }

  function wecomPresetSummary() {
    const counts = { income: 0, fee: 0, refund: 0, withdrawal: 0, unmatched: 0 };
    for (const row of dataRows()) {
      const rule = wecomRule(cell(row, "activityType"), cell(row, "direction"));
      counts[rule.code] = (counts[rule.code] || 0) + 1;
    }
    return counts;
  }

  function acceptRows(rows, label) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("文件没有可读取的数据行。");
    const candidates = rows.slice(0, 30).map((row, index) => ({ index, score: scoreHeader(row) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const headerIndex = candidates[0]?.score >= 2 ? candidates[0].index : 0;
    state.rows = rows;
    state.headerIndex = headerIndex;
    state.headers = rows[headerIndex].map((value, index) => String(value || `未命名列 ${index + 1}`).trim() || `未命名列 ${index + 1}`);
    state.mapping = inferMapping(state.headers);
    const detected = detectPlatform(rows);
    if (state.platform === "auto" && detected !== "unknown") state.platform = detected;
    state.wecomPreset = state.platform === "wecom" && isWecomFundsHeader(state.headers);
    state.manualMapping = false;
    if (state.wecomPreset) applyWecomMapping();
    state.sourceLabel = label;
    renderMapping(candidates[0]?.score < 2 ? "未能可靠识别表头，请手动确认表头行和字段对应。" : "");
  }

  function mappingOptions(selected, optional = false) {
    return `<option value="-1">${optional ? "不使用" : "请选择"}</option>${state.headers.map((header, index) => `<option value="${index}"${index === selected ? " selected" : ""}>${esc(header)}</option>`).join("")}`;
  }

  function headerOptions() {
    return state.rows.slice(0, Math.min(30, state.rows.length)).map((row, index) => `<option value="${index}"${index === state.headerIndex ? " selected" : ""}>第 ${index + 1} 行（${row.length} 列）</option>`).join("");
  }

  function mappingFields() {
    const required = ["date", "direction", "amount"];
    const optional = ["activityType", "counterparty", "summary", "transactionId", "status", "paymentMethod", "note", "time"];
    const fields = (names, optionalField) => names.map((field) => `<label><span>${esc(FIELD_LABELS[field])}${optionalField ? "" : " *"}</span><select data-ledger-import-map="${field}">${mappingOptions(state.mapping[field] ?? -1, optionalField)}</select></label>`).join("");
    return `<section class="ledger-import-field-group"><h4>必填字段</h4><p>日期时间、收支方向和金额必须对应；日期时间列可同时包含日期和时间。</p><div class="ledger-import-mapping-grid required">${fields(required, false)}</div></section><details class="ledger-import-optional"><summary>高级可选字段</summary><div class="ledger-import-mapping-grid">${fields(optional, true)}</div></details>`;
  }

  function manualMappingPanel(buttonLabel = "生成导入预览", includeFooter = true) {
    return `<div class="ledger-import-mapping-head"><div><h3>人工字段对应</h3><p>${esc(state.sourceLabel || "已读取文件")} · 原始 ${dataRows().length} 条</p></div><label><span>流水平台</span><select data-ledger-import-mapping-platform><option value="auto">请选择</option><option value="alipay">支付宝</option><option value="wecom">企业微信</option></select></label><label><span>表头所在行</span><select data-ledger-import-header>${headerOptions()}</select></label></div>${mappingFields()}<p class="ledger-import-hint">仅选择文件中真实存在且需要写入的字段；所有记录仍会在预览阶段逐行校验。</p>${includeFooter ? `<footer><button class="btn primary" type="button" data-ledger-import-action="build-preview-manual">${esc(buttonLabel)}</button></footer>` : ""}`;
  }

  function renderMapping(message = "") {
    setStep(2);
    const root = contentRoot();
    if (!root) return;
    if (state.wecomPreset && !state.manualMapping) {
      const counts = wecomPresetSummary(), total = dataRows().length;
      root.innerHTML = `<div class="ledger-import-mapping ledger-import-auto"><div class="ledger-import-auto-head"><span class="ledger-import-auto-badge">自动识别成功</span><h3>已识别：企业微信资金流水</h3><p>${esc(state.sourceLabel || "XLSX")} · 共 ${total} 条</p></div>${message ? `<p class="ledger-import-warning">${esc(message)}</p>` : ""}<section class="ledger-import-rule-summary" aria-label="预计处理"><h4>预计处理</h4><div>${[["客户付款", counts.income], ["交易手续费", counts.fee], ["客户退款", counts.refund], ["忽略提现", counts.withdrawal]].map(([label, value]) => `<span><b>${value}</b>${label}</span>`).join("")}</div>${counts.unmatched ? `<p class="ledger-import-warning">另有 ${counts.unmatched} 条未匹配推荐规则，将默认忽略并在预览中提示。</p>` : ""}</section><details class="ledger-import-advanced"><summary>高级字段对应</summary><div class="ledger-import-advanced-body">${manualMappingPanel("按人工设置生成预览")}</div></details><footer><button class="btn" type="button" data-ledger-import-action="back">重新选择</button><button class="btn primary" type="button" data-ledger-import-action="build-preview">按推荐规则生成预览</button></footer></div>`;
    } else {
      root.innerHTML = `<div class="ledger-import-mapping">${message ? `<p class="ledger-import-warning">${esc(message)}</p>` : ""}${manualMappingPanel("", false)}<footer><button class="btn" type="button" data-ledger-import-action="back">重新选择</button><button class="btn primary" type="button" data-ledger-import-action="build-preview-manual">生成导入预览</button></footer></div>`;
    }
    root.querySelectorAll("[data-ledger-import-mapping-platform]").forEach((select) => { select.value = state.platform === "auto" ? "auto" : state.platform; });
  }

  function parseDateTime(dateValue, timeValue) {
    const joined = `${String(dateValue || "").trim()} ${String(timeValue || "").trim()}`.trim().replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, " ");
    const match = joined.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
    if (!match) return null;
    const [, year, month, day, hour = "", minute = ""] = match;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const time = hour ? `${String(hour).padStart(2, "0")}:${minute}` : "";
    const test = new Date(Number(year), Number(month) - 1, Number(day));
    if (test.getFullYear() !== Number(year) || test.getMonth() !== Number(month) - 1 || test.getDate() !== Number(day) || (hour && Number(hour) > 23)) return null;
    return { date, time, raw: joined.slice(0, 80) };
  }

  function parseAmount(value, direction, allowDirectionalNegative = false) {
    const raw = String(value ?? "").trim().replace(/[￥¥,，\s]/g, "");
    if (!raw || !/^[+-]?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) return { error: "金额为空、格式无效或超过两位小数" };
    const directionText = String(direction || "").trim();
    const expense = /支出|付款|出账|借/.test(directionText);
    const income = /收入|收款|入账|贷/.test(directionText);
    if (raw.startsWith("-") && (!allowDirectionalNegative || !expense)) return { error: income ? "负金额与收入方向冲突" : "负金额不会自动反转未知方向" };
    if (raw.startsWith("+") && expense) return { error: "金额正号与支出方向冲突" };
    const unsigned = raw.replace(/^[+-]/, "");
    const [whole, decimal = ""] = unsigned.split(".");
    const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents <= 0) return { error: "金额为零或超过安全整数范围" };
    return { cents, explicitExpense: expense, explicitIncome: income, raw };
  }

  async function sha256(text) {
    if (!globalThis.crypto?.subtle) throw new Error("当前浏览器缺少 Web Crypto SHA-256 能力，已停止导入。");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function cell(row, field) {
    const index = state.mapping[field];
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  }

  function usableOrderPart(value) {
    const text = String(value ?? "").trim();
    return text && !WECOM_PLACEHOLDER.test(text) ? text : "";
  }

  async function wecomSourceId(row, activityType) {
    const merchantOrder = usableOrderPart(cell(row, "merchantOrder"));
    const relatedOrder = usableOrderPart(cell(row, "relatedOrder"));
    const type = usableOrderPart(activityType);
    const base = type && merchantOrder ? ["merchant", merchantOrder, type] : type && relatedOrder ? ["related", relatedOrder, type] : null;
    return base ? `wecom:${await sha256(JSON.stringify(base))}` : "";
  }

  async function buildCandidates() {
    const platformSelect = contentRoot()?.querySelector("[data-ledger-import-mapping-platform]");
    const platform = platformSelect?.value || state.platform;
    if (!/^(alipay|wecom)$/.test(platform)) throw new Error("请选择支付宝或企业微信作为流水平台。");
    state.platform = platform;
    contentRoot()?.querySelectorAll("[data-ledger-import-map]").forEach((select) => { state.mapping[select.dataset.ledgerImportMap] = Number(select.value); });
    const useWecomPreset = platform === "wecom" && state.wecomPreset && !state.manualMapping;
    if (useWecomPreset) applyWecomMapping();
    if (state.mapping.date < 0 || state.mapping.direction < 0 || state.mapping.amount < 0) throw new Error("必须对应日期时间、收支方向和金额字段。");
    const partners = ledgerApi()?.getImportPartners?.() || [];
    const rows = dataRows();
    if (rows.length > MAX_ROWS) throw new Error(`数据行超过 ${MAX_ROWS.toLocaleString()} 行上限。`);
    const importedAt = new Date().toISOString();
    const candidates = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const direction = cell(row, "direction"), status = cell(row, "status"), counterparty = cell(row, "counterparty").slice(0, 160);
      const activityType = cell(row, "activityType").slice(0, 80), mappedSummary = cell(row, "summary").slice(0, 300), note = cell(row, "note").slice(0, 200);
      const rule = useWecomPreset ? wecomRule(activityType, direction) : null;
      const summary = rule?.label || mappedSummary;
      const transactionId = useWecomPreset ? await wecomSourceId(row, activityType) : cell(row, "transactionId").slice(0, 180);
      const dateTime = parseDateTime(cell(row, "date"), cell(row, "time"));
      const amount = parseAmount(cell(row, "amount"), direction, useWecomPreset);
      const combined = `${activityType} ${status} ${summary} ${note}`;
      let target = "ignore", ignoreReason = "无法判断收支方向";
      if (rule) { target = rule.target; ignoreReason = rule.reason; }
      else if (SPECIAL_STATUS.test(combined)) { target = "ignore"; ignoreReason = "失败、关闭或取消记录默认忽略"; }
      else if (REFUND_STATUS.test(combined)) { target = "ignore"; ignoreReason = "退款记录默认忽略，请人工处理"; }
      else if (FEE_TEXT.test(combined)) { target = "ignore"; ignoreReason = "手续费默认忽略，可明确改为其他支出"; }
      else if (amount.explicitIncome) { target = "income"; ignoreReason = ""; }
      else if (amount.explicitExpense) { target = "other"; ignoreReason = ""; }
      const exactPartners = partners.filter((partner) => partner.name === counterparty);
      if (!useWecomPreset && target === "other" && exactPartners.length === 1) target = "third_party";
      const rawSummary = useWecomPreset ? `企业微信 · ${rule.label}` : ([counterparty, summary, status, note].filter(Boolean).join(" · ").slice(0, 300) || "外部流水");
      const fingerprintInput = JSON.stringify([platform, dateTime?.raw || cell(row, "date"), direction, amount.cents || cell(row, "amount"), activityType, cell(row, "merchantOrder"), cell(row, "relatedOrder"), counterparty, summary || note]);
      const product = rule?.product || summary.slice(0, 160);
      candidates.push({
        clientId: randomId("candidate"), id: randomId("entry"), sourcePlatform: platform, sourceTransactionId: transactionId,
        sourceImportBatchId: state.batchId, sourceImportedAt: importedAt, sourceRawSummary: rawSummary,
        sourceFingerprint: await sha256(fingerprintInput), amountCents: amount.cents || 0, date: dateTime?.date || "", time: dateTime?.time || "",
        direction, counterparty: useWecomPreset ? "企业微信" : counterparty, summary, statusText: rule?.label || status, paymentMethod: useWecomPreset ? "企业微信" : cell(row, "paymentMethod").slice(0, 100), remark: note,
        target, partnerId: !useWecomPreset && exactPartners.length === 1 ? exactPartners[0].id : "", customerCode: "", customerName: target === "income" ? (useWecomPreset ? "企业微信客户" : counterparty.slice(0, 120)) : "",
        product, orderDescription: useWecomPreset && target === "income" ? "企业微信收款" : summary.slice(0, 300), ruleCode: rule?.code || "",
        ignoreReason, fatalReason: amount.error || (!dateTime ? "完成日期或时间无效" : ""), rowNumber: state.headerIndex + index + 2,
      });
    }
    state.candidates = candidates;
    state.usedWecomPreset = useWecomPreset;
    refreshAnalysis();
  }

  function refreshAnalysis() {
    state.analysis = ledgerApi()?.previewExternalEntries?.(state.candidates) || { ok: false, error: "记账台受控导入接口不可用。" };
    state.page = Math.min(state.page, Math.max(1, Math.ceil(state.candidates.length / PAGE_SIZE)));
    renderPreview();
  }

  function statusLabel(status) {
    return { addition: "可导入", possibleDuplicate: "可能重复", duplicate: "重复", conflict: "冲突", invalid: "无效", needsSupplement: "需要补充", ignored: "已忽略" }[status] || status;
  }

  function candidateControls(candidate) {
    const partners = ledgerApi()?.getImportPartners?.() || [];
    if (candidate.target === "income") return `<div class="ledger-import-supplement"><input data-candidate-field="customerName" value="${esc(candidate.customerName)}" maxlength="120" placeholder="客户名称"><input data-candidate-field="customerCode" value="${esc(candidate.customerCode)}" maxlength="7" placeholder="客户编码 C000001"><input data-candidate-field="product" value="${esc(candidate.product)}" maxlength="160" placeholder="产品/业务（必填）"></div>`;
    if (candidate.target === "third_party") return `<div class="ledger-import-supplement"><select data-candidate-field="partnerId"><option value="">请选择已有第三方</option>${partners.map((partner) => `<option value="${esc(partner.id)}"${partner.id === candidate.partnerId ? " selected" : ""}>${esc(partner.name)}</option>`).join("")}</select><input data-candidate-field="product" value="${esc(candidate.product)}" maxlength="160" placeholder="产品/业务"></div>`;
    if (candidate.target === "other") return `<div class="ledger-import-supplement"><input data-candidate-field="product" value="${esc(candidate.product)}" maxlength="160" placeholder="产品/业务"><input data-candidate-field="remark" value="${esc(candidate.remark)}" maxlength="500" placeholder="备注"></div>`;
    return "";
  }

  function targetSelect(candidate) {
    const options = [["income", "收入"], ["third_party", "第三方代充"], ["other", "其他支出"], ["ignore", "忽略"]];
    return `<select data-candidate-target>${options.map(([value, label]) => `<option value="${value}"${candidate.target === value ? " selected" : ""}>${label}</option>`).join("")}</select>${candidateControls(candidate)}`;
  }

  function renderPreview() {
    setStep(3);
    const root = contentRoot();
    if (!root) return;
    if (!state.analysis?.ok) {
      root.innerHTML = `<p class="ledger-import-error" role="alert">${esc(state.analysis?.error || "预览失败。")}</p><footer><button class="btn" type="button" data-ledger-import-action="mapping">返回字段对应</button></footer>`;
      return;
    }
    const counts = state.analysis.counts || {};
    const targetCounts = state.candidates.reduce((result, candidate) => {
      result[candidate.target] = (result[candidate.target] || 0) + 1;
      return result;
    }, {});
    const ruleCounts = state.candidates.reduce((result, candidate) => {
      if (candidate.ruleCode) result[candidate.ruleCode] = (result[candidate.ruleCode] || 0) + 1;
      return result;
    }, {});
    const supplementCount = Number(counts.needsSupplement || 0) + Number(counts.invalid || 0);
    const statusById = new Map(state.analysis.rows.map((row) => [row.clientId, row]));
    const start = (state.page - 1) * PAGE_SIZE, pageRows = state.candidates.slice(start, start + PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(state.candidates.length / PAGE_SIZE));
    const breakdown = state.usedWecomPreset ? `<div class="ledger-import-preview-rules"><span>客户付款 <b>${ruleCounts.income || 0}</b></span><span>交易手续费 <b>${ruleCounts.fee || 0}</b></span><span>客户退款 <b>${ruleCounts.refund || 0}</b></span><span>提现忽略 <b>${ruleCounts.withdrawal || 0}</b></span></div>` : "";
    root.innerHTML = `<div class="ledger-import-preview-panel"><div class="ledger-import-preview-head"><div><h3>逐行预览与分类</h3><p>原始数据 ${state.candidates.length} 行；确认时会重新读取记账台并再次去重。</p></div><label><span>批量设置当前全部记录</span><select data-ledger-import-bulk><option value="">请选择操作</option><option value="income">收入</option><option value="third_party">第三方代充</option><option value="other">其他支出</option><option value="ignore">忽略</option></select></label></div>${breakdown}<div class="ledger-import-stats">${[["原始总行数", state.candidates.length], ["收入", targetCounts.income || 0], ["其他支出", targetCounts.other || 0], ["忽略", targetCounts.ignore || 0], ["需补充", supplementCount], ["可导入", counts.addition || 0], ["重复", counts.duplicate || 0], ["冲突", counts.conflict || 0]].map(([label, value]) => `<span><strong>${value}</strong>${label}</span>`).join("")}</div><div class="ledger-import-table-wrap"><table class="ledger-import-table"><thead><tr><th>行</th><th>日期时间</th><th>方向/金额</th><th>交易对象与说明</th><th>自动分类/来源标识</th><th>导入目标与补充</th><th>处理结果</th></tr></thead><tbody>${pageRows.map((candidate) => { const result = statusById.get(candidate.clientId) || {}; return `<tr data-candidate-id="${esc(candidate.clientId)}"><td data-label="行">${candidate.rowNumber}</td><td data-label="日期时间">${esc(candidate.date || "—")}<small>${esc(candidate.time || "")}</small></td><td data-label="方向/金额">${esc(candidate.direction || "未识别")}<strong>¥${(candidate.amountCents / 100).toFixed(2)}</strong></td><td data-label="交易对象与说明"><b>${esc(candidate.counterparty || "—")}</b><small>${esc(candidate.summary || "—")}</small></td><td data-label="自动分类/来源标识">${esc(candidate.statusText || "—")}<small>${candidate.sourceTransactionId ? "已建立脱敏稳定标识" : "使用来源指纹"}</small></td><td data-label="导入目标">${targetSelect(candidate)}</td><td data-label="处理结果"><span class="ledger-import-result ${esc(result.status)}">${esc(statusLabel(result.status))}</span><small>${esc(result.reason || "")}</small></td></tr>`; }).join("")}</tbody></table></div><div class="ledger-import-pagination"><button class="btn" type="button" data-ledger-import-action="page-prev"${state.page <= 1 ? " disabled" : ""}>上一页</button><span>第 ${state.page} / ${totalPages} 页</span><button class="btn" type="button" data-ledger-import-action="page-next"${state.page >= totalPages ? " disabled" : ""}>下一页</button></div><p class="ledger-import-hint">“可能重复”仅提示，不会覆盖或删除手工记录；确认后仍会按当前预览追加。冲突、无效、需要补充、重复和忽略项不会写入。</p><footer><button class="btn" type="button" data-ledger-import-action="mapping">返回字段对应</button><button class="btn primary" type="button" data-ledger-import-action="confirm"${(counts.addition || 0) + (counts.possibleDuplicate || 0) ? "" : " disabled"}>确认安全追加 ${Number(counts.addition || 0) + Number(counts.possibleDuplicate || 0)} 笔</button></footer></div>`;
  }

  function updateCandidate(element) {
    const row = element.closest("[data-candidate-id]");
    const candidate = state.candidates.find((item) => item.clientId === row?.dataset.candidateId);
    if (!candidate) return;
    if (element.matches("[data-candidate-target]")) {
      if (!TARGETS.has(element.value)) return;
      candidate.target = element.value;
      candidate.ignoreReason = element.value === "ignore" ? "用户选择忽略" : "";
    } else if (element.matches("[data-candidate-field]")) candidate[element.dataset.candidateField] = element.value;
    refreshAnalysis();
  }

  async function confirmMerge() {
    if (!state.analysis?.ok || !confirm("确认将预览中的合法记录安全追加到记账台吗？现有数据不会被覆盖或清空。")) return;
    const result = ledgerApi()?.mergeExternalEntries?.(state.candidates, state.analysis.signature);
    if (!result?.ok) {
      state.analysis = result || { ok: false, error: "导入失败。" };
      if (result?.changed) renderPreview();
      else alert(result?.error || "导入失败，未写入任何记录。");
      return;
    }
    const imported = result.imported || 0;
    close();
    alert(`流水安全导入完成：新增 ${imported} 笔记录。`);
  }

  function handleClick(event) {
    const button = event.target.closest("[data-ledger-import-action]");
    if (!button) return;
    const action = button.dataset.ledgerImportAction;
    if (action === "close") close();
    else if (action === "back") { state.file = null; state.rows = null; state.candidates = []; state.choices = null; renderChoose(); }
    else if (action === "use-choice") useChoice(button.dataset.choiceType);
    else if (action === "build-preview" || action === "build-preview-manual") {
      if (action === "build-preview-manual") state.manualMapping = true;
      buildCandidates().catch((error) => { const old = contentRoot()?.querySelector(".ledger-import-error"); if (old) old.remove(); contentRoot()?.insertAdjacentHTML("afterbegin", `<p class="ledger-import-error">${esc(error.message || "无法生成预览。")}</p>`); });
    }
    else if (action === "mapping") renderMapping();
    else if (action === "page-prev") { state.page -= 1; renderPreview(); }
    else if (action === "page-next") { state.page += 1; renderPreview(); }
    else if (action === "confirm") confirmMerge();
  }

  function handleChange(event) {
    if (!modalRoot()?.contains(event.target)) return;
    if (event.target.matches("[data-ledger-import-platform]")) state.platform = event.target.value;
    else if (event.target.matches("[data-ledger-import-file]")) handleFile(event.target.files?.[0]);
    else if (event.target.matches("[data-ledger-import-header]")) {
      state.manualMapping = true;
      state.headerIndex = Number(event.target.value);
      state.headers = state.rows[state.headerIndex].map((value, index) => String(value || `未命名列 ${index + 1}`).trim() || `未命名列 ${index + 1}`);
      state.mapping = inferMapping(state.headers);
      renderMapping();
    } else if (event.target.matches("[data-ledger-import-mapping-platform], [data-ledger-import-map]")) {
      state.manualMapping = true;
      if (event.target.matches("[data-ledger-import-mapping-platform]")) state.platform = event.target.value;
    } else if (event.target.matches("[data-ledger-import-bulk]")) {
      if (!TARGETS.has(event.target.value)) return;
      state.candidates.forEach((candidate) => { candidate.target = event.target.value; candidate.ignoreReason = event.target.value === "ignore" ? "用户批量选择忽略" : ""; });
      refreshAnalysis();
    } else if (event.target.matches("[data-candidate-target], [data-candidate-field]")) updateCandidate(event.target);
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && modalRoot()) close(); });

  globalThis.LedgerStatementImport = { open, close };
})();
