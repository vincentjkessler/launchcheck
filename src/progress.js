function rank(status) {
  const order = { UNKNOWN: 0, UNSAFE: 1, FAIL: 2, WARN: 3, PASS: 4 };
  return order[String(status || 'UNKNOWN').toUpperCase()] ?? 0;
}
function metricSummary(result) {
  const m = result.metrics || {};
  return {
    status: result.status,
    errors: result.errorCount || 0,
    warnings: result.warningCount || 0,
    info: result.infoCount || 0,
    totalFindings: (result.findings || []).length,
    htmlEntries: m.htmlEntries || 0,
    filesScanned: m.filesScanned || 0,
    consoleErrors: m.consoleErrors || 0,
    pageErrors: m.pageErrors || 0,
    requestFailures: m.requestFailures || 0,
    totalControls: m.totalControls || 0,
    clickedControls: m.clickedControls || 0,
    stateAttemptedCount: m.stateAttemptedCount || 0,
    stateOkCount: m.stateOkCount || 0,
    priorStateLoadedCount: m.priorStateLoadedCount || 0,
    priorStateLoadFailedCount: m.priorStateLoadFailedCount || 0,
    failedWorkflowCount: (result.failedWorkflows || []).length,
    failedWorkflows: result.failedWorkflows || [],
    findingKeys: (result.findings || []).map(f => f.key || `${f.severity}:${f.message}`)
  };
}
function computeProgress(result, previousRecord) {
  const current = metricSummary(result);
  const previous = previousRecord && previousRecord.lastMetrics ? previousRecord.lastMetrics : previousRecord ? {
    status: previousRecord.lastStatus || 'UNKNOWN', errors: 0, warnings: 0, info: 0, totalFindings: 0, htmlEntries: 0, filesScanned: 0, consoleErrors: 0, pageErrors: 0, requestFailures: 0, totalControls: 0, clickedControls: 0, stateAttemptedCount: 0, stateOkCount: 0, priorStateLoadedCount: 0, priorStateLoadFailedCount: 0, failedWorkflowCount: 0, failedWorkflows: [], findingKeys: []
  } : null;
  const previousAvailable = !!previous;
  const prevKeys = new Set(previous ? (previous.findingKeys || []) : []);
  const currKeys = new Set(current.findingKeys || []);
  const newFindingKeys = [...currKeys].filter(k => !prevKeys.has(k));
  const resolvedFindingKeys = [...prevKeys].filter(k => !currKeys.has(k));
  const repeatedFindingKeys = [...currKeys].filter(k => prevKeys.has(k));
  let grade = 'BASELINE';
  let statusImproved = false, statusRegressed = false;
  if (previousAvailable) {
    statusImproved = rank(current.status) > rank(previous.status);
    statusRegressed = rank(current.status) < rank(previous.status);
    const worse = statusRegressed || current.errors > (previous.errors || 0) || current.warnings > (previous.warnings || 0) || current.failedWorkflowCount > (previous.failedWorkflowCount || 0) || newFindingKeys.length > 0;
    const better = statusImproved || current.errors < (previous.errors || 0) || current.warnings < (previous.warnings || 0) || current.failedWorkflowCount < (previous.failedWorkflowCount || 0) || resolvedFindingKeys.length > 0;
    grade = worse ? 'REGRESSED' : better ? 'IMPROVED' : 'HELD';
  }
  return {
    schema: 'launchcheck.progress/v1', previousAvailable,
    productId: result.productId, productName: result.productName, currentVersion: result.productVersion,
    previousVersion: previousRecord ? previousRecord.version : null,
    currentStatus: current.status, previousStatus: previous ? previous.status : null,
    statusImproved, statusRegressed,
    errorsDelta: previous ? current.errors - (previous.errors || 0) : 0,
    warningsDelta: previous ? current.warnings - (previous.warnings || 0) : 0,
    totalFindingsDelta: previous ? current.totalFindings - (previous.totalFindings || 0) : 0,
    failedWorkflowDelta: previous ? current.failedWorkflowCount - (previous.failedWorkflowCount || 0) : 0,
    stateOkDelta: previous ? current.stateOkCount - (previous.stateOkCount || 0) : 0,
    newFindingsCount: newFindingKeys.length,
    resolvedFindingsCount: resolvedFindingKeys.length,
    repeatedFindingsCount: repeatedFindingKeys.length,
    priorStateLoadedCount: current.priorStateLoadedCount,
    priorStateLoadFailedCount: current.priorStateLoadFailedCount,
    current, previous,
    newFindingKeys, resolvedFindingKeys, repeatedFindingKeys,
    notes: current.priorStateLoadedCount > 0 ? ['Previous product state loaded successfully before validation workflows.'] : [],
    grade
  };
}
module.exports = { computeProgress, metricSummary };
