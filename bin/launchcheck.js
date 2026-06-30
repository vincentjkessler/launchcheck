#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const command = process.argv[2] || 'help';
const rest = process.argv.slice(3);
const root = path.resolve(__dirname, '..');

const entries = {
  watch: path.join(root, 'src', 'watcher.js'),
  worker: path.join(root, 'src', 'watcher.js'),
  status: path.join(root, 'src', 'daemonStatus.js'),
  validate: path.join(root, 'src', 'validator.js')
};

function help(exitCode = 0) {
  console.log(`LaunchCheck ${require('../package.json').version}

Usage:
  launchcheck watch [--watch <folder>] [--no-browser]
  launchcheck validate <zip-or-html> [--watch <folder>] [--no-browser]
  launchcheck status [--watch <folder>] [--json]
  launchcheck worker [--watch <folder>] [--no-browser]

Environment:
  LAUNCHCHECK_WATCH_DIR   Default watched folder when --watch is omitted.
`);
  process.exit(exitCode);
}

if (command === 'help' || command === '--help' || command === '-h') help(0);
if (command === '--version' || command === '-v' || command === 'version') {
  console.log(require('../package.json').version);
  process.exit(0);
}
if (!entries[command]) {
  console.error(`Unknown command: ${command}`);
  help(2);
}
if (command === 'validate' && !rest.length) {
  console.error('validate requires a ZIP or HTML path.');
  help(2);
}

const result = spawnSync(process.execPath, [entries[command], ...rest], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
