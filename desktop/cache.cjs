'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

// Only public resource data is seeded. Reports, JCL files and credentials never
// enter the application package. Existing user cache files win on upgrades.
function isSeedFile(relative) {
  return /^(kungfu|talents|kill-buffs|replay-resources)-(std|origin)\.json$/.test(relative)
    || /^icons\/(std|origin)\/[1-9]\d*\.png$/.test(relative);
}
async function seedCache(source, destination) {
  let copied = 0;
  async function visit(relative = '') {
    let entries;
    try { entries = await fs.readdir(path.join(source, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory() && ['icons', 'icons/std', 'icons/origin'].includes(name)) await visit(name);
      else if (entry.isFile() && isSeedFile(name)) {
        const target = path.join(destination, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        try { await fs.copyFile(path.join(source, name), target, constants.COPYFILE_EXCL); copied++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
  }
  await visit();
  return copied;
}
module.exports = { seedCache, isSeedFile };
