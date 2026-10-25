'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { analyzeJcl, readJclBattle, toBattleViewModel } = require('../lib/jcl/battle.cjs');
const { resolveTalents } = require('../lib/jcl/talents.cjs');

function fixture(records) {
  const events = [[1, '{true,"test::U900000000000000001/1"}', 1000],
    ...records.map(([data, ms = 1001]) => [4, data, ms]),
    [5, '{1,true,2000,2000,100,100}', 1100],
    [1, '{false,"test",200}', 1200]];
  return events.map(([event, data, ms], i) => `0\t${i + 1}\t1792858843\t${ms}\t${event}\t${data}`).join('\n');
}
const info = (score = '800000', talents = '{}', id = 1) => `{${id},"玩家",5,10080,${score},{},${talents},"900000000000000001"}`;
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcl-loadout-'));
  t.after(async () => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('jcl-loadout-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return dir;
}
const response = rows => ({ ok: true, text: async () => JSON.stringify(rows) });

test('ordered selections survive omitted and empty PLAYER_INFO; explicit zero score is preserved', () => {
  const p = analyzeJcl(fixture([
    [info('0', '{[2]={4,18210,1},[1]={3,5891,1}}')],
    [info('nil', 'nil')], [info('-1', '{}')],
    [info('nil', '{{3,5891,1},{4,18210,1}}')],
  ])).players[0];
  assert.equal(p.equipScore, 0);
  assert.equal(p.equipScoreEvidence.line, 2);
  assert.equal(p.equipScoreChanges.length, 1);
  assert.deepEqual(p.talents.map(t => [t.slot, t.skillId, t.optionIndexRaw]), [[1, 5891, 3], [2, 18210, 4]]);
  assert.equal(p.talentLoadout.status, 'recorded');
  assert.equal(p.talentLoadout.omittedRecordCount, 2);
  assert.equal(p.talentLoadout.changes.length, 1);
  assert.equal(p.talentLoadout.changes[0].observationCount, 2);
});

test('score and talent changes include aliases, returning to an earlier scheme, and source times', () => {
  const input = fixture([
    [info('nil', 'nil')], [info('800001', '{{3,5891,1}}'), 1002],
    [info('800002', '{{4,18210,1}}', 99), 1003],
    [info('800001', '{{3,5891,1}}', 99), 1004],
  ]).replace('1100\t5\t{1,true', '1100\t5\t{99,true') + '\n0\t99\t1\t1201\t5\t{1,true,2000,2000,100,100}';
  // Both entities must be active before the explicit end marker.
  const activeInput = input.replace('1200\t1\t{false,"test",200}', '1150\t5\t{1,false,2000,2000,100,100}');
  const p = analyzeJcl(activeInput).players[0];
  assert.deepEqual(p.entityIds, ['1', '99']);
  assert.equal(p.equipScore, 800001);
  assert.equal(p.equipScoreEvidence.atMs, 2);
  assert.deepEqual(p.equipScoreChanges.map(c => c.value), [800001, 800002, 800001]);
  assert.equal(p.talentLoadout.changed, true);
  assert.deepEqual(p.talentLoadout.changes.map(c => c.entries[0].skillId), [5891, 18210, 5891]);
  assert.deepEqual(p.talentLoadout.changes.map(c => c.evidence.atMs), [2, 3, 4]);
});

test('talent count is data-driven; no fixed nine-slot assumption', () => {
  const raw = '{' + Array.from({ length: 12 }, (_, i) => `{${i + 1},${5000 + i},1}`).join(',') + '}';
  const p = analyzeJcl(fixture([[info('800000', raw)]])).players[0];
  assert.equal(p.talents.length, 12);
  assert.equal(p.talentLoadout.status, 'recorded');
  assert.equal(p.talents[11].slot, 12);
  assert.equal(p.talents[11].optionIndexRaw, 12);
});

test('invalid and missing loadouts remain explicit; later valid snapshot does not erase partial evidence', () => {
  const b = analyzeJcl(fixture([[info('-1', '{[2]={4,-1,1}}')]]));
  const p = b.players[0], card = toBattleViewModel(b).unassignedPlayers[0];
  assert.equal(p.equipScore, null);
  assert.equal(card.equipScoreText, '未知');
  assert.equal(p.talentLoadout.status, 'partial');
  assert.equal(p.talents[0].selectionStatus, 'invalid');
  assert.equal(p.talents[0].raw[2], -1);
  const missing = toBattleViewModel(analyzeJcl(fixture([[info('nil', 'nil')]]))).unassignedPlayers[0];
  assert.equal(missing.talentStatus, 'unknown');
  assert.deepEqual(missing.talents, []);
  assert.equal(missing.talentSummary, '奇穴未知');
  const recovered = analyzeJcl(fixture([[info('-1', '{[2]={4,-1,1}}')], [info('800000', '{{3,5891,1}}'), 1002]])).players[0];
  assert.equal(recovered.talentLoadout.status, 'recorded');
  assert.equal(recovered.talentLoadout.evidence.line, 3);
  assert.equal(recovered.talentLoadout.changes[0].status, 'partial');
});

test('batch joins exact levels, separates fallback provenance, rejects substitute levels and deduplicates concurrent requests', async t => {
  const cacheDir = await temp(t);
  const input = [{ skillId: 5891, level: 1 }, { skillId: 5891, level: 2 }, { skillId: 99999, level: 1 }, { skillId: 18210, level: 1 }];
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.ok(url.includes('5891_0,5891_1,5891_2,18210_0,18210_1,99999_0,99999_1'));
    return response([
      { SkillID: 5891, Level: 2, Name: '二级', Desc: '二级说明', IconID: 12 },
      { SkillID: 5891, Level: 1, Name: '', Desc: '' },
      { SkillID: 5891, Level: 0, Name: '通用', Desc: '<SUB 549 7>', IconID: 10 },
      { SkillID: 5891, Level: 1, Name: '秋深', Desc: '', IconID: 11 },
      { SkillID: 18210, Level: 0, Name: '承清', Desc: '通用说明' },
      { SkillID: 99999, Level: 14, Name: '不应采用的替代等级' },
    ]);
  };
  const [a, b] = await Promise.all([resolveTalents(input, { cacheDir, fetchImpl }), resolveTalents(input, { cacheDir, fetchImpl })]);
  assert.equal(calls, 1);
  assert.equal(a.entries['5891_1'].name, '秋深');
  assert.equal(a.entries['5891_1'].nameResourceLevel, 1);
  assert.equal(a.entries['5891_1'].descriptionResourceLevel, 0);
  assert.equal(a.entries['5891_1'].descriptionHasReferences, true);
  assert.equal(a.entries['5891_2'].description, '二级说明');
  assert.equal(a.entries['18210_1'].status, 'generic_fallback');
  assert.equal(a.entries['99999_1'].name, null);
  assert.equal(b.entries['99999_1'].label, '奇穴 99999');
  assert.equal(b.meta.networkRequests, 0);
  const offline = await resolveTalents([...input, { skillId: 88, level: 1 }], { cacheDir, fetchImpl, offline: true });
  assert.equal(calls, 1);
  assert.equal(offline.entries['5891_2'].name, '二级');
  assert.equal(offline.entries['88_1'].metadataStatus, 'unavailable');
});

test('service failure retains expired cached names and applies retry backoff', async t => {
  const cacheDir = await temp(t);
  await fs.writeFile(path.join(cacheDir, 'talents-std.json'), JSON.stringify({ version: 1, client: 'std', entries: {
    '5891_1': { resource: { SkillID: 5891, Level: 1, Name: '旧缓存名称' }, fetchedAt: '2000-01-01T00:00:00Z', sourceUrl: 'cached' },
  } }));
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('simulated unavailable'); };
  const input = [{ skillId: 5891, level: 1 }, { skillId: 88, level: 1 }];
  const a = await resolveTalents(input, { cacheDir, fetchImpl });
  const b = await resolveTalents(input, { cacheDir, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(a.meta.status, 'degraded');
  assert.equal(a.entries['5891_1'].metadataStatus, 'stale_cache');
  assert.equal(b.entries['5891_1'].name, '旧缓存名称');
  assert.equal(b.entries['88_1'].label, '奇穴 88');
});

test('large loadout batches are bounded and cached negatives are not immediately re-requested', async t => {
  const cacheDir = await temp(t);
  const input = Array.from({ length: 101 }, (_, i) => ({ skillId: 50000 + i, level: 1 }));
  const sizes = [];
  const fetchImpl = async url => {
    sizes.push(/skill\.\[([^\]]+)\]/.exec(url)[1].split(',').length);
    return response([]);
  };
  const a = await resolveTalents(input, { cacheDir, fetchImpl });
  await resolveTalents(input, { cacheDir, fetchImpl });
  assert.deepEqual(sizes, [200, 2]);
  assert.equal(a.meta.networkRequests, 2);
  assert.equal(a.meta.status, 'partial');
});

test('readJclBattle returns resolved initial and changed loadouts; view and disable flags stay compatible', async t => {
  const cacheDir = await temp(t), file = path.join(cacheDir, 'sample.jcl');
  await fs.writeFile(file, fixture([[info('800000', '{{3,5891,1}}')], [info('800001', '{{4,18210,1}}'), 1002]]));
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    return response(url.includes('10080_0') ? [{ SkillID: 10080, Level: 0, Name: '云裳心经' }]
      : [{ SkillID: 5891, Level: 1, Name: '秋深', Desc: '说明' }, { SkillID: 18210, Level: 1, Name: '承清' }]);
  };
  const b = await readJclBattle(file, { cacheDir, fetchImpl });
  const card = toBattleViewModel(b).unassignedPlayers[0];
  assert.equal(b.schemaVersion, '1.5.0');
  assert.equal(calls, 2);
  assert.equal(card.kungfuName, '云裳心经');
  assert.equal(card.equipScoreText, '800,000');
  assert.equal(card.maxHpText, '2,000');
  assert.equal(card.talentSummary, '秋深');
  assert.equal(card.talents[0].description, '说明');
  assert.equal(card.talentSchemeChanged, true);
  assert.equal(card.equipScoreChanged, true);
  assert.equal(b.players[0].talentLoadout.changes[1].entries[0].name, '承清');
  const disabled = await readJclBattle(file, { cacheDir, fetchImpl, resolveKungfu: false, resolveTalents: false });
  assert.equal(calls, 2);
  assert.equal(disabled.talentCatalog.status, 'disabled');
  assert.equal(disabled.players[0].talents[0].label, '奇穴 5891');
});

test('real JCL matches all audited talent slots, scores, evidence and rendering fields offline', { skip: !process.env.JCL_TEST_FILE }, async () => {
  const b = await readJclBattle(process.env.JCL_TEST_FILE, { offline: true });
  const audit = JSON.parse(await fs.readFile(path.join(__dirname, '../analysis/jcl-2026-10-25-002043/talent_loadouts.json'), 'utf8'));
  const expectedScores = { '536943467': [804147, 50], '536878153': [825153, 59], '536953928': [825153, 65],
    '536952569': [825153, 77], '536949729': [825153, 82], '536951806': [824662, 104] };
  assert.equal(b.source.sha256, audit.source.sha256);
  assert.equal(b.catalog.networkRequests + b.talentCatalog.networkRequests, 0);
  const v = toBattleViewModel(b), cards = v.teams.flatMap(team => team.players);
  assert.equal(cards.length, 6);
  assert.equal(new Set(b.players.flatMap(p => p.talents.map(t => t.skillId))).size, 53);
  for (const p of b.players) {
    const old = audit.players.find(a => a.id === p.id), card = cards.find(c => c.id === p.id);
    assert.deepEqual([p.equipScore, p.equipScoreEvidence.line], expectedScores[p.id]);
    assert.equal(p.talents.length, 9);
    assert.equal(p.talentLoadout.evidence.line, old.variants[0].firstLine);
    assert.equal(p.talentLoadout.changes.length, 1);
    assert.equal(p.talentLoadout.changes[0].observationCount, old.variants[0].observationCount);
    for (const [i, talent] of p.talents.entries()) {
      for (const key of ['slot', 'optionIndexRaw', 'skillId', 'level', 'name', 'description', 'nameResourceLevel', 'descriptionResourceLevel']) {
        assert.equal(talent[key], old.variants[0].talents[i][key], `${p.name} slot ${i + 1} ${key}`);
      }
    }
    assert.equal(card.talentSummary, old.variants[0].talents.map(t => t.name).join('、'));
    assert.equal(card.talentStatus, 'recorded');
    assert.equal(card.talents.length, 9);
    assert.equal(card.equipScore, p.equipScore);
    assert.equal(card.maxHp, p.health.initialMaxHp);
  }
});
