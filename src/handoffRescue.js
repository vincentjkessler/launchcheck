const fs = require('fs');
const path = require('path');
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
try {
  const watchDir = process.env.LAUNCHCHECK_WATCH_DIR || 'D:\\DOWNLOADS';
  const logDir = ensureDir(path.join(watchDir, '_VALIDATION_WORK', '_HANDOFF'));
  const line = `[${new Date().toISOString()}] handoffRescue invoked in ${process.cwd()} version=${require('../package.json').version} handoff=${process.env.LAUNCHCHECK_HANDOFF || '0'}\n`;
  fs.appendFileSync(path.join(logDir, 'handoff-rescue.log'), line, 'utf8');
} catch (err) {
  // Never fail npm install because the rescue log could not be written.
}
