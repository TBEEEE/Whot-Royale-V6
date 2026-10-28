// Real-browser check: three isolated browser sessions (2 desktop, 1 phone) create/join a room,
// play a full round through the UI, reload mid-round, rematch, and chat.
// Usage:  npm i -D playwright && npx playwright install chromium
//         node browser.cjs https://your-game.onrender.com
const { chromium } = require('playwright');
const OUT = (process.env.SHOTS || './shots') + '/';
require('fs').mkdirSync(OUT, { recursive: true });
const URL = process.argv[2] || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const mk = async (label, opts) => {
    const ctx = await browser.newContext(opts); // separate context = separate storage/session
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    return { label, ctx, page, errs };
  };
  const desktop = { viewport: { width: 1100, height: 800 } };
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' };
  const A = await mk('Ada', desktop), B = await mk('Bayo', desktop), C = await mk('Chi', phone);
  const all = [A, B, C];

  for (const p of all) await p.page.goto(URL);
  await C.page.screenshot({ path: OUT + 'shot-welcome-phone.png' });

  // A creates a private room
  await A.page.fill('#name', 'Ada');
  await A.page.click('#create');
  await A.page.waitForSelector('#roomcode:not(:empty)');
  const code = (await A.page.textContent('#roomcode')).trim();
  console.log('room code', code);

  // B joins via invite link, C joins by typing the code
  await B.page.goto(`${URL}/?room=${code}`);
  await B.page.fill('#name', 'Bayo');
  await B.page.click('#join');
  await C.page.fill('#name', 'Chi');
  await C.page.fill('#code', code.toLowerCase());
  await C.page.click('#join');
  for (const p of all) await p.page.waitForFunction(() => document.querySelectorAll('#seats .seat').length === 3);
  await A.page.screenshot({ path: OUT + 'shot-lobby-desktop.png' });
  await C.page.screenshot({ path: OUT + 'shot-lobby-phone.png' });

  // non-host sees no start button
  console.log('non-host start visible:', await B.page.isVisible('#start'));

  await A.page.click('#start');
  for (const p of all) await p.page.waitForSelector('#game:not(.hidden) #hand .card');
  for (const p of all) console.log(p.label, 'hand size', await p.page.locator('#hand .card').count());
  await A.page.screenshot({ path: OUT + 'shot-game-desktop.png' });
  await C.page.screenshot({ path: OUT + 'shot-game-phone.png', fullPage: true });

  // play through the UI until the round ends
  let moves = 0, reloaded = false;
  const step = async (p) => { try { return await step0(p); } catch (e) { if (/Timeout/.test(e.message)) return false; throw e; } };
  const step0 = async (p) => {
    const mine = await p.page.locator('#turn.mine').count();
    if (!mine) return false;
    const playable = p.page.locator('#hand .card.playable');
    const penalty = await p.page.locator('#draw.penalty').count();
    if (!penalty && (await playable.count())) {
      await playable.first().click({ timeout: 1500 });
      if (await p.page.locator('#shapes:not(.hidden)').count()) {
        await p.page.locator('#shapeButtons button').nth(moves % 5).click({ timeout: 1500 });
      }
    } else {
      await p.page.click('#draw', { timeout: 1500 });
    }
    moves++;
    return true;
  };
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await A.page.locator('#result:not(.hidden)').count()) break;
    let acted = false;
    for (const p of all) acted = (await step(p)) || acted;
    if (!acted) await A.page.waitForTimeout(60);
    if (moves === 6 && !reloaded) {
      // reload B mid-round: should rejoin the same seat with the same hand
      reloaded = true;
      const before = await B.page.locator('#hand .card').count();
      await B.page.reload();
      await B.page.waitForSelector('#game:not(.hidden) #hand .card', { timeout: 8000 });
      const after = await B.page.locator('#hand .card').count();
      console.log(`reload: B hand before=${before} after=${after}, seats=${await B.page.locator('#seats .seat').count()}`);
    }
  }
  console.log('moves played via UI:', moves);
  const finished = await A.page.locator('#result:not(.hidden)').count();
  console.log('round finished:', !!finished);
  if (finished) {
    for (const p of all) console.log(p.label, 'sees:', (await p.page.textContent('#result')).replace(/\s+/g, ' ').trim());
    await A.page.screenshot({ path: OUT + 'shot-result-desktop.png', fullPage: true });
    await C.page.screenshot({ path: OUT + 'shot-result-phone.png', fullPage: true });
    // rematch from a non-host
    await B.page.click('#result button');
    for (const p of all) await p.page.waitForFunction(() => /Round|Your turn|playing/.test(document.querySelector('#turn')?.textContent || '') && !document.querySelector('#result:not(.hidden)'));
    console.log('rematch started; hands:', await A.page.locator('#hand .card').count(), await B.page.locator('#hand .card').count(), await C.page.locator('#hand .card').count());
  }

  // chat from phone to desktop
  await C.page.fill('#message', 'Oya, play! <b>x</b>');
  await C.page.click('#send');
  await A.page.waitForFunction(() => document.querySelector('#messages')?.textContent.includes('Oya, play!'));
  console.log('chat text on desktop:', (await A.page.textContent('#messages')).trim(), '| injected <b> elements:', await A.page.locator('#messages b').count() - await A.page.locator('#messages p').count());

  // horizontal overflow check on phone
  const overflow = await C.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('phone horizontal overflow px:', overflow);

  for (const p of all) console.log(p.label, 'JS errors:', JSON.stringify(p.errs));
  await browser.close();
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
