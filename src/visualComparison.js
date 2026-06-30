'use strict';
// LaunchCheck Level 4 — Visual Proof: Screenshot Baseline Comparison
// v4.44.0
//
// Compares screenshots from the current run against stored baselines
// from the previous PASS run. Uses SHA-256 + file-size delta to detect
// visual changes without requiring image-processing dependencies.
//
// Workflow:
//   1. On a PASS run, productState saves screenshot baselines
//      (name, sha256, bytes) via captureScreenshotBaselines().
//   2. On the next run, compareToBaseline() loads those baselines
//      and compares against the current screenshots.
//   3. Results are included in the AI packet and HTML report.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute SHA-256 of a file. Returns null on error.
 */
function sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) { return null; }
}

/**
 * Build a screenshot descriptor list from a set of paths.
 * Used to save baselines into productState on a PASS run.
 *
 * @param {string[]} screenshotPaths  Absolute paths to screenshot files
 * @param {string}   reportDir        Root to compute relative names from
 * @returns {Array<{name, sha256, bytes}>}
 */
function captureScreenshotBaselines(screenshotPaths, reportDir) {
  const baselines = [];
  for (const absPath of screenshotPaths || []) {
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      baselines.push({
        name:   path.relative(reportDir, absPath).replace(/\\/g, '/'),
        sha256: sha256File(absPath),
        bytes:  stat.size
      });
    } catch (_) {}
  }
  return baselines;
}

/**
 * Compare current run screenshots against stored PASS baselines.
 *
 * @param {string[]} currentPaths     Absolute paths from the current run
 * @param {string}   reportDir        Root used to compute relative names
 * @param {Array}    previousBaselines Stored baselines from last PASS run
 * @returns {Object} comparison result
 */
function compareToBaseline(currentPaths, reportDir, previousBaselines) {
  const result = {
    schema: 'launchcheck.visualComparison/v1',
    baselineAvailable: Array.isArray(previousBaselines) && previousBaselines.length > 0,
    totalCurrent:   (currentPaths || []).length,
    totalBaseline:  Array.isArray(previousBaselines) ? previousBaselines.length : 0,
    unchanged: 0,
    changed:   0,
    added:     0,
    removed:   0,
    details:   [],
    notes:     []
  };

  if (!result.baselineAvailable) {
    result.notes.push('No previous PASS screenshot baselines stored. This run establishes the baseline if it PASSes.');
    // Still describe current screenshots as "new"
    for (const absPath of currentPaths || []) {
      try {
        const stat = fs.statSync(absPath);
        const name = path.relative(reportDir, absPath).replace(/\\/g, '/');
        result.details.push({ name, status: 'new', sha256: sha256File(absPath), bytes: stat.size, baselineSha256: null, baselineBytes: null, bytesDelta: null });
        result.added++;
      } catch (_) {}
    }
    return result;
  }

  // Build lookup from baseline
  const baselineMap = new Map();
  for (const b of previousBaselines) {
    // Match on the screenshot file basename (e.g. "baseline.png", "qa-01.png")
    // so minor path differences don't break matching
    const key = path.basename(b.name);
    baselineMap.set(key, b);
  }

  const seenKeys = new Set();

  for (const absPath of currentPaths || []) {
    try {
      const stat = fs.statSync(absPath);
      const relName = path.relative(reportDir, absPath).replace(/\\/g, '/');
      const key = path.basename(absPath);
      const sha = sha256File(absPath);
      const bytes = stat.size;
      const baseline = baselineMap.get(key);
      seenKeys.add(key);

      if (!baseline) {
        result.details.push({ name: relName, status: 'added', sha256: sha, bytes, baselineSha256: null, baselineBytes: null, bytesDelta: null });
        result.added++;
      } else if (baseline.sha256 === sha) {
        result.details.push({ name: relName, status: 'unchanged', sha256: sha, bytes, baselineSha256: baseline.sha256, baselineBytes: baseline.bytes, bytesDelta: 0 });
        result.unchanged++;
      } else {
        const bytesDelta = bytes - (baseline.bytes || 0);
        const pct = baseline.bytes > 0 ? Math.round(Math.abs(bytesDelta) / baseline.bytes * 100) : null;
        result.details.push({ name: relName, status: 'changed', sha256: sha, bytes, baselineSha256: baseline.sha256, baselineBytes: baseline.bytes, bytesDelta, bytesDeltaPct: pct });
        result.changed++;
      }
    } catch (_) {}
  }

  // Removed screenshots
  for (const b of previousBaselines) {
    const key = path.basename(b.name);
    if (!seenKeys.has(key)) {
      result.details.push({ name: b.name, status: 'removed', sha256: null, bytes: null, baselineSha256: b.sha256, baselineBytes: b.bytes, bytesDelta: null });
      result.removed++;
    }
  }

  if (result.changed > 0) {
    result.notes.push(`${result.changed} screenshot(s) changed visually since the last PASS run.`);
  }
  if (result.added > 0) {
    result.notes.push(`${result.added} new screenshot(s) not present in the previous PASS baseline.`);
  }
  if (result.removed > 0) {
    result.notes.push(`${result.removed} screenshot(s) from the previous PASS baseline are no longer captured.`);
  }
  if (result.unchanged === result.totalBaseline && result.changed === 0 && result.added === 0 && result.removed === 0) {
    result.notes.push('All screenshots match the previous PASS baseline exactly — no visual changes detected.');
  }

  return result;
}

/**
 * One-line summary for console/log output.
 */
function visualSummaryLine(vc) {
  if (!vc) return 'Visual: n/a';
  if (!vc.baselineAvailable) return 'Visual: baseline not yet established';
  const parts = [];
  if (vc.unchanged) parts.push(`${vc.unchanged} unchanged`);
  if (vc.changed)   parts.push(`${vc.changed} changed`);
  if (vc.added)     parts.push(`${vc.added} added`);
  if (vc.removed)   parts.push(`${vc.removed} removed`);
  return `Visual: ${parts.join(', ') || 'no screenshots'}`;
}

module.exports = { captureScreenshotBaselines, compareToBaseline, visualSummaryLine };
