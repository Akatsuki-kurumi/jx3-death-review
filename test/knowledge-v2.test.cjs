'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const KB = require('../lib/ai/knowledge.cjs'), KP = require('../lib/ai/knowledge-policy.cjs');
const { hash, atomic, readJson } = require('../lib/ai/storage.cjs');
const { createTools } = require('../lib/ai/tools.cjs');
const { learn } = require('../lib/ai/experience-learning.cjs');
const { validateReportRefs } = require('../lib/ai/ref-validation.cjs');
const version = KP.versionFor('std').version;
async function store(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jx3-knowledge-v2-'));
  t.after(async () => { assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert(path.basename(dir).startsWith('jx3-knowledge-v2-')); await fs.rm(dir, { recursive: true, force: true }); });
  return KB.createKnowledgeStore({ baseDir: dir });
}
function experience(turnId, statement = '核对血量时应保留临死回血与状态移除的反证。', more = {}) {
  const r = KB.record({ kind: 'analysis_method', statement, origin: 'local:report-conversation:c:' + turnId, createdBy: { kind: 'model', id: turnId }, ...more });
  r.sources[0].kind = 'user_feedback'; return r;
}
function fact(more = {}) { return KB.record({ kind: 'mechanic', statement: '测试事实：只适用于该技能。', resourceKeys: [{ kind: 'skill', id: 1, level: 1 }], gameVersion: version, origin: 'local:maintainer-fixture', ...more }); }
function fixture() {
  const players = ['a', 'b'].map((id, i) => ({ id, name: '匿名' + i, teamId: i, entityIds: [id], health: [], positions: [] }));
  return { battle: { battle: { battleIndex: 0, startUnixSeconds: Date.parse('2026-11-01T00:00:00Z') / 1000 } }, view: { teams: [{ players }], unassignedPlayers: [] },
    replay: { source: { sha256: 'a'.repeat(64), parseErrors: 0 }, scope: {}, capabilities: {}, players,
      actors: { a: { kind: 'player', playerId: 'a' }, b: { kind: 'player', playerId: 'b' } },
      resources: { 'skill.1_1': { kind: 'skill', id: 1, level: 1, name: '测试技能' } },
      events: [{ atMs: 100, line: 1, eventType: 28, kind: 'death', actorKey: 'b', targetKey: 'a' }] },
    killAnalysis: { window: { status: 'ready', startAtMs: 0, buffStartAtMs: 0, killAtMs: 100, killLine: 1, victimId: 'a', healerIds: [] }, control: [], interference: {}, distance: { status: 'missing', points: [] }, obstacles: { hints: [] }, coverage: {}, warnings: [] } };
}
test('v1 migration preserves originals and IDs, separates feedback, archives model-only proposals', async t => {
  const s = await store(t), f = fact(), e = experience('old'), orphan = experience('orphan'); orphan.sources[0].kind = 'event';
  const deleted = experience('gone'); deleted.status = 'deprecated';
  const legacy = { version: 1, records: Object.fromEntries([f, e, orphan, deleted].map(r => [r.id, r])), history: [e], feedback: [{ recordId: e.id }] };
  for (const r of Object.values(legacy.records)) { delete r.collection; delete r.priority; }
  await atomic(path.join(s.base, 'state.json'), legacy);
  const snap = await s.snapshot(), list = await s.listExperiences();
  assert.equal(list.total, 1); assert.equal(list.records[0].id, e.id); assert.equal(list.records[0].priority, 'reference'); assert.equal(list.records[0].status, 'sourced');
  assert.equal(snap.records[f.id].collection, 'game_fact'); assert(!snap.records[orphan.id]); assert(!snap.records[deleted.id]);
  assert.equal(hash(await readJson(path.join(s.base, 'state.json'))), hash(legacy));
  assert.equal(hash(await readJson(path.join(s.base, 'migrations/v1-original.json'))), hash(legacy));
  const reopened = KB.createKnowledgeStore({ baseDir: s.base }); assert.equal((await reopened.listExperiences()).total, 1);
});
test('only facts importer can write facts; public edits/history never expose a fact ID', async t => {
  const s = await store(t), f = fact(); await s.addFacts([f]);
  await assert.rejects(s.addFacts([experience('x')]), e => e.code === 'FACT_WRITE_DENIED');
  await assert.rejects(s.history(f.id), e => e.status === 404);
  await assert.rejects(s.revise(f.id, { action: 'delete', expectedRevision: 1 }), e => e.status === 404);
  await s.clear(); assert((await s.snapshot()).records[f.id]); assert.equal((await s.listExperiences()).total, 0);
});
test('learning is idempotent by turn and normalized content; sourced experience is searchable by default', async t => {
  const s = await store(t), e = experience('one');
  assert.equal((await s.addExperiences([e], { turnId: 'one' })).added, 1);
  assert.equal((await s.addExperiences([e], { turnId: 'one' })).added, 0);
  assert.equal((await s.addExperiences([experience('two')], { turnId: 'two' })).added, 0);
  const found = s.search(await s.snapshot(), { collection: 'ai_experience' }); assert.equal(found.total, 1); assert.equal(found.records[0].applicability, 'unverified');
  await assert.rejects(s.addExperiences([experience('x')]), /对话/);
});
test('edit keeps provenance and reference weight, invalidates cache, and rejects stale or authority fields', async t => {
  const s = await store(t), e = experience('one'); await s.addExperiences([e], { turnId: 'one' });
  const before = await s.snapshot();
  const next = await s.revise(e.id, { action: 'correct', expectedRevision: 1, statement: '先核对来源，再核对触发条件。' });
  assert.equal(next.revision, 2); assert.equal(next.collection, 'ai_experience'); assert.equal(next.priority, 'reference'); assert.equal(next.review, null);
  assert.equal(next.createdBy.kind, 'model'); assert(next.sources.some(x => x.origin === 'local:experience-edit'));
  assert.notEqual((await s.snapshot()).hash, before.hash); assert.equal((await s.snapshot()).factsHash, before.factsHash);
  await assert.rejects(s.revise(e.id, { action: 'correct', expectedRevision: 1, statement: '旧编辑器内容' }), e => e.status === 409);
  await assert.rejects(s.revise(e.id, { action: 'correct', expectedRevision: 2, statement: '修改', status: 'verified' }));
  assert.equal((await s.addExperiences([experience('two')], { turnId: 'two' })).added, 0); // older wording cannot overwrite a user edit
});
test('delete survives restart and repeated learning; clear prevents in-flight resurrection', async t => {
  const s = await store(t), e = experience('one'); await s.addExperiences([e], { turnId: 'one' });
  await s.revise(e.id, { action: 'delete', expectedRevision: 1 });
  const reopened = KB.createKnowledgeStore({ baseDir: s.base }); assert.equal((await reopened.listExperiences()).total, 0);
  assert.equal((await reopened.addExperiences([experience('two')], { turnId: 'two' })).added, 0);
  const generation = await reopened.learningToken(); await reopened.clear();
  assert.equal((await reopened.addExperiences([experience('three', '另一条新经验。')], { turnId: 'three', generation })).added, 0);
  assert.equal((await reopened.addExperiences([experience('four', '之后新对话中的经验。')], { turnId: 'four', generation: await reopened.learningToken() })).added, 1);
});
test('facts sort before experiences; different season mechanics never become current facts', async t => {
  const s = await store(t), f = fact(), old = fact({ gameVersion: 'previous-season', statement: '过期事实' }); await s.addFacts([f, old]);
  await s.addExperiences([experience('new', '测试技能的机制反馈。', { kind: 'mechanic', resourceKeys: f.resourceKeys, gameVersion: version })], { turnId: 'new' });
  await s.addExperiences([experience('old', '旧赛季机制反馈。', { kind: 'mechanic', resourceKeys: f.resourceKeys, gameVersion: 'previous-season' })], { turnId: 'old' });
  const r = s.search(await s.snapshot(), { resourceKeys: f.resourceKeys }, { client: 'std', gameVersion: version });
  assert.equal(r.total, 2); assert.equal(r.records[0].collection, 'game_fact'); assert.equal(r.records[1].collection, 'ai_experience'); assert(!JSON.stringify(r).includes('旧赛季'));
  const oldBattle = fixture(); oldBattle.battle.battle.startUnixSeconds = Date.parse('2026-10-25T00:00:00Z') / 1000;
  assert(KP.battleContext(oldBattle).gameVersion.startsWith('historical-before:'));
});
test('context includes relevant facts and experience without relying on the model remembering a search', async t => {
  const s = await store(t), f = fact(); await s.addFacts([f]); await s.addExperiences([experience('one')], { turnId: 'one' });
  const tools = createTools(fixture(), await s.snapshot(), { offline: true }), c = await tools.execute('get_battle_context', {});
  assert(c.data.knowledge.gameFacts.some(r => r.id === f.id)); assert.equal(c.data.knowledge.aiExperiences.length, 1);
  assert.equal(c.data.knowledge.aiExperiences[0].priority, 'reference'); assert(c.data.knowledge.precedence.includes('不能覆盖'));
  const e = c.data.knowledge.aiExperiences[0], report = { claims: [{ id: 'c', level: 'inference', evidenceRefs: [c.data.kill.evidenceRef], mechanicRefs: [e.evidenceRef] }] };
  assert(validateReportRefs(report, tools.job, tools.ledger).errors.some(x => x.includes('experience_not_fact')));
});
test('real HTTP endpoints show only experience, forbid manual creation, protect mutations and revisions', async t => {
  const s = await store(t), f = fact(), e = experience('one'); await s.addFacts([f]); await s.addExperiences([e], { turnId: 'one' });
  const handle = require('../lib/ai/routes.cjs').routes({ knowledgeStore: s });
  const server = http.createServer((req, res) => handle(req, res, 'http://127.0.0.1:' + server.address().port));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port, headers = { 'X-Preview-Client': 'jx3', 'Content-Type': 'application/json', Origin: base };
  const post = (url, body, method = 'POST') => fetch(base + url, { method, headers, body: JSON.stringify(body) });
  const list = await (await post('/api/ai/knowledge/search', {})).json(); assert.equal(list.total, 1); assert.equal(list.records[0].id, e.id); assert.equal(list.capabilities.manualCreate, false);
  assert.equal((await fetch(base + '/api/ai/knowledge/' + f.id, { headers })).status, 404);
  assert.equal((await post('/api/ai/experiences', { statement: '手动新增' })).status, 405);
  assert.equal((await post('/api/ai/experiences/search', { collection: 'game_fact' })).status, 400);
  assert.equal((await fetch(base + '/api/ai/experiences/' + e.id, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(base + '/api/ai/experiences/search', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  assert.equal((await post('/api/ai/experiences/' + e.id, { action: 'correct', statement: '修订后的观察方法。', expectedRevision: 1 })).status, 200);
  assert.equal((await post('/api/ai/experiences/' + e.id, { expectedRevision: 1 }, 'DELETE')).status, 409);
  assert.equal((await post('/api/ai/experiences/' + e.id, { expectedRevision: 2 }, 'DELETE')).status, 200);
  assert.equal((await (await post('/api/ai/experiences/search', {})).json()).total, 0);
  assert((await s.snapshot()).records[f.id]);
});
test('extractor validates actual feedback, resource allowlist, secrets and schema before any write', async t => {
  const s = await store(t), tools = createTools(fixture(), await s.snapshot(), { offline: true });
  const run = async (id, items) => learn({ turn: { id, question: '应当核对临死回血和状态移除，不要忽略反证。 private-secret', answer: {} }, conversationId: 'chat', reportKey: 'report', report: {}, tools,
    store: s, config: { model: 'configured-model', apiKey: 'private-secret' }, generation: await s.learningToken(),
    sendModel: async (c, messages, o) => { o.onAttempt(); assert.equal(c.model, 'configured-model'); assert.equal(o.tools.length, 0); assert(!JSON.stringify(messages).includes('private-secret')); return { message: { content: JSON.stringify({ experiences: items }) } }; } });
  const item = { kind: 'analysis_method', statement: '核对临死回血与状态移除的反证。', feedbackQuote: '应当核对临死回血和状态移除', conditions: [], resourceKeys: [] };
  assert.equal((await run('one', [item])).status, 'saved');
  assert.equal((await run('two', [item])).status, 'skipped');
  assert.equal((await run('three', [{ ...item, feedbackQuote: '并不存在的反馈原文' }])).added, 0);
  assert.equal((await run('four', [{ ...item, resourceKeys: [{ kind: 'buff', id: 999, level: 1 }] }])).added, 0);
  await assert.rejects(run('five', [{ ...item, priority: 'primary' }]), e => e.code === 'LEARNING_FORMAT');
  assert.equal((await s.listExperiences()).total, 1);
});
