const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ensureDir, fileExists, readJson, writeJson, safeRead, sha256File, slugify, timestampSlug, defaultWatchDir, listFiles, extractZip, findProductRoot, toFileUrl, parseArgs } = require('./utils');
const { loadQaContract, contractSummary } = require('./qaContract');
const productState = require('./productState');
const { computeProgress, metricSummary } = require('./progress');
const { computeScore, scoreSummaryLine } = require('./scoring');
const { captureScreenshotBaselines, compareToBaseline, visualSummaryLine } = require('./visualComparison');
const { runStaticAnalysis, runSyntaxGate } = require('./staticAnalysis');
const { runResponsiveTests } = require('./responsiveTesting');
const { runPerfAndA11y } = require('./perfAndA11y');
const { runSoulCheck, buildAncestryCheck } = require('./soulCheck');
const { runDeepInspect } = require('./deepInspect');
const VALIDATOR_VERSION = require('../package.json').version;
const VALIDATOR_NAME = 'LaunchCheck Auto QA Watcher';

function finding(severity, key, message, file) { return { severity, key, message, file: file || null }; }
function statusFromFindings(findings) {
  if (findings.some(f => f.severity === 'ERROR')) return 'FAIL';
  if (findings.some(f => f.severity === 'WARN')) return 'WARN';
  return 'PASS';
}
function htmlEscape(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function rel(root, p) { return path.relative(root, p).replace(/\\/g, '/'); }


function buildFileManifest(validationRoot, files) {
  const manifest = {};
  for (const file of files || []) {
    const relPath = rel(validationRoot, file);
    if (!relPath || relPath.startsWith('_VALIDATION_') || relPath.startsWith('_VALIDATED_')) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      manifest[relPath] = {
        bytes: stat.size,
        sha256: sha256File(file)
      };
    } catch (_) {}
  }
  return manifest;
}
function normalizeVersionRotatedLaunchCheckFile(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const base = p.split('/').pop() || p;
  const operatorScript = /^(RUN_LAUNCHCHECK|RUN_LAUNCHCHECK_WATCHDOG|RUN_LAUNCHCHECK_SUPERVISOR|RESTART_LAUNCHCHECK|CHECK_LAUNCHCHECK_STATUS|PROMOTE_LAUNCHCHECK_LATEST_PASS)_V4_\d+\.ps1(?:\.txt)?$/i;
  if (operatorScript.test(base)) return p.replace(/_V4_\d+(?=\.ps1(?:\.txt)?$)/i, '_V4_X');
  return p;
}
function buildVersionRotationPairs(added, removed) {
  const addedByNormalized = new Map();
  for (const f of added || []) {
    const key = normalizeVersionRotatedLaunchCheckFile(f);
    if (key !== f) {
      if (!addedByNormalized.has(key)) addedByNormalized.set(key, []);
      addedByNormalized.get(key).push(f);
    }
  }
  const pairs = [];
  const pairedRemoved = new Set();
  const pairedAdded = new Set();
  for (const f of removed || []) {
    const key = normalizeVersionRotatedLaunchCheckFile(f);
    const candidates = addedByNormalized.get(key) || [];
    const match = candidates.find(a => !pairedAdded.has(a));
    if (key !== f && match) {
      pairs.push({ removed: f, added: match, normalized: key });
      pairedRemoved.add(f);
      pairedAdded.add(match);
    }
  }
  return { pairs, pairedRemoved, pairedAdded };
}
function compareFileManifests(current, previous) {
  const cur = current || {};
  const prev = previous || null;
  const currentFiles = Object.keys(cur).sort();
  const summary = {
    schema: 'launchcheck.changeSummary/v1',
    previousAvailable: !!prev,
    currentFileCount: currentFiles.length,
    previousFileCount: prev ? Object.keys(prev).length : 0,
    addedCount: 0,
    removedCount: 0,
    modifiedCount: 0,
    unchangedCount: 0,
    removedRatio: 0,
    riskRemovedCount: 0,
    riskRemovedRatio: 0,
    versionRotationCount: 0,
    versionRotationPairs: [],
    addedFiles: [],
    removedFiles: [],
    modifiedFiles: [],
    riskRemovedFiles: [],
    capped: false,
    notes: []
  };
  if (!prev) {
    summary.notes.push('No previous file manifest available; this validation establishes the file-delta baseline.');
    return summary;
  }
  const prevFiles = Object.keys(prev).sort();
  const curSet = new Set(currentFiles);
  const prevSet = new Set(prevFiles);
  const added = currentFiles.filter(f => !prevSet.has(f));
  const removed = prevFiles.filter(f => !curSet.has(f));
  const modified = currentFiles.filter(f => prevSet.has(f) && prev[f] && cur[f] && prev[f].sha256 !== cur[f].sha256);
  const unchanged = currentFiles.filter(f => prevSet.has(f) && prev[f] && cur[f] && prev[f].sha256 === cur[f].sha256);
  const rotations = buildVersionRotationPairs(added, removed);
  const currentNormalizedFamilies = new Set(currentFiles.map(f => normalizeVersionRotatedLaunchCheckFile(f)));
  const riskRemoved = removed.filter(f => {
    const key = normalizeVersionRotatedLaunchCheckFile(f);
    if (key !== f && currentNormalizedFamilies.has(key)) return false;
    return !rotations.pairedRemoved.has(f);
  });
  summary.addedCount = added.length;
  summary.removedCount = removed.length;
  summary.modifiedCount = modified.length;
  summary.unchangedCount = unchanged.length;
  summary.removedRatio = prevFiles.length ? Number((removed.length / prevFiles.length).toFixed(4)) : 0;
  summary.riskRemovedCount = riskRemoved.length;
  summary.riskRemovedRatio = prevFiles.length ? Number((riskRemoved.length / prevFiles.length).toFixed(4)) : 0;
  summary.versionRotationCount = rotations.pairs.length;
  const cap = 40;
  summary.addedFiles = added.slice(0, cap);
  summary.removedFiles = removed.slice(0, cap);
  summary.modifiedFiles = modified.slice(0, cap);
  summary.riskRemovedFiles = riskRemoved.slice(0, cap);
  summary.versionRotationPairs = rotations.pairs.slice(0, cap);
  summary.capped = added.length > cap || removed.length > cap || modified.length > cap || riskRemoved.length > cap || rotations.pairs.length > cap;
  if (summary.capped) summary.notes.push('File lists are capped to keep the AI packet paste-friendly. See JSON report for full counts.');
  if (summary.versionRotationCount) summary.notes.push(`Ignored ${summary.versionRotationCount} normal LaunchCheck operator-script version rotations when assessing deletion risk.`);
  const staleOperatorRemovals = removed.length - riskRemoved.length - rotations.pairs.length;
  if (staleOperatorRemovals > 0) summary.notes.push(`Ignored ${staleOperatorRemovals} stale retained LaunchCheck operator-script removals because same-family current scripts remain packaged.`);
  if (summary.riskRemovedRatio >= 0.25 && prevFiles.length >= 8) summary.notes.push('Large deletion-risk ratio detected after excluding normal versioned operator-script rotations. Review removed files before trusting this build.');
  if (!summary.addedCount && !summary.removedCount && !summary.modifiedCount) summary.notes.push('No file-level changes detected against the previous manifest.');
  return summary;
}
function fileManifestDigest(manifest) {
  const files = Object.keys(manifest || {}).sort();
  const hash = require('crypto').createHash('sha256');
  for (const f of files) {
    const item = manifest[f] || {};
    hash.update(f + '\0' + (item.bytes || 0) + '\0' + (item.sha256 || '') + '\n');
  }
  return { schema: 'launchcheck.fileManifestDigest/v1', fileCount: files.length, sha256: hash.digest('hex'), sampleFiles: files.slice(0, 25) };
}

async function validateBrowserEntry(result, entryPath, contract, previousRecord, screenshotsDir, options) {
  if (options.noBrowser) {
    result.runtimeEvidence.push({ htmlFile: rel(result.validationRoot, entryPath), skipped: true, reason: '--no-browser' });
    return;
  }
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (err) { throw new Error('Playwright is not installed. Run npm install and npx playwright install chromium.'); }
  let browser;
  const evidence = { htmlFile: rel(result.validationRoot, entryPath), consoleErrors: [], pageErrors: [], requestFailures: [], priorStateLoad: { attempted: false, ok: false }, stateTest: { attempted: false, ok: false }, interactionSummary: { totalControls: 0, clickedControls: 0 } };
  result.runtimeEvidence.push(evidence);
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) evidence.consoleErrors.push(msg.text()); });
    page.on('pageerror', err => evidence.pageErrors.push(err.message || String(err)));
    page.on('requestfailed', req => evidence.requestFailures.push(`${req.url()} :: ${req.failure() && req.failure().errorText}`));
    await page.goto(toFileUrl(entryPath), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(250);
    const baseShot = path.join(screenshotsDir, `${path.basename(entryPath)}-baseline.png`);
    await page.screenshot({ path: baseShot, fullPage: true });
    result.screenshots.push(rel(result.reportDir, baseShot));
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const txt of contract.requiredText) {
      if (!bodyText.includes(txt)) result.findings.push(finding('ERROR', `required_text:${txt}`, `Required text not found: ${txt}`, rel(result.validationRoot, entryPath)));
    }
    for (const selector of contract.requiredSelectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (!count) result.findings.push(finding('ERROR', `required_selector:${selector}`, `Required selector not found: ${selector}`, rel(result.validationRoot, entryPath)));
    }
    for (const fn of contract.requiredWindowFunctions) {
      const ok = await page.evaluate(name => typeof window[name] === 'function', fn).catch(() => false);
      if (!ok) result.findings.push(finding('ERROR', `required_function:${fn}`, `Required window function missing: ${fn}`, rel(result.validationRoot, entryPath)));
    }
    if (previousRecord && previousRecord.statePayload) {
      evidence.priorStateLoad.attempted = true;
      result.metrics.priorStateLoadedCount += 1;
      const loaded = await page.evaluate((payload) => {
        if (typeof window.importState !== 'function') return { ok: false, message: 'importState unavailable' };
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        window.importState(data);
        return { ok: true, message: 'Loaded previous product state through importState().' };
      }, previousRecord.statePayload).catch(err => ({ ok: false, message: err.message || String(err) }));
      evidence.priorStateLoad = { attempted: true, ok: !!loaded.ok, importName: 'importState', message: loaded.message, stateSize: String(previousRecord.statePayload).length, fromVersion: previousRecord.version, fromStatus: previousRecord.lastStatus, capturedAt: previousRecord.lastValidatedAt };
      if (!loaded.ok) result.metrics.priorStateLoadFailedCount += 1;
    }
    // Pass 1 — expanded control detection + interaction dead-end map
    const CLICKABLE_SEL = 'button, [role="button"]:not(button), input[type="submit"], input[type="button"], input[type="reset"], a[href]:not([href="#"]):not([href=""])';
    const INPUT_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea';
    await page.evaluate(() => {
      window._lcMut = 0;
      window._lcObs = new MutationObserver(() => { window._lcMut++; });
      window._lcObs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    }).catch(() => {});
    const clickableHandles = await page.locator(CLICKABLE_SEL).elementHandles().catch(() => []);
    const inputHandles     = await page.locator(INPUT_SEL).elementHandles().catch(() => []);
    const totalClickable   = clickableHandles.length;
    const totalInputs      = inputHandles.length;
    const totalControls    = totalClickable + totalInputs;
    evidence.interactionSummary.totalControls   = totalControls;
    evidence.interactionSummary.totalClickable  = totalClickable;
    evidence.interactionSummary.totalInputs     = totalInputs;
    result.metrics.totalControls  += totalControls;
    result.metrics.totalClickable  = (result.metrics.totalClickable  || 0) + totalClickable;
    result.metrics.totalInputs     = (result.metrics.totalInputs     || 0) + totalInputs;
    let clicked = 0, deadControls = 0;
    const deadControlLabels = [];
    for (const h of clickableHandles) {
      try {
        const mutBefore = await page.evaluate(() => window._lcMut || 0).catch(() => 0);
        await h.click({ timeout: 2500 });
        clicked++;
        await page.waitForTimeout(80);
        const mutAfter = await page.evaluate(() => window._lcMut || 0).catch(() => mutBefore + 1);
        if (mutAfter === mutBefore) {
          const lbl = await h.evaluate(el => (el.textContent || el.value || el.title || el.ariaLabel || el.id || el.tagName || '').trim().slice(0, 60)).catch(() => '?');
          deadControls++;
          deadControlLabels.push(lbl || '?');
        }
      } catch (err) {
        result.findings.push(finding('WARN', 'control_click_failed', `A visible control could not be clicked: ${err.message || err}`, rel(result.validationRoot, entryPath)));
      }
    }
    let inputsInteracted = 0;
    for (const h of inputHandles) {
      try { await h.click({ timeout: 2500 }); inputsInteracted++; await page.waitForTimeout(40); } catch (_) {}
    }
    evidence.interactionSummary.clickedControls   = clicked;
    evidence.interactionSummary.inputsInteracted  = inputsInteracted;
    evidence.interactionSummary.deadControls      = deadControls;
    evidence.interactionSummary.deadControlLabels = deadControlLabels.slice(0, 20);
    result.metrics.clickedControls  += clicked;
    result.metrics.inputsInteracted  = (result.metrics.inputsInteracted || 0) + inputsInteracted;
    if (deadControls > 0) {
      result.findings.push(finding('WARN', 'dead_controls', `${deadControls} control(s) clicked with no DOM effect (may be unimplemented): ${deadControlLabels.slice(0, 5).join(', ')}`, rel(result.validationRoot, entryPath)));
    }
    let workflowIndex = 0;
    for (const wf of contract.workflows) {
      workflowIndex++;
      if (!wf || !Array.isArray(wf.steps)) continue;
      try {
        for (const step of wf.steps) {
          if (step.action === 'click') await page.locator(step.selector).first().click({ timeout: 5000 });
          if (step.action === 'fill') await page.locator(step.selector).first().fill(step.value || '', { timeout: 5000 });
          if (step.action === 'expectText') {
            const text = await page.locator(step.selector || 'body').innerText({ timeout: 5000 });
            if (!text.includes(step.text)) throw new Error(`Expected text missing: ${step.text}`);
          }
          await page.waitForTimeout(80);
        }
        const shot = path.join(screenshotsDir, `qa-${String(workflowIndex).padStart(2,'0')}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        result.screenshots.push(rel(result.reportDir, shot));
      } catch (err) {
        const label = wf.name || `workflow ${workflowIndex}`;
        result.failedWorkflows.push(label);
        result.findings.push(finding('ERROR', `workflow:${label}`, `Workflow failed: ${label}: ${err.message || err}`, rel(result.validationRoot, entryPath)));
      }
    }
    const stateFnsPresent = await page.evaluate(() => typeof window.exportState === 'function' && typeof window.importState === 'function').catch(() => false);
    evidence.stateTest.attempted = stateFnsPresent;
    if (stateFnsPresent) {
      result.metrics.stateAttemptedCount += 1;
      const exported = await page.evaluate(() => window.exportState()).catch(err => ({ __error: err.message || String(err) }));
      const payload = typeof exported === 'string' ? exported : JSON.stringify(exported);
      await page.evaluate((payload) => {
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        window.importState(data);
      }, payload);
      const exportedAgain = await page.evaluate(() => window.exportState()).catch(() => null);
      const payloadAgain = typeof exportedAgain === 'string' ? exportedAgain : JSON.stringify(exportedAgain);
      const ok = payload === payloadAgain;
      evidence.stateTest = { attempted: true, ok, required: !!contract.stateRequired, message: `State export/import functions executed. Export size: ${payload.length} characters.`, exportName: 'exportState', importName: 'importState', exportedState: payload, exportedStateSize: payload.length, exportedStateTruncated: false };
      result.exportedStates.push({ htmlFile: rel(result.validationRoot, entryPath), roundTripOk: ok, exportFunction: 'exportState', importFunction: 'importState', stateSize: payload.length, statePayload: payload });
      if (ok) result.metrics.stateOkCount += 1;
      else result.findings.push(finding('ERROR', 'state_round_trip_failed', 'exportState/importState round trip did not preserve state.', rel(result.validationRoot, entryPath)));
    } else if (contract.stateRequired) {
      result.findings.push(finding('ERROR', 'state_functions_missing', 'State is required but exportState/importState are unavailable.', rel(result.validationRoot, entryPath)));
    }
    result.metrics.consoleErrors += evidence.consoleErrors.length;
    result.metrics.pageErrors += evidence.pageErrors.length;
    result.metrics.requestFailures += evidence.requestFailures.length;
    for (const msg of evidence.consoleErrors) result.findings.push(finding('ERROR', `console:${msg.slice(0,80)}`, `Console error: ${msg}`, rel(result.validationRoot, entryPath)));
    for (const msg of evidence.pageErrors) result.findings.push(finding('ERROR', `page:${msg.slice(0,80)}`, `Page error: ${msg}`, rel(result.validationRoot, entryPath)));
    for (const msg of evidence.requestFailures) result.findings.push(finding('WARN', `request:${msg.slice(0,80)}`, `Request failed: ${msg}`, rel(result.validationRoot, entryPath)));

    // Pass 2 — Responsive testing (mobile/tablet/desktop viewports)
    result.responsiveTesting = await runResponsiveTests(page, entryPath, rel, result);
    for (const f of (result.responsiveTesting.findings || [])) result.findings.push(f);

    // Pass 4 — Performance / offline / keyboard / undo
    result.perfAndA11y = await runPerfAndA11y(page, entryPath, rel, result);
    for (const f of (result.perfAndA11y.findings || [])) result.findings.push(f);

    // Pass 6 (browser) — Soul check + QA auto-generator + zombie features
    result.soulCheck = await runSoulCheck(page, contract, entryPath, rel, result);
    for (const f of (result.soulCheck.findings || [])) result.findings.push(f);

    // Pass 7 (browser) — AI honesty + clipboard poison + deep interaction map
    result.deepInspect = await runDeepInspect(page, contract, entryPath, rel, result, options);
    for (const f of (result.deepInspect.findings || [])) result.findings.push(f);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function buildFixPrompt(result) {
  const lines = [];
  lines.push(`Fix ${result.productName} ${result.productVersion}.`);
  lines.push(`Status: ${result.status}. Errors: ${result.errorCount}. Warnings: ${result.warningCount}.`);
  if (result.score) lines.push(`Score: ${result.score.score}/100 | Verdict: ${result.score.verdict.label} (${result.score.verdict.tier}) | ${result.score.verdict.reason}`);
  lines.push('Preserve product identity, QA contract, state export/import, and release-gate behavior.');
  if (result.historyInsights && result.historyInsights.fixPromptAddendum && result.historyInsights.fixPromptAddendum.length) {
    lines.push('');
    lines.push('History context (from prior builds):');
    for (const note of result.historyInsights.fixPromptAddendum) lines.push(`- ${note}`);
  }
  if (result.findings.length) {
    lines.push('Findings:');
    for (const f of result.findings) lines.push(`- ${f.severity}: ${f.message}${f.file ? ` (${f.file})` : ''}`);
  } else {
    lines.push('No findings. Review manually for product correctness and next feature direction.');
  }
  if (result.releaseGate) lines.push(`Release gate: ${result.releaseGate.bucket} / ${result.releaseGate.action} / ${result.releaseGate.copiedPath || 'no copy'} / ${result.releaseGate.receiptPath || 'no receipt'}`);
  return lines.join('\n');
}
function buildPacket(result) {
  const lines = [];
  lines.push('AI ITERATION PACKET - LAUNCHCHECK');
  lines.push('');
  lines.push('Use this packet to produce the next corrected version of the software. It includes product identity, QA contract summary, bugs, state, workflow failures, release gate, and report paths.');
  lines.push('');
  lines.push('NON-NEGOTIABLE RULES FOR NEXT ITERATION:');
  lines.push('1. Do not remove features to silence errors. Fix the actual cause.');
  lines.push('2. Preserve existing UI, behavior, product identity, and QA contract unless the requested change explicitly requires updating them.');
  lines.push('3. Keep or add product-specific launchcheck.qa.json / embedded QA strategy.');
  lines.push('4. Keep or add exportState(), importState(state), getDefaultState(), validateState(state), and migrateState(oldState) when the product has settings, scene state, camera state, generated outputs, tabs, sliders, coordinates, or user-created data.');
  lines.push('5. If state is included below, use it to restore continuity and avoid making the software re-run unnecessary setup on the next pass.');
  lines.push('6. Preserve release-gate copy/receipt output and include release-gate fields in reports and packet.');
  lines.push('7. Return a complete corrected ZIP/build, not a partial patch.');
  lines.push('');
  lines.push('PRODUCT / BUILD IDENTITY:');
  lines.push(`Product ID: ${result.productId}`);
  lines.push(`Raw Product ID: ${result.productId}`);
  lines.push(`Product name: ${result.productName}`);
  lines.push(`Product version: ${result.productVersion}`);
  lines.push(`Product family: ${result.productFamily || 'n/a'}`);
  lines.push(`Manifest source: ${result.manifestSource || 'n/a'}`);
  lines.push(`Package name: ${result.packageName || result.productId}`);
  lines.push(`Input: ${result.input}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Standalone HTML input: ${result.standaloneHtmlInput === true}`);
  lines.push(`Validation root: ${result.validationRoot}`);
  lines.push(`Product continuity file: ${result.productContinuityFile || 'n/a'}`);
  lines.push(`Saved product state file: ${result.savedProductStateFile || 'n/a'}`);
  lines.push(`Input SHA-256: ${result.inputSha256 || 'n/a'}`);
  lines.push(`Validator: ${VALIDATOR_NAME} ${VALIDATOR_VERSION}`);
  lines.push(`Started: ${result.started}`);
  lines.push(`Finished: ${result.finished || 'n/a'}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Errors: ${result.errorCount}`);
  lines.push(`Warnings: ${result.warningCount}`);
  lines.push(`Info: ${result.infoCount}`);
  lines.push(`Progress grade: ${result.progress ? result.progress.grade : 'n/a'}`);
  lines.push(`Progress previous/current: ${result.progress && result.progress.previousStatus ? result.progress.previousStatus : 'n/a'} -> ${result.progress ? result.progress.currentStatus : 'n/a'}`);
  lines.push('');
  lines.push('RELEASE GATE:');
  const rg = result.releaseGate || { attempted: false, bucket: 'UNKNOWN', action: 'none' };
  lines.push(`Attempted: ${rg.attempted === true}`);
  lines.push(`Bucket: ${rg.bucket || 'UNKNOWN'}`);
  lines.push(`Action: ${rg.action || 'none'}`);
  lines.push(`Copied path: ${rg.copiedPath || 'n/a'}`);
  lines.push(`Receipt path: ${rg.receiptPath || 'n/a'}`);
  lines.push(`Failure reason: ${rg.failureReason || 'n/a'}`);
  lines.push('');
  lines.push('READY NOTIFICATION:');
  const nt = result.notification || { clipboardOk: null, readyToPaste: { attempted: false, ok: false } };
  const rp = nt.readyToPaste || {};
  lines.push(`Clipboard copied: ${nt.clipboardOk === true}`);
  lines.push(`Dinger attempted: ${rp.attempted === true}`);
  lines.push(`Terminal bell OK: ${rp.terminalBellOk === true}`);
  lines.push(`Windows sound OK: ${rp.windowsSoundOk === true}`);
  lines.push(`Console beep OK: ${rp.consoleBeepOk === true}`);
  lines.push(`Notification OK: ${rp.ok === true}`);
  lines.push(`Message: ${rp.message || 'n/a'}`);
  lines.push('');
  lines.push('WHAT CHANGED / FILE DELTA:');
  const cs = result.changeSummary || { previousAvailable: false, currentFileCount: 0, previousFileCount: 0, addedCount: 0, removedCount: 0, modifiedCount: 0, unchangedCount: 0, removedRatio: 0, addedFiles: [], removedFiles: [], modifiedFiles: [], notes: [] };
  const md = result.fileManifestDigest || { fileCount: 0, sha256: 'n/a', sampleFiles: [] };
  lines.push(`Previous manifest available: ${cs.previousAvailable === true}`);
  lines.push(`Current manifest files: ${md.fileCount || 0}`);
  lines.push(`Current manifest digest: ${md.sha256 || 'n/a'}`);
  lines.push(`Files previous/current: ${cs.previousFileCount || 0} -> ${cs.currentFileCount || 0}`);
  lines.push(`Added: ${cs.addedCount || 0}`);
  lines.push(`Removed: ${cs.removedCount || 0}`);
  lines.push(`Modified: ${cs.modifiedCount || 0}`);
  lines.push(`Unchanged: ${cs.unchangedCount || 0}`);
  lines.push(`Removed ratio: ${cs.removedRatio || 0}`);
  if (cs.riskRemovedCount != null) lines.push(`Deletion-risk count: ${cs.riskRemovedCount}`);
  if (cs.riskRemovedRatio != null) lines.push(`Deletion-risk ratio: ${cs.riskRemovedRatio}`);
  if (cs.versionRotationCount != null) lines.push(`Version-script rotations ignored: ${cs.versionRotationCount}`);
  if (cs.notes && cs.notes.length) { lines.push('Notes:'); for (const n of cs.notes) lines.push(`- ${n}`); }
  lines.push('Added files:');
  if (!cs.addedFiles || !cs.addedFiles.length) lines.push('- none');
  else for (const f of cs.addedFiles) lines.push(`- ${f}`);
  lines.push('Removed files:');
  if (!cs.removedFiles || !cs.removedFiles.length) lines.push('- none');
  else for (const f of cs.removedFiles) lines.push(`- ${f}`);
  lines.push('Modified files:');
  if (!cs.modifiedFiles || !cs.modifiedFiles.length) lines.push('- none');
  else for (const f of cs.modifiedFiles) lines.push(`- ${f}`);
  lines.push('Current manifest sample:');
  if (!md.sampleFiles || !md.sampleFiles.length) lines.push('- none');
  else for (const f of md.sampleFiles) lines.push(`- ${f}`);
  lines.push('');
  lines.push('REPORT FILES:');
  lines.push(`HTML report: ${result.reportHtml}`);
  lines.push(`JSON report: ${result.reportJson}`);
  lines.push(`Fix prompt: ${result.fixPromptPath}`);
  lines.push(`AI iteration packet: ${result.aiPacketPath}`);
  lines.push('');
  lines.push('PRODUCT COMPLETENESS SCORE:');
  const sc = result.score || {};
  const sv = sc.verdict || {};
  lines.push(`Score: ${sc.score != null ? sc.score : 'n/a'}/100`);
  lines.push(`Verdict: ${sv.label || 'n/a'} (${sv.tier || 'n/a'})`);
  lines.push(`Reason: ${sv.reason || 'n/a'}`);
  lines.push(`Grade: ${sc.grade || 'n/a'}`);
  if (sc.breakdown) {
    const b = sc.breakdown;
    lines.push(`  Build errors:  ${b.buildErrors ? b.buildErrors.earned : '?'}/${b.buildErrors ? b.buildErrors.max : '?'} (${b.buildErrors ? b.buildErrors.errors : '?'} errors)`);
    lines.push(`  Warnings:      ${b.warnings ? b.warnings.earned : '?'}/${b.warnings ? b.warnings.max : '?'} (${b.warnings ? b.warnings.warnings : '?'} warnings)`);
    lines.push(`  Workflows:     ${b.workflows ? b.workflows.earned : '?'}/${b.workflows ? b.workflows.max : '?'} (${b.workflows ? b.workflows.passed : '?'}/${b.workflows ? b.workflows.total : '?'} passed)`);
    lines.push(`  State:         ${b.state ? b.state.earned : '?'}/${b.state ? b.state.max : '?'} (round-trip ${b.state && b.state.ok > 0 ? 'OK' : 'n/a'}, prior-load ${b.state && b.state.priorLoaded > 0 ? 'OK' : 'n/a'})`);
    lines.push(`  Controls:      ${b.controls ? b.controls.earned : '?'}/${b.controls ? b.controls.max : '?'} (${b.controls ? b.controls.clicked : '?'}/${b.controls ? b.controls.total : '?'} clicked)`);
    lines.push(`  QA richness:   ${b.qaContract ? b.qaContract.earned : '?'}/${b.qaContract ? b.qaContract.max : '?'}`);
    lines.push(`  Regression:    ${b.regression ? b.regression.earned : '?'}/${b.regression ? b.regression.max : '?'} (${b.regression ? b.regression.grade : '?'})`);
  }
  lines.push('');
  lines.push('VISUAL COMPARISON:');
  const vc = result.visualComparison || {};
  lines.push(`Baseline available: ${vc.baselineAvailable === true}`);
  lines.push(`Screenshots current/baseline: ${vc.totalCurrent || 0} / ${vc.totalBaseline || 0}`);
  lines.push(`Unchanged: ${vc.unchanged || 0}`);
  lines.push(`Changed:   ${vc.changed || 0}`);
  lines.push(`Added:     ${vc.added || 0}`);
  lines.push(`Removed:   ${vc.removed || 0}`);
  if (vc.notes && vc.notes.length) { for (const n of vc.notes) lines.push(`- ${n}`); }
  if (vc.details && vc.details.length) {
    lines.push('Per-screenshot status:');
    for (const d of vc.details) lines.push(`  ${d.status.toUpperCase().padEnd(9)} ${d.name}${d.bytesDelta != null && d.bytesDelta !== 0 ? ` (${d.bytesDelta > 0 ? '+' : ''}${d.bytesDelta} bytes, ${d.bytesDeltaPct != null ? d.bytesDeltaPct + '%' : ''} delta)` : ''}`);
  }
  lines.push('');
  lines.push('STATIC ANALYSIS:');
  const sa = result.staticAnalysis || {};
  lines.push(`Scanned files: ${sa.scannedFiles || 0}`);
  lines.push(`AI comment/stub markers: ${sa.aiCommentTotal || 0}`);
  if (sa.aiCommentTypes && Object.keys(sa.aiCommentTypes).length) {
    lines.push(`  Types: ${Object.entries(sa.aiCommentTypes).map(([k,n]) => `${k}(${n})`).join(', ')}`);
  }
  lines.push(`Secret/credential hits: ${(sa.secretHits || []).length}`);
  if ((sa.secretHits || []).length) {
    for (const h of sa.secretHits) lines.push(`  - ${h.label} in ${h.file}`);
  }
  lines.push(`Time-bomb hits: ${(sa.timeBombHits || []).length}`);
  lines.push(`Console.log noise (source): ${sa.consoleLogTotal || 0}`);
  lines.push(`Complexity cliffs: ${(sa.complexityCliffs || []).length}`);
  if ((sa.complexityCliffs || []).length) {
    for (const c of sa.complexityCliffs) lines.push(`  - ${c.type.toUpperCase()}: ${c.message}`);
  }
  lines.push('');
  lines.push('HISTORY INSIGHTS:');
  const hi = result.historyInsights || {};
  if (!hi.schema) {
    lines.push('Insufficient history for pattern analysis (need 2+ builds).');
  } else {
    lines.push(`Builds analyzed: ${hi.buildsAnalyzed || 0}`);
    if (hi.versionMomentum) lines.push(`Version momentum: ${hi.versionMomentum.summary}`);
    if (hi.regressionFingerprint && hi.regressionFingerprint.recurringFindingKeys && hi.regressionFingerprint.recurringFindingKeys.length) {
      lines.push('Recurring failures (regression fingerprint):');
      for (const r of hi.regressionFingerprint.recurringFindingKeys) lines.push(`  - ${r.label}`);
    }
    if (hi.scopeDrift) {
      const sd = hi.scopeDrift;
      lines.push(`Scope drift: ${sd.drift > 0 ? '+' : ''}${sd.drift} criteria (${sd.firstSize} → ${sd.latestSize})`);
      if (sd.shrank) lines.push('  ⚠ QA contract shrank — AI may have simplified spec to pass. Restore missing criteria.');
    }
    if (hi.fixPromptAddendum && hi.fixPromptAddendum.length) {
      lines.push('Fix prompt addendum:');
      for (const line of hi.fixPromptAddendum) lines.push(`  ${line}`);
    }
  }
  lines.push('');
  lines.push('RESPONSIVE TESTING (Pass 2):');
  const rt = result.responsiveTesting || {};
  if (!rt.schema) {
    lines.push('Not available (requires browser).');
  } else {
    lines.push(`Viewports tested: ${(rt.viewportsTested || []).length}`);
    for (const vp of (rt.viewportsTested || [])) {
      const issues = vp.issues && vp.issues.length ? vp.issues.join('; ') : 'clean';
      lines.push(`  ${vp.name} (${vp.width}x${vp.height}): ${issues}`);
    }
    if (rt.issues && rt.issues.length) {
      lines.push('Issues:');
      for (const i of rt.issues) lines.push(`  - [${i.viewport}] ${i.type}: ${i.detail}`);
    } else {
      lines.push('No responsive issues detected.');
    }
  }
  lines.push('');
  lines.push('PERFORMANCE / A11Y (Pass 4):');
  const pa = result.perfAndA11y || {};
  if (!pa.schema) {
    lines.push('Not available (requires browser).');
  } else {
    if (pa.timing) lines.push(`  Timing: DOMContentLoaded=${pa.timing.domContentLoadedMs}ms, Load=${pa.timing.loadMs}ms, TTFB=${pa.timing.ttfbMs}ms`);
    if (pa.serviceWorker) lines.push(`  Service worker: ${pa.serviceWorker.hasServiceWorker}, Caches API: ${pa.serviceWorker.hasCaches}`);
    if (pa.keyboard) lines.push(`  Keyboard: ${pa.keyboard.focusableElements} focusable, ${pa.keyboard.tabsAttempted} tabbed, ${pa.keyboard.focusVisibleCount} had focus indicators`);
    if (pa.undo) lines.push(`  Undo (Ctrl+Z): attempted=${pa.undo.attempted}, domChangeDetected=${pa.undo.domChangeDetected}`);
  }
  lines.push('');
  lines.push('SOUL CHECK / QA SUGGESTIONS / ZOMBIE FEATURES (Pass 6):');
  const sc6 = result.soulCheck || {};
  if (!sc6.schema) {
    lines.push('Not available.');
  } else {
    lines.push(`  Soul score: ${sc6.soulScore != null ? sc6.soulScore + '%' : 'n/a'} (product name vs visible content vocabulary overlap)`);
    if (sc6.identityMatch) lines.push(`  Page title: "${sc6.identityMatch.pageTitle}" | Headings: "${(sc6.identityMatch.headings || '').slice(0, 60)}"`);
    const qa = sc6.qaAutoSuggestions || {};
    lines.push(`  QA auto-suggestions: ${(qa.suggestedSelectors || []).length} selectors, ${(qa.suggestedTexts || []).length} texts`);
    if ((qa.suggestedSelectors || []).length) for (const s of qa.suggestedSelectors) lines.push(`    Selector: ${s.selector} — ${s.reason}`);
    if ((qa.suggestedTexts || []).length) for (const t of qa.suggestedTexts) lines.push(`    Text: "${t.text}" — ${t.reason}`);
    const zf = sc6.zombieFeatures || {};
    if (zf.count > 0) lines.push(`  Zombie features (${zf.count}): ${(zf.detected || []).slice(0, 5).join(', ')}`);
    const anc = sc6.buildAncestry || {};
    if (anc.sufficient) {
      lines.push(`  Build ancestry: ${anc.buildsTracked} builds tracked, versions: ${(anc.versions || []).join(' → ')}`);
      if (anc.issues && anc.issues.length) for (const i of anc.issues) lines.push(`    ⚠ ${i.type}: ${i.from} → ${i.to}`);
    }
  }
  lines.push('');
  lines.push('DEEP INSPECT (Pass 7):');
  const di = result.deepInspect || {};
  if (!di.schema) {
    lines.push('Not available (requires browser).');
  } else {
    const ah = di.aiHonesty || {};
    lines.push(`  AI honesty: scanned ${ah.scannedChars || 0} chars, ${ah.totalHits || 0} honesty violation(s)`);
    if ((ah.hits || []).length) for (const h of ah.hits) lines.push(`    - ${h.label} (${h.count}x)`);
    const cp = di.clipboardPoison || {};
    lines.push(`  Clipboard poison: attempted=${cp.attempted}, readable=${cp.readable}, poison hits=${(cp.poisonHits || []).length}`);
    const im = di.interactionMap || {};
    lines.push(`  Interaction map: ${im.controlsProbed || 0} controls probed`);
    if ((im.transitions || []).length) {
      const changed = (im.transitions || []).filter(t => t.domChanged).length;
      lines.push(`    DOM-changing controls: ${changed}/${im.controlsProbed || 0}`);
    }
  }
  lines.push('');
  lines.push('PROGRESS / REGRESSION SUMMARY:');
  lines.push(JSON.stringify(result.progress || {}, null, 2));
  lines.push('');
  lines.push('PRODUCT QA CONTRACT SUMMARY:');
  lines.push(JSON.stringify(result.qaContractSummary || {}, null, 2));
  lines.push('');
  lines.push('QA STATIC DETAILS:');
  lines.push(JSON.stringify(result.qaStaticDetails || {}, null, 2));
  lines.push('');
  lines.push('HTML ENTRY POINTS:');
  for (const h of result.htmlEntryPoints || []) lines.push(`- ${h}`);
  lines.push('');
  lines.push('PREVIOUS PRODUCT RECORD:');
  lines.push(JSON.stringify(result.previousProductRecord || null, null, 2));
  lines.push('');
  lines.push('EXPORTED STATE / CONTINUITY CAPSULES:');
  if (!result.exportedStates.length) lines.push('- No exported state captured.');
  for (const s of result.exportedStates) {
    lines.push('');
    lines.push(`State from: ${s.htmlFile}`);
    lines.push(`Round trip OK: ${s.roundTripOk}`);
    lines.push(`Export function: ${s.exportFunction}`);
    lines.push(`Import function: ${s.importFunction}`);
    lines.push(`State size: ${s.stateSize} characters`);
    lines.push('State payload:');
    lines.push(s.statePayload);
  }
  lines.push('');
  lines.push('FAILED PRODUCT WORKFLOWS:');
  if (!result.failedWorkflows.length) lines.push('- No failed product workflows recorded.');
  for (const wf of result.failedWorkflows) lines.push(`- ${wf}`);
  lines.push('');
  lines.push('RUNTIME EVIDENCE:');
  lines.push(JSON.stringify(result.runtimeEvidence || [], null, 2));
  lines.push('');
  lines.push('SCREENSHOTS:');
  if (!result.screenshots.length) lines.push('- No screenshots captured.');
  for (const shot of result.screenshots) lines.push(`- ${shot}`);
  lines.push('');
  lines.push('FINDINGS TO FIX:');
  if (!result.findings.length) lines.push('- No findings. Still review manually for product correctness and next feature direction.');
  for (const f of result.findings) lines.push(`- ${f.severity}: ${f.message}${f.file ? ` (${f.file})` : ''}`);
  lines.push('');
  lines.push('NEXT BUILD REQUIREMENTS:');
  lines.push('- Fix all ERROR findings.');
  lines.push('- Fix WARN findings unless there is a justified reason not to.');
  lines.push('- Preserve and update the embedded QA strategy to cover any new behavior.');
  lines.push('- Preserve or implement state export/import so the next validation can load state instead of starting cold.');
  lines.push('- Preserve release-gate report.releaseGate, output.releaseGate, HTML report panel, AI packet RELEASE GATE section, console output, copiedPath, and receiptPath.');
  lines.push('- Include a Windows PowerShell run block if the build is downloadable.');
  lines.push('');
  lines.push('END AI ITERATION PACKET');
  return lines.join('\n');
}
function buildHtmlReport(result) {
  const release = result.releaseGate || {};
  const notification = result.notification || {};
  const ready = notification.readyToPaste || {};
  const sc = result.score || {};
  const sv = sc.verdict || {};
  const verdictColor = sv.tier === 'store-ready' ? '#6ee7a8' : sv.tier === 'demo-ready' ? '#67d7ff' : sv.tier === 'acceptable-for-human-review' ? '#ffd166' : '#ff6b6b';
  const scoreBar = sc.score != null ? Math.round(sc.score) : 0;
  const vc = result.visualComparison || {};
  const vcLine = vc.baselineAvailable ? `${vc.unchanged||0} unchanged, ${vc.changed||0} changed, ${vc.added||0} added, ${vc.removed||0} removed` : 'Baseline not yet established';
  return `<!doctype html><html><head><meta charset="utf-8"><title>LaunchCheck Report - ${htmlEscape(result.productName)}</title><style>body{font-family:Segoe UI,Arial,sans-serif;background:#101318;color:#f3f6fa;margin:0;padding:24px}main{max-width:1100px;margin:auto}.card{background:#171d26;border:1px solid #2b3545;border-radius:14px;padding:18px;margin:14px 0}code,pre{background:#0b0e13;border:1px solid #293241;border-radius:8px;padding:10px;display:block;overflow:auto}.ok{color:#6ee7a8}.warn{color:#ffd166}.fail{color:#ff6b6b}.score-hero{display:flex;align-items:center;gap:24px;padding:8px 0}.score-ring{font-size:3.2rem;font-weight:900;line-height:1}.score-meta{flex:1}.verdict-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:1rem;color:#101318;margin-bottom:6px}.score-bar-bg{background:#2b3545;border-radius:6px;height:10px;margin-top:8px}.score-bar-fill{height:10px;border-radius:6px;transition:width .3s}.breakdown-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:12px}.bk{background:#0d1117;border:1px solid #2b3545;border-radius:8px;padding:10px}.bk-label{font-size:.75rem;color:#8899aa;text-transform:uppercase;letter-spacing:.05em}.bk-val{font-size:1.4rem;font-weight:700;margin:2px 0}.bk-sub{font-size:.8rem;color:#aab}.visual-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.8rem;font-weight:600;margin-right:4px}</style></head><body><main><h1>LaunchCheck Validator Report</h1>
  <section class="card"><h2>${htmlEscape(result.productName)} ${htmlEscape(result.productVersion)}</h2>
  <p>Status: <strong class="${result.status === 'PASS' ? 'ok' : result.status === 'WARN' ? 'warn' : 'fail'}">${htmlEscape(result.status)}</strong> &nbsp;|&nbsp; Errors: ${result.errorCount} &nbsp;|&nbsp; Warnings: ${result.warningCount} &nbsp;|&nbsp; Progress: ${htmlEscape(result.progress && result.progress.grade)}</p>
  <div class="score-hero">
    <div class="score-ring" style="color:${verdictColor}">${scoreBar}</div>
    <div class="score-meta">
      <div class="verdict-badge" style="background:${verdictColor}">${htmlEscape(sv.label || 'Unknown')}</div>
      <div style="color:#ccd;font-size:.9rem">${htmlEscape(sv.reason || '')}</div>
      <div class="score-bar-bg"><div class="score-bar-fill" style="width:${scoreBar}%;background:${verdictColor}"></div></div>
    </div>
  </div>
  <div class="breakdown-grid">
    ${sc.breakdown ? Object.entries(sc.breakdown).map(([k,v]) => `<div class="bk"><div class="bk-label">${htmlEscape(k)}</div><div class="bk-val" style="color:${v.earned===v.max?'#6ee7a8':v.earned>0?'#ffd166':'#ff6b6b'}">${v.earned}/${v.max}</div></div>`).join('') : ''}
  </div>
  </section>
  <section class="card"><h2>VISUAL COMPARISON</h2><p>Baseline: ${htmlEscape(vc.baselineAvailable ? 'Available' : 'Not yet established')} &nbsp;|&nbsp; ${htmlEscape(vcLine)}</p>${vc.details && vc.details.length ? '<table style="width:100%;border-collapse:collapse;font-size:.85rem"><tr style="color:#8899aa"><th style="text-align:left;padding:4px">Screenshot</th><th style="text-align:left;padding:4px">Status</th><th style="padding:4px">Bytes Δ</th></tr>' + vc.details.map(d => `<tr><td style="padding:4px">${htmlEscape(d.name)}</td><td style="padding:4px"><span class="visual-badge" style="background:${d.status==='unchanged'?'#1e3a2a':d.status==='changed'?'#3a2a00':d.status==='added'?'#1a2e3a':'#3a1a1a'};color:${d.status==='unchanged'?'#6ee7a8':d.status==='changed'?'#ffd166':d.status==='added'?'#67d7ff':'#ff6b6b'}">${htmlEscape(d.status)}</span></td><td style="padding:4px;text-align:right;color:${d.bytesDelta>0?'#ffd166':d.bytesDelta<0?'#ff6b6b':'#8899aa'}">${d.bytesDelta!=null?d.bytesDelta:''}</td></tr>`).join('') + '</table>' : ''}</section><section class="card"><h2>RELEASE GATE</h2><p>Attempted: ${release.attempted === true}</p><p>Bucket: <strong>${htmlEscape(release.bucket || 'UNKNOWN')}</strong></p><p>Action: ${htmlEscape(release.action || 'none')}</p><p>Copied path: ${htmlEscape(release.copiedPath || 'n/a')}</p><p>Receipt path: ${htmlEscape(release.receiptPath || 'n/a')}</p><p>Failure reason: ${htmlEscape(release.failureReason || 'n/a')}</p></section><section class="card"><h2>READY NOTIFICATION</h2><p>Clipboard copied: ${notification.clipboardOk === true}</p><p>Dinger attempted: ${ready.attempted === true}</p><p>Terminal bell OK: ${ready.terminalBellOk === true}</p><p>Windows sound OK: ${ready.windowsSoundOk === true}</p><p>Console beep OK: ${ready.consoleBeepOk === true}</p><p>Notification OK: ${ready.ok === true}</p><p>Message: ${htmlEscape(ready.message || 'n/a')}</p></section><section class="card"><h2>WHAT CHANGED / FILE DELTA</h2><pre>${htmlEscape(JSON.stringify({ digest: result.fileManifestDigest || {}, summary: result.changeSummary || {} }, null, 2))}</pre></section><section class="card"><h2>STATIC ANALYSIS</h2><pre>${htmlEscape(JSON.stringify(result.staticAnalysis || {}, null, 2))}</pre></section><section class="card"><h2>HISTORY INSIGHTS</h2><pre>${htmlEscape(JSON.stringify(result.historyInsights || {}, null, 2))}</pre></section><section class="card"><h2>RESPONSIVE TESTING (Pass 2)</h2><p>Viewports: ${(result.responsiveTesting && result.responsiveTesting.viewportsTested || []).map(v => `${htmlEscape(v.name)} ${v.overflow ? '<span class=\"warn\">overflow</span>' : '<span class=\"ok\">ok</span>'} ${v.controlsOutOfView ? '<span class=\"warn\">' + v.controlsOutOfView + ' unreachable</span>' : ''}`).join(' | ') || 'n/a'}</p>${result.responsiveTesting && (result.responsiveTesting.issues || []).length ? '<ul>' + (result.responsiveTesting.issues || []).map(i => `<li><strong>${htmlEscape(i.viewport)}</strong> — ${htmlEscape(i.type)}: ${htmlEscape(i.detail)}</li>`).join('') + '</ul>' : '<p class=\"ok\">No responsive issues.</p>'}</section><section class="card"><h2>PERFORMANCE / A11Y (Pass 4)</h2>${result.perfAndA11y && result.perfAndA11y.timing ? `<p>DOMContentLoaded: <strong>${htmlEscape(String(result.perfAndA11y.timing.domContentLoadedMs))}ms</strong> &nbsp;|&nbsp; Load: ${htmlEscape(String(result.perfAndA11y.timing.loadMs))}ms &nbsp;|&nbsp; TTFB: ${htmlEscape(String(result.perfAndA11y.timing.ttfbMs))}ms</p>` : '<p>Timing: n/a</p>'}${result.perfAndA11y && result.perfAndA11y.serviceWorker ? `<p>Service Worker: ${result.perfAndA11y.serviceWorker.hasServiceWorker} &nbsp;|&nbsp; Caches API: ${result.perfAndA11y.serviceWorker.hasCaches}</p>` : ''}${result.perfAndA11y && result.perfAndA11y.keyboard ? `<p>Keyboard: ${result.perfAndA11y.keyboard.focusableElements} focusable, ${result.perfAndA11y.keyboard.focusVisibleCount}/${result.perfAndA11y.keyboard.tabsAttempted} had focus indicators</p>` : ''}${result.perfAndA11y && result.perfAndA11y.undo ? `<p>Undo (Ctrl+Z): DOM changed = ${result.perfAndA11y.undo.domChangeDetected}</p>` : ''}</section><section class="card"><h2>SOUL CHECK / QA SUGGESTIONS / ZOMBIE FEATURES (Pass 6)</h2>${result.soulCheck && result.soulCheck.soulScore != null ? `<p>Soul score: <strong>${result.soulCheck.soulScore}%</strong> — product name vs page content vocabulary overlap</p>` : ''}<pre>${htmlEscape(JSON.stringify({ qaAutoSuggestions: result.soulCheck && result.soulCheck.qaAutoSuggestions || {}, zombieFeatures: result.soulCheck && result.soulCheck.zombieFeatures || {}, buildAncestry: result.soulCheck && result.soulCheck.buildAncestry || {} }, null, 2))}</pre></section><section class="card"><h2>DEEP INSPECT (Pass 7)</h2><pre>${htmlEscape(JSON.stringify({ aiHonesty: result.deepInspect && result.deepInspect.aiHonesty || {}, clipboardPoison: result.deepInspect && result.deepInspect.clipboardPoison || {}, interactionMap: result.deepInspect && result.deepInspect.interactionMap || {} }, null, 2))}</pre></section><section class="card"><h2>Findings</h2><pre>${htmlEscape(JSON.stringify(result.findings, null, 2))}</pre></section><section class="card"><h2>Progress</h2><pre>${htmlEscape(JSON.stringify(result.progress, null, 2))}</pre></section><section class="card"><h2>Runtime Evidence</h2><pre>${htmlEscape(JSON.stringify(result.runtimeEvidence, null, 2))}</pre></section><section class="card"><h2>QA Contract Summary</h2><pre>${htmlEscape(JSON.stringify(result.qaContractSummary, null, 2))}</pre></section></main></body></html>`;
}
function rewriteReports(result) {
  if (!result.reportDir) return;
  ensureDir(result.reportDir);
  result.output = result.output || {};
  result.output.releaseGate = result.releaseGate || null;
  result.output.notification = result.notification || null;
  result.output.fileManifest = result.fileManifest || null;
  result.output.fileManifestDigest = result.fileManifestDigest || null;
  result.output.changeSummary = result.changeSummary || null;
  result.report = result.report || {};
  result.report.releaseGate = result.releaseGate || null;
  result.report.notification = result.notification || null;
  result.report.fileManifest = result.fileManifest || null;
  result.report.fileManifestDigest = result.fileManifestDigest || null;
  result.report.changeSummary = result.changeSummary || null;
  fs.writeFileSync(result.fixPromptPath, buildFixPrompt(result), 'utf8');
  fs.writeFileSync(result.aiPacketPath, buildPacket(result), 'utf8');
  fs.writeFileSync(result.reportHtml, buildHtmlReport(result), 'utf8');
  writeJson(result.reportJson, result);
}
function recalcHealth(result, prevRecord) {
  result.status      = statusFromFindings(result.findings);
  result.errorCount  = result.findings.filter(f => f.severity === 'ERROR').length;
  result.warningCount = result.findings.filter(f => f.severity === 'WARN').length;
  result.infoCount   = result.findings.filter(f => f.severity === 'INFO').length;
  result.metrics     = metricSummary(result);
  result.progress    = computeProgress(result, prevRecord);
  result.score       = computeScore(result);
}
async function validateCandidate(inputPath, options = {}) {
  const started = new Date().toISOString();
  const input = path.resolve(inputPath);
  const watchDir = options.watchDir || path.dirname(input) || defaultWatchDir();
  const reportRoot = ensureDir(path.join(watchDir, '_VALIDATION_REPORTS'));
  const workRoot = ensureDir(path.join(watchDir, '_VALIDATION_WORK'));
  ensureDir(path.join(watchDir, '_VALIDATION_STATE'));
  const ext = path.extname(input).toLowerCase();
  const mode = ['.zip'].includes(ext) ? 'zip' : 'html';
  const isSingleHtmlInput = mode === 'html' && ext === '.html' && fileExists(input) && fs.statSync(input).isFile();
  const slug = `${timestampSlug()}_${slugify(path.basename(input))}`;
  const reportDir = ensureDir(path.join(reportRoot, slug));
  const screenshotsDir = ensureDir(path.join(reportDir, 'screenshots'));
  let validationRoot = input;
  if (mode === 'zip') {
    const extractDir = ensureDir(path.join(workRoot, slug));
    extractZip(input, extractDir);
    validationRoot = findProductRoot(extractDir);
  } else {
    validationRoot = path.dirname(input);
  }
  const { contract, sourcePath } = loadQaContract(validationRoot, input);
  if (isSingleHtmlInput && contract.source === 'file-name') {
    contract.entry = path.basename(input);
    contract.successCriteria = Array.isArray(contract.successCriteria) ? contract.successCriteria.slice() : [];
    contract.successCriteria.push('Standalone HTML file validates itself as the entry point.');
  }
  const prev = productState.loadPrevious(watchDir, contract.productId);
  const result = {
    schema: 'launchcheck.report/v4',
    input, mode, validationRoot, reportDir, standaloneHtmlInput: isSingleHtmlInput,
    productId: contract.productId, productName: contract.productName, productVersion: contract.version, productFamily: contract.productFamily,
    manifestSource: sourcePath || contract.source, packageName: contract.productId,
    productContinuityFile: prev.path, savedProductStateFile: null,
    inputSha256: fileExists(input) && fs.statSync(input).isFile() ? sha256File(input) : null,
    validator: { name: VALIDATOR_NAME, version: VALIDATOR_VERSION },
    started, finished: null, status: 'UNKNOWN', errorCount: 0, warningCount: 0, infoCount: 0,
    findings: [], failedWorkflows: [], runtimeEvidence: [], screenshots: [], exportedStates: [], htmlEntryPoints: [],
    previousProductRecord: prev.record, qaContractSummary: contractSummary(contract), qaStaticDetails: null,
    metrics: { htmlEntries: 0, filesScanned: 0, consoleErrors: 0, pageErrors: 0, requestFailures: 0, totalControls: 0, totalClickable: 0, totalInputs: 0, clickedControls: 0, inputsInteracted: 0, stateAttemptedCount: 0, stateOkCount: 0, priorStateLoadedCount: 0, priorStateLoadFailedCount: 0 },
    progress: null, releaseGate: null, notification: null, fileManifest: null, fileManifestDigest: null, changeSummary: null, syntaxGate: null, staticAnalysis: null, historyInsights: null, responsiveTesting: null, perfAndA11y: null, soulCheck: null, deepInspect: null, output: { releaseGate: null, notification: null, fileManifest: null, fileManifestDigest: null, changeSummary: null }, report: { releaseGate: null, notification: null, fileManifest: null, fileManifestDigest: null, changeSummary: null },
    reportHtml: path.join(reportDir, 'validator-report.html'), reportJson: path.join(reportDir, 'validator-report.json'), fixPromptPath: path.join(reportDir, 'fix-prompt.txt'), aiPacketPath: path.join(reportDir, 'ai-iteration-packet.txt')
  };
  const files = isSingleHtmlInput ? [input] : listFiles(validationRoot);
  result.metrics.filesScanned = files.length;
  result.fileManifest = buildFileManifest(validationRoot, files);
  result.fileManifestDigest = fileManifestDigest(result.fileManifest);
  result.changeSummary = compareFileManifests(result.fileManifest, prev.record && prev.record.lastFileManifest);
  if (result.changeSummary && result.changeSummary.riskRemovedRatio >= 0.25 && result.changeSummary.previousFileCount >= 8) {
    result.findings.push(finding('WARN', 'file_delta_large_deletion_ratio', `File delta removed ${result.changeSummary.riskRemovedCount} risky files of ${result.changeSummary.previousFileCount} previous files after ignoring normal LaunchCheck operator-script version rotations. Review before trusting this build.`, 'package-file-delta'));
  }
  for (const asset of contract.requiredAssets) {
    if (!fileExists(path.join(validationRoot, asset))) result.findings.push(finding('ERROR', `required_asset:${asset}`, `Required asset missing: ${asset}`, asset));
  }
  result.qaStaticDetails = {
    name: 'qa-contract-static', skipped: false, productId: contract.productId, productName: contract.productName, version: contract.version, productFamily: contract.productFamily, source: contract.source,
    requiredSelectors: contract.requiredSelectors, requiredText: contract.requiredText, requiredAssets: contract.requiredAssets,
    requiredWindowFunctions: contract.requiredWindowFunctions, workflows: contract.workflows.map(w => typeof w === 'string' ? w : w.name || 'workflow'), successCriteria: contract.successCriteria
  };
  const entryPath = path.resolve(validationRoot, contract.entry || 'index.html');
  if (fileExists(entryPath)) result.htmlEntryPoints.push(rel(validationRoot, entryPath));
  else result.findings.push(finding('ERROR', 'entry_missing', `HTML entry point not found: ${contract.entry}`, contract.entry));
  result.metrics.htmlEntries = result.htmlEntryPoints.length;
  if (fileExists(entryPath)) await validateBrowserEntry(result, entryPath, contract, prev.record, screenshotsDir, options);
  if (options.noBrowser) {
    result.findings.push(finding('INFO', 'static_only_mode', 'Static-only validation. Runtime, responsive, state, clipboard poison, and visual behavior were not fully tested.', 'validation-mode'));
  }
  // ── Phase A: remaining finding-producing passes (ALL before health recalc) ──

  // Level 4: Visual comparison against previous PASS baseline (no findings)
  const prevBaselines = prev.record && prev.record.lastPassScreenshots ? prev.record.lastPassScreenshots : null;
  result.visualComparison = compareToBaseline(
    result.screenshots.map(rel => require('path').join(result.reportDir, rel)),
    result.reportDir,
    prevBaselines
  );

  // Syntax gate — hard node --check on all src/*.js
  if (!isSingleHtmlInput) {
    result.syntaxGate = runSyntaxGate(validationRoot);
    for (const f of (result.syntaxGate.findings || [])) result.findings.push(f);
  }

  // Pass 3 — Static file analysis (AI comments, secrets, time bombs, complexity cliff, console noise)
  result.staticAnalysis = runStaticAnalysis(files, prev.record && prev.record.lastFileManifest, result.fileManifest);
  for (const f of (result.staticAnalysis.findings || [])) result.findings.push(f);

  // Pass 5 — History insights: mine prior history (no findings)
  result.historyInsights = productState.buildHistoryInsights(prev.record && prev.record.history);

  // Pass 6 — Build ancestry: version lineage check
  {
    const ancestry = buildAncestryCheck(prev.record && prev.record.history);
    if (result.soulCheck) {
      result.soulCheck.buildAncestry = ancestry;
    } else {
      result.soulCheck = { schema: 'launchcheck.soulCheck/v1', buildAncestry: ancestry, findings: [] };
    }
    for (const f of (ancestry.findings || [])) result.findings.push(f);
  }

  // ── Phase B: single authoritative health recalculation (status → errors → warnings → metrics → progress → score) ──
  recalcHealth(result, prev.record);

  // ── Phase C: progress regression guard — fires only if prior recalc gave PASS ──
  if (result.progress.grade === 'REGRESSED' && result.status === 'PASS') {
    result.findings.push(finding('ERROR', 'progress_regression', 'Product progress regressed compared with previous product record.'));
    recalcHealth(result, prev.record);
  }

  result.finished = new Date().toISOString();
  productState.saveRecord(watchDir, result);
  rewriteReports(result);
  return result;
}

if (require.main === module) {
  (async () => {
    const opts = parseArgs();
    const input = opts._[0] || opts.input;
    if (!input) { console.error('Usage: node src/validator.js <zip-or-html> [--watch <dir>] [--no-browser]'); process.exit(2); }
    const result = await validateCandidate(input, { watchDir: opts.watch, noBrowser: !!opts.noBrowser, noSelfHandoffProbe: !!opts.noSelfHandoffProbe, selfHandoffProbeTimeoutMs: Number(opts.selfHandoffProbeTimeoutMs || process.env.LAUNCHCHECK_SELF_HANDOFF_PROBE_TIMEOUT_MS || 120000) });
    console.log(`[LaunchCheck] ${result.status}: ${path.basename(input)}`);
    console.log(`[LaunchCheck] Progress: ${result.progress.grade} | Previous: ${result.progress.previousStatus || 'n/a'} | Current: ${result.progress.currentStatus} | Errors Δ: ${result.progress.errorsDelta} | Warnings Δ: ${result.progress.warningsDelta}`);
    if (result.score) console.log(`[LaunchCheck] ${scoreSummaryLine(result.score)}`);
    if (result.visualComparison) console.log(`[LaunchCheck] ${visualSummaryLine(result.visualComparison)}`);
    console.log(`[LaunchCheck] Report: ${result.reportHtml}`);
    console.log(`[LaunchCheck] AI packet: ${result.aiPacketPath}`);
    process.exit(result.status === 'PASS' ? 0 : 1);
  })().catch(err => { console.error('[LaunchCheck] validation error:', err.stack || err.message || err); process.exit(1); });
}
module.exports = { validateCandidate, rewriteReports, VALIDATOR_VERSION, VALIDATOR_NAME };
