import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

const base = process.env.ATLAS_BROWSER_TEST_URL;

test('reading and specialist routes work with real local content and recorded audio', { skip: !base, timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { sessionStorage.setItem('word-atlas:entry-mode', 'guest'); localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, theme: 'light' })); });
  try {
    await t.test('short reading supports translations, word cards, T/F/NG, and separate saved scores', async () => {
      await page.goto(`${base}/#/read?tab=short&id=r0001`);
      await page.getByRole('heading', { name: 'The Blue Book Box', exact: true }).waitFor();
      await page.getByRole('button', { name: '中英对照', exact: true }).click();
      assert.equal(await page.locator('.wa-translation').count(), 3);
      await page.locator('.wa-word').first().click();
      await page.waitForFunction(() => location.hash.includes('w=born'));
      await page.goBack();
      await page.locator('.wa-reading-quiz').waitFor();
      for (const index of [0, 4, 8]) await page.locator('.wa-reading-quiz .wa-choice').nth(index).click();
      assert.match(await page.locator('.wa-result').innerText(), /3 \/ 3/);
      const histories = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('word-atlas:extras:v1:')).map(([, v]) => JSON.parse(v)));
      assert.ok(histories.some(h => h['read:r0001']?.correct === 3));
      await page.screenshot({ path: '/tmp/word-atlas-reading-desktop.png' });
      await page.getByRole('button', { name: '全部短文', exact: true }).click();
      await page.reload();
      await page.locator('.wa-short-card').first().waitFor();
      assert.match(page.url(), /tab=short/);
    });
    await t.test('paraphrase map opens eight real questions, feedback and a result', async () => {
      await page.goto(`${base}/#/paraphrase`);
      await page.locator('.wa-level-status').waitFor();
      assert.equal(await page.locator('.wa-map-nodes .wa-level-node').count(), 400);
      await page.goto(`${base}/#/paraphrase?id=1`);
      await page.locator('.wa-round').waitFor();
      for (let i = 0; i < 8; i++) {
        await page.locator('.wa-drill-choices .wa-choice').first().click();
        await page.locator('.wa-feedback').waitFor();
        await page.locator('.wa-next-question').click();
      }
      await page.locator('.wa-round-result').waitFor();
      assert.match(await page.locator('.wa-big-score').innerText(), /\/ 8/);
      assert.equal(await page.locator('.wa-result-list li').count(), 8);
    });
    await t.test('confusables search, comparison, three blanks and passed status work', async () => {
      await page.goto(`${base}/#/confuse`);
      await page.locator('.wa-confuse-card').first().waitFor();
      assert.equal(await page.locator('.wa-confuse-card').count(), 226);
      await page.getByRole('textbox', { name: '搜索易混词' }).fill('bored');
      assert.ok(await page.locator('.wa-confuse-card').count() >= 1);
      await page.locator('.wa-confuse-card').filter({ has: page.getByRole('heading', { name: 'bored / boring', exact: true }) }).click();
      await page.locator('.wa-round').waitFor();
      assert.equal(await page.locator('.wa-comparison > section').count(), 2);
      for (let i = 0; i < 3; i++) {
        await page.locator('.wa-drill-choices .wa-choice').nth(i === 1 ? 1 : 0).click();
        await page.locator('.wa-next-question').click();
      }
      assert.match(await page.locator('.wa-big-score').innerText(), /3\s*\/ 3/);
      await page.reload();
      await page.locator('.wa-comparison').waitFor();
      assert.match(await page.locator('.page-head .eyebrow').innerText(), /已通过/);
    });
    await t.test('book playback uses local English/Chinese recordings, speed, pause/resume, chapter links and mobile layout', async () => {
      await page.goto(`${base}/#/read?book=the-little-prince&chapter=1`);
      await page.getByRole('button', { name: '开始朗读', exact: true }).waitFor();
      await page.getByRole('button', { name: '开始朗读', exact: true }).click();
      await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > .1; });
      assert.match(await page.locator('audio').evaluate(a => (a as HTMLAudioElement).currentSrc), /\/books\/the-little-prince\/audio\//);
      await page.getByLabel('朗读语言', { exact: true }).selectOption('zh');
      await page.getByLabel('朗读速度', { exact: true }).selectOption('1.2');
      await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && a.currentSrc.includes('/audio-zh/') && !a.paused && a.playbackRate === 1.2; });
      await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
      assert.equal(await page.locator('audio').evaluate(a => (a as HTMLAudioElement).paused), true);
      await page.getByRole('button', { name: '继续朗读', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('audio')!.paused);
      await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
      await page.locator('#wa-chapter').selectOption('4');
      await page.locator('.wa-article h2').filter({ hasText: 'Chapter 4' }).waitFor();
      await page.reload();
      await page.locator('.wa-article h2').filter({ hasText: 'Chapter 4' }).waitFor();
      assert.equal(await page.getByLabel('朗读速度', { exact: true }).inputValue(), '1.2');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: '/tmp/word-atlas-reading-mobile.png' });
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
