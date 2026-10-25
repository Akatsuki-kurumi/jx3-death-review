const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cards = script.slice(script.indexOf('function iconControl('), script.indexOf('function renderBattlePage('));
const loader = script.slice(script.indexOf('async function loadBattle('), script.indexOf('// Image failures'));
const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/battle-view.synthetic.json'), 'utf8'));

function context(extra = {}) {
  const scope = vm.createContext({
    escapeHTML: value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    ...extra,
  });
  vm.runInContext(cards, scope);
  return scope;
}

test('synthetic example renders both teams, six players and backfill evidence', () => {
  const output = context().battleTeams(example);
  assert.equal((output.match(/<article /g) || []).length, 6);
  for (const team of example.teams) for (const player of team.players) {
    assert(output.includes(player.kungfuName));
    assert(output.includes(player.maxHpText));
    assert(output.includes(player.equipScoreText));
  }
  assert(output.includes('后续记录补齐'));
  assert(output.includes('双方分队由战斗关系推断'));
  assert(!output.includes('胜利'));
});

test('unknown team stays unassigned; unknown hp is not zero or a death state', () => {
  const player = { ...example.teams[0].players[0], maxHp: null, maxHpText: '未知', maxHpStatus: 'unknown' };
  const output = context().battleTeams({ teamStatus: 'unknown', teams: [], unassignedPlayers: [player] });
  assert(output.includes('分队未知'));
  assert(output.includes('未分组玩家'));
  assert(output.includes('最大血量未知'));
  assert(output.includes('class="hp-value">未知</span>'));
  assert(!output.includes('team-friendly'));
  assert(!output.includes('死亡'));
});

test('prior snapshots and inconsistent values retain their evidence', () => {
  const output = context().playerCard({ ...example.teams[0].players[0], maxHpStatus: 'prior_snapshot', maxHpNote: '入战前快照', hpSnapshotInconsistent: true });
  assert(output.includes('入战前快照'));
  assert(output.includes('快照有差异'));
  assert(output.includes(example.teams[0].players[0].maxHpText));
});

test('log and external names are escaped, including fallback kungfu names', () => {
  const output = context().playerCard({ ...example.teams[0].players[0], name: '<img src=x onerror=alert(1)>', kungfuName: '心法 99999<script>' });
  assert(!output.includes('<img src=x'));
  assert(!output.includes('<script>'));
  assert(output.includes('&lt;img'));
  assert(output.includes('心法 99999&lt;script&gt;'));
});

test('first kill banner precedes teams and only the recorded victim is grayscale with a label', () => {
  const view = structuredClone(example);
  const victim = view.teams[1].players[0];
  for (const team of view.teams) for (const p of team.players) p.isFirstKillVictim = p.id === victim.id;
  view.firstKill = { status: 'recorded', canAnalyze: true, text: '开战后 4 分 5.230 秒，甲 击杀了 乙。' };
  const output = context().battleTeams(view);
  assert(output.indexOf('kill-overview') < output.indexOf('team-grid'));
  assert(output.includes(view.firstKill.text));
  assert.equal((output.match(/class="death-badge"/g) || []).length, 1);
  assert.equal((output.match(/class="player-card[^\"]* is-killed"/g) || []).length, 1);
  assert(output.includes('被击杀</span>'));
  assert(output.includes('kill-analysis-button" disabled'));
  assert(output.includes('id="kill-analysis-note">正在准备</small>'));
  assert(html.includes('.player-card.is-killed{filter:grayscale(1)'));
});

test('unassigned victim keeps the unique death mark without inventing teams', () => {
  const players = example.teams.flatMap(t => t.players).map((p, index) => ({ ...p, isFirstKillVictim: index === 2 }));
  const output = context().battleTeams({ teamStatus: 'unknown', teams: [], unassignedPlayers: players,
    firstKill: { status: 'recorded', canAnalyze: true, text: '开战后 1.000 秒，甲 击杀了 乙。' } });
  assert(output.includes('未分组玩家'));
  assert(!output.includes('team-friendly'));
  assert.equal((output.match(/class="death-badge"/g) || []).length, 1);
  assert.equal((output.match(/class="player-card[^\"]* is-killed"/g) || []).length, 1);
});

test('missing firstKill is unavailable, not no-kill; canAnalyze never enables internal analysis', () => {
  const scope = context();
  for (const firstKill of [undefined, null, { status: 'unavailable' }]) {
    const output = scope.firstKillBanner(firstKill);
    assert(output.includes('击杀信息暂不可用'));
    assert(!output.includes('本局未记录玩家击杀事件'));
    assert(!output.includes('kill-analysis-button'));
  }
  assert(!scope.firstKillBanner({ status: 'recorded', canAnalyze: false, text: '已记录击杀' }).includes('kill-analysis-button'));
  const entry = scope.firstKillBanner({ status: 'recorded', canAnalyze: true, text: '已记录击杀' });
  assert(entry.includes('kill-analysis-button" disabled'));
  assert(!entry.includes('onclick'));
});

test('no-kill banner omits analysis button and leaves every card in color, including unassigned teams', () => {
  const players = example.teams.flatMap(t => t.players).map(p => ({ ...p, isFirstKillVictim: false }));
  const output = context().battleTeams({ teamStatus: 'unknown', teams: [], unassignedPlayers: players,
    firstKill: { status: 'none', text: '本局未记录玩家击杀事件。' } });
  assert(output.includes('本局未记录玩家击杀事件。'));
  assert(!output.includes('kill-analysis-button'));
  assert(!output.includes('is-killed'));
  assert(!output.includes('death-badge'));
  const hostile = context().firstKillBanner({ status: 'recorded', text: '<script>恶意名字</script>' });
  assert(!hostile.includes('<script>'));
  assert(hostile.includes('&lt;script&gt;'));
});

function asyncContext() {
  const elements = { 'battle-body': { innerHTML: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }, 'retry-battle': {} };
  const requests = [];
  const scope = context({
    battleRequest: 0, battleController: null, activeBattle: null, path: 'D:\\logs', finished: true, AbortController,
    $: id => elements[id], bindCardMedia: () => {}, clearReplay: () => {}, attachReplay: () => {},
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  vm.runInContext(loader, scope);
  return { scope, requests, elements };
}

test('switching battles ignores delayed old response and uses original filename', async () => {
  const { scope, requests, elements } = asyncContext();
  const old = { filename: 'a-目标.jcl' }, latest = { filename: 'b-目标.jcl' };
  scope.activeBattle = old;
  const oldPromise = scope.loadBattle(old);
  scope.activeBattle = latest;
  const newPromise = scope.loadBattle(latest);
  assert.equal(JSON.parse(requests[1].options.body).filename, latest.filename);
  assert.equal(requests[0].options.signal.aborted, true);
  const view = { teamStatus: 'unknown', teams: [], unassignedPlayers: [{ ...example.teams[0].players[0], name: '新对局' }] };
  requests[1].resolve({ ok: true, json: async () => ({ view }) });
  await newPromise;
  requests[0].resolve({ ok: true, json: async () => ({ view: example }) });
  await oldPromise;
  assert(elements['battle-body'].innerHTML.includes('新对局'));
  assert(!elements['battle-body'].innerHTML.includes(example.teams[0].players[0].name));
  assert.equal(elements['battle-body'].attributes['aria-busy'], 'false');
});

test('leaving detail ignores in-flight response; failure offers escaped retry', async () => {
  const { scope, requests, elements } = asyncContext();
  const record = { filename: 'a.jcl' };
  scope.activeBattle = record;
  const pending = scope.loadBattle(record);
  scope.finished = false;
  elements['battle-body'].innerHTML = '开始界面';
  requests[0].resolve({ ok: true, json: async () => ({ view: example }) });
  await pending;
  assert.equal(elements['battle-body'].innerHTML, '开始界面');
  scope.finished = true;
  const failed = scope.loadBattle(record);
  requests[1].resolve({ ok: false, json: async () => ({ error: '读取失败 <script>' }) });
  await failed;
  assert(elements['battle-body'].innerHTML.includes('读取失败 &lt;script&gt;'));
  assert.equal(typeof elements['retry-battle'].onclick, 'function');
});

test('gear score is the main value, health follows below, unknown and explicit zero stay distinct', () => {
  const scope = context();
  const player = example.teams[0].players[0];
  const output = scope.playerCard(player);
  assert(output.includes(`class="score-value">${player.equipScoreText}</strong>`));
  assert(output.indexOf('score-value') < output.indexOf('health-line'));
  assert(output.includes(`class="hp-value">${player.maxHpText}</span>`));
  assert(scope.playerCard({ ...player, equipScore: 0, equipScoreText: '0' }).includes('class="score-value">0</strong>'));
  const missing = scope.playerCard({ ...player, equipScore: null, equipScoreText: '未知', maxHp: null, maxHpText: '未知', talents: [], talentStatus: 'unknown' });
  assert(missing.includes('value-unknown">未知</strong>'));
  assert(missing.includes('class="hp-value">未知</span>'));
  assert(missing.includes('奇穴未知'));
});

test('talents retain variable count, order, incomplete and changed scheme indicators', () => {
  const player = { ...example.teams[0].players[0], talents: Array.from({ length: 12 }, (_, i) => ({ label: `奇穴 ${1000 + i}`, iconUrl: null })), talentStatus: 'partial', talentSchemeChanged: true };
  const output = context().playerCard(player);
  assert.equal((output.match(/class="card-icon talent-icon/g) || []).length, 12);
  let previous = -1;
  for (const talent of player.talents) { const next = output.indexOf(`aria-label="${talent.label}"`); assert(next > previous); previous = next; }
  assert(output.includes('奇穴记录不完整'));
  assert(output.includes('日志中有方案变化'));
});

test('icons use only exact local cache URLs and preserve label and complete escaped description', () => {
  const scope = context();
  const description = '<SUB 123 1>\n<NounID 13> & 完整说明'.repeat(80);
  const output = scope.iconControl({ url: '/api/icons/std/7170.png?offline=1', label: '奇穴 123', description, references: true });
  assert(output.includes('src="/api/icons/std/7170.png?offline=1"'));
  assert(output.includes('data-icon-description="' + scope.escapeHTML(description) + '"'));
  assert(output.includes('data-icon-references="true"'));
  assert(!output.includes('<SUB'));
  for (const url of [null, 'https://example.com/a.png', '//example.com/a.png', '/api/icons/std/7170.png?t=1']) {
    const fallback = scope.iconControl({ url, label: '未知名称的 ID', description: null });
    assert(!fallback.includes('<img'));
    assert(fallback.includes('暂无详细说明'));
    assert(fallback.includes('未知名称的 ID'));
  }
});

test('failed cached image switches to text once without changing src or retrying', () => {
  const scope = context();
  const interactions = script.slice(script.indexOf('// Image failures'), script.indexOf('\ninitIconTooltip();'));
  vm.runInContext(interactions, scope);
  let removed = 0;
  const fallback = { hidden: true }, classes = new Set();
  const control = { classList: { add: value => classes.add(value) }, querySelector: () => fallback };
  const image = { complete: false, naturalWidth: 0, closest: () => control, remove: () => removed++ };
  Object.defineProperty(image, 'src', { set() { assert.fail('Must not assign a new src or retry'); } });
  const root = { querySelectorAll: selector => selector.endsWith('img') ? [image] : [control] };
  scope.bindCardMedia(root);
  image.onerror();
  assert.equal(removed, 1);
  assert.equal(image.onerror, null);
  assert.equal(fallback.hidden, false);
  assert(classes.has('icon-fallback'));
  assert.equal(typeof control.onmouseenter, 'function');
  assert.equal(typeof control.onfocus, 'function');
});
