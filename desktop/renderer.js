const simplePanelEl = document.getElementById('simplePanel');
const wizardPanelEl = document.getElementById('wizardPanel');

const watchRootEl = document.getElementById('watchRoot');
const organizedRootEl = document.getElementById('organizedRoot');
const pickWatchBtn = document.getElementById('pickWatch');
const pickOrganizedBtn = document.getElementById('pickOrganized');
const dropZoneEl = document.getElementById('dropZone');
const dryRunEl = document.getElementById('dryRun');
const logEachMoveEl = document.getElementById('logEachMove');
const autoStartEl = document.getElementById('autoStart');

const quickStartBtn = document.getElementById('quickStartBtn');
const openWizardBtn = document.getElementById('openWizardBtn');
const stopBtn = document.getElementById('stopBtn');

const saveBtn = document.getElementById('saveBtn');
const startBtn = document.getElementById('startBtn');
const backSimpleBtn = document.getElementById('backSimpleBtn');

const statusEl = document.getElementById('status');
const logsEl = document.getElementById('logs');

let hasSavedSettings = false;
let lastAutoOrganized = '';

function appendLog(text) {
  logsEl.textContent += `${text}`;
  if (!String(text).endsWith('\n')) logsEl.textContent += '\n';
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = `상태: ${text}`;
}

function showWizard() {
  wizardPanelEl.classList.remove('hidden');
  simplePanelEl.classList.add('hidden');
  backSimpleBtn.classList.toggle('hidden', !hasSavedSettings);
}

function showSimple() {
  simplePanelEl.classList.remove('hidden');
  wizardPanelEl.classList.add('hidden');
}

function collectPayload() {
  const watchRoot = watchRootEl.value.trim();
  const currentOrganized = organizedRootEl.value.trim();
  const organizedRoot = currentOrganized || deriveDefaultOrganizedRoot(watchRoot);
  if (!currentOrganized && organizedRoot) {
    organizedRootEl.value = organizedRoot;
    lastAutoOrganized = organizedRoot;
  }
  return {
    watchRoot,
    organizedRoot,
    dryRun: dryRunEl.checked,
    logEachMove: logEachMoveEl.checked,
    autoStart: autoStartEl.checked,
  };
}

function deriveDefaultOrganizedRoot(watchRoot) {
  const source = String(watchRoot || '').replace(/[\\/]+$/, '');
  if (!source) return '';
  const sep = source.includes('\\') ? '\\' : '/';
  const parts = source.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return '';
  const base = parts[parts.length - 1];
  const parent = parts.slice(0, -1).join(sep);
  if (!parent) return `${source}_organized_by_agent`;
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}${base}_organized_by_agent`;
  return `${parent}${sep}${base}_organized_by_agent`;
}

function maybeAutoFillOrganized(force = false) {
  const watch = watchRootEl.value.trim();
  if (!watch) return;
  const derived = deriveDefaultOrganizedRoot(watch);
  if (!derived) return;
  const current = organizedRootEl.value.trim();
  if (force || !current || current === lastAutoOrganized) {
    organizedRootEl.value = derived;
    lastAutoOrganized = derived;
    appendLog(`[UI] 결과 폴더 자동 설정: ${derived}`);
  }
}

function applySettings(s) {
  if (!s) return;
  watchRootEl.value = s.watchRoot || '';
  organizedRootEl.value = s.organizedRoot || deriveDefaultOrganizedRoot(s.watchRoot || '');
  lastAutoOrganized = organizedRootEl.value.trim();
  dryRunEl.checked = Boolean(s.dryRun);
  logEachMoveEl.checked = Boolean(s.logEachMove);
  autoStartEl.checked = Boolean(s.autoStart);
}

async function pickFolder(targetInput) {
  const p = await window.organizerApi.pickFolder();
  if (p) targetInput.value = p;
}

pickWatchBtn.addEventListener('click', async () => {
  await pickFolder(watchRootEl);
  maybeAutoFillOrganized();
});
pickOrganizedBtn.addEventListener('click', async () => {
  await pickFolder(organizedRootEl);
  lastAutoOrganized = '';
});

function handleDrop(e) {
  e.preventDefault();
  dropZoneEl.classList.remove('active');

  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;

  for (const file of files) {
    if (!file.path) continue;
    if (!watchRootEl.value.trim()) {
      watchRootEl.value = file.path;
      appendLog(`[UI] 대상 폴더 설정: ${file.path}`);
      maybeAutoFillOrganized();
    } else if (!organizedRootEl.value.trim()) {
      organizedRootEl.value = file.path;
      lastAutoOrganized = '';
      appendLog(`[UI] 결과 폴더 설정: ${file.path}`);
    } else {
      watchRootEl.value = file.path;
      appendLog(`[UI] 대상 폴더 덮어쓰기: ${file.path}`);
      maybeAutoFillOrganized();
    }
  }
}

['dragenter', 'dragover'].forEach((ev) => {
  dropZoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZoneEl.classList.add('active');
  });
});

['dragleave', 'drop'].forEach((ev) => {
  dropZoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop') return;
    dropZoneEl.classList.remove('active');
  });
});

dropZoneEl.addEventListener('drop', handleDrop);

saveBtn.addEventListener('click', async () => {
  const payload = collectPayload();
  if (!payload.watchRoot) {
    setStatus('저장 실패: 대상 폴더 경로를 입력하세요');
    return;
  }

  const result = await window.organizerApi.saveSettings(payload);
  if (!result.ok) {
    setStatus(`저장 실패: ${result.error}`);
    return;
  }

  hasSavedSettings = true;
  setStatus('설정 저장 완료');
  appendLog('[UI] 설정 저장 완료');
});

startBtn.addEventListener('click', async () => {
  const payload = collectPayload();
  if (!payload.watchRoot) {
    setStatus('대상 폴더 경로를 입력하세요');
    return;
  }

  const result = await window.organizerApi.start({ ...payload, remember: true });
  if (!result.ok) {
    setStatus(`실패: ${result.error}`);
    return;
  }

  hasSavedSettings = true;
  setStatus('실행 중');
  appendLog('[UI] 저장 후 시작 완료');
  showSimple();
});

quickStartBtn.addEventListener('click', async () => {
  const result = await window.organizerApi.quickStart();
  if (!result.ok) {
    setStatus(`빠른 시작 실패: ${result.error}`);
    showWizard();
    return;
  }
  setStatus('실행 중');
  appendLog('[UI] 빠른 시작 실행');
});

openWizardBtn.addEventListener('click', () => showWizard());
backSimpleBtn.addEventListener('click', () => showSimple());

stopBtn.addEventListener('click', async () => {
  await window.organizerApi.stop();
  setStatus('중지됨');
  appendLog('[UI] 정리 에이전트 중지 요청');
});

window.organizerApi.onLog((line) => appendLog(line));
window.organizerApi.onStatus((s) => {
  setStatus(s.running ? '실행 중' : s.message || '대기');
  appendLog(`[STATUS] ${s.message}`);
});

(async () => {
  const saved = await window.organizerApi.getSettings();
  if (saved) {
    hasSavedSettings = true;
    applySettings(saved);
    appendLog('[UI] 저장된 설정 불러오기 완료');
    showSimple();
  } else {
    hasSavedSettings = false;
    appendLog('[UI] 저장된 설정이 없습니다. 마법사로 시작하세요.');
    showWizard();
  }

  const running = await window.organizerApi.isRunning();
  setStatus(running ? '실행 중' : '대기');
})();
