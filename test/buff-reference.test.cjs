'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { convert, verify } = require('../scripts/import-buff-reference.cjs');
const { matchBuff, analyzeKill } = require('../lib/jcl/kill-analysis.cjs');
const KB = require('../lib/ai/knowledge.cjs');
const dict = require('../data/buff-reference.json');
const source = Buffer.from(`return {{szType="BUFF",szVersion="测试版本",aMonitor={
 {dwID=99001,nLevel=0,szNote="测试名称",szContent="封内",nStackNum=0,szUUID="a"},
 {dwID=99001,nLevel=0,szNote="测试名称",szContent="封内",nStackNum=0,szUUID="b"},
 {dwID=99001,nLevel=0,szNote="测试名称",szContent="减疗",nStackNum=0},
 {dwID=99001,nLevel=2,szNote="另一名称",szContent="眩晕",nStackNum=2,nStackNumOp=">="}
}}}`);
test('monitor import is lossless, preserves variants and duplicate origins without executing Lua', () => {
  const { source: parsed, dictionary: d } = convert(source, 'synthetic.jx3dat');
  assert(verify(d, parsed, source).roundTripAllSourceFields);
  assert.equal(d.stats.sourceRecordCount, 4); assert.equal(d.stats.definitionCount, 3);
  assert.equal(d.stats.duplicateDefinitionsCollapsed, 1); assert.equal(d.buffs[99001].name, null);
  assert.deepEqual(d.buffs[99001].levels[0].categories, ['封内', '减疗']);
  assert.equal(d.buffs[99001].levels[0].definitions[0].sourceRefs.length, 2);
  assert.deepEqual(matchBuff(d, 99001, 2, 1).categories, ['封内', '减疗']);
  assert.deepEqual(matchBuff(d, 99001, 2, 2).categories, ['眩晕', '封内', '减疗']);
  assert.throws(() => convert(Buffer.from('return {}; os.execute("bad")'), 'bad'));
  assert.throws(() => convert(Buffer.from('return {{szType="SKILL",aMonitor={}}}'), 'skill'));
  assert.throws(() => convert(source, 'bad', { client: 'std', gameVersion: '' }));
});
test('published monitor labels and IDs replace the old source and expose provenance in kill analysis', () => {
  assert.equal(dict.stats.buffCount, 1381); assert.equal(dict.stats.idLevelCount, 1432);
  assert.equal(dict.stats.classificationLabelCount, 408);
  assert.deepEqual(dict.source.declaredVersions, ['苍生铸世 · 2026/10/31']);
  assert.equal(dict.source.sha256, '9d9e2bd1145623a81021cbd6dd544f7aa0b3335e26e78ab55d0ca6672585533b');
  assert.equal(dict.buffs[204], undefined); // absent from this source; not a claim of removal from the game
  assert.deepEqual(matchBuff(dict, 9377, 3, 1).categories, ['疾行']);
  assert.equal(matchBuff(dict, 29282, 1, 1).name, '提子');
  assert.deepEqual(matchBuff(dict, 24356, 2, 1).categories, ['禁疗']);
  assert.equal(matchBuff(dict, 51466, 1, 1).name, '绝境·暗尘弥散');
  const result = analyzeKill({ events: [] }, { firstKill: null, scope: {}, players: [], events: [] }, dict, {});
  assert.equal(result.dictionary.revision, dict.source.sha256);
  assert.equal(result.dictionary.mechanicsVerified, false);
  assert.equal(result.dictionary.gameVersion, dict.maintenance.gameVersion);
});
test('monitor refresh archives previous facts, isolates the season and preserves user experiences', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jx3-buff-update-'));
  t.after(() => { assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); return fs.rm(dir, { recursive: true, force: true }); });
  const s = KB.createKnowledgeStore({ baseDir: dir }); await s.seed();
  const e = s.record({ kind: 'analysis_method', statement: '先核对事件再下结论。', createdBy: { kind: 'model', id: 'turn-1' }, origin: 'local:report-conversation:test:turn-1' });
  e.sources[0].kind = 'user_feedback'; await s.addExperiences([e], { turnId: 'turn-1' });
  const experienceFile = path.join(dir, 'ai-experiences/state.json'), before = await fs.readFile(experienceFile, 'utf8');
  const factFile = path.join(dir, 'game-facts/state.json'), f = JSON.parse(await fs.readFile(factFile));
  const stale = s.record({ kind: 'monitor_tag', statement: '旧标签测试', resourceKeys: [{ kind: 'buff', id: 9377, level: 0 }], origin: 'local:buff-reference', createdBy: { kind: 'program', id: 'maintained-facts-v2' } });
  f.records[stale.id] = stale; f.packHash = 'previous-pack'; await fs.writeFile(factFile, JSON.stringify(f));
  const snap = await s.snapshot(); assert.equal(await fs.readFile(experienceFile, 'utf8'), before);
  assert.equal(snap.records[stale.id].status, 'deprecated');
  const found = s.search(snap, { resourceKeys: [{ kind: 'buff', id: 9377, level: 3 }] }, { client: 'std', gameVersion: dict.maintenance.gameVersion });
  assert.equal(found.total, 1); assert(found.records[0].statement.includes('疾行'));
  assert.equal(found.records[0].collection, 'game_fact'); assert.equal(found.records[0].priority, 'primary');
  assert.equal(found.records[0].applicability, 'unverified'); assert.equal(found.records[0].review, null);
  assert.equal(s.search(snap, { kind: 'monitor_tag' }, { client: 'origin', gameVersion: dict.maintenance.gameVersion }).total, 0);
  assert.equal(s.search(snap, { kind: 'monitor_tag' }, { client: 'std', gameVersion: 'old-season' }).total, 0);
  assert.equal((await s.listExperiences()).total, 1);
  const stored = await fs.readFile(factFile, 'utf8'); await s.seed(); assert.equal(await fs.readFile(factFile, 'utf8'), stored);
});
