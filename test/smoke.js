#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateCandidate } = require('../src/validator');

(async () => {
  const input = path.resolve(__dirname, '..', 'sample-good-app', 'index.html');
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchcheck-smoke-'));
  const result = await validateCandidate(input, {
    watchDir,
    noBrowser: true,
    noSelfHandoffProbe: true
  });
  const syntaxErrors = (result.findings || []).filter(f => String(f.key || '').startsWith('syntax_error'));
  if (syntaxErrors.length) throw new Error(`Unexpected syntax errors: ${JSON.stringify(syntaxErrors)}`);
  if (!fs.existsSync(result.reportJson)) throw new Error('JSON report was not written.');
  if (!fs.existsSync(result.aiPacketPath)) throw new Error('AI iteration packet was not written.');
  console.log(`[smoke] status=${result.status} score=${result.score && result.score.score} reports=${result.reportDir}`);
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
