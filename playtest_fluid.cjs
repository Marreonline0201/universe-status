const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'playtest_screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const consoleMessages = [];
const consoleErrors = [];

(async () => {
  const browser = await chromium.launch({
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-gl=swiftshader',
      '--no-sandbox',
    ],
    headless: false,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => {
    const text = `[${msg.type().toUpperCase()}] ${msg.text()}`;
    consoleMessages.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });

  page.on('pageerror', err => {
    consoleErrors.push(`[PAGE ERROR] ${err.message}`);
  });

  // ──────────────────────────────────────────────────────
  // STEP 1: Load and navigate to FLUID TEST tab
  // ──────────────────────────────────────────────────────
  console.log('--- Step 1: Loading app ---');
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await sleep(2000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01_initial_load.png') });
  console.log('Screenshot 01_initial_load saved');

  // Find and click the FLUID TEST tab
  const allNavText = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('nav a, nav button, [role="tab"], .tab, .nav-item'));
    return els.map(el => ({ text: el.textContent.trim(), tag: el.tagName, class: el.className }));
  });
  console.log('Nav elements found:', JSON.stringify(allNavText));

  // Try to click FLUID TEST by text
  try {
    await page.getByText('FLUID TEST', { exact: false }).first().click();
    console.log('Clicked FLUID TEST tab by text');
  } catch (e) {
    console.log('Could not find by text, trying coordinates ~(551, 20)');
    await page.mouse.click(551, 20);
  }
  await sleep(3000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02_fluid_tab_loaded.png') });
  console.log('Screenshot 02_fluid_tab_loaded saved');

  // ──────────────────────────────────────────────────────
  // STEP 2: Baseline — 10K particles, no ball
  // ──────────────────────────────────────────────────────
  console.log('--- Step 2: Baseline ---');
  // Check page content for clues about the state
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Page title:', pageTitle);
  console.log('Body snippet:', bodyText);

  // Look for FPS display and particle count
  const fpsText = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && (el.textContent.includes('FPS') || el.textContent.includes('fps'))) {
        return el.textContent.trim();
      }
    }
    return 'FPS element not found';
  });
  console.log('FPS display:', fpsText);

  const uiState = await page.evaluate(() => {
    // Get all visible text elements
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (text.length > 2 && text.length < 100) results.push(text);
    }
    return results.slice(0, 60);
  });
  console.log('UI text elements:', JSON.stringify(uiState));

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03_baseline.png') });
  console.log('Screenshot 03_baseline saved');

  // ──────────────────────────────────────────────────────
  // STEP 3: DROP BALL
  // ──────────────────────────────────────────────────────
  console.log('--- Step 3: Drop Ball ---');
  let dropBallClicked = false;
  try {
    const dropBtn = page.getByText('DROP BALL', { exact: false }).first();
    await dropBtn.click();
    dropBallClicked = true;
    console.log('Clicked DROP BALL by text');
  } catch (e) {
    console.log('DROP BALL text not found, trying coordinate (~1200, 321)');
    try {
      await page.mouse.click(1200, 321);
      dropBallClicked = true;
    } catch (e2) {
      console.log('Coordinate click failed too:', e2.message);
    }
  }

  // Capture ball mid-fall (1 second after drop)
  await sleep(1000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04_ball_midfall.png') });
  console.log('Screenshot 04_ball_midfall saved (ball mid-fall — key depth compositing check)');

  // Capture after 5 seconds
  await sleep(4000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05_ball_settled.png') });
  console.log('Screenshot 05_ball_settled saved');

  // ──────────────────────────────────────────────────────
  // STEP 4: Camera rotation (3/4 view)
  // ──────────────────────────────────────────────────────
  console.log('--- Step 4: Camera rotation ---');
  // Find canvas bounding box
  const canvasBB = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  console.log('Canvas bounding box:', JSON.stringify(canvasBB));

  if (canvasBB) {
    const cx = canvasBB.x + canvasBB.w / 2;
    const cy = canvasBB.y + canvasBB.h / 2;
    // Drag left to rotate yaw
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 150, cy - 80, { steps: 20 });
    await page.mouse.up();
    await sleep(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06_rotated_34_view.png') });
    console.log('Screenshot 06_rotated_34_view saved');

    // Top-down view
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 200, { steps: 20 });
    await page.mouse.up();
    await sleep(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07_topdown_view.png') });
    console.log('Screenshot 07_topdown_view saved');
  }

  // ──────────────────────────────────────────────────────
  // STEP 5: RESET then increase particles
  // ──────────────────────────────────────────────────────
  console.log('--- Step 5: Particle stress test ---');
  // Try RESET button first
  try {
    await page.getByText('RESET', { exact: false }).first().click();
    console.log('RESET clicked');
    await sleep(2000);
  } catch (e) {
    console.log('RESET not found:', e.message);
  }
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08_after_reset.png') });

  // Click +50K to get to ~200K particles
  let plus50kClicks = 0;
  for (let i = 0; i < 4; i++) {
    try {
      const btn = page.getByText('+50K', { exact: false }).first();
      await btn.click();
      plus50kClicks++;
      console.log(`Clicked +50K (${i + 1}/4)`);
      await sleep(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `09_particles_${(i + 1) * 50 + 10}k.png`) });

      // Check if page is frozen
      const fpsNow = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.children.length === 0 && el.textContent.includes('FPS')) return el.textContent.trim();
        }
        return null;
      }).catch(() => 'PAGE_FROZEN');
      console.log(`FPS after ${(i + 1) * 50 + 10}K particles:`, fpsNow);
    } catch (e) {
      console.log(`+50K click ${i + 1} failed:`, e.message);
      break;
    }
  }

  // ──────────────────────────────────────────────────────
  // STEP 6: High particle stress (500K+)
  // ──────────────────────────────────────────────────────
  console.log('--- Step 6: High particle stress ---');
  for (let i = 0; i < 6; i++) {
    try {
      // Quick check for page responsiveness before each click
      const isResponsive = await page.evaluate(() => true).catch(() => false);
      if (!isResponsive) {
        console.log(`PAGE UNRESPONSIVE at step ${i}`);
        break;
      }

      const btn = page.getByText('+50K', { exact: false }).first();
      await btn.click();
      const currentK = 210 + i * 50;
      console.log(`Clicked +50K, now at ~${currentK}K particles`);
      await sleep(3000);

      const fpsNow = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.children.length === 0 && el.textContent.includes('FPS')) return el.textContent.trim();
        }
        return null;
      }).catch(() => 'PAGE_FROZEN');
      console.log(`FPS at ~${currentK}K:`, fpsNow);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `10_stress_${currentK}k.png`) });
    } catch (e) {
      console.log(`High-stress click ${i} failed:`, e.message);
      break;
    }
  }

  // ──────────────────────────────────────────────────────
  // STEP 7: Materials test
  // ──────────────────────────────────────────────────────
  console.log('--- Step 7: Materials ---');
  try {
    await page.getByText('RESET', { exact: false }).first().click();
    await sleep(2000);
  } catch (e) {}

  for (const material of ['Mercury', 'Lava', 'Olive Oil']) {
    try {
      await page.getByText(material, { exact: false }).first().click();
      console.log(`Clicked material: ${material}`);
      await sleep(1500);
      const safeName = material.replace(/\s+/g, '_').toLowerCase();
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `11_material_${safeName}.png`) });
    } catch (e) {
      console.log(`Material ${material} not found:`, e.message);
    }
  }

  // ──────────────────────────────────────────────────────
  // Final: dump console messages
  // ──────────────────────────────────────────────────────
  console.log('\n=== CONSOLE ERRORS ===');
  if (consoleErrors.length === 0) {
    console.log('No console errors captured in this session.');
  } else {
    consoleErrors.forEach(m => console.log(m));
  }

  console.log('\n=== ALL CONSOLE MESSAGES (last 50) ===');
  consoleMessages.slice(-50).forEach(m => console.log(m));

  // Write results to file for reading
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'console_log.txt'), consoleMessages.join('\n'));
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'console_errors.txt'), consoleErrors.join('\n'));

  console.log('\nDone. Screenshots in:', SCREENSHOTS_DIR);
  await sleep(2000);
  await browser.close();
})();
