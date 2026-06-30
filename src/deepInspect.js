'use strict';
// Pass 7 — Clipboard poison / AI honesty / deep interaction map
// v4.46.0

function finding(severity, key, message, file) {
  return { severity, key, message, file: file || null };
}

const AI_HONESTY_PATTERNS = [
  { key: 'coming_soon',        pattern: /\bcoming\s+soon\b/gi,              label: 'Coming soon' },
  { key: 'not_implemented',    pattern: /\bnot\s+(yet\s+)?implemented\b/gi, label: 'Not implemented' },
  { key: 'lorem_ipsum',        pattern: /\blorem\s+ipsum\b/gi,              label: 'Lorem ipsum placeholder' },
  { key: 'placeholder_text',   pattern: /\bplaceholder\s+text\b/gi,         label: 'Placeholder text in UI' },
  { key: 'feature_coming',     pattern: /\bfeature\s+coming\b/gi,           label: 'Feature coming message' },
  { key: 'work_in_progress',   pattern: /\bwork\s+in\s+progress\b/gi,       label: 'Work in progress message' },
  { key: 'todo_visible',       pattern: /\bTODO[:：]\s*\S/g,               label: 'Visible TODO in UI text' },
  { key: 'fixme_visible',      pattern: /\bFIXME[:：]\s*\S/g,              label: 'Visible FIXME in UI text' },
  { key: 'example_only',       pattern: /\bexample\s+only\b/gi,             label: 'Example only disclaimer' },
  { key: 'dummy_data',         pattern: /\bdummy\s+data\b/gi,               label: 'Dummy data visible in UI' },
  { key: 'under_construction', pattern: /\bunder\s+construction\b/gi,       label: 'Under construction message' },
  { key: 'tbd',                pattern: /\bTBD\b/g,                         label: 'TBD placeholder visible' },
  { key: 'sample_data',        pattern: /\bsample\s+data\b/gi,              label: 'Sample data visible in UI' },
];

const CLIPBOARD_POISON_PATTERNS = [
  { key: 'ignore_instructions', pattern: /ignore\s+(previous|prior|above)\s+instructions?/gi,    label: 'Instruction override attempt' },
  { key: 'act_as_ai',          pattern: /act\s+as\s+(an?\s+)?AI|you\s+are\s+(now\s+)?an?\s+AI/gi, label: 'Role injection attempt' },
  { key: 'repeat_text',        pattern: /repeat\s+(the\s+)?(following|this)\s+text/gi,            label: 'Repeat-text injection' },
  { key: 'fake_system_tag',    pattern: /\[SYSTEM\]|\[ADMIN\]|\[ROOT\]|\[PROMPT\]/g,              label: 'Fake system tag' },
  { key: 'jailbreak',          pattern: /DAN\s+mode|jailbreak|bypass\s+safety/gi,                 label: 'Jailbreak attempt' },
  { key: 'exfil_attempt',      pattern: /send\s+(this|these|the)\s+(to|data|info)\s+to\s+http/gi, label: 'Data exfiltration attempt' },
];

async function runDeepInspect(page, contract, entryPath, relFn, result, options) {
  const out = {
    schema: 'launchcheck.deepInspect/v1',
    aiHonesty: { scannedChars: 0, hits: [], totalHits: 0 },
    clipboardPoison: { attempted: false, readable: false, value: null, poisonHits: [] },
    interactionMap: { controlsProbed: 0, transitions: [] },
    findings: [],
  };
  const filePath = relFn(result.validationRoot, entryPath);

  // --- AI honesty: scan visible body text for lies ---
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    out.aiHonesty.scannedChars = bodyText.length;
    const hits = [];
    for (const p of AI_HONESTY_PATTERNS) {
      const matches = bodyText.match(p.pattern);
      if (matches && matches.length) {
        hits.push({ key: p.key, label: p.label, count: matches.length, samples: matches.slice(0, 3) });
        out.findings.push(finding('WARN', `ai_honesty_${p.key}`,
          `Visible text contains "${p.label}" (${matches.length} occurrence${matches.length > 1 ? 's' : ''}) — UI is lying about product completeness`, filePath));
      }
    }
    out.aiHonesty.hits = hits;
    out.aiHonesty.totalHits = hits.reduce((s, h) => s + h.count, 0);
  } catch (_) {}

  // --- Clipboard poison: check clipboard contents post-interaction ---
  try {
    const clipText = await page.evaluate(async () => {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          const t = await navigator.clipboard.readText();
          return { ok: true, text: t };
        }
      } catch (_) {}
      return { ok: false, text: null };
    }).catch(() => ({ ok: false, text: null }));

    out.clipboardPoison.attempted = true;
    out.clipboardPoison.readable = clipText.ok;
    if (clipText.ok && clipText.text !== null) {
      out.clipboardPoison.value = clipText.text.slice(0, 500);
      const poisonHits = [];
      for (const p of CLIPBOARD_POISON_PATTERNS) {
        if (p.pattern.test(clipText.text)) {
          poisonHits.push({ key: p.key, label: p.label });
          out.findings.push(finding('ERROR', `clipboard_poison_${p.key}`,
            `Clipboard contains potential prompt injection: "${p.label}" — could poison AI iteration context`, filePath));
        }
      }
      out.clipboardPoison.poisonHits = poisonHits;
    }
  } catch (_) {}

  // --- Deep interaction map: probe which controls produce DOM transitions ---
  try {
    const CLICKABLE_SEL = 'button, [role="button"]:not(button), input[type="submit"], input[type="button"], input[type="reset"]';
    const controls = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).slice(0, 12).map((el, i) => ({
        index: i,
        text: (el.textContent || el.value || '').trim().slice(0, 40),
        id: el.id || null,
        className: (el.className || '').trim().slice(0, 30),
      }));
    }, CLICKABLE_SEL).catch(() => []);

    const transitions = [];
    for (const ctrl of controls) {
      try {
        const before = await page.evaluate(() => ({
          domLen: document.body ? document.body.innerHTML.length : 0,
          title: document.title || '',
          url: location.href,
        })).catch(() => ({ domLen: 0, title: '', url: '' }));

        let clicked = false;
        if (ctrl.id) {
          const handle = await page.locator(`#${ctrl.id}`).elementHandle().catch(() => null);
          if (handle) { await handle.click({ timeout: 1500 }).catch(() => {}); clicked = true; }
        }
        if (!clicked) {
          // Try by text content match
          const handles = await page.locator(CLICKABLE_SEL).elementHandles().catch(() => []);
          const match = handles[ctrl.index];
          if (match) await match.click({ timeout: 1500 }).catch(() => {});
        }
        await page.waitForTimeout(100);

        const after = await page.evaluate(() => ({
          domLen: document.body ? document.body.innerHTML.length : 0,
          title: document.title || '',
          url: location.href,
        })).catch(() => ({ domLen: 0, title: '', url: '' }));

        transitions.push({
          control: ctrl.text || ctrl.id || `[${ctrl.index}]`,
          domChanged: before.domLen !== after.domLen,
          titleChanged: before.title !== after.title,
          navigated: before.url !== after.url,
          domDelta: after.domLen - before.domLen,
        });
      } catch (_) {
        transitions.push({ control: ctrl.text || `[${ctrl.index}]`, domChanged: false, error: true });
      }
    }
    out.interactionMap.controlsProbed = controls.length;
    out.interactionMap.transitions = transitions;
  } catch (_) {}

  return out;
}

module.exports = { runDeepInspect };
