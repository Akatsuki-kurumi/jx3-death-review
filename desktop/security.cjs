'use strict';
const { createHash } = require('node:crypto');

function isLocalUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
function contentSecurityPolicy(html) {
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(m => m[1].trim()).map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
  return ["default-src 'self'", "script-src 'self' " + hashes.join(' '),
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join('; ');
}
module.exports = { isLocalUrl, contentSecurityPolicy };
