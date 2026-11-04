'use strict';
const path = require('node:path');
const { root, atomic, readJson, locked } = require('./ai/storage.cjs');
function validDirectory(value) {
  if (typeof value !== 'string' || value.length > 4000 || !value || /[\x00-\x1f<>"|?*]/.test(value)) return false;
  const normalized = value.replace(/\//g, '\\');
  let parts;
  if (/^[a-zA-Z]:\\/.test(normalized)) parts = normalized.slice(3).split('\\');
  else if (normalized.startsWith('\\\\')) { parts = normalized.slice(2).split('\\'); if (parts.length < 2 || !parts[0] || !parts[1]) return false; }
  else return false;
  if (parts.at(-1) === '') parts.pop();
  return parts.every(p => p && !/[:\x00-\x1f<>"|?*]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p));
}
function createSettingsStore(file = path.join(root, 'app-settings.json')) {
  const load = async () => {
    const data = await readJson(file);
    if (!data) return { directory: '', setupCompleted: false };
    if (!validDirectory(data.directory) || typeof data.setupCompleted !== 'boolean') throw Error('本地配置格式不正确，请检查配置文件。');
    return { directory: data.directory, setupCompleted: data.setupCompleted };
  };
  const save = input => locked(file, async () => {
    if (!input || Object.keys(input).some(k => !['directory', 'setupCompleted'].includes(k)) || !validDirectory(input.directory) || typeof input.setupCompleted !== 'boolean') throw Error('请提供合法目录和配置完成状态。');
    const value = { directory: input.directory.replace(/\//g, '\\'), setupCompleted: input.setupCompleted };
    await atomic(file, value); return value;
  });
  return { load, save };
}
module.exports = { createSettingsStore, validDirectory };
