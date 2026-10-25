'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const queues = new Map(), retryAfter = new Map();
const DEFAULT_CACHE = jclCacheDir;
const DAY = 86400000;

const unresolved = id => ({ id, name: null, label: `心法 ${id}`, iconId: null, level: null, status: 'unresolved' });

async function resolveLocked(ids, options, cacheFile) {
  const client = options.client ?? 'std';
  const now = Date.now();
  let cache = { version: 1, client, entries: {} };
  const warnings = [];
  try {
    const stored = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (stored.version === 1 && stored.client === client && stored.entries && typeof stored.entries === 'object') cache = stored;
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push({ code: 'CATALOG_CACHE_READ', message: '心法缓存不可用，将尝试批量查询。' });
  }
  const validIds = ids.filter(id => Number.isSafeInteger(Number(id)) && Number(id) > 0);
  const missing = validIds.filter(id => {
    const old = cache.entries[id];
    const age = now - Date.parse(old?.fetchedAt);
    return !old || !Number.isFinite(age) || age < 0 || age > (old.name ? (options.cacheTtlMs ?? 30 * DAY) : DAY);
  });
  let networkRequests = 0, requestUrl = null, failed = false;
  if (missing.length && !options.offline && (retryAfter.get(cacheFile) ?? 0) <= now) {
    // Query all distinct kungfu IDs together. Level 0 is the generic name; 1 is a fallback.
    const keys = missing.flatMap(id => [`${id}_0`, `${id}_1`]);
    requestUrl = `https://node.jx3box.com/resource/${client}/skill.[${keys.join(',')}].[SkillID,Level,Name,SkillName,IconID,BelongSchool]`;
    networkRequests++;
    try {
      const response = await (options.fetchImpl || fetch)(requestUrl, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(options.apiTimeoutMs ?? 10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('Oversized resource response');
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('Unexpected resource response shape');
      const rank = row => Number(row.Level) === 0 ? -2 : Number(row.Level) === 1 ? -1 : Number(row.Level);
      for (const id of missing) {
        const row = rows.filter(r => r && String(r.SkillID) === String(id) && typeof (r.Name || r.SkillName) === 'string' && (r.Name || r.SkillName).trim())
          .sort((a, b) => rank(a) - rank(b))[0];
        cache.entries[id] = { id: Number(id), name: row ? (row.Name || row.SkillName).trim() : null,
          iconId: row && Number.isSafeInteger(Number(row.IconID)) && row.IconID != null ? Number(row.IconID) : null,
          level: row ? Number(row.Level) : null, fetchedAt: new Date(now).toISOString(), sourceUrl: requestUrl };
      }
      const temp = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
        await fs.rename(temp, cacheFile);
      } catch {
        warnings.push({ code: 'CATALOG_CACHE_WRITE', message: '心法已查询，但本地缓存写入失败。' });
      } finally { await fs.unlink(temp).catch(() => {}); }
    } catch (error) {
      failed = true;
      retryAfter.set(cacheFile, now + 5 * 60_000);
      warnings.push({ code: 'CATALOG_UNAVAILABLE', message: `心法服务暂不可用，保留缓存名称或心法 ID。${error.message}` });
    }
  }
  const entries = {};
  for (const id of ids) {
    const row = cache.entries[id];
    if (!row?.name) { entries[id] = unresolved(Number(id)); continue; }
    const stale = now - Date.parse(row.fetchedAt) > (options.cacheTtlMs ?? 30 * DAY);
    entries[id] = { id: Number(id), name: row.name, label: row.name, iconId: row.iconId,
      level: row.level, status: stale ? 'stale_cache' : 'resolved', fetchedAt: row.fetchedAt, sourceUrl: row.sourceUrl };
  }
  const unknown = ids.filter(id => !entries[id].name);
  if (unknown.length) warnings.push({ code: 'KUNGFU_UNRESOLVED', message: `以下心法未取得名称：${unknown.join('、')}，界面使用 ID。` });
  return { entries, warnings, meta: { client, status: failed ? 'degraded' : unknown.length ? 'partial' : 'resolved',
    networkRequests, cacheFile, requestUrl, offline: Boolean(options.offline) } };
}

async function resolveKungfu(inputIds, options = {}) {
  const client = options.client ?? 'std';
  if (!['std', 'origin'].includes(client)) throw new Error('client 只支持 std 或 origin。');
  const ids = [...new Set(inputIds.map(String))].sort((a, b) => Number(a) - Number(b));
  if (ids.length > 64) throw new Error('单场心法 ID 超过 64 个，请检查玩家筛选结果。');
  const cacheFile = path.join(options.cacheDir || DEFAULT_CACHE, `kungfu-${client}.json`);
  // Deduplicate concurrent requests from two UI clicks or two files in the same process.
  const previous = queues.get(cacheFile) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => resolveLocked(ids, options, cacheFile));
  queues.set(cacheFile, current);
  try { return await current; } finally { if (queues.get(cacheFile) === current) queues.delete(cacheFile); }
}

module.exports = { resolveKungfu };
