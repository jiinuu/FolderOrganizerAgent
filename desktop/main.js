const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');

let mainWindow = null;
let worker = null;

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function runtimeDir() {
  return path.join(app.getPath('userData'), 'runtime');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function deriveDefaultOrganizedRoot(watchRoot) {
  const normalized = String(watchRoot || '').replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parent = path.dirname(normalized);
  const base = path.basename(normalized);
  if (!base) return '';
  return path.join(parent, `${base}_organized_by_agent`);
}

async function readSavedSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.watchRoot || !parsed.organizedRoot) return null;
    return {
      watchRoot: String(parsed.watchRoot),
      organizedRoot: String(parsed.organizedRoot),
      dryRun: Boolean(parsed.dryRun),
      logEachMove: Boolean(parsed.logEachMove),
      autoStart: Boolean(parsed.autoStart),
    };
  } catch {
    return null;
  }
}

async function saveSettings(payload) {
  const watchRoot = String(payload.watchRoot || '');
  const organizedRoot = String(payload.organizedRoot || '') || deriveDefaultOrganizedRoot(watchRoot);
  const data = {
    watchRoot,
    organizedRoot,
    dryRun: Boolean(payload.dryRun),
    logEachMove: Boolean(payload.logEachMove),
    autoStart: Boolean(payload.autoStart),
  };

  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

async function writeRuntimeConfig(payload) {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'organizer.runtime.config.json');

  const cfg = {
    watchRoot: payload.watchRoot,
    organizedRoot: payload.organizedRoot,
    scanIntervalMs: Number(payload.scanIntervalMs || 5000),
    settleMs: Number(payload.settleMs || 4000),
    dryRun: Boolean(payload.dryRun),
    logEachMove: Boolean(payload.logEachMove),
    unknownFolder: '_unsorted',
    rules: {
      extensionMap: {
        '.jpg': 'images',
        '.jpeg': 'images',
        '.png': 'images',
        '.gif': 'images',
        '.webp': 'images',
        '.svg': 'images',
        '.mp4': 'videos',
        '.mov': 'videos',
        '.avi': 'videos',
        '.mkv': 'videos',
        '.mp3': 'audio',
        '.wav': 'audio',
        '.pdf': 'documents/pdf',
        '.doc': 'documents/office',
        '.docx': 'documents/office',
        '.ppt': 'documents/office',
        '.pptx': 'documents/office',
        '.xls': 'documents/office',
        '.xlsx': 'documents/office',
        '.csv': 'data',
        '.json': 'data',
        '.txt': 'documents/text',
        '.md': 'documents/text',
        '.zip': 'archives',
        '.rar': 'archives',
        '.7z': 'archives',
        '.tar': 'archives',
        '.gz': 'archives',
        '.exe': 'installers',
        '.msi': 'installers',
        '.apk': 'installers',
        '.hwp': 'documents/office',
      },
      keywordMap: {
        invoice: 'finance/invoices',
        receipt: 'finance/receipts',
        '영수증': 'finance/receipts',
        resume: 'career/resume',
        '이력서': 'career/resume',
        '논문': 'research/papers',
        '발표': 'research/presentations',
      },
    },
  };

  await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), 'utf8');
  return filePath;
}

function stopWorker() {
  if (worker) {
    worker.kill();
    worker = null;
    send('organizer:status', { running: false, message: '중지됨' });
  }
}

async function startOrganizer(payload) {
  if (worker) return { ok: false, error: '이미 실행 중입니다.' };
  if (!payload || !payload.watchRoot) {
    return { ok: false, error: 'watchRoot가 필요합니다.' };
  }
  const runtimePayload = { ...payload };
  if (!runtimePayload.organizedRoot) {
    runtimePayload.organizedRoot = deriveDefaultOrganizedRoot(runtimePayload.watchRoot);
  }
  if (!runtimePayload.organizedRoot) return { ok: false, error: 'organizedRoot를 생성할 수 없습니다.' };

  try {
    const cfgPath = await writeRuntimeConfig(runtimePayload);

    worker = spawn(process.execPath, [path.join(__dirname, '..', 'folder-organizer-agent.js'), '--config', cfgPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    worker.stdout.on('data', (buf) => send('organizer:log', String(buf)));
    worker.stderr.on('data', (buf) => send('organizer:log', `[stderr] ${String(buf)}`));

    worker.on('exit', (code, signal) => {
      const msg = `프로세스 종료(code=${code}, signal=${signal || 'none'})`;
      send('organizer:status', { running: false, message: msg });
      worker = null;
    });

    send('organizer:status', { running: true, message: '실행 중' });
    return { ok: true };
  } catch (err) {
    worker = null;
    return { ok: false, error: err.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Folder Organizer Agent',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  mainWindow.webContents.once('did-finish-load', async () => {
    const saved = await readSavedSettings();
    if (saved && saved.autoStart) {
      const result = await startOrganizer(saved);
      if (!result.ok) send('organizer:status', { running: false, message: `자동 시작 실패: ${result.error}` });
    }
  });
}

ipcMain.handle('dialog:pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('settings:get', async () => {
  return readSavedSettings();
});

ipcMain.handle('settings:save', async (_event, payload) => {
  try {
    const saved = await saveSettings(payload || {});
    return { ok: true, settings: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('organizer:start', async (_event, payload) => {
  const startResult = await startOrganizer(payload);
  if (!startResult.ok) return startResult;

  if (payload?.remember) {
    try {
      await saveSettings(payload);
    } catch {
      // ignore save error; runtime already started
    }
  }
  return { ok: true };
});

ipcMain.handle('organizer:quick-start', async () => {
  const saved = await readSavedSettings();
  if (!saved) return { ok: false, error: '저장된 설정이 없습니다.' };
  return startOrganizer(saved);
});

ipcMain.handle('organizer:stop', async () => {
  stopWorker();
  return { ok: true };
});

ipcMain.handle('organizer:is-running', async () => Boolean(worker));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWorker();
  if (process.platform !== 'darwin') app.quit();
});
