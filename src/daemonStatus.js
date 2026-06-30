const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { defaultWatchDir, readJson, processAlive, compareVersions } = require('./utils');
const PRODUCT_ID = 'launchcheck-auto-qa-watcher';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i+1];
      if (!next || next.startsWith('--')) opts[key] = true; else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

function parseLaunchCheckVersionFromName(name) {
  const m = String(name || '').match(/launchcheck[_-]auto[_-]qa[_-]watcher[_-]v(\d+)[_.](\d+)(?:[_.](\d+))?\.zip$/i);
  if (!m) return null;
  return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}.${parseInt(m[3] || '0', 10)}`;
}
function scanZipCandidates(dir, bucketName) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const version = parseLaunchCheckVersionFromName(name);
      if (!version) continue;
      const full = path.join(dir, name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      out.push({ version, path: full, source: bucketName, mtimeMs });
    }
  } catch {}
  return out;
}
function findLatestKnownPassBuild(watchDir) {
  const candidates = [];
  candidates.push(...scanZipCandidates(watchDir, 'watch-folder'));
  candidates.push(...scanZipCandidates(path.join(watchDir, '_VALIDATED_BUILDS', 'PASS'), 'validated-pass'));
  candidates.sort((a, b) => {
    const v = compareVersions(a.version, b.version);
    if (v !== 0) return v;
    return (a.mtimeMs || 0) - (b.mtimeMs || 0);
  });
  return candidates[candidates.length - 1] || null;
}

function lockPathFor(watchDir) {
  return path.join(watchDir, '_VALIDATION_WORK', 'launchcheck-active-watcher.json');
}
function latestLiveHandoffPath(watchDir) {
  return path.join(watchDir, '_VALIDATION_WORK', '_HANDOFF', 'live-handoff-latest.json');
}
function readLockStatus(watchDir) {
  const lockPath = lockPathFor(watchDir);
  const lock = readJson(lockPath, null);
  const now = Date.now();
  const heartbeatMs = lock && lock.heartbeatAt ? (now - Date.parse(lock.heartbeatAt)) : null;
  const alive = !!(lock && lock.pid && processAlive(lock.pid));
  const fresh = alive && heartbeatMs != null && heartbeatMs <= 10000;
  const latestPassBuild = findLatestKnownPassBuild(watchDir);
  const activeBehindLatestPass = !!(lock && lock.version && latestPassBuild && compareVersions(latestPassBuild.version, lock.version) > 0);
  return {
    schema: 'launchcheck.daemonStatus/v1',
    productId: PRODUCT_ID,
    watchDir,
    lockPath,
    lockExists: !!lock,
    active: !!fresh,
    alive,
    fresh,
    stale: !!(lock && (!alive || !fresh)),
    version: lock && lock.version || null,
    pid: lock && lock.pid || null,
    heartbeatAt: lock && lock.heartbeatAt || null,
    heartbeatAgeMs: heartbeatMs,
    cwd: lock && lock.cwd || null,
    latestLiveHandoffPath: latestLiveHandoffPath(watchDir),
    latestLiveHandoff: readJson(latestLiveHandoffPath(watchDir), null),
    latestPassBuild,
    activeBehindLatestPass,
    recommendation: activeBehindLatestPass ? `Active watcher ${lock.version} is behind latest PASS build ${latestPassBuild.version}. Download and start the newer public release manually if you trust it.` : (fresh ? 'Active watcher heartbeat is fresh.' : 'Watcher is not active or heartbeat is stale. Start LaunchCheck again.'),
    checkedAt: new Date().toISOString()
  };
}
function killPid(pid) {
  if (!pid) return false;
  let killed = false;
  try { process.kill(Number(pid)); killed = true; } catch {}
  if (process.platform === 'win32') {
    try { childProcess.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); killed = true; } catch {}
  }
  return killed;
}
function printHuman(status) {
  console.log('');
  console.log('============================================================');
  console.log('LaunchCheck daemon status');
  console.log('============================================================');
  console.log(`Watch folder: ${status.watchDir}`);
  console.log(`Active: ${status.active}`);
  console.log(`Alive: ${status.alive}`);
  console.log(`Fresh heartbeat: ${status.fresh}`);
  console.log(`Version: ${status.version || 'n/a'}`);
  console.log(`PID: ${status.pid || 'n/a'}`);
  console.log(`Heartbeat: ${status.heartbeatAt || 'n/a'}`);
  console.log(`Heartbeat age: ${status.heartbeatAgeMs == null ? 'n/a' : status.heartbeatAgeMs + 'ms'}`);
  console.log(`CWD: ${status.cwd || 'n/a'}`);
  console.log(`Lock: ${status.lockPath}`);
  console.log(`Latest release status file: ${status.latestLiveHandoffPath}`);
  if (status.latestPassBuild) {
    console.log(`Latest PASS build: ${status.latestPassBuild.version} @ ${status.latestPassBuild.path}`);
    console.log(`Active behind latest PASS: ${status.activeBehindLatestPass === true}`);
  }
  console.log(`Recommendation: ${status.recommendation || 'n/a'}`);
  if (status.latestLiveHandoff) {
    console.log(`Latest handoff OK: ${status.latestLiveHandoff.ok === true}`);
    console.log(`Latest handoff target: ${status.latestLiveHandoff.targetVersion || 'n/a'}`);
    console.log(`Latest handoff reason: ${status.latestLiveHandoff.reason || 'n/a'}`);
  }
  console.log('============================================================');
}
if (require.main === module) {
  const args = parseArgs();
  const watchDir = path.resolve(args.watch || defaultWatchDir());
  const status = readLockStatus(watchDir);
  if (args.json) console.log(JSON.stringify(status, null, 2)); else printHuman(status);
  if (args.killStale && status.stale && status.pid) {
    const ok = killPid(status.pid);
    console.log(`[LaunchCheck] Stale PID cleanup attempted: ${ok}`);
    try { fs.unlinkSync(status.lockPath); console.log('[LaunchCheck] Stale lock removed.'); } catch {}
  }
  process.exit(status.active ? 0 : 1);
}
module.exports = { readLockStatus, lockPathFor, latestLiveHandoffPath, killPid, findLatestKnownPassBuild };
