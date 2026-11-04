'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jx3-talent-refresh-'));
process.env.JX3_USER_DATA_DIR = path.join(root, 'user');
process.env.JX3_CACHE_DIR = path.join(root, 'shared-cache');
const { isCurrentTalentTime, pruneTalentEntries } = require('../lib/jcl/talent-cache-policy.cjs');
const { resolveTalents } = require('../lib/jcl/talents.cjs');
const resources = require('../lib/ai/resources.cjs');
const KB = require('../lib/ai/knowledge.cjs');
const { knowledgeCheck } = require('../lib/ai/validation.cjs');
test.after(() => {
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('jx3-talent-refresh-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const old = '2026-10-29T23:59:59.999+09:00';
const fresh = '2026-10-30T00:00:00+09:00';
const entry = (id, level, fetchedAt, description) => ({ fetchedAt, sourceUrl: 'https://node.jx3box.com/resource/std/test', resource: { SkillID: id, Level: level, Name: `奇穴${id}`, Desc: description } });
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('only dates after the whole cutoff day are reusable; invalid and future dates are discarded', () => {
  const now = Date.parse('2026-11-04T12:00:00+09:00');
  for (const value of [null, undefined, '', 'bad', old, '2027-01-01T00:00:00Z']) assert.equal(isCurrentTalentTime(value, now), false);
  assert.equal(isCurrentTalentTime(fresh, now), true);
  assert.equal(isCurrentTalentTime('2026-10-29T15:00:00Z', now), true);
  const entries = { old: { fetchedAt: old }, valid: { fetchedAt: fresh }, missing: {} };
  assert.equal(pruneTalentEntries(entries, now), 2);
  assert.deepEqual(Object.keys(entries), ['valid']);
});

test('mixed cache refreshes only expired keys, persists fetch time, and reuses exact and generic levels', async () => {
  const cacheDir = path.join(root, 'mixed'), file = path.join(cacheDir, 'talents-std.json');
  write(file, { version: 1, client: 'std', entries: {
    '100_1': entry(100, 1, old, '旧精确说明'), '100_0': entry(100, 0, old, '旧通用说明'),
    '200_1': entry(200, 1, fresh, '保留的新说明'), '200_0': entry(200, 0, fresh, '新通用说明'),
    '300_1': entry(300, 1, old, '未显示的旧奇穴也要清理'),
  } });
  let calls = 0;
  const before = Date.now();
  const fetchImpl = async url => {
    calls++;
    assert.match(url, /skill\.\[100_0,100_1\]/);
    return { ok: true, text: async () => JSON.stringify([{ SkillID: 100, Level: 1, Name: '更新奇穴', Desc: '更新说明' }]) };
  };
  const input = [{ skillId: 100, level: 1 }, { skillId: 200, level: 1 }];
  const first = await resolveTalents(input, { cacheDir, fetchImpl });
  assert.equal(first.meta.invalidatedEntries, 3);
  assert.equal(first.entries['100_1'].description, '更新说明');
  assert.equal(first.entries['100_1'].metadataStatus, 'fresh');
  assert.ok(Date.parse(first.entries['100_1'].fetchedAt) >= before);
  assert.equal(first.entries['200_1'].fetchedAt, fresh);
  const saved = read(file);
  assert.equal(saved.entries['300_1'], undefined);
  const second = await resolveTalents(input, { cacheDir, fetchImpl });
  assert.equal(second.meta.networkRequests, 0);
  assert.equal(calls, 1);
  assert.deepEqual(read(file), saved); // Reading must not renew timestamps.
  const origin = await resolveTalents(input, { cacheDir, offline: true, client: 'origin' });
  assert.equal(origin.entries['100_1'].description, null);
});

test('offline old exact and generic descriptions stay unknown and are physically removed', async () => {
  const cacheDir = path.join(root, 'offline'), file = path.join(cacheDir, 'talents-std.json');
  write(file, { version: 1, client: 'std', entries: {
    '10_1': entry(10, 1, old, '旧说明'), '10_0': entry(10, 0, old, '旧通用'),
    '20_1': entry(20, 1, old, '旧精确'), '20_0': entry(20, 0, fresh, '新通用'),
  } });
  const result = await resolveTalents([{ skillId: 10, level: 1 }, { skillId: 20, level: 1 }], { cacheDir, offline: true });
  assert.equal(result.entries['10_1'].label, '奇穴 10');
  assert.equal(result.entries['10_1'].description, null);
  assert.equal(result.entries['20_1'].description, '新通用');
  assert.deepEqual(Object.keys(read(file).entries), ['20_0']);
});

test('AI talent lookup shares the card cache, never resurrects its own old copy, and retains true fetch provenance', async () => {
  const cacheFile = path.join(process.env.JX3_CACHE_DIR, 'talents-std.json');
  const sourceFile = path.join(process.env.JX3_USER_DATA_DIR, 'ai-knowledge/sources/std.json');
  write(cacheFile, { version: 1, client: 'std', entries: { '5891_1': entry(5891, 1, old, '旧卡片说明') } });
  write(sourceFile, { entries: { 'talent.5891_1': { kind: 'talent', id: 5891, level: 1, description: '旧AI说明', retrievedAt: old } } });
  const wanted = [{ kind: 'talent', id: 5891, level: 1 }];
  const unavailable = await resources.details(wanted, { offline: true });
  assert.equal(unavailable[0].description, null);
  assert.equal(read(sourceFile).entries['talent.5891_1'], undefined);
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, text: async () => JSON.stringify([{ SkillID: 5891, Level: 1, Name: '秋深', Desc: '当前说明', IconID: 11 }]) }; };
  await resolveTalents([{ skillId: 5891, level: 1 }], { fetchImpl });
  const current = await resources.details(wanted, { fetchImpl });
  assert.equal(current[0].description, '当前说明');
  assert.equal(current[0].retrievedAt, read(cacheFile).entries['5891_1'].fetchedAt);
  await resources.details(wanted, { fetchImpl });
  assert.equal(calls, 1);
  const records = KB.search(await KB.snapshot(), { resourceKeys: wanted }).records;
  assert.ok(records.length > 0);
  assert.ok(records.every(({ applicability, ...r }) => knowledgeCheck(r) && r.resourceFetchedAt === current[0].retrievedAt));
  const oldRecord = KB.record({ kind: 'resource_description', statement: '旧版说明', resourceKeys: wanted, origin: 'local:test', raw: { fetchedAt: old } });
  const legacy = { ...records[0] }; delete legacy.resourceFetchedAt;
  assert.equal(KB.applicability(oldRecord, { client: 'std' }), 'mismatch');
  assert.equal(KB.applicability(legacy, { client: 'std' }), 'mismatch');
  assert.equal(records[0].applicability, 'unverified'); // Fresh fetch is not proof of a historical mechanic.
});

test('AI buff facts reject pre-season caches, fetch in one batch and reuse within the maintenance version', async () => {
  const sourceFile=path.join(process.env.JX3_USER_DATA_DIR,'ai-knowledge/sources/std.json');
  write(sourceFile,{entries:{'buff.900001_1':{kind:'buff',id:900001,level:1,description:'旧赛季减疗说明',retrievedAt:old}}});
  write(path.join(process.env.JX3_CACHE_DIR,'kill-buffs-std.json'),{entries:{'900001_1':{BuffID:900001,Level:1,Name:'旧名称',Desc:'旧说明',retrievedAt:old}}});
  const wanted=[{kind:'buff',id:900001,level:1},{kind:'buff',id:900002,level:1}];
  assert((await resources.details(wanted,{offline:true})).every(r=>r.description===null));
  let count=0;const fetchImpl=async url=>{count++;assert(url.includes('900001_1')&&url.includes('900002_1'));return {ok:true,text:async()=>JSON.stringify(wanted.map(r=>({BuffID:r.id,Level:1,Name:'新资料',Desc:'本版本资料'})))}};
  const current=await resources.details(wanted,{fetchImpl,gameVersion:'std-2026-10-30'});assert.equal(count,1);assert(current.every(r=>r.collection==='game_fact'&&r.priority==='primary'&&r.applicability==='matched'));
  await resources.details(wanted,{fetchImpl});assert.equal(count,1);
  const historical=await resources.details(wanted,{offline:true,gameVersion:'historical-before:std-2026-10-30'});assert(historical.every(r=>r.applicability==='mismatch'));
  const source=path.join(process.env.JX3_USER_DATA_DIR,'ai-knowledge/game-facts/sources/std-2026-10-30/std.json');assert.equal(read(source).gameVersion,'std-2026-10-30');
});
