'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TALENT_VALID_FROM, isCurrentTalentTime } = require('./talent-cache-policy.cjs');
const DAY = 86400000;
const retryAfter = new Map();
const hasText = value => typeof value === 'string' && value.trim().length > 0;

// The simulator is a versioned talent catalog, not a level-specific skill table.
// Match actual IDs, never infer an ID from a name or the player's slot alone.
function catalogEntries(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('奇穴版本资料格式不正确');
  const entries = Object.create(null), conflicting = new Set();
  for (const [kungfuName, slots] of Object.entries(data)) {
    if (!slots || typeof slots !== 'object') continue;
    for (const choices of Object.values(slots)) {
      if (!choices || typeof choices !== 'object') continue;
      for (const row of Object.values(choices)) {
        const id = Number(row?.id), icon = Number(row?.icon);
        if (!Number.isSafeInteger(id) || id <= 0 || !hasText(row?.name) || !hasText(row?.desc)) continue;
        const resource = { SkillID: id, Level: null, Name: row.name.trim(), Desc: row.desc.replace(/\\n/g, '\n'),
          IconID: Number.isSafeInteger(icon) && icon > 0 ? icon : null };
        if (entries[id] && JSON.stringify(entries[id].resource) !== JSON.stringify(resource)) conflicting.add(String(id));
        entries[id] = { resource, kungfuName, slot: Number(row.order) || null, optionIndex: Number(row.pos) || null };
      }
    }
  }
  for (const id of conflicting) delete entries[id];
  if (!Object.keys(entries).length) throw Error('奇穴版本资料未包含可识别条目');
  return entries;
}

async function resolveSupplement(ids, options, cacheDir) {
  const client = options.client ?? 'std', requestUrls = [], warnings = [];
  if (client !== 'std' || options.simulatorFallback === false || !ids.length) return { entries: {}, requestUrls, warnings };
  const cacheFile = path.join(cacheDir, `talent-simulator-${client}.json`);
  const minimumVersion = 'v' + TALENT_VALID_FROM.slice(0, 10).replaceAll('-', '');
  let cache;
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') warnings.push({ code: 'TALENT_SUPPLEMENT_CACHE_READ', message: '奇穴版本缓存不可用，将尝试重新查询。' }); }
  if (cache?.version !== 1 || cache.client !== client || !/^v\d{8}$/.test(cache.catalogVersion) || cache.catalogVersion < minimumVersion ||
      !isCurrentTalentTime(cache.fetchedAt) || !cache.entries || typeof cache.entries !== 'object') cache = null;
  // A new ID may be added upstream. Negative catalog matches are retried daily.
  const missing = ids.some(id => !cache?.entries[id]);
  if (missing && (!cache || Date.now() - Date.parse(cache.fetchedAt) > DAY) && !options.offline && (retryAfter.get(cacheFile) ?? 0) <= Date.now()) {
    const indexUrl = `https://data.jx3box.com/talent/${client}/index.json`;
    const getJson = async url => {
      requestUrls.push(url);
      const timeout = AbortSignal.timeout(options.apiTimeoutMs ?? 10000);
      const r = await (options.fetchImpl || fetch)(url, { headers: { Accept: 'application/json' },
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (text.length > 3_000_000) throw Error('奇穴版本资料过大');
      return JSON.parse(text);
    };
    try {
      const versions = await getJson(indexUrl);
      if (!Array.isArray(versions)) throw Error('奇穴版本索引格式不正确');
      const latest = versions.filter(v => /^v\d{8}$/.test(v?.version) && v.version >= minimumVersion)
        .sort((a, b) => b.version.localeCompare(a.version))[0];
      if (!latest) throw Error('暂无更新后的奇穴版本资料');
      const sourceUrl = `https://data.jx3box.com/talent/${client}/${latest.version}.json`;
      const entries = catalogEntries(await getJson(sourceUrl));
      cache = { version: 1, client, catalogVersion: latest.version, catalogName: latest.name || null,
        fetchedAt: new Date().toISOString(), sourceUrl, indexUrl, entries };
      const temp = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
        await fs.rename(temp, cacheFile);
      } catch { warnings.push({ code: 'TALENT_SUPPLEMENT_CACHE_WRITE', message: '已取得奇穴版本资料，但缓存保存失败。' }); }
      finally { await fs.unlink(temp).catch(() => {}); }
    } catch (e) {
      retryAfter.set(cacheFile, Date.now() + 5 * 60000);
      warnings.push({ code: 'TALENT_SUPPLEMENT_UNAVAILABLE', message: `奇穴版本资料暂不可用，缺失项保留 ID。${e.message}` });
    }
  }
  const entries = Object.create(null);
  for (const id of ids) if (cache?.entries[id]) entries[id] = { resource: cache.entries[id].resource,
    fetchedAt: cache.fetchedAt, sourceUrl: cache.sourceUrl, sourceKind: 'talent_simulator', sourceVersion: cache.catalogVersion };
  return { entries, requestUrls, warnings };
}
module.exports = { resolveSupplement, catalogEntries };
