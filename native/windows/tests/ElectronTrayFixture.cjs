// Owned Electron fixture; never reads or controls another application's content.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const marker = process.argv[2];
app.setPath('userData', marker + '-profile');
let window,
  clicks = 0,
  activations = 0,
  rendererVisibility = 'unknown';
function report() {
  if (!window || window.isDestroyed()) return;
  fs.writeFileSync(
    marker + '.json',
    JSON.stringify({
      pid: process.pid,
      handle: window.getNativeWindowHandle().readBigUInt64LE().toString(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      maximized: window.isMaximized(),
      clicks,
      activations,
      electron: process.versions.electron,
      rendererVisibility,
    }),
  );
}
function restore() {
  activations++;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  report();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', restore);
  app.whenReady().then(async () => {
    window = new BrowserWindow({
      title: 'LaunchFlow Electron Tray Fixture',
      width: 700,
      height: 460,
      x: 110,
      y: 110,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    window.setMenu(null);
    ipcMain.on('fixture-click', () => {
      clicks++;
      report();
    });
    ipcMain.on('fixture-visibility', (_, value) => {
      rendererVisibility = value;
      report();
    });
    await window.loadURL(
      'data:text/html,' +
        encodeURIComponent(`<!doctype html><title>LaunchFlow Electron Tray Fixture</title>
      <style>body{font:24px sans-serif;padding:30px}button{width:220px;height:80px}</style>
      <button id="test" onclick="require('electron').ipcRenderer.send('fixture-click')">Test Click</button>
      <script>const report=()=>require('electron').ipcRenderer.send('fixture-visibility',document.visibilityState);
      document.addEventListener('visibilitychange',report);report();</script>`),
    );
    window.hide();
    report();
    setInterval(() => {
      report();
      if (!fs.existsSync(marker + '.command')) return;
      const command = fs.readFileSync(marker + '.command', 'utf8');
      fs.unlinkSync(marker + '.command');
      if (command === 'hide') {
        window.hide();
        report();
      }
      if (command === 'maximize-hide') {
        window.maximize();
        window.hide();
        report();
      }
      if (command === 'restore') restore();
      if (command === 'quit') app.quit();
    }, 50);
  });
}
