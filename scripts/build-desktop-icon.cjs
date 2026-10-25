'use strict';
const { app, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.whenReady().then(async () => {
  try { await fs.access(path.join(__dirname, '../public/app-icon.jpg')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('公开源码不含个人头像，桌面程序使用 Electron 默认图标。');
    app.quit(); return;
  }
  // Format conversion only: use the user's existing image without replacing it.
  const image = nativeImage.createFromPath(path.join(__dirname, '../public/app-icon.jpg'));
  if (image.isEmpty()) throw Error('应用图标无法读取。');
  const png = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(__dirname, '../desktop/app.ico'), Buffer.concat([header, png]));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
