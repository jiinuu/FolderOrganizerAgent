const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function log(level, text, meta = undefined) {
  if (meta === undefined) {
    console.log(`[${nowIso()}] [${level}] ${text}`);
    return;
  }
  console.log(`[${nowIso()}] [${level}] ${text} ${JSON.stringify(meta)}`);
}

function parseArgs(argv) {
  const args = { config: 'organizer.config.json', once: false, initConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config' && argv[i + 1]) {
      args.config = argv[i + 1];
      i += 1;
    } else if (a === '--once') {
      args.once = true;
    } else if (a === '--init-config') {
      args.initConfig = true;
    }
  }
  return args;
}

function normalizeExt(ext) {
  if (!ext) return '';
  return ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

function startsWithPath(target, base) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function moveFileSafe(src, dest) {
  try {
    await fsp.rename(src, dest);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  await fsp.copyFile(src, dest);
  await fsp.unlink(src);
}

async function uniquePath(destPath) {
  if (!(await exists(destPath))) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  for (let i = 1; i <= 9999; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`중복 파일명 해결 실패: ${destPath}`);
}

async function walkFiles(rootDir, skipDirSet) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (skipDirSet.has(full)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function buildLearnedFolders(organizedRoot) {
  const folders = [];
  async function walk(current, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(current, ent.name);
      const rel = path.relative(organizedRoot, full);
      const tokens = tokenize(rel);
      folders.push({ rel, tokens });
      await walk(full, depth + 1);
    }
  }
  await walk(organizedRoot, 0);
  return folders;
}

function pickByLearned(baseName, learnedFolders) {
  const words = tokenize(baseName);
  if (!words.length || !learnedFolders.length) return null;
  let best = null;
  for (const f of learnedFolders) {
    let score = 0;
    const set = new Set(f.tokens);
    for (const w of words) {
      if (set.has(w)) score += 1;
    }
    if (!best || score > best.score) best = { rel: f.rel, score };
  }
  if (!best || best.score < 1) return null;
  return best.rel;
}

function pickDestinationRel(filePath, cfg, learnedFolders) {
  const name = path.basename(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext = normalizeExt(path.extname(filePath));

  const keywordMap = cfg.rules?.keywordMap || {};
  for (const [keyword, relPath] of Object.entries(keywordMap)) {
    if (base.toLowerCase().includes(String(keyword).toLowerCase())) {
      return relPath;
    }
  }

  const extMap = cfg.rules?.extensionMap || {};
  if (extMap[ext]) return extMap[ext];

  const learned = pickByLearned(base, learnedFolders);
  if (learned) return learned;

  return cfg.unknownFolder || '_unsorted';
}

function toAbsConfigPath(p) {
  if (!p) return '';
  return path.resolve(p);
}

function validateConfig(raw) {
  const cfg = { ...raw };
  cfg.watchRoot = toAbsConfigPath(cfg.watchRoot || '');
  cfg.organizedRoot = toAbsConfigPath(cfg.organizedRoot || '');
  cfg.scanIntervalMs = Number(cfg.scanIntervalMs || 5000);
  cfg.settleMs = Number(cfg.settleMs || 4000);
  cfg.dryRun = Boolean(cfg.dryRun);
  cfg.logEachMove = Boolean(raw.logEachMove);
  cfg.unknownFolder = cfg.unknownFolder || '_unsorted';
  cfg.rules = cfg.rules || {};
  cfg.rules.extensionMap = cfg.rules.extensionMap || {};
  cfg.rules.keywordMap = cfg.rules.keywordMap || {};

  if (!cfg.watchRoot || !cfg.organizedRoot) {
    throw new Error('config에 watchRoot, organizedRoot가 필요합니다.');
  }

  return cfg;
}

async function processStableFile(filePath, cfg, learnedFolders) {
  const relDest = pickDestinationRel(filePath, cfg, learnedFolders);
  const destDir = path.join(cfg.organizedRoot, relDest);
  await ensureDir(destDir);
  const finalDest = await uniquePath(path.join(destDir, path.basename(filePath)));

  if (cfg.dryRun) {
    if (cfg.logEachMove) log('DRYRUN', '파일 이동 시뮬레이션', { from: filePath, to: finalDest });
    return true;
  }

  await moveFileSafe(filePath, finalDest);
  if (cfg.logEachMove) log('MOVE', '파일 이동 완료', { from: filePath, to: finalDest });
  return true;
}

async function runAgent(cfg, once) {
  await ensureDir(cfg.watchRoot);
  await ensureDir(cfg.organizedRoot);

  const pending = new Map();
  let learnedFolders = await buildLearnedFolders(cfg.organizedRoot);
  let cycle = 0;
  let movedCount = 0;

  log('INFO', '폴더 정리 에이전트 시작', {
    watchRoot: cfg.watchRoot,
    organizedRoot: cfg.organizedRoot,
    dryRun: cfg.dryRun,
    once,
  });

  while (true) {
    cycle += 1;
    if (cycle % 6 === 1) {
      learnedFolders = await buildLearnedFolders(cfg.organizedRoot);
    }

    const skipDirs = new Set();
    if (startsWithPath(cfg.organizedRoot, cfg.watchRoot) || cfg.organizedRoot === cfg.watchRoot) {
      skipDirs.add(cfg.organizedRoot);
    }

    const files = await walkFiles(cfg.watchRoot, skipDirs);
    const seen = new Set(files);
    const now = Date.now();

    for (const filePath of files) {
      let st;
      try {
        st = await fsp.stat(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const prev = pending.get(filePath);
      if (!prev) {
        pending.set(filePath, { size: st.size, changedAt: now });
        continue;
      }

      if (prev.size !== st.size) {
        pending.set(filePath, { size: st.size, changedAt: now });
        continue;
      }

      if (now - prev.changedAt < cfg.settleMs) continue;

      try {
        const moved = await processStableFile(filePath, cfg, learnedFolders);
        if (moved) movedCount += 1;
      } catch (err) {
        log('ERROR', '파일 처리 실패', { filePath, error: err.message });
      } finally {
        pending.delete(filePath);
      }
    }

    for (const key of pending.keys()) {
      if (!seen.has(key)) pending.delete(key);
    }

    if (once && cycle >= 2) {
      log('INFO', '1회 정리 완료', { movedCount, remainingPending: pending.size });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.scanIntervalMs));
  }
}

async function initConfig(targetPath) {
  const full = path.resolve(targetPath);
  if (await exists(full)) {
    log('WARN', '설정 파일이 이미 존재합니다.', { path: full });
    return;
  }
  const sample = {
    watchRoot: './watch_inbox',
    organizedRoot: './organized',
    scanIntervalMs: 5000,
    settleMs: 4000,
    dryRun: true,
    unknownFolder: '_unsorted',
    rules: {
      extensionMap: {
        '.jpg': 'images',
        '.jpeg': 'images',
        '.png': 'images',
        '.gif': 'images',
        '.mp4': 'videos',
        '.mov': 'videos',
        '.pdf': 'documents',
        '.docx': 'documents',
        '.xlsx': 'documents',
        '.zip': 'archives',
      },
      keywordMap: {
        invoice: 'finance/invoices',
        receipt: 'finance/receipts',
        resume: 'career/resume',
      },
    },
  };
  await fsp.writeFile(full, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
  log('INFO', '샘플 설정 파일 생성 완료', { path: full });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.initConfig) {
    await initConfig(args.config);
    return;
  }

  const raw = await readJson(args.config, null);
  if (!raw) {
    throw new Error(`설정 파일을 읽을 수 없습니다: ${args.config}. 먼저 --init-config 실행`);
  }
  const cfg = validateConfig(raw);
  await runAgent(cfg, args.once);
}

if (require.main === module) {
  main().catch((err) => {
    log('FATAL', err.message);
    process.exit(1);
  });
}

module.exports = {
  validateConfig,
  runAgent,
  initConfig,
};
