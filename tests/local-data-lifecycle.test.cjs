// Synthetic-only lifecycle tests; never touches a browser profile or real storage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../js/script.js'), 'utf8');
const markerKey = 'zy_kb_skip_default_seed_v1';
const knowledgeKey = 'zy_kb_system_v2';
const dataVersionKey = 'zy_kb_default_data_version_v2';
const dataVersion = 'document-pack-2026-07-22';
const defaults = [{ category_id: 'default', title: '默认分类', items: [{ content_id: 'default-article', title: '默认文章', paragraphs: ['默认内容'] }] }];

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function initialize(seed = {}) {
  const localStorage = storage(seed);
  const end = source.indexOf('      hydrateGroups();') + '      hydrateGroups();'.length;
  assert.ok(end > 0, 'startup initialization block exists');
  const startup = source.slice(0, end) + '\n;globalThis.startupResult = { groups, skipDefaultSeed, needsDataVersionWrite };';
  const context = vm.createContext({
    localStorage,
    structuredClone,
    ORIGINAL_DATA: defaults,
    hydrateGroups() {},
    mergeOriginalData(stored) { return [...stored, ...structuredClone(defaults)]; },
  });
  vm.runInContext(startup, context);
  return { result: context.startupResult, localStorage };
}

test('fresh device still initializes the bundled default knowledge base', () => {
  const { result } = initialize();
  assert.equal(result.skipDefaultSeed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.groups)), defaults);
});

test('cleared device stays blank across reloads and future data-version changes', () => {
  const first = initialize({ [markerKey]: '1' });
  assert.equal(first.result.skipDefaultSeed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(first.result.groups)), []);

  const second = initialize({
    [markerKey]: '1',
    [knowledgeKey]: '[]',
    [dataVersionKey]: 'older-version',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(second.result.groups)), []);
});

test('clear order preserves the blank-state marker and unrelated keys', () => {
  const match = source.match(/function removeProjectStorage\(storage\) \{[\s\S]*?\n      \}/);
  assert.ok(match, 'project storage cleanup helper exists');
  const context = vm.createContext({});
  vm.runInContext(`${match[0]}; globalThis.removeProjectStorage = removeProjectStorage;`, context);
  const local = storage({ [knowledgeKey]: '[{"title":"测试"}]', zy_kb_customer_codes_v1: '{}', unrelated_key: 'keep' });
  context.removeProjectStorage(local);
  local.setItem(markerKey, '1');
  assert.deepEqual(Object.fromEntries(local.values), { unrelated_key: 'keep', [markerKey]: '1' });

  const confirmBlock = source.slice(source.indexOf('async function confirmClearLocalData'), source.indexOf('function closeRestoreDefaultDataDialog'));
  assert.ok(confirmBlock.indexOf('removeProjectStorage(localStorage)') < confirmBlock.indexOf('localStorage.setItem(SKIP_DEFAULT_SEED_KEY, "1")'));
});

test('restoring defaults removes the marker and knowledge customizations but names no business keys', () => {
  const restoreBlock = source.slice(source.indexOf('function confirmRestoreDefaultData'), source.indexOf('function importData'));
  assert.match(restoreBlock, /SKIP_DEFAULT_SEED_KEY/);
  for (const businessKey of ['CUSTOMER_CODES_KEY', 'EXPENSE_GROUPS_KEY', 'DAILY_EXPENSES_KEY', 'MAIL_ACCOUNTS_KEY', 'PRICE_GALLERY_META_KEY', 'GALLERY_COLLECTIONS_KEY']) {
    assert.doesNotMatch(restoreBlock, new RegExp(`\\b${businessKey}\\b`));
  }
  const restored = initialize();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.result.groups)), defaults);
});

test('separate device without the marker remains unaffected', () => {
  const clearedDevice = initialize({ [markerKey]: '1' });
  const otherDevice = initialize();
  assert.deepEqual(JSON.parse(JSON.stringify(clearedDevice.result.groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(otherDevice.result.groups)), defaults);
});
