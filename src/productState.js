'use strict';
// LaunchCheck productState.js — v4.45.0
// Pass 5: history entries now carry findingKeys + qaContractSize + grade + score
// so buildHistoryInsights() can mine patterns across builds.

const path = require('path');
const { ensureDir, readJson, writeJson } = require('./utils');
const { captureScreenshotBaselines } = require('./visualComparison');

function stateFileFor(baseDir, productId) {
  return path.join(baseDir, '_VALIDATION_STATE', `${productId}.json`);
}

function loadPrevious(baseDir, productId) {
  const p = stateFileFor(baseDir, productId);
  const record = readJson(p, null);
  return { path: p, record };
}

// ── Pass 5: History insight mining ───────────────────────────────────────────

function summarizeMomentum(statuses) {
  if (!statuses || !statuses.length) return 'no data';
  const fail  = statuses.filter(s => s === 'FAIL').length;
  const pass  = statuses.filter(s => s === 'PASS').length;
  const warn  = statuses.filter(s => s === 'WARN').length;
  if (pass === statuses.length) return 'healthy — consistent PASS streak';
  if (fail >= Math.ceil(statuses.length * 0.6)) return 'struggling — majority failing';
  if (fail > 0 && pass > 0) return 'oscillating — PASS/FAIL alternating';
  if (warn >= 2 && fail === 0) return 'warning pattern — clearing warnings but no errors';
  if (pass >= 2 && warn >= 1) return 'nearly there — mostly passing with warnings';
  return 'mixed';
}

function buildHistoryInsights(history) {
  if (!history || history.length < 2) return null;

  const insights = {
    schema: 'launchcheck.historyInsights/v1',
    buildsAnalyzed: history.length,
    versionMomentum: null,
    regressionFingerprint: null,
    scopeDrift: null,
    fixPromptAddendum: [],
  };

  // ── Version momentum: last 5 builds ──────────────────────────────────────
  const recent = history.slice(-5);
  const statuses = recent.map(h => h.status || 'UNKNOWN');
  insights.versionMomentum = {
    recent: recent.map(h => ({ v: h.version, status: h.status || '?', grade: h.grade || '?' })),
    summary: summarizeMomentum(statuses),
  };

  // ── Regression fingerprint: recurring finding keys ────────────────────────
  const findingKeyCounts = {};
  let buildsWithFindings = 0;
  for (const entry of history) {
    const keys = entry.findingKeys;
    if (!keys || !keys.length) continue;
    buildsWithFindings++;
    for (const key of keys) {
      findingKeyCounts[key] = (findingKeyCounts[key] || 0) + 1;
    }
  }
  if (buildsWithFindings >= 2) {
    const recurring = Object.entries(findingKeyCounts)
      .filter(([, count]) => count >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([key, count]) => ({
        key,
        count,
        pct: Math.round((count / buildsWithFindings) * 100),
        label: `${key} appeared in ${count}/${buildsWithFindings} builds (${Math.round((count/buildsWithFindings)*100)}%)`,
      }));
    insights.regressionFingerprint = {
      recurringFindingKeys: recurring,
      buildsWithFindings,
      totalBuilds: history.length,
    };
    if (recurring.length) {
      insights.fixPromptAddendum.push(
        `RECURRING FAILURES (regression fingerprint): ${recurring.map(r => r.label).join('; ')}.`
      );
    }
  }

  // ── Scope drift: QA contract size across builds ───────────────────────────
  const sizeSeries = history
    .filter(h => h.qaContractSize != null)
    .map(h => ({ version: h.version, size: h.qaContractSize, at: h.at }));
  if (sizeSeries.length >= 2) {
    const first = sizeSeries[0];
    const latest = sizeSeries[sizeSeries.length - 1];
    const drift = latest.size - first.size;
    const shrank = drift < -2;
    const grew = drift > 2;
    insights.scopeDrift = {
      firstVersion: first.version,
      firstSize: first.size,
      latestVersion: latest.version,
      latestSize: latest.size,
      drift,
      shrank,
      grew,
      stable: !shrank && !grew,
    };
    if (shrank) {
      insights.fixPromptAddendum.push(
        `SCOPE DRIFT WARNING: QA contract shrank from ${first.size} criteria (v${first.version}) to ${latest.size} (v${latest.version}). AI may have simplified the spec to pass — restore missing criteria.`
      );
    }
  }

  // ── Momentum addendum ─────────────────────────────────────────────────────
  if (insights.versionMomentum.summary !== 'healthy — consistent PASS streak') {
    insights.fixPromptAddendum.push(
      `VERSION MOMENTUM: ${insights.versionMomentum.summary} — ${statuses.slice(-3).join(' → ')}.`
    );
  }

  return insights;
}

// ── saveRecord ────────────────────────────────────────────────────────────────

function saveRecord(baseDir, result) {
  const p = stateFileFor(baseDir, result.productId);
  const previous = readJson(p, null);
  const history = Array.isArray(previous && previous.history) ? previous.history.slice(-49) : [];

  const state = result.exportedStates && result.exportedStates[0] ? result.exportedStates[0] : null;

  // Pass 5: enrich each history entry with finding keys, QA contract size, grade, score
  const qaContractSize = (() => {
    const c = result.qaContractSummary || {};
    // sum of all count-type fields as a proxy for richness
    return (c.requiredSelectors || 0) + (c.requiredText || 0) + (c.requiredAssets || 0) +
           (c.requiredWindowFunctions || 0) + (c.workflows || 0) + (c.successCriteria || 0);
  })();

  const historyEntry = {
    version:        result.productVersion,
    status:         result.status,
    at:             result.finished || new Date().toISOString(),
    reportHtml:     result.reportHtml,
    // Pass 5 additions:
    grade:          result.progress ? result.progress.grade : null,
    score:          result.score ? result.score.score : null,
    findingKeys:    (result.findings || []).map(f => f.key).filter(Boolean),
    qaContractSize,
  };

  const record = {
    productId:            result.productId,
    productName:          result.productName,
    version:              result.productVersion,
    lastStatus:           result.status,
    lastValidatedAt:      result.finished || new Date().toISOString(),
    lastInputSha256:      result.inputSha256,
    lastInputPath:        result.input,
    lastValidationRoot:   result.validationRoot,
    lastReportHtml:       result.reportHtml,
    lastReportJson:       result.reportJson,
    lastAiPacket:         result.aiPacketPath,
    qaContractSummary:    result.qaContractSummary || null,
    hasState:             !!state,
    stateSize:            state ? state.stateSize : 0,
    statePayload:         state ? state.statePayload : null,
    lastMetrics:          result.metrics,
    lastProgress:         result.progress,
    lastFindings:         result.findings || [],
    lastFailedWorkflows:  result.failedWorkflows || [],
    lastFileManifest:     result.fileManifest || null,
    lastChangeSummary:    result.changeSummary || null,
    lastPassScreenshots:  result.status === 'PASS'
      ? captureScreenshotBaselines(
          (result.screenshots || []).map(rel => require('path').join(result.reportDir, rel)),
          result.reportDir
        )
      : (previous && previous.lastPassScreenshots ? previous.lastPassScreenshots : null),
    historyCount:         history.length + 1,
    history:              history.concat([historyEntry]),
  };

  ensureDir(path.dirname(p));
  writeJson(p, record);
  result.savedProductStateFile = p;
  return { path: p, record };
}

module.exports = { stateFileFor, loadPrevious, saveRecord, buildHistoryInsights };
