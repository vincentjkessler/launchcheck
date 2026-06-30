const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ensureDir, defaultWatchDir, parseArgs, fileExists, writeJson, readJson, compareVersions, processAlive } = require('./utils');
const { releaseGate } = require('./releaseGate');
const PKG = require('../package.json');
const VERSION = PKG.version;
const PRODUCT_ID = 'launchcheck-auto-qa-watcher';
let validatorModule = null;

function banner(watchDir, reportsDir, opts) {
  console.log('');
  console.log('============================================================');
  console.log(`LaunchCheck Auto QA Watcher v${VERSION}`);
  console.log(`Watching: ${watchDir}`);
  console.log(`Reports:  ${reportsDir}`);
  console.log('Auto-validates: .zip, .html, .htm');
  if (opts.noBrowser) console.log('Browser runtime: OFF by --no-browser. Static and contract checks still run.');
  console.log('Startup backlog: OFF by default. Existing Downloads files are ignored.');
  console.log('Use --scan-existing only when you intentionally want to validate the whole Downloads backlog.');
  console.log('Reads product QA contracts from launchcheck.qa.json, embedded HTML, package.json, or marked code blocks.');
  console.log('Never auto-runs arbitrary products: .exe, .msi, .bat, .cmd, .ps1, .vbs, .scr, .jar');
  console.log('Auto-run boundary: LaunchCheck validates builds but never installs, promotes, or replaces itself.');
  console.log('Clipboard: copies ai-iteration-packet.txt automatically after validation.');
  console.log('Ready notification: terminal bell + Windows SystemSounds + console beep fallback after clipboard copy.');
  console.log('Product state: remembers productId and loads previous exported state during validation.');
  console.log('Release gate: copies validated builds into _VALIDATED_BUILDS and writes receipts.');
  console.log('Self-update: OFF in the public release.');
  console.log('Daemon health: active lock plus daemon-health-latest.json can be checked with the status command.');
  console.log(`File detection: polling scanner every ${opts.pollMs || 2000}ms plus fs.watch assist.`);
  console.log('Press Ctrl+C to stop.');
  console.log('============================================================');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitStable(filePath) {
  let last = -1, stable = 0;
  for (let i = 0; i < 120; i++) {
    if (!fileExists(filePath)) { await sleep(500); continue; }
    if (/\.(crdownload|tmp|part)$/i.test(filePath)) { await sleep(500); continue; }
    const size = fs.statSync(filePath).size;
    if (size === last && size > 0) stable++; else stable = 0;
    if (stable >= 3) return true;
    last = size;
    await sleep(500);
  }
  return false;
}
function copyToClipboard(filePath, noClipboard) {
  if (noClipboard) return false;
  if (process.platform !== 'win32') return false;
  const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const q = String(filePath).replace(/'/g, "''");
  const cmd = `Get-Content -LiteralPath '${q}' -Raw -Encoding UTF8 | Set-Clipboard`;
  const r = childProcess.spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
  return r.status === 0;
}

function notifyReadyToPaste(noNotifySound) {
  const status = {
    attempted: !noNotifySound,
    terminalBellAttempted: false,
    terminalBellOk: false,
    windowsSoundAttempted: false,
    windowsSoundOk: false,
    consoleBeepAttempted: false,
    consoleBeepOk: false,
    ok: false,
    message: '',
    completedAt: new Date().toISOString()
  };
  if (noNotifySound) {
    status.message = '--no-notify-sound was supplied.';
    return status;
  }
  try {
    status.terminalBellAttempted = true;
    process.stdout.write('\x07');
    status.terminalBellOk = true;
  } catch (err) {
    status.terminalBellError = err.message || String(err);
  }
  if (process.platform === 'win32') {
    status.windowsSoundAttempted = true;
    status.consoleBeepAttempted = true;
    try {
      const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::Beep(988,180); $global:lcBeep1 = $true } catch { $global:lcBeep1 = $false }
try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {}
try { [System.Media.SystemSounds]::Asterisk.Play(); $global:lcSound1 = $true } catch { $global:lcSound1 = $false }
Start-Sleep -Milliseconds 220
try { [Console]::Beep(1319,220); $global:lcBeep2 = $true } catch { $global:lcBeep2 = $false }
try { [System.Media.SystemSounds]::Exclamation.Play(); $global:lcSound2 = $true } catch { $global:lcSound2 = $false }
Start-Sleep -Milliseconds 160
Write-Output ("LC_NOTIFY beep1={0};beep2={1};sound1={2};sound2={3}" -f $global:lcBeep1,$global:lcBeep2,$global:lcSound1,$global:lcSound2)
`;
      const r = childProcess.spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 5000 });
      status.windowsSoundOk = r.status === 0;
      status.consoleBeepOk = r.status === 0;
      status.exitCode = r.status;
      status.stdout = (r.stdout || '').trim();
      status.stderr = (r.stderr || '').trim();
      if (r.error) status.error = r.error.message || String(r.error);
    } catch (err) {
      status.windowsSoundError = err.message || String(err);
    }
  }
  status.ok = !!(status.terminalBellOk || status.windowsSoundOk || status.consoleBeepOk);
  status.message = status.ok ? 'Ready-to-paste notification attempted through terminal bell plus Windows sound/beep fallback.' : 'Ready-to-paste notification could not be triggered.';
  status.completedAt = new Date().toISOString();
  return status;
}

function ensureRuntimeDeps(opts = {}) {
  if (opts.noBrowser) {
    console.log('[LaunchCheck] Runtime dependency gate: skipped because --no-browser is active.');
    return;
  }
  try { require.resolve('playwright'); return; } catch {}
  console.log('[LaunchCheck] Runtime dependency gate: Playwright missing. Installing before validation...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let r = childProcess.spawnSync(npm, ['install', '--no-audit', '--fund=false'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm install failed during runtime dependency gate.');
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  r = childProcess.spawnSync(npx, ['playwright', 'install', 'chromium'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npx playwright install chromium failed during runtime dependency gate.');
}
function getValidator() {
  if (!validatorModule) validatorModule = require('./validator');
  return validatorModule;
}
function writeReady(readyPath, watchDir, lockPath, duplicateOf) {
  if (!readyPath) return;
  writeJson(readyPath, { ok: true, productId: PRODUCT_ID, version: VERSION, pid: process.pid, watchDir, lockPath, duplicateOf: duplicateOf || null, readyAt: new Date().toISOString() });
  console.log(`[LaunchCheck] Ready file written: ${readyPath}`);
}
function acquireLock(watchDir, readyPath) {
  const workRoot = ensureDir(path.join(watchDir, '_VALIDATION_WORK'));
  const lockPath = path.join(workRoot, 'launchcheck-active-watcher.json');
  const existing = readJson(lockPath, null);
  if (existing && existing.pid && existing.pid !== process.pid && processAlive(existing.pid)) {
    const cmp = compareVersions(existing.version, VERSION);
    if (cmp >= 0) {
      console.log(`[LaunchCheck] Existing watcher is already active: v${existing.version}, pid ${existing.pid}`);
      writeReady(readyPath, watchDir, lockPath, existing);
      console.log('[LaunchCheck] This watcher will exit to avoid duplicate watchers.');
      process.exit(0);
    }
  }
  const startTime = new Date().toISOString();
  const healthPath = path.join(workRoot, 'daemon-health-latest.json');
  const writeLock = () => {
    const payload = { productId: PRODUCT_ID, version: VERSION, pid: process.pid, watchDir, cwd: process.cwd(), heartbeatAt: new Date().toISOString(), startedAt: startTime, lockPath, healthPath };
    writeJson(lockPath, payload);
    writeJson(healthPath, { schema: 'launchcheck.daemonHealth/v1', active: true, ...payload });
  };
  writeLock();
  setInterval(writeLock, 2000).unref();
  process.on('exit', () => {
    try { writeJson(healthPath, { schema: 'launchcheck.daemonHealth/v1', active: false, productId: PRODUCT_ID, version: VERSION, pid: process.pid, watchDir, cwd: process.cwd(), exitedAt: new Date().toISOString(), startedAt: startTime }); } catch {}
    try { const cur = readJson(lockPath, null); if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath); } catch {}
  });
  console.log(`[LaunchCheck] Active watcher lock: ${lockPath}`);
  writeReady(readyPath, watchDir, lockPath, null);
  return { workRoot, lockPath };
}
async function waitForReady(readyPath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = readJson(readyPath, null);
    if (r && r.ok) return r;
    await sleep(1000);
  }
  return null;
}

function appendLog(filePath, message) {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
async function validateOne(filePath, opts, lockInfo) {
  await waitStable(filePath);
  try {
    console.log(`[LaunchCheck] New candidate detected: ${filePath}`);
    ensureRuntimeDeps(opts);
    const validator = getValidator();
    const result = await validator.validateCandidate(filePath, { watchDir: opts.watchDir, noBrowser: opts.noBrowser });
    const gate = await releaseGate(filePath, result, opts);
    result.releaseGate = gate;
    result.output = result.output || {};
    result.output.releaseGate = gate;
    result.report = result.report || {};
    result.report.releaseGate = gate;
    validator.rewriteReports(result);
    console.log(`[LaunchCheck] ${result.status}: ${path.basename(filePath)}`);
    console.log(`[LaunchCheck] Progress: ${result.progress.grade} | Previous: ${result.progress.previousStatus || 'n/a'} | Current: ${result.progress.currentStatus} | Errors Δ: ${result.progress.errorsDelta} | Warnings Δ: ${result.progress.warningsDelta}`);
    if (result.changeSummary) {
      console.log(`[LaunchCheck] File delta: previousAvailable=${result.changeSummary.previousAvailable === true} files ${result.changeSummary.previousFileCount || 0}->${result.changeSummary.currentFileCount || 0} added=${result.changeSummary.addedCount || 0} removed=${result.changeSummary.removedCount || 0} modified=${result.changeSummary.modifiedCount || 0}`);
    }
    console.log(`[LaunchCheck] Release gate: ${gate.bucket} | attempted=${gate.attempted} | action=${gate.action}`);
    console.log(`[LaunchCheck] Release copied path: ${gate.copiedPath || 'n/a'}`);
    console.log(`[LaunchCheck] Release receipt path: ${gate.receiptPath || 'n/a'}`);
    if (gate.failureReason) console.log(`[LaunchCheck] Release failure: ${gate.failureReason}`);
    console.log(`[LaunchCheck] Report: ${result.reportHtml}`);
    console.log(`[LaunchCheck] Fix prompt: ${result.fixPromptPath}`);
    console.log(`[LaunchCheck] AI packet: ${result.aiPacketPath}`);
    const clipboardOk = copyToClipboard(result.aiPacketPath, opts.noClipboard);
    if (clipboardOk) console.log('[LaunchCheck] Clipboard ready: ai-iteration-packet.txt copied via Set-Clipboard UTF-8 file read. Paste it directly into ChatGPT/Claude.');
    const notify = notifyReadyToPaste(opts.noNotifySound);
    result.notification = { clipboardOk, readyToPaste: notify };
    result.output = result.output || {};
    result.output.notification = result.notification;
    result.report = result.report || {};
    result.report.notification = result.notification;
    validator.rewriteReports(result);
    if (clipboardOk) copyToClipboard(result.aiPacketPath, opts.noClipboard);
    console.log(`[LaunchCheck] Dinger: attempted=${notify.attempted} terminalBell=${notify.terminalBellOk} windowsSound=${notify.windowsSoundOk} consoleBeep=${notify.consoleBeepOk} ok=${notify.ok}`);
    console.log('[LaunchCheck] Notify: Paste the AI packet into ChatGPT now.');
    console.log(`[LaunchCheck] Packet path: ${result.aiPacketPath}`);
  } catch (err) {
    console.error(`[LaunchCheck] Validation failed internally: ${err.stack || err.message || err}`);
  }
}
async function main() {
  const args = parseArgs();
  const watchDir = path.resolve(args.watch || defaultWatchDir());
  const reportsDir = ensureDir(path.join(watchDir, '_VALIDATION_REPORTS'));
  ensureDir(watchDir);
  const opts = {
    watchDir,
    copyMode: args.copyMode || 'always',
    releaseMode: args.releaseMode || 'copy',
    noClipboard: !!args.noClipboard,
    noReleaseCopy: !!args.noReleaseCopy,
    noNotifySound: !!args.noNotifySound,
    noBrowser: !!args.noBrowser,
    scanExisting: !!args.scanExisting,
    pollMs: Math.max(500, Number(args.pollMs || process.env.LAUNCHCHECK_POLL_MS || 2000))
  };
  const lockInfo = acquireLock(watchDir, args.handoffReady);
  banner(watchDir, reportsDir, opts);
  const knownMtimes = new Map();
  const queued = new Set();
  let queue = Promise.resolve();
  function candidatePathFromName(name) {
    if (!name) return null;
    const s = Buffer.isBuffer(name) ? name.toString('utf8') : String(name);
    if (!isSupportedCandidateName(s)) return null;
    return path.join(watchDir, s);
  }
  function fileMtime(full) {
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return null;
      return st.mtimeMs;
    } catch { return null; }
  }
  function seedExisting(name) {
    const full = candidatePathFromName(name);
    if (!full) return;
    const mtime = fileMtime(full);
    if (mtime != null) knownMtimes.set(full, mtime);
  }
  const enqueue = (full, reason = 'event', force = false) => {
    if (!full || !isSupportedCandidateName(path.basename(full))) return;
    const mtime = fileMtime(full);
    if (mtime == null && !force) return;
    const previous = knownMtimes.get(full);
    if (!force && previous === mtime) return;
    knownMtimes.set(full, mtime == null ? Date.now() : mtime);
    if (queued.has(full)) return;
    queued.add(full);
    queue = queue
      .then(() => validateOne(full, opts, lockInfo))
      .catch(err => console.error(err))
      .finally(() => {
        queued.delete(full);
        const latest = fileMtime(full);
        if (latest != null) knownMtimes.set(full, latest);
      });
  };
  async function startupScan() {
    let entries = [];
    try { entries = fs.readdirSync(watchDir); } catch { return; }
    if (opts.scanExisting) {
      console.log('[LaunchCheck] Startup scan: --scan-existing enabled. Existing ZIP/HTML backlog will be validated.');
      for (const name of entries) {
        const full = candidatePathFromName(name);
        if (full) enqueue(full, 'startup-scan', true);
      }
      return;
    }
    // Seed current files so the polling scanner does not chew the old Downloads backlog.
    for (const name of entries) seedExisting(name);
    console.log('[LaunchCheck] Startup backlog guard: existing Downloads files ignored. Drop or copy a ZIP/HTML after this banner to validate it.');
  }
  function pollWatchDir() {
    let entries = [];
    try { entries = fs.readdirSync(watchDir); }
    catch (err) { console.error(`[LaunchCheck] Poll scan could not read watch folder: ${err.message || err}`); return; }
    for (const name of entries) {
      const full = candidatePathFromName(name);
      if (full) enqueue(full, 'poll');
    }
  }
  await startupScan();
  let nativeWatchOk = false;
  try {
    const nativeWatcher = fs.watch(watchDir, { persistent: true }, (event, filename) => {
      const full = candidatePathFromName(filename);
      if (full) enqueue(full, `fs.watch:${event || 'event'}`);
    });
    nativeWatcher.on('error', err => console.error(`[LaunchCheck] fs.watch error; polling remains active: ${err.message || err}`));
    nativeWatchOk = true;
  } catch (err) {
    console.error(`[LaunchCheck] fs.watch unavailable; polling remains active: ${err.message || err}`);
  }
  console.log(`[LaunchCheck] File detector ready: polling every ${opts.pollMs}ms${nativeWatchOk ? ' with fs.watch assist.' : ' only.'}`);
  setInterval(pollWatchDir, opts.pollMs).unref?.();
}
main().catch(err => { console.error('[LaunchCheck] watcher fatal:', err.stack || err.message || err); process.exit(1); });
