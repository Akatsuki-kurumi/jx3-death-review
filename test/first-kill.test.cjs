'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeJcl, toBattleViewModel } = require('../lib/jcl/battle.cjs');

const info = (id, name, guid) => `{${id},"${name}",5,10080,800000,{},{},"${guid}"}`;
const log = events => events.map(([type, data, ms], i) => `0\t${i + 1}\t1792858843\t${ms}\t${type}\t${data}`).join('\n');
const roster = [[4, info(1, '甲', '100000000000000001'), 900], [4, info(2, '乙', '100000000000000002'), 900]];
const cards = b => { const v = toBattleViewModel(b); return [...v.teams.flatMap(t => t.players), ...v.unassignedPlayers]; };

test('first kill excludes pre-start, NPC and post-end deaths and preserves event order', () => {
  const b = analyzeJcl(log([...roster, [28, '{1,2}', 1000], [1, '{true,"one"}', 1000],
    [28, '{999,2}', 1100], [28, '{2,1}', 1200], [28, '{1,2}', 1200],
    [1, '{false,"one"}', 1400], [28, '{1,2}', 1500]]));
  assert.equal(b.firstKill.victim.playerId, '2');
  assert.equal(b.firstKill.killer.playerId, '1');
  assert.equal(b.firstKill.evidence.line, 6);
  assert.equal(b.firstKill.evidence.atMs, 200);
  const view = toBattleViewModel(b);
  assert.equal(view.firstKill.text, '开战后 0.200 秒，甲 击杀了 乙。');
  assert.deepEqual(cards(b).filter(p => p.isFirstKillVictim).map(p => p.id), ['2']);
});

test('only non-player deaths or zero health do not mark a player as killed', () => {
  const b = analyzeJcl(log([...roster, [28, '{1,2}', 950], [1, '{true,"one"}', 1000],
    [5, '{1,true,0,2000,100,100}', 1100], [28, '{999,1}', 1200],
    [1, '{false,"one"}', 1400], [28, '{1,2}', 1500]]));
  const v = toBattleViewModel(b);
  assert.equal(b.firstKill, null);
  assert.equal(v.firstKill.status, 'none');
  assert.equal(v.firstKill.canAnalyze, false);
  assert.equal(v.firstKill.text, '本局未记录玩家击杀事件。');
  assert.ok(cards(b).every(p => !p.isFirstKillVictim));
});

test('death under a new entity ID marks the same GUID card and retains the raw entity ID', () => {
  const b = analyzeJcl(log([...roster, [1, '{true,"one"}', 1000], [5, '{1,true,2000,2000,100,100}', 1100],
    [4, info(99, '甲', '100000000000000001'), 1200], [28, '{99,2}', 1300]]));
  assert.equal(b.players.length, 2);
  assert.equal(b.firstKill.victim.playerId, '1');
  assert.equal(b.firstKill.victim.entityId, '99');
  assert.deepEqual(cards(b).filter(p => p.isFirstKillVictim).map(p => p.id), ['1']);
});

test('unknown killer uses the recorded ID without attributing pets or guessing from damage', () => {
  for (const [id, expected] of [[0, '日志未记明击杀者'], [999, '击杀者 ID 999 击杀了 甲']]) {
    const b = analyzeJcl(log([...roster, [1, '{true,"one"}', 1000],
      [21, '{2,1,0,1,123,1,false,3,{[13]=100}}', 1100], [28, `{1,${id}}`, 246230]]));
    const v = toBattleViewModel(b);
    assert.equal(v.firstKill.atMs, 245230);
    assert.equal(v.firstKill.elapsedText, '4 分 5.230 秒');
    assert.equal(v.firstKill.killerPlayerId, null);
    assert.ok(v.firstKill.text.includes(expected));
    assert.equal(v.firstKill.canAnalyze, true);
  }
});

test('selected battle reports its own first kill without leaking a previous match', () => {
  const input = log([...roster, [1, '{true,"one"}', 1000], [28, '{1,2}', 1100], [1, '{false,"one"}', 1200],
    [4, info(1, '甲', '100000000000000001'), 1900], [4, info(2, '乙', '100000000000000002'), 1900],
    [1, '{true,"two"}', 2000], [28, '{2,1}', 2200], [1, '{false,"two"}', 2300]]);
  const second = analyzeJcl(input, { battleIndex: 1 });
  assert.equal(second.firstKill.victim.playerId, '2');
  assert.equal(second.firstKill.evidence.atMs, 200);
  assert.equal(second.firstKill.evidence.line, 9);
});

test('next battle start ends the selection even if the first battle has no end marker', () => {
  const input = log([...roster, [1, '{true,"one"}', 1000], [5, '{1,true,2000,2000,100,100}', 1100],
    [1, '{true,"two"}', 2000], [28, '{1,2}', 2100]]);
  const first = analyzeJcl(input);
  assert.equal(first.firstKill, null);
  assert.equal(toBattleViewModel(first).firstKill.status, 'none');
});

test('old summaries missing firstKill stay unavailable rather than claiming no kill', () => {
  const summary = analyzeJcl(log([...roster, [1, '{true,"one"}', 1000], [28, '{1,2}', 1100]]));
  delete summary.firstKill;
  const view = toBattleViewModel(summary);
  assert.equal(view.firstKill.status, 'unavailable');
  assert.equal(view.firstKill.canAnalyze, false);
  assert.ok(view.firstKill.text.includes('击杀信息暂不可用'));
  assert.ok([...view.teams.flatMap(t => t.players), ...view.unassignedPlayers].every(p => !p.isFirstKillVictim));
});
