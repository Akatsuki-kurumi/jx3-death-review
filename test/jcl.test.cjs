'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { LuaReader, parseJcl } = require('../lib/jcl/lua-literal.cjs');
const { analyzeJcl, toBattleViewModel, readJclBattle } = require('../lib/jcl/battle.cjs');
const { resolveKungfu } = require('../lib/jcl/kungfu.cjs');

function fixture(extra = [], settings = {}) {
  let n = 0;
  const rows = [];
  const row = (event, data, ms = 1000 + n) => { rows.push(`0\t${++n}\t1792858843\t${ms}\t${event}\t${data}`); };
  row(1, '{true,"test::U900000000000000001/1",0,127}', 1000);
  for (let i = 1; i <= 6; i++) {
    row(4, `{${i},"玩家${i}",5,10080,1,{},{},"90000000000000000${i}"}`, 1001);
  }
  for (let i = 1; i <= 6; i++) {
    row(5, settings.invalidPlayer === i ? `{${i},true,255,255,1073741823,0}` : `{${i},true,2000,2000,100,100}`, 1010);
  }
  if (!settings.noRelations) {
    for (let i = 1; i <= 3; i++) for (let j = 4; j <= 6; j++) row(21, `{${i},${j},0,1,123,1,false,3,{[0]=50,[13]=50,[14]=0}}`, 1020);
  }
  for (const e of extra) row(...e);
  return rows.join('\n') + '\n';
}

async function removeTestDir(directory) {
  const resolved = path.resolve(directory), root = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(resolved.startsWith(root) && /^jcl-/.test(path.basename(resolved)));
  await fs.rm(resolved, { recursive: true, force: true });
}

test('data-only reader preserves long IDs, nesting and escapes; rejects code', () => {
  const d = new LuaReader('{123,"a\\n中",true,[9]={false},guid=900000000000000123}').parse();
  assert.equal(d.guid, '900000000000000123');
  assert.equal(d[2], 'a\n中');
  assert.equal(d[9][1], false);
  for (const bad of ['{os.execute("x")}', '{}; process.exit()', '{[1]=1,[1]=2}', '{true} garbage']) {
    assert.throws(() => new LuaReader(bad).parse());
  }
  const hostile = new LuaReader('{["__proto__"]={polluted=true}}').parse();
  assert.equal(Object.getPrototypeOf(hostile), null);
  assert.equal({}.polluted, undefined);
});

test('six players resolve into two teams from combat relations; recorder determines perspective', () => {
  const b = analyzeJcl(fixture());
  assert.equal(b.source.parseErrorCount, 0);
  assert.deepEqual(b.teams[0].playerIds, ['1', '2', '3']);
  assert.deepEqual(b.teams[1].playerIds, ['4', '5', '6']);
  assert.equal(b.teams[0].label, '我方');
  assert.equal(b.players[0].guid, '900000000000000001');
  assert.equal(b.players[0].health.maxHpOnCombatEntry, 2000);
  assert.equal(toBattleViewModel(b).teams[0].players[0].maxHpText, '2,000');
});

test('enemy heals do not overturn a unique damage partition; evidence remains visible', () => {
  const b = analyzeJcl(fixture([[21, '{1,4,0,1,5,1,false,3,{[6]=100,[14]=100}}', 1030]]));
  assert.equal(b.teamAnalysis.status, 'inferred');
  assert.equal(b.teamAnalysis.opposingHealingEventCount, 1);
  assert.ok(b.warnings.some(w => w.code === 'OPPOSING_HEALING_EVENTS'));
});

test('contradictory damage and missing relations remain unassigned', () => {
  const b = analyzeJcl(fixture([[21, '{1,2,0,1,5,1,false,3,{[0]=100,[13]=100}}', 1030]]));
  assert.equal(b.teamAnalysis.reason, 'CONFLICTING_DAMAGE_RELATIONS');
  assert.equal(toBattleViewModel(b).unassignedPlayers.length, 6);
  assert.equal(analyzeJcl(fixture([], { noRelations: true })).teamAnalysis.status, 'unknown');
});

test('heal relations can disambiguate disconnected damage groups', () => {
  const b = analyzeJcl(fixture([
    [21, '{1,4,0,1,5,1,false,3,{[13]=100}}', 1030],
    [21, '{1,2,0,1,5,1,false,3,{[6]=100}}', 1030],
    [21, '{1,3,0,1,5,1,false,3,{[6]=100}}', 1030],
    [21, '{4,5,0,1,5,1,false,3,{[6]=100}}', 1030],
    [21, '{4,6,0,1,5,1,false,3,{[6]=100}}', 1030],
  ], { noRelations: true }));
  assert.deepEqual(b.teams[0].playerIds, ['1', '2', '3']);
  assert.equal(b.teamAnalysis.usedHealingToDisambiguate, true);
});

test('placeholder entry HP is not treated as 255; later evidence is marked as backfill', () => {
  const b = analyzeJcl(fixture([
    [29, '{4,1,0,0,0,0,1800,2000,100,100,0}', 1500],
    [5, '{1,false,1900,2000,100,100}', 1600],
  ], { invalidPlayer: 1 }));
  const h = b.players[0].health;
  assert.equal(h.maxHpOnCombatEntry, null);
  assert.equal(h.initialMaxHp, 2000);
  assert.equal(h.initialMaxHpStatus, 'later_snapshot');
  assert.equal(h.initialMaxHpOffsetMs, 490);
  assert.equal(h.initialMaxHpEvidence.eventType, 29);
  assert.equal(h.invalidSnapshotCount, 1);
});

test('unverified coordinate extensions, post-death observations and late observations do not fabricate entry HP', () => {
  const unknownLocation = analyzeJcl(fixture([[29, '{4,1,0,0,0,0,1800,2000,100,100,0}', 1500]], { invalidPlayer: 1 }));
  assert.equal(unknownLocation.players[0].health.initialMaxHp, null);
  const dead = analyzeJcl(fixture([[28, '{1,4}', 1400], [5, '{1,false,0,2000,100,100}', 1500]], { invalidPlayer: 1 }));
  assert.equal(dead.players[0].health.initialMaxHp, null);
  const late = analyzeJcl(fixture([[5, '{1,false,1900,2000,100,100}', 60000]], { invalidPlayer: 1 }));
  assert.equal(late.players[0].health.initialMaxHp, null);
  assert.equal(late.players[0].health.firstValidObservation.value, 2000);
  assert.equal(toBattleViewModel(late).teams[0].players[0].maxHpText, '未知');
});

test('explicit maximum is preserved with a quality flag when current HP exceeds it', () => {
  const b = analyzeJcl(fixture().replace('{1,true,2000,2000,100,100}', '{1,true,2100,2000,100,100}'));
  assert.equal(b.players[0].health.maxHpOnCombatEntry, 2000);
  assert.equal(b.players[0].health.initialSnapshotInconsistent, true);
  assert.ok(b.warnings.some(w => w.code === 'HP_SNAPSHOT_INCONSISTENT'));
});

test('same GUID with a new entity ID is one player, and later max HP changes are retained', () => {
  const b = analyzeJcl(fixture([
    [5, '{1,false,0,1800,100,100}', 2000],
    [4, '{99,"玩家1",5,10080,1,{},{},"900000000000000001"}', 2100],
    [29, '{4,99,0,0,0,0,1073741823,2000,1073741823,100,0}', 2200],
  ]));
  assert.equal(b.players.length, 6);
  assert.deepEqual(b.players[0].entityIds, ['1', '99']);
  assert.deepEqual(b.players[0].health.maxHpChanges.map(s => s.value), [2000, 1800]);
});

test('initial blank name and kungfu -1 are replaced by subsequent valid metadata', () => {
  const input = fixture([[4, '{1,"正确名字",5,10080,1,{},{},"900000000000000001"}', 1500]])
    .replace('{1,"玩家1",5,10080', '{1,"",0,-1');
  const p = analyzeJcl(input).players[0];
  assert.equal(p.name, '正确名字');
  assert.equal(p.kungfuId, 10080);
  assert.equal(p.kungfuEvidence.atMs, 500);
});

test('multi-battle files are selected explicitly without mixing players', () => {
  const first = fixture() + '0\t50\t1\t1900\t1\t{false,"one",900}\n';
  const second = fixture().split('\n').filter(Boolean).map(line => {
    const c = line.split('\t'); c[3] = String(Number(c[3]) + 2000); c[5] = c[5].replaceAll('玩家', '第二场'); return c.join('\t');
  }).join('\n');
  const b = analyzeJcl(first + second, { battleIndex: 1 });
  assert.equal(b.battle.battleCount, 2);
  assert.equal(b.players.length, 6);
  assert.ok(b.players.every(p => p.name.startsWith('第二场')));
  assert.throws(() => analyzeJcl(first + second, { battleIndex: 2 }));
});

test('corrupt lines are reported without executing their contents; missing start fails explicitly', () => {
  const input = fixture() + '0\t1\t1\t2000\t4\t{process.exit()}\n';
  assert.equal(parseJcl(input).totalErrors, 1);
  assert.equal(analyzeJcl(input).teamAnalysis.confidence, 'limited_by_parse_errors');
  assert.throws(() => analyzeJcl('0\t1\t1\t1\t4\t{1,"x"}'));
});

test('kungfu names use one batch, persistent cache, negative cache and concurrent request deduplication', async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcl-catalog-'));
  t.after(() => removeTestDir(cacheDir));
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.ok(url.includes('10080_0,10080_1,10786_0,10786_1,99999_0,99999_1'));
    assert.ok(!url.includes('玩家'));
    return { ok: true, text: async () => JSON.stringify([
      { SkillID: 10080, Level: 0, Name: '云裳心经', IconID: 887 },
      { SkillID: 10786, Level: 1, Name: '周天功', IconID: 22823 },
    ]) };
  };
  const [a, b] = await Promise.all([resolveKungfu([10080, 10786, 99999], { cacheDir, fetchImpl }), resolveKungfu([10080, 10786, 99999], { cacheDir, fetchImpl })]);
  assert.equal(calls, 1);
  assert.equal(a.entries[10786].name, '周天功');
  assert.equal(b.entries[99999].label, '心法 99999');
  const offline = await resolveKungfu([10080, 12345], { cacheDir, offline: true, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(offline.entries[10080].name, '云裳心经');
  assert.equal(offline.entries[12345].name, null);
});

test('API failure degrades to IDs without breaking the local battle result', async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcl-failure-'));
  t.after(() => removeTestDir(cacheDir));
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('offline'); };
  const a = await resolveKungfu([10080], { cacheDir, fetchImpl });
  const b = await resolveKungfu([10080], { cacheDir, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(a.entries[10080].name, null);
  assert.equal(b.entries[10080].label, '心法 10080');
});

test('preview list and battle HTTP endpoint return the rendering model; unsafe paths and foreign origins are rejected', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcl-http-'));
  t.after(() => removeTestDir(dir));
  const filename = '2026-10-25-00-00-00-测试地图(1)-(2).jcl';
  await fs.writeFile(path.join(dir, filename), fixture().replace('{1,"玩家1",5,10080,1,{},{}', '{1,"玩家1",5,10080,825153,{},{{3,5891,1}}'));
  const { createServer } = require('../preview-server.cjs');
  const server = createServer({ port: 4174 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (endpoint, body, origin = 'http://127.0.0.1:4174') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: endpoint, method: 'POST',
      headers: { Host: '127.0.0.1:4174', Origin: origin, 'X-Preview-Client': 'jx3', 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const list = await request('/api/records', { directory: dir });
  assert.equal(list.data.records[0].filename, filename);
  const detail = await request('/api/battle', { directory: dir, filename, offline: true });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.view.teams[0].players.length, 3);
  const card = detail.data.view.teams[0].players[0];
  assert.equal(detail.data.view.schemaVersion, '1.5.0');
  assert(detail.data.killAnalysis);
  assert.equal(card.equipScore, 825153);
  assert.equal(card.equipScoreText, '825,153');
  assert.equal(card.talents[0].skillId, 5891);
  assert.equal(card.talentStatus, 'recorded');
  assert.equal(card.maxHpText, '2,000');
  assert.equal(typeof card.kungfuName, 'string');
  assert.equal((await request('/api/battle', { directory: dir, filename: '..\\secret.jcl' })).status, 400);
  assert.equal((await request('/api/battle', { directory: dir, filename }, 'https://example.com')).status, 403);
  assert.equal((await request('/api/battle', { directory: dir, filename }, 'http://127.0.0.1:4173')).status, 403);
});

test('supplied real JCL reproduces audited roster, HP and line numbers', { skip: !process.env.JCL_TEST_FILE }, async () => {
  const b = await readJclBattle(process.env.JCL_TEST_FILE, { offline: true });
  assert.equal(b.source.sha256, '4ee8492051e8e5ed0d24e4fdbbf0f72ae8e5b5e4c5c5ba345300ffcc2244dd68');
  assert.equal(b.source.encoding, 'gb18030');
  assert.equal(b.source.parsedEventCount, 29403);
  assert.equal(b.source.parseErrorCount, 0);
  assert.equal(b.players.length, 6);
  assert.deepEqual(b.teams[0].playerIds, ['536952569', '536949729', '536951806']);
  const gy = b.players.find(p => p.id === '536953928');
  assert.equal(gy.health.maxHpOnCombatEntry, 3426821);
  assert.equal(gy.health.initialMaxHpEvidence.line, 673);
  assert.equal(gy.health.maxHpChanges.at(-1).value, 3422701);
  for (const [id, hp, line, offset] of [['536952569', 3427926, 1827, 6732], ['536949729', 3422701, 826, 726]]) {
    const p = b.players.find(p => p.id === id);
    assert.equal(p.health.maxHpOnCombatEntry, null);
    assert.equal(p.health.initialMaxHp, hp);
    assert.equal(p.health.initialMaxHpEvidence.line, line);
    assert.equal(p.health.initialMaxHpOffsetMs, offset);
  }
});
