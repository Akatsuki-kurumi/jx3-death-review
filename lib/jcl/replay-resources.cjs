'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const queues = new Map(), retryAfter = new Map();
const seedFile = path.join(__dirname, '../../data/replay-name-catalog.json');
const keyOf = r => `${r.kind}.${r.id}_${r.level}`;
const hasName = row => typeof row?.name === 'string' && row.name.trim() && !/^Buff\s*=\s*1[，,]/i.test(row.name);

function resourceView(catalog, kind, id, level) {
  const exact = catalog[`${kind}.${id}_${level}`], generic = catalog[`${kind}.${id}_0`];
  const row = [exact, generic].find(hasName);
  return { kind, id: Number(id), level: Number(level), name: row?.name ?? null,
    label: row?.name ?? `${kind === 'buff' ? 'Buff' : '技能'} ID ${id}`,
    nameLevel: row?.level ?? null, nameField: row?.nameField ?? null,
    nameStatus: row ? Number(row.level) === Number(level) ? 'exact' : 'generic_level_0' : 'unresolved',
    isPassive: row?.isPassive ?? null, sourceUrl: row?.sourceUrl ?? null };
}

async function resolveLocked(resources, options, cacheFile) {
  const client = options.client ?? 'std', entries = Object.create(null), warnings = [];
  let seedCount = 0;
  if (client === 'std') {
    try {
      const seed = JSON.parse(await fs.readFile(options.seedFile ?? seedFile, 'utf8'));
      if (seed.client === client) { Object.assign(entries, seed.entries); seedCount = Object.keys(seed.entries).length; }
    } catch { /* No research cache on a fresh installation: batch the missing keys. */ }
  }
  try {
    const stored = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (stored.client === client && stored.version === 1) Object.assign(entries, stored.entries);
  } catch { /* Safe to proceed with the seeded dictionary. */ }
  const wanted = new Map();
  for (const r of resources) {
    if (!['skill', 'buff'].includes(r.kind) || !Number.isSafeInteger(r.id) || r.id <= 0 || !Number.isSafeInteger(r.level) || r.level < 0) continue;
    for (const level of [r.level, 0]) wanted.set(`${r.kind}.${r.id}_${level}`, { kind: r.kind, id: r.id, level });
  }
  let networkRequests = 0, changed = false;
  if (!options.offline && (retryAfter.get(cacheFile) ?? 0) <= Date.now()) {
    for (const kind of ['skill', 'buff']) {
      const missing = [...wanted.values()].filter(r => r.kind === kind && !Object.hasOwn(entries, keyOf(r)));
      for (let i = 0; i < missing.length; i += 300) {
        const batch = missing.slice(i, i + 300), fields = kind === 'skill' ? 'SkillID,Level,Name,SkillName,IsPassiveSkill' : 'BuffID,Level,Name';
        const url = `https://node.jx3box.com/resource/${client}/${kind}.[${batch.map(r => `${r.id}_${r.level}`).join(',')}].[${fields}]`;
        networkRequests++;
        try {
          const response = await (options.fetchImpl || fetch)(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(options.apiTimeoutMs ?? 10000) });
          if (!response.ok) throw Error(`HTTP ${response.status}`);
          const text = await response.text(); if (text.length > 2_000_000) throw Error('资源响应过大');
          const rows = JSON.parse(text); if (!Array.isArray(rows)) throw Error('资源响应格式不正确');
          for (const r of batch) {
            const matches = rows.filter(row => row && Number(row[kind === 'skill' ? 'SkillID' : 'BuffID']) === r.id && Number(row.Level) === r.level);
            const valid = matches.filter(row => hasName({ name: row.Name || row.SkillName }));
            const names = new Set(valid.map(row => (row.Name || row.SkillName).trim()));
            const row = names.size === 1 ? valid[0] : null;
            entries[keyOf(r)] = { ...r, name: row ? (row.Name || row.SkillName).trim() : null,
              nameField: row ? row.Name ? 'Name' : 'SkillName' : null, isPassive: row?.IsPassiveSkill ?? null,
              fetchedAt: new Date().toISOString(), sourceUrl: url };
          }
          changed = true;
        } catch (error) {
          warnings.push({ code: 'REPLAY_RESOURCE_UNAVAILABLE', message: `事件名称服务不可用，保留缓存或 ID。${error.message}` });
          retryAfter.set(cacheFile, Date.now() + 300000); break;
        }
      }
      if (warnings.length) break;
    }
  }
  if (changed) {
    const temp = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(temp, JSON.stringify({ version: 1, client, entries })); await fs.rename(temp, cacheFile);
    } catch { warnings.push({ code: 'REPLAY_RESOURCE_CACHE_WRITE', message: '事件名称缓存写入失败。' }); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  return { entries, warnings, meta: { client, networkRequests, seedCount, requestedKeys: wanted.size, offline: Boolean(options.offline) } };
}
async function resolveReplayResources(resources, options = {}) {
  const client = options.client ?? 'std';
  if (!['std', 'origin'].includes(client)) throw Error('客户端不支持');
  const cacheFile = path.join(options.cacheDir || jclCacheDir, `replay-resources-${client}.json`);
  const promise = (queues.get(cacheFile) || Promise.resolve()).catch(() => {}).then(() => resolveLocked(resources, options, cacheFile));
  queues.set(cacheFile, promise);
  try { return await promise; } finally { if (queues.get(cacheFile) === promise) queues.delete(cacheFile); }
}
module.exports = { resolveReplayResources, resourceView };
