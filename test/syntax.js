#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['src', 'bin', 'test'];
const files = [];
for (const rootName of roots) {
  const root = path.resolve(__dirname, '..', rootName);
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (fs.statSync(full).isFile() && name.endsWith('.js')) files.push(full);
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
console.log(`[syntax] checked ${files.length} JavaScript files`);
