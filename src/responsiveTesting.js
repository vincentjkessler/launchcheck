'use strict';
// Pass 2 — Responsive testing
// v4.46.0 — Multi-viewport UI checks: mobile, tablet, desktop

const VIEWPORTS = [
  { name: 'mobile',  width: 375,  height: 667  },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'desktop', width: 1280, height: 800  },
];

function finding(severity, key, message, file) {
  return { severity, key, message, file: file || null };
}

async function runResponsiveTests(page, entryPath, relFn, result) {
  const out = {
    schema: 'launchcheck.responsiveTesting/v1',
    viewportsTested: [],
    issues: [],
    findings: [],
  };
  const CLICKABLE_SEL = 'button, [role="button"]:not(button), input[type="submit"], input[type="button"], input[type="reset"], a[href]:not([href="#"]):not([href=""])';
  const filePath = relFn(result.validationRoot, entryPath);

  for (const vp of VIEWPORTS) {
    const vpResult = { name: vp.name, width: vp.width, height: vp.height, overflow: false, controlsOutOfView: 0, issues: [] };
    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(200);

      // Check for horizontal overflow
      const overflowData = await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        const scrollW = Math.max(body.scrollWidth, html.scrollWidth);
        const clientW = Math.max(body.clientWidth, html.clientWidth);
        return { scrollWidth: scrollW, clientWidth: clientW, overflow: scrollW > clientW + 5 };
      }).catch(() => ({ overflow: false, scrollWidth: 0, clientWidth: 0 }));

      if (overflowData.overflow) {
        vpResult.overflow = true;
        vpResult.scrollWidth = overflowData.scrollWidth;
        vpResult.clientWidth = overflowData.clientWidth;
        const detail = `Horizontal overflow: content ${overflowData.scrollWidth}px > viewport ${overflowData.clientWidth}px`;
        vpResult.issues.push(detail);
        out.issues.push({ viewport: vp.name, type: 'horizontal_overflow', detail });
        out.findings.push(finding('WARN', `responsive_overflow_${vp.name}`,
          `Layout overflow at ${vp.name} (${vp.width}px): ${detail}`, filePath));
      }

      // Check for unreachable controls (off-screen or zero-size)
      const controlData = await page.evaluate((sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        let outOfView = 0;
        const labels = [];
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const hidden = r.width === 0 || r.height === 0 ||
            r.right < 0 || r.bottom < 0 ||
            r.left > vpW || r.top > vpH * 3;
          if (hidden) {
            outOfView++;
            labels.push((el.textContent || el.value || el.title || el.ariaLabel || el.tagName || '').trim().slice(0, 40));
          }
        }
        return { outOfView, labels: labels.slice(0, 5) };
      }, CLICKABLE_SEL).catch(() => ({ outOfView: 0, labels: [] }));

      if (controlData.outOfView > 0) {
        vpResult.controlsOutOfView = controlData.outOfView;
        const detail = `${controlData.outOfView} control(s) unreachable: ${controlData.labels.join(', ')}`;
        vpResult.issues.push(detail);
        out.issues.push({ viewport: vp.name, type: 'controls_unreachable', detail });
        out.findings.push(finding('WARN', `responsive_controls_unreachable_${vp.name}`,
          `${controlData.outOfView} control(s) off-screen at ${vp.name} (${vp.width}px): ${controlData.labels.join(', ')}`, filePath));
      }

    } catch (err) {
      vpResult.issues.push(`Viewport test error: ${err.message || err}`);
    }
    out.viewportsTested.push(vpResult);
  }

  // Restore standard desktop viewport
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(100);
  } catch (_) {}

  return out;
}

module.exports = { runResponsiveTests };
