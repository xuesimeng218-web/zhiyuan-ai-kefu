// Synthetic-only regression tests; no browser profile, real storage or IndexedDB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/ledger.js'), 'utf8');
const keys = { entries: 'zy_kb_ledger_entries_v1', partners: 'zy_kb_ledger_partners_v1', categories: 'zy_kb_ledger_categories_v1' };
const stamp = '2026-09-10T08:00:00.000Z';
function setup(seed = {}) {
  const stored = new Map(Object.entries(seed));
  const target = { innerHTML: '', textContent: '' };
  let failKey = '', blob;
  const context = vm.createContext({
    structuredClone, Date, Map, Set, JSON, Number, String, Math, Blob,
    crypto: require('node:crypto').webcrypto,
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => { if (key === failKey) throw new Error('synthetic quota'); stored.set(key, value); },
      removeItem: key => stored.delete(key),
    },
    document: { addEventListener() {}, querySelector: () => target, querySelectorAll: () => [], createElement: () => ({click(){}}) },
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } },
    alert() {}, confirm: () => true, setTimeout: () => {},
    URL: { createObjectURL: value => { blob = value; return 'blob:synthetic'; }, revokeObjectURL() {} },
  });
  const expose = `
    formError = (form, message) => { document.querySelector().textContent = message; };
    render = () => {}; modal = () => {}; openCategories = () => {}; openPartners = () => {}; closeAll = () => {}; notify = () => {};
    globalThis.testApi = { ensureInitialized, saveCategoryForm, categoryOptions, saveCategories, saveEntryForm,
      deleteManaged, entryCategoryName, syncPartnerFields, handleClick, addPartner, togglePartner, partnerOptions, entryPartnerValue, getImportPartners, normalizeEntry, normalizeCategory, filteredExpenses, filteredIncome, categoryChart, monthlySummary,
      previewImport, confirmImport, downloadBackup, partnerName, entryPartnerName, analyzeExternalEntries,
      state: () => state, entries: () => entries, categories: () => categories, partners: () => partners,
      preview: () => importPreview, storageMessage: () => storageMessage };
  `;
  vm.runInContext(source.replace('  globalThis.openLedgerWorkbench = open;', expose + '\n  globalThis.openLedgerWorkbench = open;'), context);
  context.testApi.ensureInitialized();
  return { api: context.testApi, stored, target, fail: key => { failKey = key; }, blob: () => blob, context };
}
function category(api, name, type = 'expense', id = '') {
  api.saveCategoryForm({ values: {name, type}, dataset: {categoryId:id} });
}
function entry(api, values = {}, id = '', type = 'expense') {
  api.saveEntryForm({ values: {date:'2026-09-10', time:'12:00', amount:'120', category: type === 'income' ? '客户付款' : '其他支出', invoiceEligibility:'unknown', invoiceStatus:'unissued', ...values}, dataset:{entryId:id, entryType:type} });
}
const names = (api, type) => Array.from(api.categoryOptions(type), row => row[0]);
test('category trim, type isolation, duplicate/default/length rejection, no eager category write', () => {
  const {api, stored, target} = setup();
  assert.equal(stored.has(keys.categories), false);
  category(api, '  生活支出  '); category(api, '课程收入', 'income');
  assert.deepEqual(names(api,'expense'), ['第三方代充','其他支出','生活支出']);
  assert.deepEqual(names(api,'income'), ['客户付款','课程收入']);
  for (const name of ['生活支出','其他支出',' ', '长'.repeat(41)]) category(api,name);
  assert.equal(api.categories().length,2);
  assert.ok(target.textContent);
});
test('rename, disable, reload and editing preserve historical category and all original fields', () => {
  const {api,stored} = setup(); category(api,'生活支出'); entry(api,{category:'生活支出',remark:'合成备注'});
  const before = JSON.stringify(api.entries());
  const cat = api.categories()[0]; category(api,'日常生活', 'expense',cat.id);
  api.saveCategories(api.categories().map(item => ({...item,active:false})));
  assert.equal(JSON.stringify(api.entries()),before);
  assert.ok(!names(api,'expense').includes('日常生活'));
  const reloaded = setup(Object.fromEntries(stored));
  assert.equal(JSON.stringify(reloaded.api.entries()),before);
  entry(reloaded.api,{category:'生活支出',remark:'合成备注'},reloaded.api.entries()[0].id);
  assert.equal(reloaded.api.entries().length,1);
  assert.equal(reloaded.api.entries()[0].amountCents,12000);
  entry(reloaded.api,{category:'日常生活'});
  assert.equal(reloaded.api.entries().length,1);
});
test('category and entry write failures retain stored and in-memory data', () => {
  for (const kind of ['categories','entries']) {
    const {api,stored,fail} = setup(); category(api,'生活支出');
    const before = JSON.stringify(Object.fromEntries(stored));
    const memory = JSON.stringify([api.categories(),api.entries()]);
    fail(keys[kind]);
    if (kind === 'categories') category(api,'失败分类'); else entry(api,{category:'生活支出'});
    assert.equal(JSON.stringify(Object.fromEntries(stored)),before);
    assert.equal(JSON.stringify([api.categories(),api.entries()]),memory);
  }
});
test('custom filters, category shares and monthly totals include exact amounts and counts', () => {
  const {api} = setup(); category(api,'生活支出'); category(api,'课程收入','income');
  entry(api,{category:'生活支出'}); entry(api,{amount:'80',payee:'合成群'});
  entry(api,{category:'课程收入',amount:'500'},'','income');
  api.state().filters.expenses.monthScope='all'; api.state().filters.income.monthScope='all';
  api.state().filters.expenses.category='生活支出'; assert.equal(api.filteredExpenses().length,1);
  api.state().filters.income.category='课程收入'; assert.equal(api.filteredIncome().length,1);
  const chart = api.categoryChart(api.entries().filter(e=>e.type==='expense'));
  assert.match(chart,/生活支出/); assert.match(chart,/¥120.00 · 60.0%/);
  const summary = api.monthlySummary('all','all'); assert.match(summary,/¥500.00/); assert.match(summary,/¥200.00/); assert.match(summary,/¥300.00/);
  api.state().filters.expenses.category='all'; api.state().filters.expenses.partner='合成群'; assert.equal(api.filteredExpenses().length,1);
});
test('JSON export/import preserves categories and manual group fields, supports old backups and deduplicates', async () => {
  const original = setup(); category(original.api,'生活支出'); entry(original.api,{payee:'合成群'});
  original.api.downloadBackup(); const text = await original.blob().text(); const backup = JSON.parse(text);
  assert.equal(backup.schemaVersion,1); assert.equal(backup.categories[0].name,'生活支出'); assert.equal(backup.entries[0].payee,'合成群');
  const restored = setup(); const file = {size:text.length,text:async()=>text};
  await restored.api.previewImport(file); restored.api.confirmImport();
  assert.equal(JSON.stringify(restored.api.entries()),JSON.stringify(original.api.entries()));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.api.categories())),JSON.parse(JSON.stringify(original.api.categories())));
  await restored.api.previewImport(file); assert.equal(restored.api.preview().duplicate,2);
  delete backup.categories; const old = JSON.stringify(backup);
  await setup().api.previewImport({size:old.length,text:async()=>old});
});
test('multi-key backup failure rolls back exact stored bytes and leaves memory unchanged', async () => {
  const origin = setup(); category(origin.api,'生活支出'); entry(origin.api); origin.api.downloadBackup(); const text = await origin.blob().text();
  for (const key of [keys.entries,keys.partners,keys.categories]) {
    const {api,stored,fail} = setup(); const before = JSON.stringify(Object.fromEntries(stored));
    await api.previewImport({size:text.length,text:async()=>text}); fail(key); api.confirmImport();
    assert.equal(JSON.stringify(Object.fromEntries(stored)),before);
    assert.equal(api.entries().length,0); assert.equal(api.categories().length,0); assert.ok(api.preview());
  }
});
test('Alipay/WeCom import review, controlled source fields and deduplication still work alongside custom categories', () => {
  const {api} = setup(); category(api,'生活支出'); entry(api,{category:'生活支出'});
  const candidates = ['alipay','wecom'].map((platform,i)=>({id:`synthetic-import-${i}`,clientId:`synthetic-${i}`,target:'other',amountCents:100,date:'2026-09-10',time:'10:00',counterparty:'合成对象',sourcePlatform:platform,sourceImportBatchId:'synthetic-batch',sourceImportedAt:stamp,sourceRawSummary:'合成摘要',sourceFingerprint:String(i).repeat(64),fileName:'must-not-persist.csv',rawRow:'must-not-persist'}));
  const review = api.analyzeExternalEntries(candidates,api.entries()); assert.equal(review.counts.addition,2);
  for (const row of review.rows) { assert.equal(row.entry.source,'statement-import'); assert.ok(!('fileName' in row.entry)); assert.ok(!('rawRow' in row.entry)); }
  const again = api.analyzeExternalEntries(candidates,[...api.entries(),...review.rows.map(row=>row.entry)]); assert.equal(again.counts.duplicate,2);
});
test('synthetic CSV parsing → platform recognition → preview → merge → repeated-import dedup for both platforms', async () => {
  const {api,context} = setup(); category(api,'生活支出'); entry(api,{category:'生活支出'});
  context.TextEncoder = TextEncoder;
  context.document.querySelector = () => null;
  const importer = fs.readFileSync(path.join(__dirname,'../js/ledger-import.js'),'utf8');
  vm.runInContext(importer.replace('  globalThis.LedgerStatementImport =', `
    renderPreview = () => {};
    globalThis.importTest = { parseCsv, detectPlatform, inferMapping, buildCandidates,
      configure(rows, platform, preset) { state = freshState(); state.rows = rows; state.headers = rows[0]; state.headerIndex = 0; state.platform = platform; state.mapping = inferMapping(rows[0]); state.wecomPreset = preset; state.batchId = 'synthetic-batch'; },
      candidates: () => state.candidates, analysis: () => state.analysis };
    globalThis.LedgerStatementImport =`),context);
  const fixtures = [
    ['alipay',false,'交易时间,收支,金额,交易对方,商品说明,支付宝交易号,交易状态\n2026-09-10 10:00:00,支出,6.00,合成商家,合成办公用品,,交易成功'],
    ['wecom',true,'动账时间,关联单号,动账类型,收支类型,动账金额,账户余额,商户单号,备注,商户号,操作人,操作人所在部门,所属管理规则\n2026-09-10 11:00:00,,交易手续费,支出,2.00,0,,合成验收,,合成操作员,测试,测试'],
  ];
  for (const [platform,preset,csv] of fixtures) {
    const rows = context.importTest.parseCsv(csv,','); assert.equal(context.importTest.detectPlatform(rows),platform);
    context.importTest.configure(rows,platform,preset); await context.importTest.buildCandidates();
    const review = context.importTest.analysis(); assert.equal(review.counts.addition,1);
    const result = context.LedgerWorkbench.mergeExternalEntries(context.importTest.candidates(),review.signature); assert.equal(result.imported,1);
    await context.importTest.buildCandidates(); assert.equal(context.importTest.analysis().counts.duplicate,1);
  }
  assert.equal(api.entries().length,3); assert.equal(api.entries()[0].category,'生活支出');
});


function group(api, name, id = '') { api.addPartner({values:{name},dataset:{partnerId:id}}); }
test('managed groups validate, rename, deactivate, reactivate, persist, and fail atomically', () => {
  const {api,stored,fail,target} = setup(); group(api,'  群 A  ');
  const id = api.partners()[0].id; assert.equal(api.partners()[0].name,'群 A');
  for (const name of ['群 a',' ', '长'.repeat(101)]) group(api,name);
  assert.equal(api.partners().length,1); assert.ok(target.textContent);
  group(api,'群 B',id); assert.equal(api.partnerOptions()[1][1],'群 B');
  api.togglePartner(id); assert.equal(api.partnerOptions().length,1); assert.equal(api.getImportPartners().length,0);
  entry(api,{category:'第三方代充',partnerId:id}); assert.equal(api.entries().length,0);
  group(api,'群 B'); assert.equal(api.partners().length,1);
  api.togglePartner(id); assert.equal(api.partnerOptions().length,2);
  assert.equal(setup(Object.fromEntries(stored)).api.partners()[0].active,true);
  const before = stored.get(keys.partners), memory = JSON.stringify(api.partners()); fail(keys.partners);
  group(api,'保存失败'); api.togglePartner(id);
  assert.equal(stored.get(keys.partners),before); assert.equal(JSON.stringify(api.partners()),memory);
});
test('two historical records reassign independently with exact unrelated fields, reload, backup and inactive compatibility', async () => {
  const base = setup(); entry(base.api);
  const records = [
    {...base.api.entries()[0],id:'first',category:'第三方代充',partnerId:'old',payee:'原支付对象'},
    {...base.api.entries()[0],id:'second',category:'第三方代充',partnerId:'manual-group:GPT-034'},
    {...base.api.entries()[0],id:'override',category:'第三方代充',partnerId:'old',partnerDisplayName:'历史自定义群'},
  ];
  const {api,stored,blob,fail} = setup({[keys.entries]:JSON.stringify({version:1,entries:records}),[keys.partners]:JSON.stringify({version:1,partners:[{id:'old',name:'03chatgpt/claude 充值',createdAt:stamp,updatedAt:stamp}]})});
  assert.equal(api.partners()[0].active,true);
  assert.equal(api.entryPartnerValue(api.entries()[0]),'old');
  assert.ok(api.partnerOptions(api.entries()[1]).some(([id,label])=>id==='manual-group:GPT-034' && label.includes('GPT-034')));
  assert.equal(api.entryPartnerValue(api.entries()[2]),'historical-current');
  group(api,'Claude 成品号供货群'); const nextId = api.partners()[1].id;
  const totals = api.monthlySummary('all','all');
  entry(api,{category:'第三方代充',partnerId:nextId},'first');
  for (const [key,value] of Object.entries(records[0])) if (!['partnerId','updatedAt'].includes(key)) assert.equal(api.entries()[0][key],value,key);
  assert.equal(JSON.stringify(api.entries()[1]),JSON.stringify(records[1]));
  entry(api,{category:'第三方代充',partnerId:'old'},'second');
  assert.equal(api.entries()[0].partnerId,nextId); assert.equal(api.entries()[1].partnerId,'old');
  group(api,'GPT 代充供货群','old'); assert.equal(api.entryPartnerName(api.entries()[1]),'GPT 代充供货群');
  assert.equal(api.entryPartnerName(api.entries()[2]),'历史自定义群');
  assert.equal(api.monthlySummary('all','all'),totals);
  api.togglePartner('old'); assert.ok(!api.partnerOptions().some(([id])=>id==='old'));
  assert.ok(api.partnerOptions(api.entries()[1]).some(([id])=>id==='old'));
  entry(api,{category:'第三方代充',partnerId:'old'},'second'); assert.equal(api.entries().length,3);
  entry(api,{category:'第三方代充',partnerId:'old'}); assert.equal(api.entries().length,3);
  entry(api,{category:'第三方代充',partnerId:nextId},'override'); assert.ok(!('partnerDisplayName' in api.entries()[2]));
  assert.equal(JSON.stringify(setup(Object.fromEntries(stored)).api.entries()),JSON.stringify(api.entries()));
  category(api,'生活支出'); api.downloadBackup(); const backup = JSON.parse(await blob().text());
  assert.equal(backup.partners[0].name,'GPT 代充供货群'); assert.equal(backup.partners[0].active,false);
  assert.equal(backup.entries[0].partnerId,nextId); assert.equal(backup.categories[0].name,'生活支出');
  const before = stored.get(keys.entries); fail(keys.entries);
  entry(api,{category:'第三方代充',partnerId:nextId},'second'); assert.equal(stored.get(keys.entries),before);
});

test('category rename duplicates are type-scoped; unused deletion confirms and system categories are protected', () => {
  const {api,context,stored,target} = setup();
  category(api,'生活'); category(api,'办公'); category(api,'生活','income');
  const id = api.categories()[0].id;
  category(api,'办公','expense',id); assert.match(target.textContent,/已存在/);
  assert.equal(api.categories()[0].name,'生活');
  category(api,'日常','expense',id); assert.equal(api.categories()[0].name,'日常');
  category(api,'客户付款','expense'); assert.equal(api.categories().length,4);
  let prompt = '';
  context.confirm = msg => { prompt = msg; return false; };
  const before = stored.get(keys.categories); api.deleteManaged('category',id);
  assert.match(prompt,/确定删除分类/); assert.equal(stored.get(keys.categories),before);
  context.confirm = () => true; api.deleteManaged('category',id);
  assert.ok(!names(api,'expense').includes('日常'));
  api.deleteManaged('category','客户付款');
  assert.ok(names(api,'income').includes('客户付款'));
});

test('used text and ID categories can only deactivate; linked names, filters, backup and snapshots survive', async () => {
  const original = setup(); category(original.api,'生活'); entry(original.api,{category:'生活'});
  const id = original.api.categories()[0].id;
  const records = [original.api.entries()[0],{...original.api.entries()[0],id:'linked',categoryId:id}];
  const seed = Object.fromEntries(original.stored);
  seed[keys.entries] = JSON.stringify({version:1,entries:records});
  const {api,context,stored,blob} = setup(seed);
  const before = stored.get(keys.entries);
  let prompt;
  context.confirm = msg => { prompt=msg; return false; };
  api.deleteManaged('category',id); assert.match(prompt,/已有 2 条记录使用/);
  assert.equal(api.categories()[0].active,true);
  context.confirm = () => true; api.deleteManaged('category',id);
  assert.equal(api.categories()[0].active,false); assert.equal(stored.get(keys.entries),before);
  category(api,'日常','expense',id);
  assert.equal(api.entryCategoryName(api.entries()[0]),'生活');
  assert.equal(api.entryCategoryName(api.entries()[1]),'日常');
  api.state().filters.expenses.monthScope='all'; api.state().filters.expenses.category='日常';
  assert.equal(api.filteredExpenses().length,1); assert.match(api.categoryChart(api.entries()),/日常/);
  assert.equal(stored.get(keys.entries),before);
  api.downloadBackup(); const backup=JSON.parse(await blob().text());
  assert.equal(backup.entries[1].categoryId,id);
  entry(api,{category:'日常'},'linked'); assert.equal(api.entries()[1].categoryId,id);
  assert.equal(setup(Object.fromEntries(stored)).api.entryCategoryName(api.entries()[1]),'日常');
});

test('group duplicate edits, unused deletion, referenced deletion and compatibility references', () => {
  const {api,context,target,stored} = setup(); group(api,'群 A'); group(api,'群 B');
  const id = api.partners()[0].id, unused = api.partners()[1].id;
  group(api,'群 B',id); assert.match(target.textContent,/已存在/); assert.equal(api.partners()[0].name,'群 A');
  context.confirm = () => false; api.deleteManaged('partner',unused); assert.equal(api.partners().length,2);
  context.confirm = () => true; api.deleteManaged('partner',unused); assert.equal(api.partners().length,1);
  entry(api,{category:'第三方代充',partnerId:id});
  const before = stored.get(keys.entries); let prompt;
  context.confirm = msg => { prompt=msg; return false; };
  api.deleteManaged('partner',id); assert.match(prompt,/已有 1 条支出记录使用/);
  assert.equal(api.partners()[0].active,true);
  context.confirm = () => true; api.deleteManaged('partner',id);
  assert.equal(api.partners()[0].active,false);
  assert.equal(api.entryPartnerName(api.entries()[0]),'群 A');
  assert.equal(stored.get(keys.entries),before);
  assert.ok(!api.partnerOptions().some(([value])=>value===id));
  assert.ok(api.partnerOptions(api.entries()[0]).some(([value])=>value===id));
  for (const fields of [{partnerId:'manual-group:群 A'},{partnerId:'',partnerDisplayName:'群 A'}]) {
    const seed=Object.fromEntries(stored);
    seed[keys.entries]=JSON.stringify({version:1,entries:[{...api.entries()[0],...fields}]});
    const compat=setup(seed); compat.api.deleteManaged('partner',id);
    assert.equal(compat.api.partners().length,1);
    assert.equal(compat.api.entryPartnerName(compat.api.entries()[0]),'群 A');
  }
});

test('management write failures preserve data and ordinary expense hides partner field', () => {
  for (const kind of ['category','partner']) {
    const {api,stored,fail} = setup(); category(api,'生活'); group(api,'群');
    const before=JSON.stringify(Object.fromEntries(stored));
    fail(keys[kind === 'category' ? 'categories' : 'partners']);
    api.deleteManaged(kind,kind === 'category' ? api.categories()[0].id : api.partners()[0].id);
    assert.equal(JSON.stringify(Object.fromEntries(stored)),before);
  }
  const {api,context}=setup();
  const partnerLabel={},payeeLabel={};
  const form={elements:{category:{value:'第三方代充'},partnerId:{closest:()=>partnerLabel},payee:{closest:()=>payeeLabel}}};
  context.document.querySelector=()=>form;
  api.syncPartnerFields(); assert.equal(partnerLabel.hidden,false); assert.equal(form.elements.partnerId.required,true);
  form.elements.category.value='生活支出'; api.syncPartnerFields();
  assert.equal(partnerLabel.hidden,true); assert.equal(form.elements.partnerId.disabled,true); assert.equal(payeeLabel.hidden,false);
});

test('cancel management edits does not write data', () => {
  const {api,stored}=setup(); category(api,'生活'); group(api,'群 A');
  const before=JSON.stringify(Object.fromEntries(stored));
  for (const action of ['categories','partners']) {
    api.handleClick({target:{closest:()=>({dataset:{ledgerAction:action}})}});
    assert.equal(JSON.stringify(Object.fromEntries(stored)),before);
  }
});
