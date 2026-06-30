'use strict';
// LaunchCheck Pass 3 — Static File Analysis
// v4.46.4

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AI_COMMENT_PATTERNS = [
  { key: 'todo',            pattern: /\/\/\s*TODO\b/gi,                        label: 'TODO comment' },
  { key: 'fixme',           pattern: /\/\/\s*FIXME\b/gi,                       label: 'FIXME comment' },
  { key: 'placeholder',     pattern: /\/\/\s*placeholder\b/gi,                 label: 'placeholder comment' },
  { key: 'stub',            pattern: /\/\/\s*stub\b/gi,                        label: 'stub comment' },
  { key: 'dummy',           pattern: /\/\/\s*dummy\b/gi,                       label: 'dummy comment' },
  { key: 'not_implemented', pattern: /\/\/\s*not\s+implemented\b/gi,           label: 'not-implemented comment' },
  { key: 'hardcoded',       pattern: /\/\/\s*hardcoded\b/gi,                   label: 'hardcoded comment' },
  { key: 'temp_comment',    pattern: /\/\/\s*temp\b/gi,                        label: 'temp comment' },
  { key: 'alert_call',      pattern: /\balert\s*\(/g,                          label: 'alert() call' },
  { key: 'debug_comment',   pattern: /\/\/\s*debug\b/gi,                       label: 'debug comment' },
];

const SECRET_PATTERNS = [
  { key: 'openai_key',     pattern: /['"`]sk-[A-Za-z0-9\-_]{20,}['"`]/g,                       label: 'OpenAI API key' },
  { key: 'bearer_token',   pattern: /Bearer\s+[A-Za-z0-9\-_\.]{20,}/gi,                        label: 'Bearer token' },
  { key: 'long_hex',       pattern: /['"`][0-9a-fA-F]{40,64}['"`]/g,                           label: 'Long hex string (possible secret)' },
  { key: 'credential_var', pattern: /(?:password|apiKey|api_key|secret|token|authToken|auth_token)\s*[=:]\s*['"`][^'"` \n\r]{8,}['"`]/gi, label: 'Hardcoded credential' },
  { key: 'aws_key',        pattern: /['"`]AKIA[0-9A-Z]{16}['"`]/g,                             label: 'AWS access key' },
];

const TIME_BOMB_PATTERNS = [
  { key: 'hardcoded_date', pattern: /new\s+Date\s*\(\s*['"`]\d{4}-\d{2}-\d{2}/g,              label: 'Hardcoded date in Date constructor' },
  { key: 'trial_expiry',   pattern: /\b(?:trialDays|trialExpiry|trial_expiry|licenseExpiry|license_expiry|expiresAt|expires_at)\b/gi, label: 'Trial/license expiry variable' },
  { key: 'date_gate',      pattern: /new\s+Date\s*\(\s*\)\s*[><=!]+\s*new\s+Date\s*\(/g,      label: 'Date comparison gate (possible time-lock)' },
];

function countConsoleLog(source) {
  const matches = source.match(/\bconsole\.log\s*\(/g);
  return matches ? matches.length : 0;
}

// Files that define scanner patterns — do not flag their own pattern definitions as product defects.
const SCANNER_SELF_BASENAMES = new Set(['staticAnalysis.js']);

// Heuristic: a JS file is a Node.js CLI operational tool (not browser code) if it uses
// require.main or process.argv — console.log in these files is intentional operator output.
function isCLIOperational(source) {
  return /require\.main\s*===?\s*module|process\.argv|main\(\)\.catch\s*\(/.test(source);
}

function scanFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isJs   = ['.js', '.mjs', '.cjs'].includes(ext);
  const isHtml = ['.html', '.htm'].includes(ext);
  if (!isJs && !isHtml) return null;
  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const basename = path.basename(filePath);
  const isScannerSelf = SCANNER_SELF_BASENAMES.has(basename);
  const isCLI = isJs && isCLIOperational(source);
  const result = { file: filePath, isJs, isHtml, isCLI, aiComments: [], secrets: [], timeBombs: [], consoleLogs: 0, bytes: Buffer.byteLength(source, 'utf8') };
  if (isJs) {
    // Skip AI-comment and time-bomb checks on the scanner itself — its own pattern
    // definitions contain the very strings it searches for, producing false positives.
    if (!isScannerSelf) {
      for (const { key, pattern, label } of AI_COMMENT_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = source.match(pattern);
        if (matches && matches.length) result.aiComments.push({ key, label, count: matches.length });
      }
      for (const { key, pattern, label } of TIME_BOMB_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = source.match(pattern);
        if (matches && matches.length) result.timeBombs.push({ key, label, count: matches.length });
      }
    }
    for (const { key, pattern, label } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = source.match(pattern);
      if (matches && matches.length) result.secrets.push({ key, label, count: matches.length });
    }
    result.consoleLogs = countConsoleLog(source);
  }
  return result;
}

function detectComplexityCliffs(currentManifest, prevManifest) {
  if (!prevManifest || !currentManifest) return [];
  const cliffs = [];
  for (const [relPath, cur] of Object.entries(currentManifest)) {
    const prev = prevManifest[relPath];
    if (!prev || !prev.bytes || !cur.bytes) continue;
    const ratio = cur.bytes / prev.bytes;
    if (ratio < 0.50) {
      cliffs.push({ file: relPath, prevBytes: prev.bytes, curBytes: cur.bytes, ratio: ratio.toFixed(2), type: 'shrank', message: `File shrank ${Math.round((1-ratio)*100)}% (${prev.bytes}B→${cur.bytes}B) — AI may have lobotomized it` });
    } else if (ratio > 3.0) {
      cliffs.push({ file: relPath, prevBytes: prev.bytes, curBytes: cur.bytes, ratio: ratio.toFixed(2), type: 'bloated', message: `File grew ${ratio.toFixed(1)}x (${prev.bytes}B→${cur.bytes}B) — uncontrolled sprawl suspected` });
    }
  }
  return cliffs;
}

function runStaticAnalysis(files, prevManifest, currentManifest) {
  const NOISE_THRESHOLD = 5;
  const summary = {
    schema: 'launchcheck.staticAnalysis/v1',
    scannedFiles: 0,
    aiCommentTotal: 0,
    aiCommentTypes: {},
    secretHits: [],
    timeBombHits: [],
    consoleLogTotal: 0,
    consoleLogNoisyFiles: [],
    complexityCliffs: [],
    findings: [],
  };

  for (const filePath of files || []) {
    const r = scanFile(filePath);
    if (!r) continue;
    summary.scannedFiles++;
    for (const { key, label, count } of r.aiComments) {
      summary.aiCommentTotal += count;
      summary.aiCommentTypes[key] = (summary.aiCommentTypes[key] || 0) + count;
    }
    for (const hit of r.secrets) summary.secretHits.push({ file: path.basename(filePath), ...hit });
    for (const hit of r.timeBombs) summary.timeBombHits.push({ file: path.basename(filePath), ...hit });
    if (r.consoleLogs > 0) {
      // CLI operational files (watcher, daemon, etc.) use console.log for intentional
      // operator output — do not count them toward the browser-debug-noise total.
      if (!r.isCLI) {
        summary.consoleLogTotal += r.consoleLogs;
        if (r.consoleLogs > NOISE_THRESHOLD) summary.consoleLogNoisyFiles.push({ file: path.basename(filePath), count: r.consoleLogs });
      }
    }
  }

  summary.complexityCliffs = detectComplexityCliffs(currentManifest, prevManifest);

  if (summary.aiCommentTotal > 0) {
    const types = Object.entries(summary.aiCommentTypes).sort(([,a],[,b]) => b - a).map(([k,n]) => `${k}(${n})`).join(', ');
    summary.findings.push({ severity: 'WARN', key: 'static_ai_comments', message: `${summary.aiCommentTotal} AI stub/comment marker(s) in source: ${types}. Suggests unfinished implementation.`, file: 'static-analysis' });
  }
  if (summary.secretHits.length > 0) {
    const labels = summary.secretHits.map(h => `${h.label} in ${h.file}`).join('; ');
    summary.findings.push({ severity: 'ERROR', key: 'static_secret_leak', message: `Possible hardcoded secret/credential: ${labels}. Review before distributing.`, file: 'static-analysis' });
  }
  if (summary.timeBombHits.length > 0) {
    const labels = summary.timeBombHits.map(h => `${h.label} in ${h.file}`).join('; ');
    summary.findings.push({ severity: 'WARN', key: 'static_time_bomb', message: `Possible time-bomb or expiry logic: ${labels}. Behavior may change on a future date.`, file: 'static-analysis' });
  }
  if (summary.consoleLogTotal > 20) {
    summary.findings.push({ severity: 'WARN', key: 'static_console_noise', message: `High console.log noise: ${summary.consoleLogTotal} console.log calls in source files. Remove debug logging before release.`, file: 'static-analysis' });
  }
  for (const cliff of summary.complexityCliffs) {
    summary.findings.push({ severity: cliff.type === 'shrank' ? 'ERROR' : 'WARN', key: `static_complexity_cliff_${cliff.type}`, message: cliff.message, file: cliff.file });
  }

  return summary;
}



function runSyntaxGate(validationRoot) {
  // Hard gate: node --check every JS file in src/ of the validated package.
  // A syntax error that LaunchCheck cannot catch in its own probe is a critical trust gap.
  const result = {
    schema: 'launchcheck.syntaxGate/v1',
    attempted: false,
    srcDir: null,
    filesChecked: 0,
    failures: [],
    findings: [],
  };

  const srcDir = path.join(validationRoot, 'src');
  result.srcDir = srcDir;

  let jsFiles;
  try {
    jsFiles = fs.readdirSync(srcDir)
      .filter(f => /\.(js|mjs|cjs)$/.test(f))
      .map(f => path.join(srcDir, f));
  } catch {
    // No src/ dir — not an error, just nothing to check
    return result;
  }

  if (!jsFiles.length) return result;
  result.attempted = true;

  for (const jsFile of jsFiles) {
    const rel = path.relative(validationRoot, jsFile).replace(/\\/g, '/');
    const check = spawnSync(process.execPath, ['--check', jsFile], { encoding: 'utf8', timeout: 10000 });
    result.filesChecked++;
    if (check.status !== 0) {
      const errLine = (check.stderr || '').split('\n').find(l => l.includes('SyntaxError')) || (check.stderr || '').trim().split('\n')[1] || 'SyntaxError';
      result.failures.push({ file: rel, error: errLine.trim() });
      result.findings.push({
        severity: 'ERROR',
        key: `syntax_error_${path.basename(jsFile, path.extname(jsFile))}`,
        message: `Syntax error in ${rel}: ${errLine.trim()}. File cannot be loaded by Node.js.`,
        file: rel,
      });
    }
  }

  return result;
}

module.exports = { runStaticAnalysis, detectComplexityCliffs, runSyntaxGate };
