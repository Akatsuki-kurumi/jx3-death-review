'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { seedCache } = require('../desktop/cache.cjs');

(async () => {
  const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
  const openSource = process.argv.includes('--open-source');
  const executableName = openSource ? '这咋死的-开源版' : '这咋死的';
  const { packager } = await import('@electron/packager');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (!openSource) {
    const iconResult = spawnSync(require('electron'), [path.join(__dirname, 'build-desktop-icon.cjs')], { env, windowsHide: true, stdio: 'inherit' });
    if (iconResult.status !== 0) throw Error('Windows 图标转换失败。');
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'zhezhaside-package-'));
  try {
    // Explicit allowlist; never include analysis logs, user settings, saved AI
    // reports, test results, node_modules links or the entire research directory.
    for (const directory of ['desktop', 'public', 'lib', 'data']) await fs.cp(path.join(root, directory), path.join(staging, directory), {
      recursive: true,
      filter: source => !openSource || !['public/app-icon.jpg', 'desktop/app.ico'].includes(path.relative(root, source).split(path.sep).join('/'))
    });
    for (const filename of ['index.html', 'preview-server.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, filename), path.join(staging, filename));
    if (!openSource) await seedCache(path.join(root, 'cache/jcl'), path.join(staging, 'cache/jcl'));
    const { devDependencies, scripts, ...production } = manifest;
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ ...production, author: production.author ?? '' }, null, 2));
    const copied = new Map();
    async function copyDependency(name, parent) {
      const source = path.dirname(require.resolve(name + '/package.json', { paths: [parent] }));
      const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      if (copied.has(name)) { if (copied.get(name) !== metadata.version) throw Error('依赖版本冲突：' + name); return; }
      copied.set(name, metadata.version);
      await fs.cp(source, path.join(staging, 'node_modules', name), { recursive: true, dereference: true });
      for (const dependency of Object.keys(metadata.dependencies || {})) await copyDependency(dependency, source);
    }
    for (const name of Object.keys(manifest.dependencies)) await copyDependency(name, root);
    const out = openSource ? path.join(root, 'dist', 'open-source', 'v' + manifest.version) : path.join(root, 'dist', 'v' + manifest.version);
    const folders = await packager({
      dir: staging, name: executableName, executableName, platform: 'win32', arch: 'x64',
      electronVersion: manifest.devDependencies.electron, out, overwrite: false, asar: true, prune: false,
      icon: !openSource && require('node:fs').existsSync(path.join(root, 'public/app-icon.jpg')) ? path.join(root, 'desktop/app.ico') : undefined,
      appVersion: manifest.version, buildVersion: manifest.version + '.0',
      win32metadata: { ProductName: executableName, FileDescription: '剑网三竞技场战斗复盘工具', OriginalFilename: executableName + '.exe' }
    });
    for (const folder of folders) {
      await fs.copyFile(path.join(root, 'README.md'), path.join(folder, '使用说明.md'));
      // Electron already supplies LICENSE in the distribution; preserve it.
      await fs.copyFile(path.join(root, 'LICENSE'), path.join(folder, 'LICENSE.app.txt'));
      await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(folder, 'THIRD_PARTY_NOTICES.md'));
      await fs.writeFile(path.join(folder, 'version.json'), JSON.stringify({ name: executableName, edition: openSource ? 'open-source' : 'local', version: production.version, platform: 'win32', arch: 'x64', electron: manifest.devDependencies.electron }, null, 2));
      console.log('桌面应用：' + path.join(folder, executableName + '.exe'));
    }
  } finally {
    const resolved = path.resolve(staging);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('zhezhaside-package-')) throw Error('打包临时目录校验失败，未清理。');
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
