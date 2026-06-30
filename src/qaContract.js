const path = require('path');
const { fileExists, readJson } = require('./utils');

function deriveProductId(value) {
  return String(value || 'unknown-product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown-product';
}
function loadQaContract(root, inputFile) {
  const qaPath = path.join(root, 'launchcheck.qa.json');
  const manifestPath = path.join(root, 'product.manifest.json');
  const pkgPath = path.join(root, 'package.json');
  const qa = fileExists(qaPath) ? readJson(qaPath, {}) : null;
  const manifest = fileExists(manifestPath) ? readJson(manifestPath, {}) : null;
  const pkg = fileExists(pkgPath) ? readJson(pkgPath, {}) : null;
  const source = qa ? 'launchcheck.qa.json' : manifest ? 'product.manifest.json' : pkg ? 'package.json' : 'file-name';
  const raw = qa || manifest || pkg || {};
  const productId = deriveProductId(raw.productId || raw.name || (pkg && pkg.name) || path.basename(inputFile || root));
  const productName = raw.productName || raw.displayName || raw.name || (pkg && pkg.description ? productId : productId);
  const version = raw.version || (pkg && pkg.version) || '0.0.0';
  const contract = {
    schema: raw.schema || 'launchcheck.qa/v2',
    productId,
    productName,
    version,
    productFamily: raw.productFamily || null,
    source,
    entry: raw.entry || raw.mainHtml || 'index.html',
    requiredSelectors: raw.requiredSelectors || [],
    requiredText: raw.requiredText || [],
    requiredAssets: raw.requiredAssets || [],
    requiredWindowFunctions: raw.requiredWindowFunctions || [],
    workflows: raw.workflows || [],
    stateRequired: raw.stateRequired !== false,
    successCriteria: raw.successCriteria || [],
    handoff: raw.handoff || { enabled: false },
    releaseGate: raw.releaseGate || { required: false }
  };
  return { contract, raw, sourcePath: qa ? qaPath : manifest ? manifestPath : pkg ? pkgPath : null };
}
function contractSummary(contract) {
  return {
    schema: contract.schema,
    productId: contract.productId,
    productName: contract.productName,
    version: contract.version,
    productFamily: contract.productFamily,
    source: contract.source,
    entry: contract.entry,
    requiredSelectors: contract.requiredSelectors.length,
    requiredText: contract.requiredText.length,
    requiredAssets: contract.requiredAssets.length,
    requiredWindowFunctions: contract.requiredWindowFunctions.length,
    workflows: contract.workflows.length,
    stateRequired: !!contract.stateRequired,
    successCriteria: contract.successCriteria.length,
    handoffEnabled: !!(contract.handoff && contract.handoff.enabled),
    releaseGateRequired: !!(contract.releaseGate && contract.releaseGate.required)
  };
}
module.exports = { loadQaContract, contractSummary, deriveProductId };
