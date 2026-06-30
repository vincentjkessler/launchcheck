'use strict';
// Pass 4 — Performance / offline / keyboard / undo
// v4.46.0

function finding(severity, key, message, file) {
  return { severity, key, message, file: file || null };
}

const SLOW_DOM_CONTENT_LOADED_MS = 3000;
const MAX_KEYBOARD_TABS = 15;

async function runPerfAndA11y(page, entryPath, relFn, result) {
  const out = {
    schema: 'launchcheck.perfAndA11y/v1',
    timing: null,
    serviceWorker: null,
    keyboard: null,
    undo: null,
    findings: [],
  };
  const filePath = relFn(result.validationRoot, entryPath);

  // --- Performance timing ---
  try {
    const timing = await page.evaluate(() => {
      try {
        const nav = performance.getEntriesByType && performance.getEntriesByType('navigation');
        if (nav && nav.length) {
          const n = nav[0];
          return {
            source: 'PerformanceNavigationTiming',
            domContentLoadedMs: Math.round(n.domContentLoadedEventEnd - n.startTime),
            loadMs: Math.round(n.loadEventEnd - n.startTime),
            ttfbMs: Math.round(n.responseStart - n.startTime),
            domInteractiveMs: Math.round(n.domInteractive - n.startTime),
          };
        }
        const t = performance.timing;
        if (t && t.navigationStart) {
          return {
            source: 'PerformanceTiming',
            domContentLoadedMs: t.domContentLoadedEventEnd - t.navigationStart,
            loadMs: t.loadEventEnd - t.navigationStart,
            ttfbMs: t.responseStart - t.navigationStart,
            domInteractiveMs: t.domInteractive - t.navigationStart,
          };
        }
      } catch (_) {}
      return null;
    }).catch(() => null);
    out.timing = timing;
    if (timing && timing.domContentLoadedMs > SLOW_DOM_CONTENT_LOADED_MS) {
      out.findings.push(finding('WARN', 'perf_slow_dom_content_loaded',
        `DOMContentLoaded slow: ${timing.domContentLoadedMs}ms (threshold ${SLOW_DOM_CONTENT_LOADED_MS}ms)`, filePath));
    }
  } catch (_) {}

  // --- Service worker / offline capability ---
  try {
    const swData = await page.evaluate(() => {
      return {
        hasServiceWorker: 'serviceWorker' in navigator,
        hasCaches: typeof caches !== 'undefined',
      };
    }).catch(() => ({ hasServiceWorker: false, hasCaches: false }));
    out.serviceWorker = swData;
    // Informational only — absence of SW is not an error
  } catch (_) {}

  // --- Keyboard navigation + focus indicators ---
  try {
    const FOCUSABLE_SEL = 'button:not([disabled]), [role="button"]:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusableCount = await page.locator(FOCUSABLE_SEL).count().catch(() => 0);
    let focusVisibleCount = 0;
    let tabsAttempted = 0;

    if (focusableCount > 0) {
      // Reset focus to top of page
      await page.evaluate(() => { if (document.body) document.body.focus(); }).catch(() => {});
      const tabs = Math.min(focusableCount, MAX_KEYBOARD_TABS);
      for (let i = 0; i < tabs; i++) {
        await page.keyboard.press('Tab').catch(() => {});
        await page.waitForTimeout(40);
        tabsAttempted++;
        const hasFocusIndicator = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return false;
          const s = window.getComputedStyle(el);
          const hasOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
          const hasBoxShadow = s.boxShadow && s.boxShadow !== 'none';
          // Also accept bordered elements (some designs use border instead of outline)
          const hasBorderFocus = parseFloat(s.borderWidth) > 1;
          return hasOutline || hasBoxShadow || hasBorderFocus;
        }).catch(() => true);
        if (hasFocusIndicator) focusVisibleCount++;
      }
    }

    out.keyboard = { focusableElements: focusableCount, tabsAttempted, focusVisibleCount };
    if (tabsAttempted > 3 && focusVisibleCount === 0) {
      out.findings.push(finding('WARN', 'a11y_no_focus_indicators',
        `Keyboard navigation: ${tabsAttempted} Tab presses detected no focus indicators — keyboard users cannot see where focus is`, filePath));
    }
  } catch (_) {}

  // --- Undo probe: Ctrl+Z after state mutations ---
  try {
    // Use the MutationObserver counter installed in Pass 1 (_lcMut)
    const mutBefore = await page.evaluate(() => window._lcMut || 0).catch(() => 0);
    await page.keyboard.press('Control+z').catch(() => {});
    await page.waitForTimeout(120);
    const mutAfter = await page.evaluate(() => window._lcMut || 0).catch(() => mutBefore);
    out.undo = { attempted: true, domChangeDetected: mutAfter > mutBefore };
    // Informational — not all products support undo
  } catch (_) {
    out.undo = { attempted: false, domChangeDetected: false };
  }

  return out;
}

module.exports = { runPerfAndA11y };
