'use strict';
const { app, BrowserWindow, Menu, dialog, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { seedCache } = require('./cache.cjs');
const { isLocalUrl, contentSecurityPolicy } = require('./security.cjs');

const productName = '这咋死的';
const userRoot = process.env.JX3_USER_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ZheZhaSiDe');
process.env.JX3_USER_DATA_DIR = userRoot;
process.env.JX3_CACHE_DIR = path.join(userRoot, 'cache/jcl');
app.setName(productName);
app.setAppUserModelId('com.zhezhaside.desktop');
require('node:fs').mkdirSync(path.join(userRoot, 'desktop'), { recursive: true });
app.setPath('userData', path.join(userRoot, 'desktop'));

let window, server;
const title = `${productName} · v${app.getVersion()}`;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { server?.close(); server?.closeAllConnections(); });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('无法启动这咋死的', error.message);
    app.quit();
  });
}

async function start() {
  const appRoot = app.getAppPath();
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await seedCache(path.join(appRoot, 'cache/jcl'), process.env.JX3_CACHE_DIR);
  // Reuse the current backend in this process; never attach to or stop a preview server.
  server = require('../preview-server.cjs').createServer({ port: 0 });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({
    title, width: 1280, height: 900, minWidth: 720, minHeight: 540, show: false,
    icon: require('node:fs').existsSync(path.join(appRoot, 'public/app-icon.jpg'))
      ? nativeImage.createFromPath(path.join(appRoot, 'public/app-icon.jpg')) : undefined,
    backgroundColor: '#101513', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, spellcheck: false, partition: 'persist:desktop' }
  });
  const contents = window.webContents, session = contents.session;
  const csp = contentSecurityPolicy(await fs.readFile(path.join(appRoot, 'index.html'), 'utf8'));
  session.webRequest.onHeadersReceived({ urls: [origin + '/*'] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === contents && permission === 'clipboard-sanitized-write' && isLocalUrl(details.requestingUrl, origin));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    webContents === contents && permission === 'clipboard-sanitized-write' && requestingOrigin === origin);
  session.on('will-download', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => { if (!isLocalUrl(url, origin)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isLocalUrl(url, origin)) event.preventDefault(); });
  window.on('page-title-updated', event => event.preventDefault());
  contents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(window, {
      type: 'question', title: '生成尚未完成', message: 'AI 内容仍在生成，离开此页面会终止本次生成。',
      detail: '选择“留下，继续等待”可继续生成。',
      buttons: ['留下，继续等待', '终止生成并离开'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (response === 1) event.preventDefault();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '应用', submenu: [
      { label: `关于 ${productName} · v${app.getVersion()}`, click: () => dialog.showMessageBox(window, {
        type: 'info', title: `关于 ${productName}`, message: title,
        detail: '剑网三竞技场战斗复盘工具\nWindows 桌面版\n\n配置、报告、知识库与缓存保存在当前 Windows 用户的本地应用数据目录。', buttons: ['确定']
      }) }, { type: 'separator' }, { label: '退出', role: 'quit' }
    ] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' },
      { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '重新载入', role: 'reload' }, { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' },
      { label: '全屏', role: 'togglefullscreen' }] }
  ]));
  await window.loadURL(origin + '/');
  window.show();
}
