const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const demoDir = path.join(root, 'demo');
  const videoDir = path.join(demoDir, 'recordings');
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();
  await page.goto('file://' + path.join(demoDir, 'launchcheck-demo.html').replace(/\\/g, '/'));
  await page.waitForTimeout(7200);
  await context.close();
  await browser.close();

  const files = fs.readdirSync(videoDir)
    .filter(name => name.endsWith('.webm'))
    .map(name => path.join(videoDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('No demo video was recorded.');
  const finalPath = path.join(videoDir, 'launchcheck-demo.webm');
  fs.copyFileSync(files[0], finalPath);
  for (const file of files) {
    if (path.basename(file) !== 'launchcheck-demo.webm') fs.rmSync(file, { force: true });
  }
  console.log(finalPath);
})();
