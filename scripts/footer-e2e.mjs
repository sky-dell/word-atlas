import assert from 'node:assert/strict';
import {leaveGuest} from './guest-ui-test-utils.mjs';
import { chromium } from 'playwright';

const origin = process.env.TEST_URL || 'http://127.0.0.1:15189';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
async function dismissWelcome(page) {
  const welcome = page.getByRole('dialog', { name: '欢迎', exact: true });
  try {
    await welcome.waitFor({ state: 'visible', timeout: 2000 });
    await welcome.getByRole('button', { name: '出发', exact: true }).click();
  } catch {}
}
try {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, sfx: false })));
  await context.addInitScript(() => sessionStorage.setItem('word-atlas:entry-mode', 'guest'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/');
  await page.getByRole('button', { name: '以游客身份登录', exact: true }).click();
  await page.locator('main.main').waitFor();
  await dismissWelcome(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/?footer-width='+width+'#/atlas');
    const footer = page.locator('footer.footer');
    await footer.waitFor();
    assert.equal(await footer.locator('a').count(), 0, 'The footer must not contain project links');
    assert.match(await footer.textContent(), /多懂一个词，多看一点世界。/);
    assert.ok((await footer.textContent()).includes('词与远方'), 'Keep the brand logo');
    // A viewport resize and a newly mounted atlas need a layout pass before
    // measuring; still fail if horizontal overflow persists.
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, undefined, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
    await dismissWelcome(page);
    await leaveGuest(page);
    await page.locator('.auth-entry .account-panel').waitFor();
    console.log(`PASS ${width}px footer is minimal and authentication has its own entry page`);
  }
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
