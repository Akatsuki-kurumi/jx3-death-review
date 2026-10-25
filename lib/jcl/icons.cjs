'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DEFAULT_CACHE = path.join(jclCacheDir, 'icons');
const MAX_BYTES = 1024 * 1024;
const pending = new Map(), failures = new Map(), waiters = [];
let activeDownloads = 0;

function validId(value) { return Number.isSafeInteger(value) && value > 0; }
function validClient(client) { return client === 'std' || client === 'origin'; }

// Official JX3BOX iconLink convention; keep std/origin caches separate.
function remoteIconUrl(iconId, client = 'std') {
  if (!validId(iconId) || !validClient(client)) return null;
  return `https://icon.jx3box.com/${client === 'origin' ? 'origin_icon' : 'icon'}/${iconId}.png`;
}

function localIconUrl(iconId, options = {}) {
  const client = options.client ?? 'std';
  if (!validId(iconId) || !validClient(client)) return null;
  return `/api/icons/${client}/${iconId}.png${options.offline ? '?offline=1' : ''}`;
}

function validPng(bytes) {
  if (bytes.length < 45 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8, hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > MAX_BYTES || offset + 12 + length > bytes.length) return false;
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 512 || height > 512) return false;
    }
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') return length === 0 && hasData && offset + 12 === bytes.length;
    offset += 12 + length;
  }
  return false;
}

async function withDownloadSlot(work) {
  if (activeDownloads >= 3) await new Promise(resolve => waiters.push(resolve));
  else activeDownloads++;
  try { return await work(); }
  finally {
    if (waiters.length) waiters.shift()();
    else activeDownloads--;
  }
}

async function cachedBytes(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = await fs.readFile(file);
    return validPng(bytes) ? bytes : null;
  } catch { return null; }
}

async function readIcon(iconId, options = {}) {
  const client = options.client ?? 'std', sourceUrl = remoteIconUrl(iconId, client);
  if (!sourceUrl) return null;
  const file = path.resolve(options.cacheDir || DEFAULT_CACHE, client, `${iconId}.png`);
  const bytes = await cachedBytes(file);
  if (bytes) return { bytes, source: 'disk', sourceUrl, cacheFile: file };
  // Offline reads never join a request that is fetching from the network.
  if (options.offline) return null;
  if (pending.has(file)) return pending.get(file);
  const work = (async () => {
    const missFile = `${file}.miss.json`, now = Date.now();
    let retryAt = failures.get(file) ?? 0;
    try { retryAt = Math.max(retryAt, JSON.parse(await fs.readFile(missFile, 'utf8')).retryAt || 0); } catch {}
    if (retryAt > now) return null;
    const temp = `${file}.${randomUUID()}.tmp`;
    let failureTtl = 5 * 60_000;
    try {
      const result = await withDownloadSlot(async () => {
        // A queued request may find that another process has already saved it.
        const saved = await cachedBytes(file);
        if (saved) return { bytes: saved, source: 'disk', sourceUrl, cacheFile: file };
        const response = await (options.fetchImpl || fetch)(sourceUrl, {
          headers: { Accept: 'image/png' }, redirect: 'error',
          signal: AbortSignal.timeout(options.apiTimeoutMs ?? 10000),
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 410) failureTtl = 86400000;
          throw new Error(`HTTP ${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Oversized icon');
        const chunks = []; let length = 0;
        if (!response.body) throw new Error('Missing image body');
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > MAX_BYTES) throw new Error('Oversized icon');
          chunks.push(Buffer.from(chunk));
        }
        const downloaded = Buffer.concat(chunks);
        if (!validPng(downloaded)) throw new Error('Invalid PNG');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temp, downloaded);
        await fs.rename(temp, file);
        return { bytes: downloaded, source: 'download', sourceUrl, cacheFile: file };
      });
      failures.delete(file);
      await fs.unlink(missFile).catch(() => {});
      return result;
    } catch {
      const retryAt = Date.now() + failureTtl;
      failures.set(file, retryAt);
      await fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(missFile, JSON.stringify({ retryAt }))).catch(() => {});
      return null;
    } finally { await fs.unlink(temp).catch(() => {}); }
  })();
  pending.set(file, work);
  try { return await work; } finally { if (pending.get(file) === work) pending.delete(file); }
}

module.exports = { localIconUrl, remoteIconUrl, readIcon };
