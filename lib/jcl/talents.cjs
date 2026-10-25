'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DAY = 86400000;
const queues = new Map(), retryAfter = new Map();
const DEFAULT_CACHE = jclCacheDir;
const FIELDS = ['SkillID', 'Level', 'Name', 'SkillName', 'IconID', 'Desc', 'BelongKungfu', 'BelongSchool', 'IsPassiveSkill'];
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const rowName = row => hasText(row?.Name) ? row.Name.trim() : hasText(row?.SkillName) ? row.SkillName.trim() : null;
const keyOf = talent => `${talent.skillId}_${talent.level}`;

async function resolveLocked(talents, options, cacheFile) {
  const client = options.client ?? 'std', now = Date.now(), warnings = [];
  let cache = { version: 1, client, entries: Object.create(null) };
  try {
    const read = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (read.version === 1 && read.client === client && read.entries && typeof read.entries === 'object') cache = read;
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push({ code: 'TALENT_CACHE_READ', message: '奇穴缓存不可用，将尝试批量查询。' });
  }
  const keys = [...new Set(talents.flatMap(t => [keyOf(t), `${t.skillId}_0`]))].sort((a, b) => {
    const [ai, al] = a.split('_').map(Number), [bi, bl] = b.split('_').map(Number);
    return ai - bi || al - bl;
  });
  const stale = entry => {
    const age = now - Date.parse(entry?.fetchedAt);
    return !entry || !Number.isFinite(age) || age < 0 || age > (entry.resource ? (options.cacheTtlMs ?? 30 * DAY) : DAY);
  };
  const missing = keys.filter(key => stale(cache.entries[key]));
  const requestUrls = [];
  let failed = false, updated = false;
  if (missing.length && !options.offline && (retryAfter.get(cacheFile) ?? 0) <= now) {
    // Ordinary 3v3 loadouts fit in one request. Bound very large changed-loadout files.
    for (let offset = 0; offset < missing.length; offset += 200) {
      const batch = missing.slice(offset, offset + 200);
      const url = `https://node.jx3box.com/resource/${client}/skill.[${batch.join(',')}].[${FIELDS.join(',')}]`;
      requestUrls.push(url);
      try {
        const response = await (options.fetchImpl || fetch)(url, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(options.apiTimeoutMs ?? 10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error('Oversized resource response');
        const rows = JSON.parse(text);
        if (!Array.isArray(rows)) throw new Error('Unexpected resource response shape');
        const richness = row => Number(Boolean(rowName(row))) + Number(hasText(row.Desc));
        for (const key of batch) {
          // The API can return substitute levels. Cache only exact keys, including negatives.
          const row = rows.filter(r => r && `${r.SkillID}_${r.Level}` === key).sort((a, b) => richness(b) - richness(a))[0];
          cache.entries[key] = { resource: row ?? null, fetchedAt: new Date(now).toISOString(), sourceUrl: url };
        }
        updated = true;
      } catch (error) {
        failed = true; retryAfter.set(cacheFile, now + 5 * 60_000);
        warnings.push({ code: 'TALENT_CATALOG_UNAVAILABLE', message: `奇穴服务暂不可用，保留缓存或技能 ID。${error.message}` });
        break;
      }
    }
  }
  if (updated) {
    const temp = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
      await fs.rename(temp, cacheFile);
    } catch { warnings.push({ code: 'TALENT_CACHE_WRITE', message: '已取得奇穴信息，但缓存写入失败。' }); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  const entries = Object.create(null);
  for (const t of talents) {
    const key = keyOf(t), exact = cache.entries[key], generic = cache.entries[`${t.skillId}_0`];
    const candidates = [exact, generic];
    const nameEntry = candidates.find(e => rowName(e?.resource));
    const descEntry = candidates.find(e => hasText(e?.resource?.Desc));
    const iconEntry = candidates.find(e => Number.isSafeInteger(e?.resource?.IconID) && e.resource.IconID >= 0);
    const name = rowName(nameEntry?.resource), description = descEntry?.resource.Desc ?? null;
    const used = [nameEntry, descEntry, iconEntry].filter(Boolean);
    entries[key] = {
      name, label: name || `奇穴 ${t.skillId}`, iconId: iconEntry?.resource.IconID ?? null,
      description, descriptionHasReferences: description ? /<(?:SUB|BUFF|NounID|TALENT|TALENT_CORE)\b/i.test(description) : false,
      nameResourceLevel: nameEntry?.resource.Level ?? null, descriptionResourceLevel: descEntry?.resource.Level ?? null,
      status: name ? (Number(nameEntry.resource.Level) === t.level ? 'resolved' : 'generic_fallback') : 'unresolved',
      metadataStatus: !used.length ? 'unavailable' : used.some(stale) ? 'stale_cache' : 'fresh',
      sourceUrl: nameEntry?.sourceUrl ?? descEntry?.sourceUrl ?? null,
      fetchedAt: nameEntry?.fetchedAt ?? descEntry?.fetchedAt ?? null,
    };
  }
  const unresolved = Object.keys(entries).filter(key => !entries[key].name);
  if (unresolved.length) warnings.push({ code: 'TALENTS_UNRESOLVED', message: `${unresolved.length} 项奇穴未取得名称，保留技能 ID。`, keys: unresolved });
  return { entries, warnings, meta: { client, status: failed ? 'degraded' : unresolved.length ? 'partial' : 'resolved',
    networkRequests: requestUrls.length, requestUrls, cacheFile, offline: Boolean(options.offline) } };
}

async function resolveTalents(input, options = {}) {
  const client = options.client ?? 'std';
  if (!['std', 'origin'].includes(client)) throw new Error('client 只支持 std 或 origin。');
  const unique = new Map();
  for (const t of input) if (Number.isSafeInteger(t.skillId) && t.skillId > 0 && Number.isSafeInteger(t.level) && t.level >= 0) unique.set(keyOf(t), t);
  const cacheFile = path.join(options.cacheDir || DEFAULT_CACHE, `talents-${client}.json`);
  const previous = queues.get(cacheFile) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => resolveLocked([...unique.values()], options, cacheFile));
  queues.set(cacheFile, current);
  try { return await current; } finally { if (queues.get(cacheFile) === current) queues.delete(cacheFile); }
}

module.exports = { resolveTalents };
