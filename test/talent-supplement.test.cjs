'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jx3-talent-supplement-'));
process.env.JX3_CACHE_DIR = path.join(root, 'cache');
process.env.JX3_USER_DATA_DIR = path.join(root, 'user');
const { resolveTalents } = require('../lib/jcl/talents.cjs');
const { catalogEntries } = require('../lib/jcl/talent-supplement.cjs');
const resources = require('../lib/ai/resources.cjs');
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('jx3-talent-supplement-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const response = body => ({ ok: true, text: async () => JSON.stringify(body) });
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
const row = (id, name = '合成奇穴') => ({ id: String(id), name, desc: '第一段\\n\\n第二段 <SUB 7 1>', icon: 123, order: '1', pos: 2 });
const synthetic = { 合成心法: { 1: { 2: row(70001) }, 6: { 3: row(70002, '合成奇穴二') } } };

test('current negative resource entries are supplemented by exact ID and persist across offline reuse and AI queries', async () => {
  const cacheDir = process.env.JX3_CACHE_DIR;
  const now = new Date().toISOString();
  write(path.join(cacheDir, 'talents-std.json'), { version: 1, client: 'std', entries: Object.fromEntries(
    ['70001_0', '70001_1', '70002_0', '70002_1'].map(key => [key, { resource: null, fetchedAt: now }])) });
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.endsWith('/index.json')) return response([{ version: 'v20261030', name: '合成版本' }]);
    if (url.endsWith('/v20261030.json')) return response(synthetic);
    if (url.includes('/resource/')) return response([]);
    assert.fail('Fresh negative cache must not be fetched again: ' + url);
  };
  const input = [{ skillId: 70001, level: 1 }, { skillId: 70002, level: 1 }];
  const first = await resolveTalents(input, { fetchImpl });
  assert.equal(urls.length, 2);
  assert.equal(first.entries['70001_1'].description, '第一段\n\n第二段 <SUB 7 1>');
  assert.equal(first.entries['70001_1'].descriptionHasReferences, true);
  assert.equal(first.entries['70001_1'].nameResourceLevel, null);
  assert.equal(first.entries['70001_1'].status, 'catalog_fallback');
  assert.equal(first.entries['70001_1'].sourceVersion, 'v20261030');
  const file = path.join(cacheDir, 'talent-simulator-std.json'), before = fs.readFileSync(file, 'utf8');
  const repeated = await resolveTalents(input, { offline: true, fetchImpl });
  assert.equal(repeated.meta.networkRequests, 0);
  assert.equal(repeated.entries['70002_1'].name, '合成奇穴二');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const ai = await resources.details([{ kind: 'talent', id: 70001, level: 1 }], { offline: true, fetchImpl });
  assert.equal(ai[0].name, '合成奇穴');
  assert.equal(ai[0].description, first.entries['70001_1'].description);
  assert.equal(ai[0].nameLevel, null);
  assert.equal(ai[0].sourceVersion, 'v20261030');
  assert.equal(ai[0].retrievedAt, first.entries['70001_1'].fetchedAt);
  assert.equal(urls.length, 2);
  const unknown = await resolveTalents([{ skillId: 99999, level: 1 }], { fetchImpl });
  // Only the missing resource is checked; the catalog's missing ID remains unknown.
  assert.equal(unknown.entries['99999_1'].name, null);
  assert.equal(urls.length, 3);
  const origin = await resolveTalents(input, { client: 'origin', offline: true });
  assert.equal(origin.entries['70001_1'].name, null);
});

test('same ID with conflicting descriptions is not guessed; slot and option do not substitute an ID', () => {
  const data = structuredClone(synthetic);
  data.另一个心法 = { 1: { 2: { ...row(70001), desc: '冲突说明' } } };
  const entries = catalogEntries(data);
  assert.equal(entries[70001], undefined);
  assert.equal(entries[70002].resource.Name, '合成奇穴二');
  assert.equal(entries[99999], undefined);
});

test('single-row and null resource responses are handled, while an error envelope is rejected', async () => {
  const input = [{ skillId: 70003, level: 1 }];
  const single = await resolveTalents(input, { cacheDir: path.join(root, 'single'), simulatorFallback: false,
    fetchImpl: async () => response({ SkillID: 70003, Level: 1, Name: '精确等级', Desc: '精确说明' }) });
  assert.equal(single.entries['70003_1'].name, '精确等级');
  assert.equal(single.entries['70003_1'].nameResourceLevel, 1);
  const empty = await resolveTalents(input, { cacheDir: path.join(root, 'empty'), simulatorFallback: false, fetchImpl: async () => response(null) });
  assert.equal(empty.entries['70003_1'].name, null);
  assert.equal(empty.meta.status, 'partial');
  const invalid = await resolveTalents(input, { cacheDir: path.join(root, 'invalid'), simulatorFallback: false, fetchImpl: async () => response({ error: 'no' }) });
  assert.equal(invalid.meta.status, 'degraded');
});

test('pre-update catalog versions and stale catalog cache do not fill unknown talent descriptions', async () => {
  const cacheDir = path.join(root, 'old');
  write(path.join(cacheDir, 'talent-simulator-std.json'), { version: 1, client: 'std', catalogVersion: 'v20261025',
    fetchedAt: new Date().toISOString(), entries: catalogEntries(synthetic) });
  let calls = 0;
  const result = await resolveTalents([{ skillId: 70001, level: 1 }], { cacheDir, fetchImpl: async url => {
    calls++;
    return response(url.includes('/resource/') ? [] : [{ version: 'v20261025' }]);
  } });
  assert.equal(result.entries['70001_1'].name, null);
  assert.equal(calls, 2);
  assert.ok(result.warnings.some(w => w.code === 'TALENT_SUPPLEMENT_UNAVAILABLE'));
});
