const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readJclBattleBundle } = require('./lib/jcl/battle.cjs');
const { readIcon } = require('./lib/jcl/icons.cjs');

function parseRecord(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(.+?)[(（]\d+[)）](?:-|$)/.exec(name.replace(/\.jcl$/i, ''));
  if (!match) return { time: '时间未识别', map: '地图未识别', sortKey: '' };
  const [, y, m, d, h, min, sec, map] = match;
  const time = `${y}-${m}-${d} ${h}:${min}:${sec}`;
  return { time, map, sortKey: time };
}

async function listRecords(directory) {
  const files = await fs.readdir(directory, { withFileTypes: true });
  return files.filter(file => file.isFile() && /\.jcl$/i.test(file.name))
    .map(file => ({ ...parseRecord(file.name), filename: file.name }))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ time, map, filename }) => ({ time, map, filename }));
}

function createServer(options = {}) {
  const port = options.port ?? 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('预览端口必须为 0 至 65535 的整数（0 为系统分配）。');
  const aiRoutes = require('./lib/ai/routes.cjs').routes(options.aiOptions);
  const server = http.createServer(async (req, res) => {
    const boundPort = port === 0 ? server.address()?.port : port;
    const allowedHost = `127.0.0.1:${boundPort}`, allowedOrigin = `http://${allowedHost}`;
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== allowedHost) return send(403, { error: '请从本地预览页面访问。' });
    try {
      if (await aiRoutes(req, res, allowedOrigin)) return;
      if (req.method === 'GET' && req.url.startsWith('/api/icons/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== allowedOrigin)) return send(403, { error: '不允许此来源访问。' });
        const match = /^\/api\/icons\/(std|origin)\/([1-9]\d*)\.png(?:\?offline=1)?$/.exec(req.url);
        if (!match || !Number.isSafeInteger(Number(match[2]))) return send(400, { error: '图标地址不正确。' });
        const icon = await readIcon(Number(match[2]), {
          client: match[1], offline: req.url.endsWith('?offline=1'),
          cacheDir: options.iconCacheDir, fetchImpl: options.iconFetchImpl,
        });
        if (!icon) return send(404, { error: '图标暂不可用，请显示名称或 ID。' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': icon.bytes.length,
          'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin', 'X-Icon-Source': icon.source });
        return res.end(icon.bytes);
      }
      if (req.method === 'POST' && req.url === '/api/battle') {
        if (req.headers['x-preview-client'] !== 'jx3' || (req.headers.origin && req.headers.origin !== allowedOrigin)) return send(403, { error: '不允许此来源访问。' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) return send(413, { error: '文件地址过长。' });
        }
        let input;
        try { input = JSON.parse(body); } catch { return send(400, { error: '请求格式不正确。' }); }
        const { directory, filename } = input || {};
        if (typeof directory !== 'string' || !path.win32.isAbsolute(directory) || directory.includes('\0')
          || typeof filename !== 'string' || filename !== path.win32.basename(filename)
          || /[<>:"|?*\x00-\x1f]/.test(filename) || !/\.jcl$/i.test(filename)) {
          return send(400, { error: '请提供完整目录地址和该目录下的 JCL 文件名。' });
        }
        try {
          const data = await readJclBattleBundle(path.join(directory, filename), {
            battleIndex: input.battleIndex ?? 0, offline: input.offline === true,
          });
          return send(200, data);
        } catch (error) {
          return send(400, { error: error.code === 'ENOENT' ? '战斗文件不存在，请刷新列表。' : error.message });
        }
      }
      if (req.method === 'POST' && req.url === '/api/records') {
        if (req.headers['x-preview-client'] !== 'jx3' || (req.headers.origin && req.headers.origin !== allowedOrigin)) return send(403, { error: '不允许此来源访问。' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) return send(413, { error: '目录地址过长。' });
        }
        let directory;
        try { directory = JSON.parse(body).directory; } catch { return send(400, { error: '目录地址格式不正确。' }); }
        if (typeof directory !== 'string' || !path.win32.isAbsolute(directory)) return send(400, { error: '请提供完整目录地址。' });
        return send(200, { records: await listRecords(directory) });
      }
      if (req.method === 'GET' && req.url === '/public/app-icon.jpg') {
        let bytes, contentType = 'image/jpeg';
        try { bytes = await fs.readFile(path.join(__dirname, 'public', 'app-icon.jpg')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          bytes = await fs.readFile(path.join(__dirname, 'public', 'app-icon-default.svg'));
          contentType = 'image/svg+xml';
        }
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length,
          'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin' });
        return res.end(bytes);
      }
      if (req.method === 'GET' && ['/public/replay-query.js', '/public/replay-ui.js', '/public/replay.css', '/public/kill-query.js', '/public/kill-ui.js', '/public/kill.css', '/public/ai-leave-guard.js', '/public/ai-chat.js', '/public/ai-ui.js', '/public/ai.css'].includes(req.url)) {
        res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await fs.readFile(path.join(__dirname, req.url.slice(1))));
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await fs.readFile(path.join(__dirname, 'index.html')));
      }
      return send(404, { error: '未找到页面。' });
    } catch (error) {
      const message = error.code === 'ENOENT' ? '目录不存在，请检查目录地址。'
        : error.code === 'ENOTDIR' ? '该地址不是文件夹，请选择战斗数据目录。'
        : error.code === 'EACCES' || error.code === 'EPERM' ? '无法访问此目录，请检查读取权限。'
        : '读取目录失败，请重试。';
      return send(400, { error: message });
    }
  });
  return server;
}

if (require.main === module) {
  const port = process.argv[2] === '--port' ? Number(process.argv[3]) : 4173;
  createServer({ port }).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}`));
}
module.exports = { parseRecord, listRecords, createServer };
