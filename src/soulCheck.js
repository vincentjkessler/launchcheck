'use strict';
// Pass 6 — Soul check / QA auto-generator / zombie features / build ancestry
// v4.46.0

function finding(severity, key, message, file) {
  return { severity, key, message, file: file || null };
}

// Token-overlap similarity — no external deps
function tokenSimilarity(a, b) {
  const tok = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = new Set(tok(a));
  const tb = new Set(tok(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

async function runSoulCheck(page, contract, entryPath, relFn, result) {
  const out = {
    schema: 'launchcheck.soulCheck/v1',
    soulScore: null,
    identityMatch: null,
    qaAutoSuggestions: { suggestedSelectors: [], suggestedTexts: [] },
    zombieFeatures: { detected: [], count: 0 },
    buildAncestry: null,
    findings: [],
  };
  const filePath = relFn(result.validationRoot, entryPath);
  const productName = contract.productName || '';

  // --- Soul check: visible page content vs product name ---
  try {
    const pageData = await page.evaluate(() => {
      const title = document.title || '';
      const h1h2 = Array.from(document.querySelectorAll('h1,h2,h3'))
        .map(el => el.textContent.trim()).slice(0, 5).join(' ');
      const bodyStart = document.body ? (document.body.innerText || '').slice(0, 600) : '';
      return { title, h1h2, bodyStart };
    }).catch(() => ({ title: '', h1h2: '', bodyStart: '' }));

    const combined = `${pageData.title} ${pageData.h1h2} ${pageData.bodyStart}`;
    const score = tokenSimilarity(productName, combined);
    out.soulScore = Math.round(score * 100);
    out.identityMatch = { productName, pageTitle: pageData.title, headings: pageData.h1h2.slice(0, 100), score: out.soulScore };

    if (score < 0.12 && productName.replace(/[^a-z]/gi, '').length > 3) {
      out.findings.push(finding('WARN', 'soul_check_identity_mismatch',
        `Product name "${productName}" shares little vocabulary with visible page content (soul score: ${out.soulScore}%). The build may have drifted from its identity.`, filePath));
    }
  } catch (_) {}

  // --- QA auto-generator: suggest contract additions ---
  try {
    const CLICKABLE_SEL = 'button:not([disabled]), [role="button"]:not(button):not([disabled]), input[type="submit"], input[type="button"], input[type="reset"]';
    const existingSelectors = new Set((contract.requiredSelectors || []).map(s => s.toLowerCase()));
    const existingTexts = new Set((contract.requiredText || []).map(t => t.toLowerCase()));

    const buttons = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).slice(0, 25).map(el => ({
        text: (el.textContent || el.value || '').trim().slice(0, 60),
        id: el.id || null,
        tag: el.tagName.toLowerCase(),
      })).filter(b => b.text.length > 1);
    }, CLICKABLE_SEL).catch(() => []);

    for (const btn of buttons) {
      if (btn.id) {
        const sel = `#${btn.id}`;
        if (!existingSelectors.has(sel.toLowerCase())) {
          out.qaAutoSuggestions.suggestedSelectors.push({ selector: sel, reason: `Button with id found: "${btn.text}"` });
        }
      }
      if (btn.text.length > 3 && /^[a-z]/i.test(btn.text) && !existingTexts.has(btn.text.toLowerCase())) {
        out.qaAutoSuggestions.suggestedTexts.push({ text: btn.text, reason: 'Visible button text not yet in requiredText' });
      }
    }
    out.qaAutoSuggestions.suggestedSelectors = out.qaAutoSuggestions.suggestedSelectors.slice(0, 10);
    out.qaAutoSuggestions.suggestedTexts = out.qaAutoSuggestions.suggestedTexts.slice(0, 10);
  } catch (_) {}

  // --- Zombie feature detection: controls not touched by any workflow step ---
  try {
    const CLICKABLE_SEL = 'button, [role="button"]:not(button), input[type="submit"], input[type="button"], input[type="reset"]';
    const allControls = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map(el => ({
        text: (el.textContent || el.value || '').trim().slice(0, 60),
        id: el.id || null,
      })).filter(c => c.text.length > 0);
    }, CLICKABLE_SEL).catch(() => []);

    // Collect all selectors used in any workflow step
    const workflowSelectors = new Set();
    for (const wf of (contract.workflows || [])) {
      for (const step of (wf.steps || [])) {
        if (step.selector) workflowSelectors.add(step.selector.toLowerCase());
      }
    }

    if (workflowSelectors.size > 0) {
      const zombies = [];
      for (const ctrl of allControls) {
        const idSel = ctrl.id ? `#${ctrl.id}` : null;
        const matched = idSel && workflowSelectors.has(idSel.toLowerCase());
        if (!matched && ctrl.text.length > 3) zombies.push(ctrl.text);
      }
      out.zombieFeatures.detected = zombies.slice(0, 20);
      out.zombieFeatures.count = zombies.length;
      if (zombies.length > 0) {
        out.findings.push(finding('INFO', 'zombie_features',
          `${zombies.length} control(s) exist but aren't covered by any workflow: ${zombies.slice(0, 4).join(', ')}`, filePath));
      }
    }
  } catch (_) {}

  return out;
}

// Build ancestry: version lineage check — pure JS, no Playwright
function buildAncestryCheck(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return { schema: 'launchcheck.buildAncestry/v1', sufficient: false, buildsTracked: (history || []).length };
  }
  const versions = history.map(h => h.version).filter(Boolean);
  const issues = [];
  const parseVer = s => String(s || '0').split('.').map(x => parseInt(x, 10) || 0);

  for (let i = 1; i < versions.length; i++) {
    const pa = parseVer(versions[i - 1]);
    const ca = parseVer(versions[i]);
    // Regression: current < previous
    let regressed = false, broke = false;
    for (let j = 0; j < Math.max(pa.length, ca.length); j++) {
      const a = pa[j] || 0, b = ca[j] || 0;
      if (b < a) { regressed = true; broke = true; break; }
      if (b > a) break;
    }
    if (regressed) issues.push({ type: 'version_regression', from: versions[i - 1], to: versions[i] });
    // Large jump (>50 in any segment is suspicious)
    for (let j = 0; j < Math.max(pa.length, ca.length); j++) {
      const delta = Math.abs((ca[j] || 0) - (pa[j] || 0));
      if (delta > 50) issues.push({ type: 'large_version_jump', from: versions[i - 1], to: versions[i], segment: j, delta });
    }
  }

  const findings = issues
    .filter(i => i.type === 'version_regression')
    .map(i => finding('WARN', 'build_ancestry_version_regression',
      `Version regressed in build history: ${i.from} → ${i.to}`, null));

  return {
    schema: 'launchcheck.buildAncestry/v1',
    sufficient: true,
    buildsTracked: versions.length,
    versions: versions.slice(-10),
    issues,
    findings,
  };
}

module.exports = { runSoulCheck, buildAncestryCheck };
