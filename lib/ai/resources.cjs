'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');
const { resolveTalents } = require('../jcl/talents.cjs');
const path = require('node:path');
const { root, readJson, atomic, locked } = require('./storage.cjs'), KB = require('./knowledge.cjs');
const { versionFor, currentResource } = require('./knowledge-policy.cjs');
const key = r => r.kind + '.' + r.id + '_' + r.level;
async function details(wanted, { client = 'std', gameVersion = null, offline = false, signal, fetchImpl = fetch } = {}) {
  if (!wanted.length) return [];
  const policy = versionFor(client);
  const file = path.join(root, 'ai-knowledge', 'game-facts', 'sources', policy.version, client + '.json');
  return locked(file, async () => {
    signal?.throwIfAborted();
    const stored = await readJson(file, { version: 2, client, gameVersion: policy.version, entries: {} }), entries = stored.entries;
    const oldFile = path.join(root, 'ai-knowledge', 'sources', client + '.json'), old = await readJson(oldFile);
    // Do not resurrect the previously invalidated talent copies used by older application versions.
    if (old) {
      let pruned = false;
      for (const [k, v] of Object.entries(old.entries || {})) if (k.startsWith('talent.') && !currentResource(v, client)) { delete old.entries[k]; pruned = true; }
      if (pruned) await atomic(oldFile, old);
    }
    const expanded = [...new Map(wanted.flatMap(r => [r, { ...r, level: 0 }]).map(r => [key(r), r])).values()];
    const talentRequests = wanted.filter(r => r.kind === 'talent');
    const talentCatalog = talentRequests.length ? await resolveTalents(talentRequests.map(r => ({ skillId: r.id, level: r.level })), { client, offline, fetchImpl, signal }) : null;
    const local = await Promise.all(['talents', 'kill-buffs', 'kungfu', 'replay-resources'].map(n => readJson(path.join(jclCacheDir, n + '-' + client + '.json'), {})));
    let changed = false;
    for (const [k, v] of Object.entries(entries)) if (!currentResource(v, client)) { delete entries[k]; changed = true; }
    for (const r of expanded) {
      if (r.kind === 'talent') {
        const meta = talentCatalog.entries[r.id + '_' + r.level];
        if (meta?.name || meta?.description) {
          const value = { ...r, gameVersion: policy.version, name: meta.name, description: meta.description,
            source: meta.sourceUrl, retrievedAt: meta.fetchedAt, sourceKind: meta.sourceKind, sourceVersion: meta.sourceVersion,
            raw: { SkillID: r.id, Level: meta.descriptionResourceLevel, Name: meta.name, Desc: meta.description, ...meta } };
          if (JSON.stringify(entries[key(r)]) !== JSON.stringify(value)) { entries[key(r)] = value; changed = true; }
        } else if (entries[key(r)]) { delete entries[key(r)]; changed = true; }
        continue;
      }
      if (entries[key(r)]) continue;
      const lookup = r.id + '_' + r.level;
      const candidates = r.kind === 'talent' ? [local[0].entries?.[lookup]]
        : r.kind === 'buff' ? [local[1].entries?.[lookup], local[3].entries?.[key(r)]]
        : r.kind === 'kungfu' ? [local[2].entries?.[String(r.id)]]
        : [local[3].entries?.[key(r)]];
      candidates.push(old?.entries?.[key(r)]);
      const rich = candidates.find(v => v && currentResource(v, client) && (v.resource?.Desc || v.Desc || v.description));
      if (!rich) continue;
      const row = rich.resource || rich.raw || rich;
      entries[key(r)] = { ...r, gameVersion: policy.version, name: row.Name || row.SkillName || row.name || null,
        description: row.Desc || rich.description || null, source: rich.sourceUrl || rich.source || 'local:cache',
        retrievedAt: rich.fetchedAt || rich.retrievedAt, raw: row };
      changed = true;
    }
    if (!offline) for (const kind of ['skill', 'buff']) {
      const missing = expanded.filter(r => r.kind !== 'talent' && (r.kind === 'buff' ? 'buff' : 'skill') === kind && !entries[key(r)]);
      if (!missing.length) continue;
      const keys = [...new Set(missing.map(r => r.id + '_' + r.level))];
      const fields = kind === 'buff' ? 'BuffID,Level,Name,Desc' : 'SkillID,Level,Name,SkillName,Desc,BelongKungfu,IsPassiveSkill';
      const url = 'https://node.jx3box.com/resource/' + client + '/' + kind + '.[' + keys.join(',') + '].[' + fields + ']';
      try {
        const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { Accept: 'application/json' }, redirect: 'error' });
        if (!response.ok) throw Error('资源请求失败');
        const text = await response.text(); if (text.length > 2000000) throw Error('资源过大');
        const data = JSON.parse(text); if (!Array.isArray(data)) throw Error('资源格式错误');
        for (const r of missing) {
          const row = data.find(v => Number(v[kind === 'buff' ? 'BuffID' : 'SkillID']) === r.id && Number(v.Level) === r.level && !/^Buff\s*=/.test(v.Name || ''));
          entries[key(r)] = { ...r, gameVersion: policy.version, name: row?.Name || row?.SkillName || null, description: row?.Desc || null, source: url, retrievedAt: new Date().toISOString(), raw: row || null }; changed = true;
        }
      } catch { signal?.throwIfAborted(); }
    }
    signal?.throwIfAborted();
    if (changed) await atomic(file, stored);
    const records = expanded.map(r => entries[key(r)]).filter(r => r?.description).map(r => KB.record({
      kind: 'resource_description', collection: 'game_fact', client, gameVersion: policy.version,
      statement: (r.name || r.kind + ' ID ' + r.id) + '：' + r.description,
      resourceKeys: [{ kind: r.kind, id: r.id, level: r.level }], origin: r.source || 'local:resource-cache', raw: r,
      conditions: r.kind === 'talent' && r.raw?.Level !== r.level ? ['资料等级为 ' + (r.raw?.Level ?? '未知') + '，查询绑定日志等级 ' + r.level + '；不能据此确认精确等级机制。'] : []
    }));
    if (records.length) await KB.addFacts(records, { signal });
    return wanted.map(r => {
      const exact = entries[key(r)], generic = entries[key({ ...r, level: 0 })], chosen = exact?.description ? exact : generic?.description ? generic : exact || generic;
      return { ...r, client, collection: 'game_fact', priority: 'primary', name: chosen?.name || null, description: chosen?.description || null,
        nameLevel: chosen?.raw && Object.hasOwn(chosen.raw, 'Level') ? chosen.raw.Level : chosen?.level ?? null,
        source: chosen?.source || null, retrievedAt: chosen?.retrievedAt || null,
        sourceKind: chosen?.sourceKind || 'resource', sourceVersion: chosen?.sourceVersion || null,
        descriptionHasReferences: !!chosen?.description && /<[A-Z]/.test(chosen.description),
        gameVersion: policy.version, applicability: gameVersion && gameVersion !== policy.version ? 'mismatch' : gameVersion === policy.version && chosen?.level === r.level && !(r.kind === 'talent' && chosen?.raw?.Level !== r.level) ? 'matched' : 'unverified', missing: !chosen?.description };
    });
  });
}
module.exports = { details };
