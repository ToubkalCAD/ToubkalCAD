// ============================================================
// ToubkalCAD — headless browser driver (agent harness)
//
// A tiny chromium-cli-style REPL: pipe newline-separated commands on
// stdin, each drives one shared headless-Chrome page against the dev
// server. Built because this box has playwright-core (a transitive dep)
// and system Chrome, but NO `chromium-cli` / `playwright` CLI.
//
//   node .claude/skills/run-toubkalcad/driver.mjs <<'EOF'
//   nav   http://localhost:8080
//   ready                       # poll until the kernel + ribbon are up
//   shot  app                   # → screenshots/app.png
//   click .ribbon-tab:has-text("Model")
//   shot  model 92              # clip top 92px (the ribbon)
//   errors
//   EOF
//
// Commands:
//   nav <url>            navigate, wait for domcontentloaded
//   ready                poll up to 120s for `.ribbon-tab` (48MB wasm,
//                        main-thread compile — first cold load is slow)
//   wait <selector>      waitForSelector (visible), 60s
//   click <selector>     click (Playwright selectors, incl. :has-text)
//   hover <selector>     REAL mouse.move to element centre — needed for
//                        CSS :hover tooltips (.hover() alone won't repaint)
//   shot <name> [h]      screenshot → screenshots/<name>.png; clip top
//                        <h>px from x=0 if given, else full viewport
//   eval <js>            evaluate in page, print result
//   sleep <ms>           wait
//   errors               print collected console errors (deduped)
//
// Env: CHROME_PATH (default /usr/bin/google-chrome), OUT (screenshot dir,
// default <skill-dir>/screenshots), VIEWPORT=WxH (default 1440x900).
// ============================================================
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = process.env.OUT || resolve(HERE, 'screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const [vw, vh] = (process.env.VIEWPORT || '1440x900').split('x').map(Number);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const SHOT_MS = 60000; // screenshots can block while the kernel compiles wasm

async function run(line) {
  const sp = line.indexOf(' ');
  const cmd = (sp < 0 ? line : line.slice(0, sp)).trim();
  const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
  switch (cmd) {
    case 'nav':
      await page.goto(arg, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('nav', arg); break;
    case 'ready': {
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(2000);
        if (await page.$('.ribbon-tab')) {
          const coi = await page.evaluate(() => self.crossOriginIsolated).catch(() => null);
          console.log(`ready (${(i + 1) * 2}s, crossOriginIsolated=${coi})`); return;
        }
      }
      throw new Error('ready: .ribbon-tab never appeared within 120s'); }
    case 'wait':
      await page.waitForSelector(arg, { state: 'visible', timeout: 60000 });
      console.log('wait', arg); break;
    case 'click':
      await page.click(arg, { timeout: 30000 });
      await page.waitForTimeout(300);
      console.log('click', arg); break;
    case 'hover': {
      const box = await page.locator(arg).first().boundingBox();
      if (!box) throw new Error('hover: no box for ' + arg);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await page.waitForTimeout(500);
      console.log('hover', arg); break; }
    case 'move': {                                   // move <x> <y>  — real pointer move to page coords
      const [x, y] = arg.split(/\s+/).map(Number);
      await page.mouse.move(x, y, { steps: 5 });
      await page.waitForTimeout(150);
      console.log('move', x, y); break; }
    case 'press':                                    // press <key>  — keyboard press (e.g. Escape)
      await page.keyboard.press(arg); await page.waitForTimeout(150); console.log('press', arg); break;
    case 'down':
      await page.mouse.down(); await page.waitForTimeout(60); console.log('down'); break;
    case 'up':
      await page.mouse.up(); await page.waitForTimeout(60); console.log('up'); break;
    case 'mclick': {                                 // mclick <x> <y>  — move + click at page coords
      const [x, y] = arg.split(/\s+/).map(Number);
      await page.mouse.move(x, y, { steps: 5 });
      await page.waitForTimeout(80);
      await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
      await page.waitForTimeout(250);
      console.log('mclick', x, y); break; }
    case 'ctrlclick': {                              // ctrlclick <x> <y>  — Ctrl-held click at page coords (multi-select)
      const [x, y] = arg.split(/\s+/).map(Number);
      await page.mouse.move(x, y, { steps: 5 });
      await page.waitForTimeout(80);
      await page.keyboard.down('Control');
      await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
      await page.keyboard.up('Control');
      await page.waitForTimeout(250);
      console.log('ctrlclick', x, y); break; }
    case 'fill': {                                   // fill <selector> <value>  — type into an input (value = last token, React-safe)
      const fsp = arg.lastIndexOf(' ');
      const sel = arg.slice(0, fsp), val = arg.slice(fsp + 1);
      await page.fill(sel, val);
      await page.waitForTimeout(120);
      console.log('fill', sel, val); break; }
    case 'shot': {
      const [name, h] = arg.split(/\s+/);
      const opts = { path: `${OUT}/${name}.png`, timeout: SHOT_MS, animations: 'disabled' };
      if (h) opts.clip = { x: 0, y: 0, width: vw, height: Number(h) };
      await page.screenshot(opts);
      console.log('shot', `${OUT}/${name}.png`); break; }
    case 'eval':
      console.log('eval =>', JSON.stringify(await page.evaluate(arg))); break;
    case 'sleep':
      await page.waitForTimeout(Number(arg)); break;
    case 'errors':
      console.log('CONSOLE ERRORS:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 10), null, 2) : 'none'); break;
    default:
      if (cmd) console.log('?? unknown command:', cmd);
  }
}

const rl = createInterface({ input: process.stdin });
try {
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    await run(line);
  }
} catch (e) {
  console.error('DRIVER ERROR:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
