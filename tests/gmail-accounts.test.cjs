// Synthetic-only tests. Never connects to a browser, real localStorage or IndexedDB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/gmail-accounts.js'), 'utf8');
const KEY = 'zy_kb_gmail_accounts_v1';
const text = 'demo1@gmail.com----Password001----ABCDEFGHIJKLMNOP\n\ndemo2@gmail.com----Password002----QRSTUVWXYZABCDEF';
const stamp = '2026-09-22T00:00:00.000Z';
const record = (overrides = {}) => ({ id: 'gmail-demo', email: 'demo1@gmail.com', password: 'Password001', twoFactor: 'ABCDEFGHIJKLMNOP', customerCode: '', deliveryDate: '', status: 'pending', sourceBatch: 'demo-batch', remark: '', createdAt: stamp, updatedAt: stamp, ...overrides });
const doc = (records) => JSON.stringify({ version: 1, records });
function setup(seed = {}) {
  const storage = new Map(Object.entries(seed));
  const writes = [], copied = [], messages = [], error = { textContent: '' };
  let failRead = false, failWrite = false;
  const ctx = vm.createContext({
    Date, console, crypto: require('node:crypto').webcrypto,
    localStorage: {
      getItem(key) { if (failRead) throw new Error('synthetic read failure'); return storage.get(key) ?? null; },
      setItem(key, value) { if (failWrite) throw new Error('synthetic quota'); writes.push(key); storage.set(key, value); },
    },
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    document: { addEventListener() {}, querySelector: () => null },
  });
  const expose = `
    openModal = () => {}; updateList = () => {};
    globalThis.api = { analyzeBatch, validateRecord, readStore, saveRecords, saveEdit, confirmBatch,
      copyRecord, renderRows, filteredRecords, deliveryText,
      setDraft(text, sourceBatch = '') { draft = {text, sourceBatch, preview: analyzeBatch(text, readStore().records)}; },
      setEditing(value) { editingRecord = value; },
      setFilters(value) { Object.assign(filters, value); },
      draft: () => draft };
  `;
  vm.runInContext(source.replace('  globalThis.GmailAccounts =', expose + '\n  globalThis.GmailAccounts ='), ctx);
  ctx.GmailAccounts.configure({ notify: (s) => messages.push(s) });
  const form = (values) => ({ elements: { namedItem: (name) => ({ value: values[name] ?? '' }) }, querySelector: () => error });
  return { api: ctx.api, module: ctx.GmailAccounts, storage, writes, copied, messages, error, form,
    failRead() { failRead = true; }, failWrite() { failWrite = true; } };
}
test('batch: blank lines, trimming, case normalization, duplicate types and line errors', () => {
  const { api } = setup();
  const parsed = api.analyzeBatch(text);
  assert.equal(parsed.additions.length, 2);
  assert.equal(parsed.empty, 1);
  assert.equal(parsed.additions[1].line, 3);
  const mixed = api.analyzeBatch('  DEMO1@GMAIL.COM ---- Password001 ---- ABCDEFGHIJKLMNOP \n demo1@gmail.com----P----T\ndemo@gmail.com----PasswordOnly\ninvalid----P----T\ndemo2@gmail.com----P----T----extra\ndemo3@gmail.com----P----', [record()]);
  assert.equal(mixed.duplicates.length, 2);
  assert.equal(mixed.errors.length, 4);
  assert.match(mixed.errors[0].reason, /缺少 2FA/);
  assert.equal(mixed.errors[0].line, 3);
  assert.equal(api.analyzeBatch(text + '\ndemo1@gmail.com----Other----Other').duplicates[0].reason, '批内重复');
  assert.equal(api.analyzeBatch(' DEMO2@GMAIL.COM ---- P ---- T ').additions[0].email, 'demo2@gmail.com');
  assert.equal(api.analyzeBatch('de mo@gmail.com----P----T').errors.length, 1);
});
test('preview does not write; confirmation appends once and preserves unrelated stores', () => {
  const env = setup({ zy_kb_mail_accounts_v1: 'synthetic mail sentinel', zy_kb_recharge_codes_v1: 'synthetic recharge sentinel' });
  env.api.setDraft(text, 'demo-batch');
  assert.equal(env.writes.length, 0);
  env.api.confirmBatch();
  env.api.confirmBatch();
  assert.equal(JSON.parse(env.storage.get(KEY)).records.length, 2);
  assert.deepEqual(env.writes, [KEY]);
  assert.equal(env.storage.get('zy_kb_mail_accounts_v1'), 'synthetic mail sentinel');
  assert.equal(env.storage.get('zy_kb_recharge_codes_v1'), 'synthetic recharge sentinel');
  const restored = setup(Object.fromEntries(env.storage));
  assert.equal(restored.module.getSummary().total, 2);
  assert.equal(restored.api.readStore().records[0].sourceBatch, 'demo-batch');
});
test('confirmation rechecks duplicates when another tab wrote after preview', () => {
  const env = setup();
  env.api.setDraft(text);
  env.storage.set(KEY, doc([record()]));
  env.api.confirmBatch();
  assert.equal(env.writes.length, 0);
  assert.equal(env.api.draft().preview.additions.length, 1);
  env.api.confirmBatch();
  assert.equal(JSON.parse(env.storage.get(KEY)).records.length, 2);
});
test('copy exact three-line template without any storage writes or field changes', async () => {
  const env = setup({ [KEY]: doc([record()]) });
  const before = env.storage.get(KEY);
  await env.api.copyRecord('gmail-demo');
  assert.equal(env.copied[0], '账号：demo1@gmail.com\n密码：Password001\n2Fa：ABCDEFGHIJKLMNOP');
  assert.equal(env.storage.get(KEY), before);
  assert.equal(env.writes.length, 0);
  assert.equal(env.messages.at(-1), '已复制');
});
test('single add/edit, customer validation, manual delivery, counts and keyword/batch filtering', () => {
  const env = setup();
  env.api.saveEdit(env.form(record()));
  assert.equal(env.module.getSummary().available, 1);
  let saved = env.api.readStore().records[0];
  env.api.setEditing(saved);
  env.api.saveEdit(env.form({ ...saved, customerCode: 'c123' }));
  assert.match(env.error.textContent, /C \+ 6/);
  assert.equal(env.writes.length, 1);
  env.api.saveEdit(env.form({ ...saved, customerCode: 'C000123', deliveryDate: '2026-09-22', status: 'delivered', remark: 'demo delivery' }));
  const summary = env.module.getSummary(new Date('2026-09-22T12:00:00'));
  assert.equal(summary.available, 0);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.monthDelivered, 1);
  assert.equal(env.module.getSummary(new Date('2026-10-01T12:00:00')).monthDelivered, 0);
  env.api.setFilters({ keyword: 'C000123', batch: 'demo-batch', status: 'delivered' });
  assert.equal(env.api.filteredRecords().length, 1);
  env.api.setFilters({ keyword: 'missing' });
  assert.equal(env.api.filteredRecords().length, 0);
  env.api.setEditing(null);
  env.api.saveEdit(env.form(record()));
  assert.match(env.error.textContent, /重复 Gmail/);
});
test('invalid date and concurrent edit are rejected', () => {
  const original = record();
  const env = setup({ [KEY]: doc([original]) });
  env.api.setEditing(original);
  env.api.saveEdit(env.form({ ...original, deliveryDate: '2026-02-30' }));
  assert.equal(env.writes.length, 0);
  env.storage.set(KEY, doc([record({ remark: 'other tab' })]));
  env.api.saveEdit(env.form({ ...original, remark: 'overwrite' }));
  assert.match(env.error.textContent, /其他页面修改/);
  assert.equal(env.writes.length, 0);
});
test('corrupt/versioned/duplicate Gmail stores fail closed and remain intact', () => {
  for (const bad of ['{broken', '{"version":2,"records":[]}', doc([record(), record()]), doc([{ ...record(), twoFactor: null }])]) {
    const env = setup({ [KEY]: bad });
    assert.equal(env.module.getSummary().ok, false);
    assert.equal(env.api.saveRecords([], env.api.readStore()), false);
    env.api.saveEdit(env.form(record()));
    assert.equal(env.storage.get(KEY), bad);
    assert.equal(env.writes.length, 0);
  }
});
test('read/quota errors and stale base never overwrite records', () => {
  const env = setup({ [KEY]: doc([record()]) });
  const base = env.api.readStore();
  env.failWrite();
  assert.equal(env.api.saveRecords([record({ remark: 'change' })], base), false);
  assert.equal(env.storage.get(KEY), base.raw);
  env.failRead();
  assert.equal(env.api.readStore().ok, false);
  const other = setup();
  const stale = other.api.readStore();
  other.storage.set(KEY, doc([record()]));
  assert.equal(other.api.saveRecords([], stale), false);
  assert.equal(other.writes.length, 0);
});
test('list and preview hide secrets; user text is HTML escaped', () => {
  const env = setup({ [KEY]: doc([record({ password: '<script>demo</script>', twoFactor: 'SECRET-DEMO' })]) });
  const html = env.module.renderPane();
  assert.ok(!html.includes('<script>demo</script>'));
  assert.ok(!html.includes('SECRET-DEMO'));
  assert.ok(html.includes('••••••••'));
  assert.ok(html.includes('一键复制'));
  const rendered = env.api.renderRows([record({ customerCode: '<img src=x>' })]);
  assert.ok(!rendered.includes('<img src=x>'));
  assert.ok(rendered.includes('&lt;img src=x&gt;'));
});
