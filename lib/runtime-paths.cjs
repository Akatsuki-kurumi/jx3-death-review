'use strict';
const path = require('node:path');
// Development uses the existing workspace cache. Desktop startup sets a writable,
// persistent location before loading the parser or AI modules.
const jclCacheDir = process.env.JX3_CACHE_DIR || path.join(__dirname, '../cache/jcl');
module.exports = { jclCacheDir };
