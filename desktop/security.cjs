'use strict';
const { createHash } = require('node:crypto');

function isLocalUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
function isVideoSourceUrl(value) {
  try { const url=new URL(value);return url.protocol==='https:'&&url.hostname==='www.bilibili.com'&&!url.port&&!url.username&&!url.password&&/^\/video\/BV[0-9A-Za-z]+\/?$/.test(url.pathname)&&!/[\u0000-\u0020\u007f]/.test(value); }
  catch { return false; }
}
function contentSecurityPolicy(html) {
  // HTML parsing normalizes CRLF/CR to LF before CSP hashes are checked.
  html=html.replace(/\r\n?/g,'\n');
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(m => m[1].trim()).map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
  return ["default-src 'self'", "script-src 'self' " + hashes.join(' '),
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join('; ');
}
module.exports = { isLocalUrl, isVideoSourceUrl, contentSecurityPolicy };
