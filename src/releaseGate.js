const fs = require('fs');
const path = require('path');
const { ensureDir, writeJson, slugify } = require('./utils');
function bucketFor(result) {
  if (result.unsafe) return 'UNSAFE';
  if (result.progress && result.progress.grade === 'REGRESSED') return 'REGRESSION';
  if (result.status === 'PASS' && (result.warningCount || 0) === 0) return 'PASS';
  if (result.status === 'WARN' || (result.warningCount || 0) > 0) return 'WARN';
  if (result.status === 'FAIL' || (result.errorCount || 0) > 0) return 'FAIL';
  return 'UNKNOWN';
}
async function releaseGate(filePath, result, options = {}) {
  const started = new Date().toISOString();
  const bucket = bucketFor(result);
  const gate = {
    schema: 'launchcheck.releaseGate/v1',
    attempted: !options.noReleaseCopy,
    bucket,
    action: options.noReleaseCopy ? 'disabled' : (options.releaseMode || 'copy'),
    copiedPath: null,
    receiptPath: null,
    failureReason: null,
    started,
    finished: null
  };
  if (options.noReleaseCopy) { gate.finished = new Date().toISOString(); return gate; }
  try {
    const baseDir = options.watchDir || path.dirname(filePath);
    const releaseRoot = path.join(baseDir, '_VALIDATED_BUILDS', bucket);
    ensureDir(releaseRoot);
    const ext = path.extname(filePath) || '.bin';
    const base = slugify(path.basename(filePath, ext));
    let target = path.join(releaseRoot, `${base}${ext}`);
    if (fs.existsSync(target)) target = path.join(releaseRoot, `${base}_${Date.now()}${ext}`);
    const wantsMove = String(options.releaseMode || 'copy').toLowerCase() === 'move';
    const isLaunchCheckUpdate = result.productId === 'launchcheck-auto-qa-watcher';
    if (wantsMove && !isLaunchCheckUpdate) {
      fs.renameSync(filePath, target);
      gate.action = 'move';
    } else {
      fs.copyFileSync(filePath, target);
      gate.action = wantsMove && isLaunchCheckUpdate ? 'safe-copy' : 'copy';
    }
    gate.copiedPath = target;
    const receiptPath = target.replace(new RegExp(`${ext.replace('.', '\\.')}$`), '.launchcheck-receipt.json');
    const receipt = {
      schema: 'launchcheck.receipt/v1',
      productId: result.productId,
      productName: result.productName,
      productVersion: result.productVersion,
      status: result.status,
      progressGrade: result.progress ? result.progress.grade : null,
      bucket,
      action: gate.action,
      sourcePath: filePath,
      copiedPath: target,
      reportHtml: result.reportHtml,
      reportJson: result.reportJson,
      aiPacketPath: result.aiPacketPath,
      fixPromptPath: result.fixPromptPath,
      inputSha256: result.inputSha256,
      score: result.score ? result.score.score : null,
      verdict: result.score ? result.score.verdict : null,
      writtenAt: new Date().toISOString()
    };
    writeJson(receiptPath, receipt);
    gate.receiptPath = receiptPath;
  } catch (err) {
    gate.failureReason = err && err.message ? err.message : String(err);
  }
  gate.finished = new Date().toISOString();
  return gate;
}
module.exports = { releaseGate, bucketFor };
