'use strict';
// LaunchCheck Level 9 — Product Completeness Score
// LaunchCheck Level 10 — Verdict Tiers
// v4.44.0

/**
 * Compute a 0-100 completeness score from a validation result.
 *
 * Weight table (total 100 pts):
 *   Build health – errors   35 pts   -10 per error
 *   Warnings                10 pts   -3 per warning
 *   Workflow pass rate       20 pts   (passed/total)*20; 10 pts if no workflows defined
 *   State reliability        15 pts   +10 round-trip ok, +5 prior-state load ok
 *   Control coverage         10 pts   (clicked/total)*10; 8 pts if no controls
 *   QA contract richness      5 pts   1 pt each: selectors, text, assets, functions, criteria
 *   No regression             5 pts   0 if REGRESSED, 5 otherwise
 */
function computeScore(result) {
  const m = result.metrics || {};
  const c = result.qaContractSummary || {};
  const grade = (result.progress && result.progress.grade) || 'BASELINE';

  // --- Build health: errors (max 35) ---
  const errorDeduct = Math.min(35, (result.errorCount || 0) * 10);
  const earnedErrors = 35 - errorDeduct;

  // --- Warnings (max 10) ---
  const warnDeduct = Math.min(10, (result.warningCount || 0) * 3);
  const earnedWarnings = 10 - warnDeduct;

  // --- Workflow pass rate (max 20) ---
  const totalWf = typeof c.workflows === 'number' ? c.workflows : 0;
  const failedWf = (result.failedWorkflows || []).length;
  const passedWf = Math.max(0, totalWf - failedWf);
  let earnedWorkflows;
  if (totalWf === 0) {
    earnedWorkflows = 10; // no workflows defined — partial credit
  } else {
    earnedWorkflows = Math.round((passedWf / totalWf) * 20);
  }

  // --- State reliability (max 15) ---
  let earnedState = 0;
  const stateAttempted = m.stateAttemptedCount || 0;
  const stateOk = m.stateOkCount || 0;
  const priorLoaded = m.priorStateLoadedCount || 0;
  const priorFailed = m.priorStateLoadFailedCount || 0;
  if (stateAttempted > 0) {
    if (stateOk > 0) earnedState += 10;
    if (priorLoaded > 0 && priorFailed === 0) earnedState += 5;
  } else {
    earnedState = (c.stateRequired === false) ? 7 : 0;
  }

  // --- Control coverage (max 10) ---
  // Use totalClickable (buttons/role-button/links) for the coverage ratio.
  // totalControls now includes form inputs whose "coverage" is interaction, not clicks,
  // so we keep the ratio meaningful by scoping it to clickable elements only.
  const totalCtrl   = m.totalClickable || m.totalControls || 0;
  const clickedCtrl = m.clickedControls || 0;
  let earnedControls;
  if (totalCtrl === 0) {
    earnedControls = 8;
  } else {
    earnedControls = Math.round((clickedCtrl / totalCtrl) * 10);
  }

  // --- QA contract richness (max 5) ---
  const earnedQa = Math.min(5,
    ((c.requiredSelectors || 0) > 0 ? 1 : 0) +
    ((c.requiredText || 0) > 0 ? 1 : 0) +
    ((c.requiredAssets || 0) > 0 ? 1 : 0) +
    ((c.requiredWindowFunctions || 0) > 0 ? 1 : 0) +
    ((c.successCriteria || 0) > 0 ? 1 : 0)
  );

  // --- Regression guard (max 5) ---
  const earnedRegression = grade === 'REGRESSED' ? 0 : 5;

  const raw = earnedErrors + earnedWarnings + earnedWorkflows + earnedState + earnedControls + earnedQa + earnedRegression;
  const score = Math.max(0, Math.min(100, raw));

  const breakdown = {
    buildErrors:  { earned: earnedErrors,    max: 35, errors:    result.errorCount || 0 },
    warnings:     { earned: earnedWarnings,  max: 10, warnings:  result.warningCount || 0 },
    workflows:    { earned: earnedWorkflows, max: 20, passed: passedWf, total: totalWf },
    state:        { earned: earnedState,     max: 15, attempted: stateAttempted, ok: stateOk, priorLoaded, priorFailed },
    controls:     { earned: earnedControls,  max: 10, clicked: clickedCtrl, total: totalCtrl, inputs: m.totalInputs || 0, inputsInteracted: m.inputsInteracted || 0 },
    qaContract:   { earned: earnedQa,        max:  5 },
    regression:   { earned: earnedRegression, max:  5, grade }
  };

  const verdict = computeVerdict(score, result);

  return {
    schema: 'launchcheck.score/v1',
    score,
    breakdown,
    verdict,
    grade
  };
}

/**
 * Map a score + result to a human-readable verdict tier.
 */
function computeVerdict(score, result) {
  const errors = result.errorCount || 0;
  const grade  = (result.progress && result.progress.grade) || 'BASELINE';
  const status = result.status || 'UNKNOWN';

  if (grade === 'REGRESSED') {
    return { tier: 'needs-work', label: 'Needs Work', reason: 'Regression detected — this build performs worse than the previous record' };
  }

  if (errors > 0 || status === 'FAIL') {
    if (score < 25) return { tier: 'broken', label: 'Broken', reason: `${errors} error(s), score ${score}/100 — requires significant repair` };
    return { tier: 'needs-work', label: 'Needs Work', reason: `${errors} error(s) must be resolved before this build can be released` };
  }

  if (score >= 90) return { tier: 'store-ready', label: 'Store-Ready', reason: `Score ${score}/100 — production-quality build, suitable for public distribution` };
  if (score >= 70) return { tier: 'demo-ready', label: 'Demo-Ready', reason: `Score ${score}/100 — functional and demonstrable, minor gaps remain before wide release` };
  if (score >= 50) return { tier: 'acceptable-for-human-review', label: 'Acceptable for Human Review', reason: `Score ${score}/100 — no errors, but QA coverage or test depth is low; human review recommended` };
  return { tier: 'needs-work', label: 'Needs Work', reason: `Score ${score}/100 — quality below release threshold even without hard errors` };
}

function scoreSummaryLine(scoreResult) {
  if (!scoreResult) return 'Score: n/a';
  const { score, verdict } = scoreResult;
  return `Score: ${score}/100 | Verdict: ${verdict.label} (${verdict.tier})`;
}

module.exports = { computeScore, computeVerdict, scoreSummaryLine };
