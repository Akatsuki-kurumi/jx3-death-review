'use strict';
const path = require('node:path');
const { root, hash, atomic, readJson, locked } = require('./storage.cjs');
const { knowledgeCheck, errors } = require('./validation.cjs');
const { isCurrentTalentTime } = require('../jcl/talent-cache-policy.cjs');
const { policy, versionFor, currentResource, precedence } = require('./knowledge-policy.cjs');
const pack = require('../../data/ai/game-facts.json');
const dict = require('../../data/buff-reference.json');
const gameplay = require('./gameplay-reference.cjs');
const sourceHash = hash([policy, pack, dict]);
const now = () => new Date().toISOString();
const inactive = r => ['deprecated', 'rejected', 'conflicted'].includes(r.status);
const fault = (code, message, status = 400) => Object.assign(Error(message), { code, status });
const isExperience = r => r.collection === 'ai_experience';
function record({ kind, statement, resourceKeys = [], origin, raw, client = 'std', status = 'sourced', createdBy = { kind: 'program', id: 'local-import-v2' }, conditions = [], collection, gameVersion = null, review = null }) {
  collection ||= createdBy.kind !== 'program' || status === 'candidate' ? 'ai_experience' : 'game_fact';
  const contentHash = hash(raw ?? statement), id = hash([collection, kind, client, gameVersion, resourceKeys, origin, contentHash]).slice(0, 24), at = now();
  const fetched = raw?.retrievedAt || raw?.fetchedAt;
  return { schemaVersion: 'jx3.ai-knowledge.v1', id, revision: 1, kind, statement: String(statement).slice(0, 1600), status, client, gameVersion,
    collection, priority: collection === 'game_fact' ? 'primary' : 'reference', validFrom: null, validTo: null, resourceKeys, conditions,
    ...(fetched ? { resourceFetchedAt: fetched } : {}),
    sources: [{ refId: 'source:' + contentHash, kind: kind === 'parser_rule' ? 'parser_rule' : 'resource', origin: String(origin).slice(0, 500), contentHash, retrievedAt: fetched || at }],
    createdBy, createdAt: at, updatedAt: at, review: review || (kind === 'parser_rule' && status === 'verified' ? { actorKind: 'maintained_rule', actorId: 'jcl-parser-v1', at, sourceRefs: ['source:' + contentHash], note: '解析规则，不证明游戏机制。' } : null), conflictsWith: [], supersedes: [] };
}
function applicability(r, context = {}) {
  if (inactive(r)) return 'mismatch';
  if (r.gameplayReference) return gameplay.applicability(r, context);
  if (r.kind === 'resource_description' && r.resourceKeys.some(k => k.kind === 'talent') && !isCurrentTalentTime(r.resourceFetchedAt)) return 'mismatch';
  if (r.client !== '*' && r.client !== 'unknown' && r.client !== (context.client || 'std')) return 'mismatch';
  if (r.gameVersion && r.gameVersion !== '*' && context.gameVersion && r.gameVersion !== context.gameVersion) return 'mismatch';
  if (isExperience(r)) return 'unverified';
  if (r.kind === 'parser_rule' && r.status === 'verified') return 'matched';
  return r.gameVersion && r.gameVersion === context.gameVersion && r.conditions.length === 0 && r.client === context.client ? 'matched' : 'unverified';
}
function search(snap, { query = '', resourceKeys = [], kind, includeCandidates = false, collection, limit = 15, offset = 0 } = {}, context = { client: 'std', gameVersion: null }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = Object.values(snap.records).filter(r => !inactive(r) && (!collection || r.collection === collection) && (!kind || r.kind === kind)
    && (includeCandidates || r.status !== 'candidate') && applicability(r, context) !== 'mismatch'
    && (!isExperience(r) || r.kind === 'analysis_method' || includeCandidates || (!!r.gameVersion && r.gameVersion === context.gameVersion)))
    .map(r => {
      const resourceMatch = resourceKeys.length && r.resourceKeys.some(k => resourceKeys.some(q => q.kind === k.kind && q.id === k.id && (q.level == null || q.level === k.level || (r.kind === 'monitor_tag' && k.level === 0))));
      const textMatch = words.length && words.some(w => r.statement.toLowerCase().includes(w));
      return { r, relevance: (resourceMatch ? 100 : 0) + (textMatch ? 20 : 0) };
    }).filter(x => (!resourceKeys.length && !words.length) || x.relevance >= 20)
    .sort((a, b) => Number(isExperience(a.r)) - Number(isExperience(b.r)) || b.relevance - a.relevance || a.r.id.localeCompare(b.r.id));
  return { total: rows.length, records: rows.slice(offset, offset + limit).map(({ r }) => ({ ...r, applicability: applicability(r, context) })) };
}
function fingerprint(r) { return hash([r.client, r.gameVersion, r.kind, [...r.resourceKeys].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), r.statement.normalize('NFKC').replace(/\s+/g, '').toLowerCase()]); }
function check(r) { if (!knowledgeCheck(r)) throw fault('KNOWLEDGE_SCHEMA', '知识结构错误：' + errors(knowledgeCheck).join(';')); }
function createKnowledgeStore({ baseDir = path.join(root, 'ai-knowledge') } = {}) {
  const factFile = path.join(baseDir, 'game-facts', 'state.json'), experienceFile = path.join(baseDir, 'ai-experiences', 'state.json');
  const legacyFile = path.join(baseDir, 'state.json'), lockKey = path.join(baseDir, 'knowledge-v2.lock');
  const empty = () => ({ version: 2, publishedRevision: 1, records: {}, history: [], feedback: [], tombstones: {}, fingerprints: {}, processedTurns: {}, generation: 0 });
  async function ensure() {
    let facts = await readJson(factFile), experience = await readJson(experienceFile);
    if (!facts || !experience) {
      const old = await readJson(legacyFile), backup = path.join(baseDir, 'migrations', 'v1-original.json');
      if (old && !await readJson(backup)) await atomic(backup, old);
      const f = empty(), e = empty();
      for (const original of Object.values(old?.records || {})) {
        if (!knowledgeCheck(original)) continue;
        if (original.createdBy.kind === 'model' && !original.sources.some(s => s.kind === 'user_feedback')) {
          (e.excludedLegacyCandidates ||= []).push(original.id); continue; // Preserved in the untouched v1 backup, not learned from a player.
        }
        const userOrigin = original.createdBy.kind !== 'program' || original.sources.some(s => s.kind === 'user_feedback');
        const r = { ...original, collection: userOrigin ? 'ai_experience' : 'game_fact', priority: userOrigin ? 'reference' : 'primary' };
        if (userOrigin) {
          r.review = null; if (!inactive(r)) r.status = 'sourced';
          e.fingerprints[fingerprint(r)] = r.id;
          if (['deprecated', 'rejected'].includes(r.status)) e.tombstones[r.id] = { at: now(), fingerprint: fingerprint(r) }; else e.records[r.id] = r;
        } else {
          if (!['parser_rule', 'monitor_tag'].includes(r.kind)) {
            const client = r.client === 'origin' ? 'origin' : 'std';
            r.gameVersion ||= currentResource({ retrievedAt: r.resourceFetchedAt }, client) ? versionFor(client).version : 'legacy-unversioned';
          }
          f.records[r.id] = r;
        }
      }
      const experienceIds = new Set([...Object.keys(e.records), ...Object.keys(e.tombstones)]);
      e.history = (old?.history || []).filter(r => experienceIds.has(r.id)); e.feedback = (old?.feedback || []).filter(r => experienceIds.has(r.recordId));
      e.migration = f.migration = { at: now(), from: old ? 1 : null, originalPreserved: !!old };
      if (!facts) { facts = f; await atomic(factFile, facts); }
      if (!experience) { experience = e; await atomic(experienceFile, experience); }
    }
    if (facts.packHash !== sourceHash) {
      for (const r of Object.values(facts.records)) if (!inactive(r) && r.createdBy.id === 'maintained-facts-v2') {
        facts.history.push(r); facts.records[r.id] = { ...r, status: 'deprecated', updatedAt: now() };
      }
      for (const r of Object.values(facts.records)) if (!inactive(r) && ['parser_rule', 'monitor_tag'].includes(r.kind) && r.sources.some(s => ['local:buff-reference', 'local:replay-rules'].includes(s.origin))) {
        facts.history.push(r); facts.records[r.id] = { ...r, status: 'deprecated', updatedAt: now() };
      }
      const records = [];
      for (const b of Object.values(dict.buffs)) for (const l of Object.values(b.levels)) records.push(record({ kind: 'monitor_tag',
        client: dict.client || 'unknown', gameVersion: dict.maintenance?.gameVersion || null,
        statement: (l.name || l.names.join(' / ') || `Buff ID ${b.id}`) + '：监控作者标签 ' + (l.categories || []).join('、') +
          '。来源声明版本：' + (dict.source.declaredVersions.join('、') || '未知') + '。维护者选用的分类参考，不等同官方机制或本局效果已发生。',
        resourceKeys: [{ kind: 'buff', id: b.id, level: l.level }], origin: 'local:buff-reference',
        raw: { sourceSha256: dict.source.sha256, declaredVersions: dict.source.declaredVersions, maintenance: dict.maintenance, definition: l },
        conditions: ['监控作者标签；具体机制与本局适用性仍需核对', '原始等级、叠层、心法及地图条件未由知识检索器逐项匹配；等级 0 只是监控通配候选'],
        createdBy: { kind: 'program', id: 'maintained-facts-v2' } }));
      records.push(record({ kind: 'parser_rule', client: '*', gameVersion: '*', status: 'verified', origin: 'local:replay-rules', statement: '事件 21 的 R13 是有效伤害、R14 是有效治疗。事件 27 仅生命变化，不归类为伤害。无血量快照不补 0；距离超过 20 尺只是显示阈值，不能直接解释为治疗不可达。', createdBy: { kind: 'program', id: 'maintained-facts-v2' } }));
      for (const item of pack.entries) {
        if (!['parser_rule', 'monitor_tag'].includes(item.kind) && !item.gameVersion) throw fault('FACT_VERSION_REQUIRED', '维护资料中的游戏事实必须标明版本。');
        records.push(record({ ...item, collection: 'game_fact', createdBy: { kind: 'program', id: 'maintained-facts-v2' } }));
      }
      for (const r of records) { check(r); facts.records[r.id] = r; }
      facts.packHash = sourceHash; facts.publishedRevision++; await atomic(factFile, facts);
    }
    if (facts.gameplayHash !== gameplay.fingerprint) {
      for (const r of Object.values(facts.records)) if (!inactive(r) && r.createdBy.id === 'maintained-gameplay-reference-v1') {
        facts.history.push(r); facts.records[r.id] = { ...r, status: 'deprecated', updatedAt: now() };
      }
      for (const r of gameplay.records(record)) { check(r); facts.records[r.id] = r; }
      facts.gameplayHash = gameplay.fingerprint; facts.publishedRevision++; await atomic(factFile, facts);
    }
    return { facts, experience };
  }
  async function seed() { return locked(lockKey, ensure); }
  async function snapshot() {
    const { facts, experience } = await seed(), records = { ...facts.records, ...experience.records };
    const factsHash = hash([policy, Object.values(facts.records)]), experienceHash = hash([experience.publishedRevision, experience.records]);
    return { revision: facts.publishedRevision + ':' + experience.publishedRevision, hash: hash([factsHash, experienceHash]), factsHash, experienceHash, policy, precedence, records };
  }
  async function addFacts(records, { signal } = {}) { return locked(lockKey, async () => {
    const { facts } = await ensure(); signal?.throwIfAborted(); let count = 0;
    for (const r of records) {
      check(r); if (isExperience(r) || r.createdBy.kind !== 'program') throw fault('FACT_WRITE_DENIED', '游戏事实只能由维护资料导入。', 403);
      if (!['parser_rule', 'monitor_tag'].includes(r.kind) && !r.gameVersion) throw fault('FACT_VERSION_REQUIRED', '游戏事实必须标明维护版本。');
      if (!facts.records[r.id]) {
        if (r.kind === 'resource_description') for (const previous of Object.values(facts.records)) {
          if (!inactive(previous) && previous.kind === r.kind && previous.client === r.client && previous.gameVersion === r.gameVersion && previous.createdBy.id === r.createdBy.id && hash(previous.resourceKeys) === hash(r.resourceKeys)) {
            facts.history.push(previous); facts.records[previous.id] = { ...previous, status: 'deprecated', updatedAt: now() };
          }
        }
        facts.records[r.id] = r; count++;
      }
    }
    if (count) { facts.publishedRevision++; signal?.throwIfAborted(); await atomic(factFile, facts); } return count;
  }); }
  async function learningToken() { const { experience } = await seed(); return experience.generation; }
  async function addExperiences(records, { signal, turnId, generation } = {}) { return locked(lockKey, async () => {
    const { experience: s } = await ensure(); signal?.throwIfAborted();
    if (!turnId) throw fault('EXPERIENCE_SOURCE_REQUIRED', '学习经验必须来自报告下的对话。');
    if (s.processedTurns[turnId] || (generation != null && generation !== s.generation)) return { added: 0, ids: [], skipped: true };
    const ids = []; let duplicates = 0;
    for (const original of records) {
      const r = { ...original, collection: 'ai_experience', priority: 'reference', status: 'sourced', review: null };
      check(r);
      if (r.createdBy.kind !== 'model' || r.createdBy.id !== turnId || !r.sources.some(x => x.kind === 'user_feedback' && x.origin.startsWith('local:report-conversation:'))) throw fault('EXPERIENCE_SOURCE_REQUIRED', '学习经验缺少对话来源。');
      const fp = fingerprint(r);
      if (s.tombstones[r.id] || s.fingerprints[fp] || s.records[r.id]) { duplicates++; continue; }
      s.records[r.id] = r; s.fingerprints[fp] = r.id; ids.push(r.id);
    }
    s.processedTurns[turnId] = { at: now(), ids, duplicates };
    if (ids.length) s.publishedRevision++;
    signal?.throwIfAborted(); await atomic(experienceFile, s); return { added: ids.length, ids, duplicates };
  }); }
  async function listExperiences({ query = '', offset = 0, limit = 30 } = {}) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fault('REQUEST', '请求中的搜索或分页参数不正确。');
    const { experience: s } = await seed(), rows = Object.values(s.records).filter(r => !['deprecated', 'rejected'].includes(r.status) && r.statement.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { schemaVersion: 'jx3.ai-experiences.v2', collection: 'ai_experience', revision: s.publishedRevision, total: rows.length, offset, limit, nextOffset: offset + limit < rows.length ? offset + limit : null, records: rows.slice(offset, offset + limit), capabilities: { manualCreate: false, edit: true, delete: true }, hint: '可在 AI 报告下与 AI 对话；有参考价值的反馈会自动整理为学习经验。' };
  }
  async function revise(id, input) { return locked(lockKey, async () => {
    const { experience: s } = await ensure(), old = s.records[id];
    if (!old) throw fault('NOT_FOUND', '学习经验不存在或已删除。', 404);
    if (!input || Object.keys(input).some(k => !['action', 'statement', 'note', 'expectedRevision'].includes(k)) || !['correct', 'delete', 'deactivate'].includes(input.action)) throw fault('REQUEST', '不支持此修改。');
    if (input.expectedRevision !== old.revision) throw fault('REVISION_CONFLICT', '这条经验已变更，请刷新后再操作。', 409);
    if (input.action === 'correct' && (typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 1600)) throw fault('REQUEST', '请填写 1–1600 字经验。');
    const at = now(); s.history.push(old);
    if (input.action !== 'correct') { s.tombstones[id] = { at, fingerprint: fingerprint(old) }; delete s.records[id]; }
    else {
      const next = { ...old, statement: input.statement.trim(), revision: old.revision + 1, status: 'sourced', review: null, updatedAt: at };
      next.sources = [...old.sources.slice(0, 19), { refId: 'feedback:' + id + ':r' + next.revision, kind: 'user_feedback', origin: 'local:experience-edit', contentHash: hash(next.statement), retrievedAt: at }];
      check(next); s.records[id] = next; s.fingerprints[fingerprint(next)] = id;
    }
    s.feedback.push({ recordId: id, action: input.action, at, beforeRevision: old.revision, note: String(input.note || '').slice(0, 800) }); s.publishedRevision++;
    await atomic(experienceFile, s); return s.records[id] || { id, deleted: true };
  }); }
  async function history(id) { const { experience: s } = await seed(); if (!s.records[id]) throw fault('NOT_FOUND', '学习经验不存在或已删除。', 404); return { record: s.records[id], history: s.history.filter(r => r.id === id), feedback: s.feedback.filter(r => r.recordId === id) }; }
  async function clear() { return locked(lockKey, async () => {
    const { experience: s } = await ensure(), count = Object.keys(s.records).length;
    for (const r of Object.values(s.records)) s.tombstones[r.id] = { at: now(), fingerprint: fingerprint(r) };
    s.records = {}; s.history = []; s.feedback = []; s.generation++; s.publishedRevision++;
    await atomic(experienceFile, s); return { collection: 'ai_experience', deletedCount: count, revision: s.publishedRevision };
  }); }
  const addRecords = addFacts;
  async function rollback() { /* Reports no longer create knowledge. Learning commits after the answer. */ }
  return { base: baseDir, seed, snapshot, search, record, applicability, addFacts, addRecords, addExperiences, listExperiences, learningToken, revise, clear, history, rollback };
}
module.exports = { ...createKnowledgeStore(), createKnowledgeStore, fingerprint };
