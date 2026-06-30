#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertSafeZipEntries } = require('../src/utils');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launchcheck-security-'));
const safeZip = path.join(root, 'safe.zip');
const badZip = path.join(root, 'bad.zip');
const script = `
import zipfile, sys
safe, bad = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(safe, 'w') as z: z.writestr('app/index.html', '<h1>ok</h1>')
with zipfile.ZipFile(bad, 'w') as z: z.writestr('../escape.txt', 'blocked')
`;
const py = process.platform === 'win32' ? 'py' : 'python3';
const args = process.platform === 'win32' ? ['-3', '-c', script, safeZip, badZip] : ['-c', script, safeZip, badZip];
const created = spawnSync(py, args, { encoding: 'utf8' });
if (created.status !== 0) {
  console.error(created.stderr || created.stdout);
  process.exit(created.status || 1);
}
assertSafeZipEntries(safeZip);
let rejected = false;
try { assertSafeZipEntries(badZip); } catch (error) { rejected = /Unsafe ZIP entry rejected/.test(String(error.message)); }
if (!rejected) throw new Error('Archive traversal fixture was not rejected.');
console.log('[security] archive traversal entries are rejected before extraction.');
