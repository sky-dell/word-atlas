import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let server: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'atlas-entry-test-'));
  server = await createServer({
    root, configFile: false, publicDir: false, appType: 'custom', cacheDir,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, entries: [], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, preTransformRequests: false },
    plugins: [{
      name: 'isolated-entry-test',
      resolveId(id) { if (id === '/entry-test.js') return '\0entry-test'; },
      load(id) {
        if (id === '\0entry-test') return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import '/src/styles/app.css';
          import { EntryGate } from '/src/pages/EntryGate.tsx';
          import '/src/styles/parity.css';
          createRoot(document.getElementById('root')).render(React.createElement(EntryGate, {
            initialLogin: new URLSearchParams(location.search).has('initialLogin'),
            onGuest: () => document.getElementById('root').dataset.guest = 'entered'
          }));`;
      },
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/test-entry')) {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entry test</title><div id="root"></div><script type="module" src="/entry-test.js"></script></html>');
          } else if (/^\/atlas\/thumb\/(explore|journey|horizon)\.webp$/.test(req.url || '')) {
            res.setHeader('Content-Type', 'image/webp');
            void readFile(join(root, 'public', req.url!)).then(data => res.end(data));
          } else next();
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

async function open(page: Page, suffix = '', enabled = true) {
  page.on('pageerror', error => process.stderr.write(`Entry browser: ${error.message}\n`));
  page.on('console', message => { if (message.type() === 'error') process.stderr.write(`Entry console: ${message.text()}\n`); });
  await page.route('**/api/auth/session', route => route.fulfill({ json: {
    user: null, csrfToken: 'entry-test-csrf', enabled, emailEnabled: enabled,
  } }));
  await page.goto(`${origin}test-entry${suffix}`);
  await page.getByRole('button', { name: enabled ? '登录账号' : '重新检查账号服务', exact: true }).waitFor({ timeout: 10_000 }).catch(async error => {
    process.stderr.write(`Entry content: ${await page.locator('body').innerText()}\n`);
    throw error;
  });
}

test('entry shows password login immediately, preserves registration and keyboard guest entry', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await open(page);
    assert.equal(await page.getByRole('main').count(), 1);
    assert.equal(await page.getByRole('main').getAttribute('class'), 'auth-entry');
    const guestLabel=await page.getByRole('button',{name:/游客进入/}).evaluate(el=>{const copy=el.cloneNode(true) as HTMLElement;copy.querySelectorAll('[aria-hidden=true]').forEach(node=>node.remove());const visible=copy.textContent?.trim()||'';return {visible,label:el.getAttribute('aria-label')||visible};});
    assert.ok(guestLabel.label.includes(guestLabel.visible),'Guest accessible name must include its visible text for voice control');
    assert.equal(await page.getByRole('region', { name: '账户登录与注册', exact: true }).count(), 1);
    assert.equal(await page.getByLabel('用户名或邮箱', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('密码', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    assert.equal(await page.getByLabel('六位验证码', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    assert.equal(await page.getByLabel('邮箱', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '用户名注册', exact: true }).click();
    assert.equal(await page.getByLabel('确认密码', { exact: true }).isVisible(), true);
    const guest = page.getByRole('button', { name: '暂不登录，先体验（游客进入）', exact: true });
    assert.equal(await guest.innerText(), '暂不登录，先体验 →');
    await guest.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#root').getAttribute('data-guest'), 'entered');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('starlight does not paint a second square panel inside the authentication card', async()=>{
  const page=await browser.newPage();
  try{await open(page);await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.dataset.skin='starlight';});const style=await page.locator('.auth-entry .account-panel').evaluate(e=>({shadow:getComputedStyle(e).boxShadow,background:getComputedStyle(e).backgroundColor}));assert.equal(style.shadow,'none');assert.equal(style.background,'rgba(0, 0, 0, 0)');}finally{await page.close();}
});

test('entry fits desktop and 320/390px short screens in both themes and reduced motion', async () => {
  const page = await browser.newPage();
  try {
    await open(page, '?initialLogin');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme as 'light' | 'dark' });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 640 });
        await page.waitForFunction(width=>{
          const layout=document.querySelector('.auth-entry__layout');
          return innerWidth===width && !!layout && (getComputedStyle(layout).gridTemplateColumns.split(/\s+/).length===1)===(width<=800);
        },width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width}: no horizontal overflow`);
        const {story,card}=await page.evaluate(()=>{
          const a=document.querySelector('.auth-entry__story')?.getBoundingClientRect();
          const b=document.querySelector('.auth-entry__card')?.getBoundingClientRect();
          return {story:a?{x:a.x,y:a.y,width:a.width,height:a.height}:null,card:b?{x:b.x,y:b.y,width:b.width,height:b.height}:null};
        });
        assert.ok(story && card);
        assert.ok(width > 800 ? card.x > story.x + story.width : card.y >= story.y + story.height, `${theme}/${width}: responsive columns`);
        assert.equal(await page.locator('.auth-entry__atlas').isVisible(), width > 800);
        if (width > 800) {
          const notesBottom = await page.locator('.auth-entry__word-note').evaluateAll(nodes => Math.max(...nodes.map(node => node.getBoundingClientRect().bottom)));
          const signature = await page.locator('.auth-entry__signature').boundingBox();
          assert.ok(signature && signature.y > notesBottom, 'wordcard annotations do not overlap the signature');
        }
        assert.equal(await page.locator('.account-primary').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
        await page.getByRole('button', { name: '暂不登录，先体验（游客进入）', exact: true }).scrollIntoViewIfNeeded();
        assert.equal(await page.getByRole('button', { name: '暂不登录，先体验（游客进入）', exact: true }).isVisible(), true);
        if (process.env.ATLAS_ENTRY_SCREENSHOTS && width !== 320) {
          await page.screenshot({ path: `/tmp/atlas-entry-${theme}-${width}.png`, fullPage: true });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.auth-entry__atlas img')].length === 3 && [...document.querySelectorAll<HTMLImageElement>('.auth-entry__atlas img')].every(img => img.complete && img.naturalWidth > 0));
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.getByLabel('确认密码', { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '暂不登录，先体验（游客进入）', exact: true }).click();
    assert.equal(await page.locator('#root').getAttribute('data-guest'), 'entered');
  } finally { await page.close(); }
});

test('unavailable account service keeps the guest path usable', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  try {
    await open(page, '', false);
    await page.getByRole('button', { name: '暂不登录，先体验（游客进入）', exact: true }).click();
    assert.equal(await page.locator('#root').getAttribute('data-guest'), 'entered');
  } finally { await page.close(); }
});

test('login fits the viewport without scrolling or clipped controls at desktop and phone heights', async()=>{
  const page=await browser.newPage();
  try{
    await open(page);
    for(const [width,height] of [[1920,900],[1366,768],[1280,640],[1280,600],[390,844],[390,700],[375,667],[320,640]]){
      await page.setViewportSize({width,height});
      for(const method of ['账户登录','验证码登录']){
        await page.getByRole('button',{name:method,exact:true}).click();
        await page.evaluate(()=>scrollTo(0,0));
        const size=await page.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth}));
        assert.ok(size.height<=height+1,`${width}x${height}/${method}: document height ${size.height}`);
        assert.ok(size.width<=width,`${width}x${height}: horizontal overflow`);
        for(const control of [page.locator('.account-primary'),page.getByRole('button',{name:/游客进入/})]){
          const rect=await control.boundingBox();assert.ok(rect&&rect.y>=0&&rect.y+rect.height<=height,`${width}x${height}: action fully in viewport`);
        }
      }
    }
    // Very short windows and enlarged text must remain scrollable, never clipped.
    await page.setViewportSize({width:320,height:400});
    await page.getByRole('button',{name:'注册',exact:true}).click();
    await page.getByRole('button',{name:'创建账号',exact:true}).scrollIntoViewIfNeeded();
    assert.ok(await page.getByRole('button',{name:'创建账号',exact:true}).isVisible());
    const overflow=await page.evaluate(()=>({body:getComputedStyle(document.body).overflowY,main:getComputedStyle(document.querySelector('main')!).overflowY}));
    assert.notEqual(overflow.body,'hidden');assert.notEqual(overflow.main,'hidden');
  }finally{await page.close();}
});
