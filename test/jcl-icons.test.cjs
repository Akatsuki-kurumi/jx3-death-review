'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { readIcon, localIconUrl, remoteIconUrl } = require('../lib/jcl/icons.cjs');
const { analyzeJcl, toBattleViewModel } = require('../lib/jcl/battle.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/SxkAAAAASUVORK5CYII=', 'base64');
const pngResponse = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcl-icons-'));
  t.after(async () => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('jcl-icons-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return dir;
}

test('icon URLs validate IDs, isolate clients, and propagate offline policy through the view', () => {
  assert.equal(localIconUrl(7067), '/api/icons/std/7067.png');
  assert.equal(localIconUrl(7067, { client: 'origin', offline: true }), '/api/icons/origin/7067.png?offline=1');
  assert.equal(remoteIconUrl(7067, 'origin'), 'https://icon.jx3box.com/origin_icon/7067.png');
  for (const id of [null, 0, -1, 1.2, NaN, '7067', '../secret', Number.MAX_SAFE_INTEGER + 1]) assert.equal(localIconUrl(id), null);
  assert.equal(localIconUrl(7067, { client: '../std' }), null);
  const b = analyzeJcl('0\t1\t1\t1000\t1\t{true,"test"}\n0\t2\t1\t1001\t4\t{1,"x",5,10080,1,{},{{1,5891,1}},"guid"}\n0\t3\t1\t1002\t5\t{1,true,2000,2000,100,100}', { offline: true });
  b.players[0].kungfu.iconId = 7067;
  b.players[0].talents[0].iconId = 7170;
  const card = toBattleViewModel(b).unassignedPlayers[0];
  assert.equal(card.kungfuIconUrl, '/api/icons/std/7067.png?offline=1');
  assert.equal(card.talents[0].iconUrl, '/api/icons/std/7170.png?offline=1');
});

test('same icon downloads once concurrently, persists across process restarts, and separates clients', async t => {
  const cacheDir = await temp(t); let calls = 0;
  const fetchImpl = async () => { calls++; return pngResponse(); };
  const results = await Promise.all(Array.from({ length: 8 }, () => readIcon(7067, { cacheDir, fetchImpl })));
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.bytes.equals(PNG)));
  assert.deepEqual(await fs.readFile(path.join(cacheDir, 'std/7067.png')), PNG);
  assert.equal((await readIcon(7067, { cacheDir, fetchImpl })).source, 'disk');
  const script = `const {readIcon}=require(process.argv[1]); let calls=0; readIcon(7067,{cacheDir:process.argv[2],fetchImpl:()=>{calls++;throw Error('unexpected');}}).then(r=>console.log(JSON.stringify({source:r?.source,calls})));`;
  const child = await execFile(process.execPath, ['-e', script, path.resolve(__dirname, '../lib/jcl/icons.cjs'), cacheDir]);
  assert.deepEqual(JSON.parse(child.stdout), { source: 'disk', calls: 0 });
  await readIcon(7067, { cacheDir, fetchImpl, client: 'origin' });
  assert.equal(calls, 2);
  assert.ok((await readIcon(7067, { cacheDir, offline: true })).bytes.equals(PNG));
});

test('offline miss does not fetch or wait for an online request', async t => {
  const cacheDir = await temp(t); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const ongoing = readIcon(7067, { cacheDir, fetchImpl: async () => {
    started(); await new Promise(resolve => { release = resolve; }); return pngResponse();
  } });
  await ready;
  const offline = await readIcon(7067, { cacheDir, offline: true, fetchImpl: () => { throw Error('offline must not fetch'); } });
  assert.equal(offline, null);
  release();
  await ongoing;
  assert.equal((await readIcon(7067, { cacheDir, offline: true })).source, 'disk');
});

test('missing images are negatively cached on disk and transient failures back off', async t => {
  const cacheDir = await temp(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('missing', { status: 404 }); };
  assert.equal(await readIcon(123, { cacheDir, fetchImpl }), null);
  assert.equal(await readIcon(123, { cacheDir, fetchImpl }), null);
  assert.equal(calls, 1);
  const negative = JSON.parse(await fs.readFile(path.join(cacheDir, 'std/123.png.miss.json'), 'utf8'));
  assert.ok(negative.retryAt > Date.now() + 23 * 3600000);
  const script = `const {readIcon}=require(process.argv[1]);let calls=0;readIcon(123,{cacheDir:process.argv[2],fetchImpl:()=>{calls++;throw Error('unexpected');}}).then(r=>console.log(JSON.stringify({missing:r===null,calls})));`;
  const child = await execFile(process.execPath, ['-e', script, path.resolve(__dirname, '../lib/jcl/icons.cjs'), cacheDir]);
  assert.deepEqual(JSON.parse(child.stdout), { missing: true, calls: 0 });
  const fails = async () => { calls++; throw Error('network down'); };
  assert.equal(await readIcon(124, { cacheDir, fetchImpl: fails }), null);
  assert.equal(await readIcon(124, { cacheDir, fetchImpl: fails }), null);
  assert.equal(calls, 2);
});

test('invalid responses are never saved as images, while a damaged local file can be repaired', async t => {
  const cacheDir = await temp(t);
  assert.equal(await readIcon(1, { cacheDir, fetchImpl: async () => new Response('<html>error</html>') }), null);
  assert.equal(await readIcon(2, { cacheDir, fetchImpl: async () => new Response(PNG.subarray(0, 40)) }), null);
  assert.equal(await readIcon(3, { cacheDir, fetchImpl: async () => new Response(PNG, { headers: { 'Content-Length': 1048577 } }) }), null);
  for (const id of [1, 2, 3]) await assert.rejects(fs.access(path.join(cacheDir, `std/${id}.png`)));
  await fs.writeFile(path.join(cacheDir, 'std/4.png'), 'broken');
  const fixed = await readIcon(4, { cacheDir, fetchImpl: async () => pngResponse() });
  assert.equal(fixed.source, 'download');
  assert.deepEqual(await fs.readFile(fixed.cacheFile), PNG);
});

test('many distinct icons respect the download concurrency limit', async t => {
  const cacheDir = await temp(t); let active = 0, peak = 0, calls = 0;
  const fetchImpl = async () => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return pngResponse();
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => readIcon(100 + i, { cacheDir, fetchImpl })));
  assert.ok(results.every(Boolean));
  assert.equal(calls, 12);
  assert.ok(peak <= 3);
});

test('local icon HTTP endpoint serves persisted PNGs and fails safely for offline misses and invalid URLs', async t => {
  const iconCacheDir = await temp(t); let calls = 0;
  const { createServer } = require('../preview-server.cjs');
  const server = createServer({ iconCacheDir, iconFetchImpl: async () => { calls++; return pngResponse(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url,
      headers: { Host: '127.0.0.1:4173', ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
  const first = await request('/api/icons/std/7067.png');
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  assert.equal(first.headers['x-icon-source'], 'download');
  assert.deepEqual(first.bytes, PNG);
  assert.equal((await request('/api/icons/std/7067.png')).headers['x-icon-source'], 'disk');
  assert.equal((await request('/api/icons/std/7170.png?offline=1')).status, 404);
  assert.equal((await request('/api/icons/std/0.png')).status, 400);
  assert.equal((await request('/api/icons/std/../../other.png')).status, 400);
  assert.equal((await request('/api/icons/std/1.png?url=https://example.com')).status, 400);
  assert.equal((await request('/api/icons/std/1.png', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(calls, 1);
});
