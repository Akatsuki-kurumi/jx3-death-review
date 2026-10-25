'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { seedCache } = require('../desktop/cache.cjs');
const { isLocalUrl, contentSecurityPolicy } = require('../desktop/security.cjs');

test('desktop seeds only resource files and never overwrites persistent caches', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jx3-desktop-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }); });
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  await fs.mkdir(path.join(source, 'icons/std'), { recursive: true }); await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'kungfu-std.json'), 'seed'); await fs.writeFile(path.join(target, 'kungfu-std.json'), 'user-newer');
  await fs.writeFile(path.join(source, 'icons/std/12128.png'), 'icon'); await fs.writeFile(path.join(source, 'model-config.dpapi'), 'private'); await fs.writeFile(path.join(source, 'battle.jcl'), 'private');
  assert.equal(await seedCache(source, target), 1); assert.equal(await fs.readFile(path.join(target, 'kungfu-std.json'), 'utf8'), 'user-newer');
  assert.equal(await seedCache(source, target), 0); assert.deepEqual((await fs.readdir(target)).sort(), ['icons', 'kungfu-std.json']);
});

test('desktop navigation and CSP allow only its origin and current inline script hashes', () => {
  const origin = 'http://127.0.0.1:41234'; assert(isLocalUrl(origin + '/', origin));
  for (const value of ['https://example.com', 'http://127.0.0.1:4173', 'http://127.0.0.1.evil.invalid:41234', 'javascript:alert(1)', 'http://user@127.0.0.1:41234']) assert.equal(isLocalUrl(value, origin), false);
  const html = '<script>console.log(1)</script><script src="/public/ai-ui.js"></script>', policy = contentSecurityPolicy(html);
  assert(policy.includes("script-src 'self' 'sha256-")); assert(!policy.includes("script-src 'self' 'unsafe-inline'")); assert(policy.includes("connect-src 'self'"));
  assert.notEqual(policy, contentSecurityPolicy(html.replace('log(1)', 'log(2)')));
});

test('system-assigned desktop port retains exact Host, Origin and request-header checks', async t => {
  const server = require('../preview-server.cjs').createServer({ port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  const request = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  assert.equal(await request('/'), 200);
  assert.equal(await request('/', { Host: 'localhost:' + port }), 403);
  assert.equal(await request('/api/records', {}, 'POST'), 403);
  assert.equal(await request('/api/records', { 'X-Preview-Client': 'jx3', Origin: 'https://example.com' }, 'POST'), 403);
  assert.equal(await request('/api/records', { 'X-Preview-Client': 'jx3', Origin: origin }, 'POST'), 400);
});
