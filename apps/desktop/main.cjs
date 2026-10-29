'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
function webBundleDirectory() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'zuno-web');
  return path.resolve(__dirname, '../../dist/web');
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 360, minHeight: 640,
    backgroundColor: '#0d0d15',
    title: 'ZUNO',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const bundleIndex = path.join(webBundleDirectory(), 'index.html');
  const { pathToFileURL } = require('node:url');
  const ownDocumentUrl = pathToFileURL(bundleIndex).href;
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' && !target.username && !target.password) shell.openExternal(target.toString());
    } catch (_) {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let target;
    try { target = new URL(url); } catch (_) { event.preventDefault(); return; }
    const normalizedPath = target.protocol === 'file:' ? target.href.split(/[?#]/, 1)[0] : '';
    if (target.protocol === 'file:' && normalizedPath === ownDocumentUrl) return;
    if (target.protocol === 'http:' && ['localhost','127.0.0.1'].includes(target.hostname) && !app.isPackaged) return;
    event.preventDefault();
    if (target.protocol === 'https:' && !target.username && !target.password) {
      shell.openExternal(target.toString());
    }
  });
  win.loadFile(bundleIndex);
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
