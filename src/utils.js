const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
function safeRead(p, fallback = '') { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } }
function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}
function slugify(s) { return String(s || 'item').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'item'; }
function timestampSlug(d = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
}
function defaultWatchDir() {
  const os = require('os');
  const configured = process.env.LAUNCHCHECK_WATCH_DIR;
  const candidates = [
    configured,
    path.join(os.homedir(), 'Downloads'),
    'D:\\DOWNLOADS',
    'D:\\Downloads',
    process.cwd()
  ].filter(Boolean);
  return candidates.find(fileExists) || process.cwd();
}
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function listFiles(root, options = {}) {
  const out = [];
  const max = options.max || 5000;
  function walk(dir) {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (['node_modules', '.git', '_VALIDATION_WORK', '_VALIDATION_REPORTS', '_VALIDATION_STATE', '_VALIDATED_BUILDS'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else out.push(full);
    }
  }
  walk(root);
  return out;
}
function copyRecursive(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d); else fs.copyFileSync(s, d);
  }
}
function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function assertSafeZipEntries(zipPath) {
  let result;
  if (process.platform === 'win32') {
    const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const q = String(zipPath).replace(/'/g, "''");
    const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${q}'); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`;
    result = childProcess.spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  } else {
    result = childProcess.spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  }
  if (result.status !== 0) throw new Error(`Unable to inspect ZIP entries safely: ${(result.stderr || result.stdout || '').trim()}`);
  const entries = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  for (const raw of entries) {
    const entry = raw.replace(/\\/g, '/');
    const segments = entry.split('/').filter(Boolean);
    const unsafe = entry.includes('\0') || entry.startsWith('/') || /^[a-zA-Z]:\//.test(entry) || segments.includes('..');
    if (unsafe) throw new Error(`Unsafe ZIP entry rejected: ${raw}`);
  }
}
function extractZip(zipPath, dest) {
  assertSafeZipEntries(zipPath);
  ensureDir(dest);
  const q = (s) => String(s).replace(/'/g, "''");
  if (process.platform === 'win32') {
    const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const command = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(dest)}' -Force`;
    const r = childProcess.spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Expand-Archive failed: ${(r.stderr || r.stdout || '').trim()}`);
    return;
  }
  const r = childProcess.spawnSync('unzip', ['-q', '-o', zipPath, '-d', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`unzip failed: ${(r.stderr || r.stdout || '').trim()}`);
}
function findProductRoot(root) {
  const direct = ['launchcheck.qa.json', 'package.json', 'product.manifest.json'].map(f => path.join(root, f));
  if (direct.some(fileExists)) return root;
  const queue = [root];
  for (let depth = 0; depth < 3; depth++) {
    const next = [];
    for (const dir of queue) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (['node_modules', '.git'].includes(e.name)) continue;
        if (['launchcheck.qa.json', 'package.json', 'product.manifest.json'].some(f => fileExists(path.join(full, f)))) return full;
        next.push(full);
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return root;
}
function toFileUrl(p) {
  let resolved = path.resolve(p).replace(/\\/g, '/');
  if (!resolved.startsWith('/')) resolved = '/' + resolved;
  return encodeURI('file://' + resolved);
}
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
module.exports = { ensureDir, fileExists, readJson, writeJson, safeRead, sha256File, slugify, timestampSlug, defaultWatchDir, compareVersions, listFiles, copyRecursive, processAlive, assertSafeZipEntries, extractZip, findProductRoot, toFileUrl, parseArgs };
