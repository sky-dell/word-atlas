import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;
async function waitForAsync(page:Page, condition:()=>Promise<boolean>) {
  const deadline=Date.now()+5000;
  do {
    if(await page.evaluate(condition)) return;
    await new Promise(r=>setTimeout(r,25));
  }while(Date.now()<deadline);
  throw new Error('Asynchronous browser state did not become ready');
}
before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "word-atlas-test-"));
  server = await createServer({
    configFile: false,
    publicDir: false,
    appType: "custom",
    cacheDir,
    optimizeDeps: {
      noDiscovery: true,
      entries: [],
      include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime"],
    },
    server: { port: 0, watch: null, hmr: false, preTransformRequests: false },
    plugins: [
      {
        name: "test-page",
        resolveId(id) { if (id === '/account-test-mount.js') return '\0account-test-mount'; },
        load(id) { if (id === '\0account-test-mount') return "import '/src/styles/app.css'; import * as React from 'react'; import * as dom from 'react-dom/client'; import { AccountMenu } from '/src/ui/AccountMenu.tsx'; export { React, dom }; export function MenuHarness() { const [open,setOpen]=React.useState(false); return React.createElement('div',{className:'topbar-tools',style:{display:'flex',justifyContent:'flex-end'}},React.createElement(AccountMenu,{open,onToggle:()=>setOpen(!open),onClose:()=>setOpen(false),onEnter:()=>{window.accountEntryRequested=(window.accountEntryRequested||0)+1}})); }"; },
        configureServer(s) {
          s.middlewares.use("/test-page", (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>Store tests</title>");
          });
        },
      },
    ],
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

async function load(page: Page, id = "test") {
  page.on("pageerror", error => process.stderr.write(`Browser error: ${error.message}\n`));
  page.on("console", msg => { if (msg.type() === "error") process.stderr.write(`Browser console: ${msg.text()}\n`); });
  await page.goto(`${origin}test-page`);
  await page.evaluate(async (id) => {
    const path = "/src/store/store.ts";
    const mod = await import(path);
    Object.assign(window, { atlasStore: mod });
    mod.store.useDataset(id);
    await mod.flush();
  }, id);
}


test("profile switches isolate IDB progress, settings and reader extras without deleting guest", async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await load(page);
    const result = await page.evaluate(async () => {
      const m = (window as any).atlasStore;
      if (!m.switchProfile) return { missing: true };
      const reader = await import('/src/lib/reader.ts' as string);
      m.store.progress((p: any) => ({ ...p, bookmarks: ['guest'] }));
      reader.savePosition({ kind: 'short', id: 'guest-book', paragraph: 2 });
      await m.switchProfile('A');
      const initialA = m.store.get().progress.bookmarks;
      const positionA = reader.readPosition();
      m.store.progress((p: any) => ({ ...p, bookmarks: ['A'] })); m.store.settings({ dailyNew: 30 });
      reader.savePosition({ kind: 'short', id: 'A-book', paragraph: 4 });
      await m.switchProfile('B');
      const initialB = m.store.get().progress.bookmarks;
      const dailyB = m.store.get().settings.dailyNew;
      await m.switchProfile('A');
      const a = m.store.get().progress.bookmarks, dailyA = m.store.get().settings.dailyNew;
      const aBook = reader.readPosition()?.id;
      await m.switchProfile(null);
      return { initialA, positionA, initialB, dailyB, a, dailyA, aBook, guest: m.store.get().progress.bookmarks, guestBook: reader.readPosition()?.id };
    });
    assert.deepEqual(result, { initialA: [], positionA: null, initialB: [], dailyB: 10, a: ['A'], dailyA: 30, aBook: 'A-book', guest: ['guest'], guestBook: 'guest-book' });
  } finally { await context.close(); }
});

test("guest import is explicit, snapshot strips sessions and rejects oversized extras atomically", async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await load(page);
    const result = await page.evaluate(async () => {
      const m = (window as any).atlasStore;
      if (!m.importGuestProfile) return { missing: true };
      m.store.progress((p: any) => ({ ...p, bookmarks: ['guest'] })); await m.flush();
      await m.switchProfile('A');
      const before = m.store.get().progress.bookmarks;
      await m.importGuestProfile(); await m.flush();
      const imported = m.store.get().progress.bookmarks;
      const snapshot = JSON.parse(m.exportBackup());
      const bad = m.importBackup(JSON.stringify({ ...snapshot, progress: { ...snapshot.progress, bookmarks: ['bad'] }, extras: { 'word-atlas:reader:v1': { size: 25 }, 'word-atlas:appearance': 'x'.repeat(2100000) } }));
      const after = m.store.get().progress.bookmarks;
      await m.switchProfile(null);
      return { before, imported, session: snapshot.progress.session, bad: bad.ok, after, guest: m.store.get().progress.bookmarks };
    });
    assert.deepEqual(result, { before: [], imported: ['guest'], session: null, bad: false, after: ['guest'], guest: ['guest'] });
  } finally { await context.close(); }
});

test('standalone account panel bootstraps disabled HTTP service and offers HTTPS migration without hiding guest data', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.route('**/api/auth/session', r => r.fulfill({ json: { user: null, enabled: false, csrfToken: '', secureOrigin: 'https://43.133.166.184' } }));
  try {
    await load(page);
    await page.evaluate(async () => {
      const panel = await import('/src/pages/Account.tsx' as string).catch(e => { console.error(e); return null; });
      if (!panel?.AccountPanel) return;
      const { React, dom } = await import('/account-test-mount.js' as string);
      const root = document.createElement('div'); document.body.append(root);
      dom.createRoot(root).render(React.createElement(panel.AccountPanel));
    });
    await assert.doesNotReject(() => page.getByRole('link', { name: /HTTPS/ }).waitFor({ timeout: 3000 }));
    assert.equal(await page.getByRole('link', { name: /HTTPS/ }).getAttribute('href'), 'https://43.133.166.184/#/account');
    assert.match(await page.locator('body').innerText(), /导出.*JSON/);
    assert.equal(await page.locator('input[type=password]:enabled').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/word-atlas-task2-http-mobile.png', fullPage: true });
  } finally { await context.close(); }
});

test('registration uses validated fields and free cloud access, password change returns to login', async () => {
  const context = await browser.newContext(); const page = await context.newPage(); let loggedIn = false;
  const calls: { path: string; data: any; headers: Record<string, string> }[] = [];
  const user = { id: 'A', username: 'alice', nickname: 'Alice', role: 'user', disabled: false, membership: { active: false, permanent: false, expiresAt: null } };
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: loggedIn ? user : null, enabled: true, csrfToken: 'csrf' } });
    calls.push({ path, data: req.postDataJSON(), headers: req.headers() });
    if (path === '/api/auth/register') loggedIn = true;
    if (path === '/api/auth/password') loggedIn = false;
    return route.fulfill({ json: { user: loggedIn ? user : null } });
  });
  try {
    await load(page);
    await page.evaluate(async () => {
      const panel = await import('/src/pages/Account.tsx' as string).catch(e => { console.error(e); return null; }); if (!panel?.AccountPanel) return;
      const { React, dom } = await import('/account-test-mount.js' as string); const root = document.createElement('div'); document.body.append(root);
      dom.createRoot(root).render(React.createElement(panel.AccountPanel));
    });
    await page.getByRole('button', { name: '注册', exact: true }).click({ timeout: 3000 });
    await page.getByLabel('用户名', { exact: true }).fill('alice');
    await page.getByLabel('昵称（可选）').fill('Alice');
    await page.getByLabel('密码', { exact: true }).fill('long-password-123');
    await page.getByLabel('确认密码', { exact: true }).fill('long-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await page.getByRole('button', { name: '创建云端备份' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '创建云端备份' }).isEnabled(), true);
    await page.locator('summary').filter({ hasText: '修改密码' }).click();
    await page.getByLabel('当前密码').fill('long-password-123');
    await page.getByLabel('新密码', { exact: true }).fill('new-password-456');
    await page.getByLabel('确认新密码').fill('new-password-456');
    await page.getByRole('button', { name: '修改密码' }).click();
    await page.getByRole('button', { name: '登录账号', exact: true }).waitFor();
    assert.equal(await page.locator('.account-badge').count(), 0);
    assert.equal(calls[0].path, '/api/auth/register'); assert.equal(calls[0].headers['x-csrf-token'], 'csrf');
    assert.deepEqual(calls[0].data, { username: 'alice', password: 'long-password-123', nickname: 'Alice' });
    assert.equal(calls[1].headers['x-account-id'], 'A');
    assert.equal(calls[1].path, '/api/auth/password');
  } finally { await context.close(); }
});

test('admin confirms actions with password reauthentication and renders reset token and audit', async () => {
  const context = await browser.newContext(); const page = await context.newPage(); const writes: string[] = [];
  const user = { id: 'admin-A', username: 'admin', nickname: '', role: 'admin', disabled: false, membership: { active: false, permanent: false, expiresAt: null } };
  const target = { ...user, id: 'target-B', username: 'learner', role: 'user' };
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === 'POST') { writes.push(path); assert.equal(req.headers()['x-account-id'], 'admin-A'); }
    const json = path === '/api/auth/session' ? { user, enabled: true, csrfToken: 'csrf' } : path === '/api/admin/users' ? { users: [target] } : path === '/api/admin/audit' ? { audit: [{ id: 1, actorId: user.id, targetId: target.id, action: 'membership', before: {}, after: { days: 30 }, createdAt: 0 }] } : path.endsWith('/reset') ? { token: 'one-use-reset', expiresAt: Date.now() + 10000 } : { user: target };
    return route.fulfill({ json });
  });
  try {
    await load(page);
    await page.evaluate(async () => {
      const panel = await import('/src/pages/Admin.tsx' as string).catch(() => null); if (!panel?.AdminPage) return;
      const { React, dom } = await import('/account-test-mount.js' as string); const root = document.createElement('div'); document.body.append(root);
      dom.createRoot(root).render(React.createElement(panel.AdminPage));
    });
    await page.getByRole('button', { name: '禁用账号', exact: true }).click({ timeout: 3000 });
    assert.equal(await page.getByRole('button', { name: /开通|永久|取消会员/ }).count(), 0);
    await page.getByLabel('管理员密码').fill('admin-password-123');
    await page.getByRole('button', { name: '重新验证并执行' }).click();
    await page.getByRole('button', { name: '生成重置凭据' }).click();
    await page.getByLabel('管理员密码').fill('admin-password-123');
    await page.getByRole('button', { name: '重新验证并执行' }).click();
    await page.getByLabel('一次性凭据').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/word-atlas-task2-admin-mobile.png', fullPage: true });
    assert.equal(await page.getByLabel('一次性凭据').inputValue(), 'one-use-reset');
    assert.deepEqual(writes, ['/api/auth/reauth', '/api/admin/users/target-B/status', '/api/auth/reauth', '/api/admin/users/target-B/reset']);
    assert.match(await page.locator('body').innerText(), /历史权限变更/);
  } finally { await context.close(); }
});

test('same-origin tabs serialize session bootstrap to avoid competing anonymous CSRF cookies',async()=>{
  const context=await browser.newContext();let active=0,peak=0;
  await context.route('**/api/auth/session',async route=>{
    active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,500));
    await route.fulfill({json:{user:null,enabled:false,csrfToken:''}});active--;
  });
  const pages=await Promise.all([context.newPage(),context.newPage()]);
  try {
    await Promise.all(pages.map(p=>load(p)));
    const result=await Promise.all(pages.map(p=>p.evaluate(async()=>{
      const m=await import('/src/account/state.tsx' as string);await m.refreshAccount();return m.accountState.get().bootstrapped;
    })));
    assert.deepEqual(result,[true,true]);assert.equal(peak,1,'Anonymous session creation must not overlap across tabs');
  }finally{await context.close();}
});

test('cross-tab identity signals revalidate the cookie and replace profile data', async () => {
  const context = await browser.newContext(); let identity: string | null = 'A';
  await context.route('**/api/auth/session', route => route.fulfill({ json: { user: identity ? { id: identity, username: identity, nickname: '', role: 'user', disabled: false, membership: { active: false, permanent: false, expiresAt: null } } : null, enabled: true, csrfToken: 'csrf' } }));
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  try {
    for (const page of pages) {
      await load(page);
      await page.evaluate(async () => { const mod = await import('/src/account/index.ts' as string); const { React, dom } = await import('/account-test-mount.js' as string); const root = document.createElement('div'); document.body.append(root); dom.createRoot(root).render(React.createElement(mod.AccountController)); });
      await page.waitForFunction(() => (window as any).atlasStore.store.get().ready);
      await waitForAsync(page,async () => (await import('/src/store/profile.ts' as string)).getProfile() === 'A');
    }
    await pages[0].evaluate(async () => { const m = (window as any).atlasStore; m.store.progress((p: any) => ({ ...p, bookmarks: ['private-A'] })); await m.flush(); });
    identity = 'B';
    await pages[0].evaluate(() => localStorage.setItem('word-atlas:identity-changed', 'B-signal'));
    await waitForAsync(pages[1],async () => (await import('/src/store/profile.ts' as string)).getProfile() === 'B');
    assert.deepEqual(await pages[1].evaluate(() => (window as any).atlasStore.store.get().progress.bookmarks), []);
    identity = null;
    await pages[0].evaluate(() => localStorage.setItem('word-atlas:identity-changed', 'logout-signal'));
    await waitForAsync(pages[1],async () => (await import('/src/store/profile.ts' as string)).getProfile() === null);
    assert.deepEqual(await pages[1].evaluate(() => (window as any).atlasStore.store.get().progress.bookmarks), []);
  } finally { await context.close(); }
});

test('authentication writes share the cross-tab bootstrap cookie lock',async()=>{
  const context=await browser.newContext();let active=0,peak=0;
  await context.route('**/api/auth/**',async route=>{
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,350));active--;
    await route.fulfill({json:{user:null,enabled:true,emailEnabled:false,csrfToken:'csrf'}});
  });
  const pages=await Promise.all([context.newPage(),context.newPage()]);
  try {
    await Promise.all(pages.map(p=>load(p)));
    await Promise.all(pages.map(p=>p.evaluate(async()=>{const m=await import('/src/account/state.tsx' as string);await m.refreshAccount();})));
    peak=0;
    await Promise.all([
      pages[0].evaluate(async()=>{const m=await import('/src/account/state.tsx' as string);await m.authAction('login',{username:'test_user',password:'disposable fixture password'});}),
      pages[1].evaluate(async()=>{const m=await import('/src/account/state.tsx' as string);await m.refreshAccount(true);}),
    ]);
    assert.equal(peak,1,'Cookie-changing authentication must not overlap session bootstrap');
  }finally{await context.close();}
});

test('failed old profile writes retry only in the old namespace and cannot change new profile memory', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await load(page);
    const result = await page.evaluate(async () => {
      const m = (window as any).atlasStore;
      await m.switchProfile('A');
      const put = IDBObjectStore.prototype.put; let fail = true;
      IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) { if (fail && String(key).includes('account:A:')) this.transaction.abort(); return put.call(this, value, key!); };
      m.store.progress((p: any) => ({ ...p, bookmarks: ['old-A'] })); await m.flush();
      await m.switchProfile('B');
      m.store.progress((p: any) => ({ ...p, bookmarks: ['new-B'] })); m.store.settings({ dailyNew: 5 });
      fail = false; await m.flush();
      const b = m.store.get().progress.bookmarks, settingsB = m.store.get().settings.dailyNew;
      await m.switchProfile('A');
      return { b, settingsB, a: m.store.get().progress.bookmarks };
    });
    assert.deepEqual(result, { b: ['new-B'], settingsB: 5, a: ['old-A'] });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('reader callbacks captured before an account switch cannot persist into the new account', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await load(page);
    const result = await page.evaluate(async () => {
      const m = (window as any).atlasStore, profile = await import('/src/store/profile.ts' as string), reader = await import('/src/lib/reader.ts' as string);
      await m.switchProfile('A'); const epoch = profile.profileGeneration(); await m.switchProfile('B');
      let rejected = false; try { reader.savePosition({ kind: 'short', id: 'A-book', paragraph: 8 }, epoch); } catch { rejected = true; }
      return { rejected, position: reader.readPosition() };
    });
    assert.deepEqual(result, { rejected: true, position: null });
  } finally { await context.close(); }
});

test('wire snapshots sanitize unknown fields and exclude other account extras and credentials', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await load(page);
    const result = await page.evaluate(async () => {
      const m = (window as any).atlasStore; await m.switchProfile('A');
      localStorage.setItem('word-atlas:account:A:word-atlas:reader:v1', '{"size":24}');
      localStorage.setItem('word-atlas:account:A:word-atlas:csrf', 'secret');
      localStorage.setItem('word-atlas:account:B:word-atlas:reader:v1', '{"size":28}');
      const raw = JSON.parse(m.exportBackup());
      raw.progress.cards = { good: { due: 1, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, seen: 1, unexpected: 'must-drop' } };
      m.importBackup(JSON.stringify(raw));
      const snapshot = JSON.parse(m.exportBackup());
      return { extras: snapshot.extras, cardKeys: Object.keys(snapshot.progress.cards.good), session: snapshot.progress.session };
    });
    assert.deepEqual(result.extras, { 'word-atlas:reader:v1': { size: 24 } });
    assert.equal(result.cardKeys.includes('unexpected'), false); assert.equal(result.session, null);
  } finally { await context.close(); }
});

test('restoring a snapshot replaces current-profile extras and preserves other identities',async()=>{
  const context=await browser.newContext(),page=await context.newPage();
  try {
    await load(page);
    const result=await page.evaluate(async()=>{
      const m=(window as any).atlasStore;await m.switchProfile('A');
      localStorage.setItem('word-atlas:account:A:word-atlas:reader-position:v1','{"id":"obsolete"}');
      localStorage.setItem('word-atlas:account:B:word-atlas:reader-position:v1','{"id":"B"}');
      localStorage.setItem('word-atlas:reader-position:v1','{"id":"guest"}');
      localStorage.setItem('word-atlas:account:A:word-atlas:sync:test','{"version":3}');
      const snapshot=JSON.parse(m.exportBackup());snapshot.extras={};
      const restored=m.importBackup(JSON.stringify(snapshot));
      return {ok:restored.ok,old:localStorage.getItem('word-atlas:account:A:word-atlas:reader-position:v1'),b:localStorage.getItem('word-atlas:account:B:word-atlas:reader-position:v1'),guest:localStorage.getItem('word-atlas:reader-position:v1'),meta:localStorage.getItem('word-atlas:account:A:word-atlas:sync:test')};
    });
    assert.deepEqual(result,{ok:true,old:null,b:'{"id":"B"}',guest:'{"id":"guest"}',meta:'{"version":3}'});
  }finally{await context.close();}
});

test('a quota error mid-restore rolls extras back without changing learning progress',async()=>{
  const context=await browser.newContext(),page=await context.newPage();
  try {
    await load(page);
    const result=await page.evaluate(async()=>{
      const m=(window as any).atlasStore;await m.switchProfile('A');
      m.store.progress((p:any)=>({...p,bookmarks:['before']}));await m.flush();
      const a='word-atlas:account:A:word-atlas:appearance',r='word-atlas:account:A:word-atlas:reader:v1';
      localStorage.setItem(a,'{"theme":"aurora"}');localStorage.setItem(r,'{"size":20}');
      const snapshot=JSON.parse(m.exportBackup());snapshot.progress.bookmarks=['incoming'];snapshot.extras={'word-atlas:appearance':{theme:'dark'},'word-atlas:reader:v1':{size:28}};
      const original=Storage.prototype.setItem;let writes=0;
      Storage.prototype.setItem=function(k:string,v:string){if(k.startsWith('word-atlas:account:A:')&&++writes===2)throw new DOMException('quota','QuotaExceededError');return original.call(this,k,v);};
      let answer;
      try{answer=m.importBackup(JSON.stringify(snapshot));}finally{Storage.prototype.setItem=original;}
      return {ok:answer.ok,a:localStorage.getItem(a),r:localStorage.getItem(r),bookmarks:m.store.get().progress.bookmarks};
    });
    assert.deepEqual(result,{ok:false,a:'{"theme":"aurora"}',r:'{"size":20}',bookmarks:['before']});
  }finally{await context.close();}
});

test('account cloud snapshots support normal per-word illustration preferences beyond 200 keys',async()=>{
  const context=await browser.newContext(),page=await context.newPage();
  try {
    await load(page);
    const count=await page.evaluate(async()=>{
      const m=(window as any).atlasStore;await m.switchProfile('A');
      for(let i=0;i<201;i++)localStorage.setItem('word-atlas:account:A:word-atlas:illustration:word'+i,'classic');
      const {readSnapshot}=await import('/src/account/state.tsx' as string);
      return Object.keys(readSnapshot().extras).length;
    });
    assert.equal(count,201);
  }finally{await context.close();}
});

async function mountMenu(page: Page) {
  await load(page);
  await page.evaluate(async () => {
    const { React, dom, MenuHarness } = await import('/account-test-mount.js' as string);
    const root = document.createElement('div'); document.body.append(root);
    dom.createRoot(root).render(React.createElement(MenuHarness));
    const outside = document.createElement('input'); outside.setAttribute('aria-label', 'Outside'); outside.style.cssText = 'position:fixed;bottom:10px;left:10px'; document.body.append(outside);
  });
}

async function mountAuth(page: Page) {
  await load(page);
  await page.evaluate(async()=>{
    const {React,dom}=await import('/account-test-mount.js' as string);
    const {AccountPanel}=await import('/src/pages/Account.tsx' as string);
    const root=document.createElement('div');document.body.append(root);
    dom.createRoot(root).render(React.createElement(AccountPanel));
  });
}

test('login has two direct methods, placeholder labels and an inline code action', async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  await page.route('**/api/**',route=>route.fulfill({json:{user:null,enabled:true,emailEnabled:true,csrfToken:'csrf'}}));
  try{
    await mountAuth(page);
    await page.getByRole('button',{name:'登录账号',exact:true}).waitFor();
    assert.deepEqual(await page.locator('.account-auth-tabs button').allTextContents(),['账户登录','验证码登录']);
    assert.equal(await page.locator('.account-methods').count(),0);
    await page.getByPlaceholder('请输入账号或邮箱',{exact:true}).waitFor();
    await page.getByPlaceholder('请输入密码',{exact:true}).waitFor();
    await page.getByRole('button',{name:'验证码登录',exact:true}).click();
    await page.getByPlaceholder('请输入邮箱',{exact:true}).fill('alice@example.com');
    const code=page.getByLabel('六位验证码',{exact:true});await code.fill('012345');assert.equal(await code.inputValue(),'012345');
    const group=page.locator('.account-code-field'),send=group.getByRole('button',{name:'获取验证码',exact:true});
    const outer=await group.boundingBox(),inner=await send.boundingBox();assert.ok(outer&&inner&&inner.x>=outer.x&&inner.x+inner.width<=outer.x+outer.width+1);
    assert.equal(await send.evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    assert.equal(await page.locator('.account-code-hint').isVisible(),false);
    await page.getByRole('button',{name:'注册',exact:true}).click();await page.getByRole('button',{name:'用户名注册',exact:true}).click();await page.getByLabel('用户名',{exact:true}).waitFor();
    await page.getByRole('button',{name:'返回登录',exact:true}).click();await page.getByRole('button',{name:'账户登录',exact:true}).waitFor();
  }finally{await context.close();}
});

test('disabled email on the authentication page preserves username fallback', async()=>{
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/api/**',route=>route.fulfill({json:{user:null,enabled:true,emailEnabled:false,csrfToken:'csrf'}}));
  try{await mountAuth(page);await page.getByRole('button',{name:'注册',exact:true}).click();await page.getByRole('button',{name:'邮箱注册',exact:true}).click();assert.equal(await page.getByRole('button',{name:'获取验证码'}).isEnabled(),false);assert.match(await page.locator('.account-panel').innerText(),/邮箱服务尚未启用/);await page.getByRole('button',{name:'用户名注册',exact:true}).click();await page.getByLabel('用户名',{exact:true}).waitFor();}finally{await context.close();}
});

test('anonymous header returns to the entry page without exposing an authentication dropdown', async () => {
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/api/**',route=>route.fulfill({json:{user:null,enabled:true,emailEnabled:true,csrfToken:'csrf'}}));
  try {
    await mountMenu(page);
    assert.equal(await page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
    await page.getByRole('button',{name:'返回入口',exact:true}).click();
    assert.equal(await page.evaluate(()=>(window as any).accountEntryRequested),1);
    assert.equal(await page.locator('.account-dropdown').count(),0);
    assert.equal(await page.getByRole('button',{name:'注册',exact:true}).count(),0);
  }finally{await context.close();}
});

test('account dropdown is anchored, keyboard dismissible and bounded at 390px without a modal or scroll lock', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  await page.route('**/api/**', route => route.fulfill({ json: { user: {id:'menu-user',username:'alice',nickname:'Alice',email:'alice@example.com',emailVerified:true,role:'user',disabled:false,createdAt:1793145600000}, enabled: true, emailEnabled: false, csrfToken: 'csrf' } }));
  try {
    await mountMenu(page);
    const trigger = page.getByRole('button', { name: '账户菜单', exact: true });
    await trigger.click();
    assert.equal(await page.getByRole('button', { name: '注册', exact: true }).count(), 0);
    await page.getByRole('button', { name: '个人中心', exact: true }).waitFor();
    await page.getByRole('button', { name: '账户注册信息', exact: true }).click();
    assert.match(await page.locator('.account-dropdown').innerText(), /alice@example.com/);
    assert.match(await page.locator('.account-dropdown').innerText(), /注册时间/);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    const bounds = await page.locator('.account-dropdown').boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height < 844);
    await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click(); await page.getByLabel('Outside', { exact: true }).click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByLabel('Outside', { exact: true }).evaluate(el => el === document.activeElement), true);
    await trigger.click(); await page.locator('.account-dropdown button').last().focus(); await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('[aria-label="账户菜单"]')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await page.getByLabel('Outside', { exact: true }).evaluate(el => el === document.activeElement), true);
  } finally { await context.close(); }
});

test('verified email registration and six digit login use CSRF, purpose and cooldown without losing leading zeroes', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  const calls: { path: string; body: any; csrf?: string }[] = [];
  await page.route('**/api/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null, enabled: true, emailEnabled: true, csrfToken: 'email-csrf' } });
    calls.push({ path, body: req.postDataJSON(), csrf: req.headers()['x-csrf-token'] });
    return route.fulfill({ json: { ok: true, retryAfter: 60, expiresIn: 300 } });
  });
  try {
    await mountAuth(page);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.getByRole('button', { name: '邮箱注册', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('alice@example.com');
    await page.getByRole('button', { name: '获取验证码' }).click();
    await page.getByRole('button', { name: /秒后重发/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /秒后重发/ }).isDisabled(), true);
    assert.match(await page.locator('.account-panel').innerText(), /5 分钟/);
    await page.getByLabel('六位验证码').fill('012345');
    await page.getByLabel('密码', { exact: true }).fill('long-password-123');
    await page.getByLabel('确认密码', { exact: true }).fill('long-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    // The session refresh remounts this anonymous mock at the login entry.
    await page.getByRole('button', { name: '账户登录', exact: true }).waitFor();
    await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('alice@example.com');
    await page.getByRole('button', { name: '获取验证码' }).click();
    await page.getByLabel('六位验证码').fill('001234');
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login-code');
    await page.getByRole('button', { name: '登录账号' }).click();
    await loginResponse;
    assert.deepEqual(calls.map(c => [c.path, c.body]), [
      ['/api/auth/email-code', { email: 'alice@example.com', purpose: 'register' }],
      ['/api/auth/register', { email: 'alice@example.com', code: '012345', password: 'long-password-123', nickname: '' }],
      ['/api/auth/email-code', { email: 'alice@example.com', purpose: 'login' }],
      ['/api/auth/login-code', { email: 'alice@example.com', code: '001234' }],
    ]);
    assert.ok(calls.every(c => c.csrf === 'email-csrf'));
  } finally { await context.close(); }
});

test('email service failure remains honest and does not block username or email password login', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  const logins: unknown[] = [];
  await page.route('**/api/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null, enabled: true, emailEnabled: true, csrfToken: 'csrf' } });
    if (path === '/api/auth/email-code') return route.fulfill({ status: 503, json: { error: '邮箱服务尚未配置。' } });
    if (path === '/api/auth/login') logins.push(req.postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await mountAuth(page);
    await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('alice@example.com');
    await page.getByRole('button', { name: '获取验证码' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /尚未配置/);
    assert.equal(await page.getByRole('button', { name: /秒后重发/ }).count(), 0);
    await page.getByRole('button', { name: '账户登录', exact: true }).click();
    for (const identifier of ['alice', 'alice@example.com']) {
      await page.getByLabel('用户名或邮箱').fill(identifier);
      await page.getByLabel('密码', { exact: true }).fill('long-password-123');
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login');
      await page.getByRole('button', { name: '登录账号' }).click(); await response;
      await page.getByLabel('用户名或邮箱').waitFor();
    }
    assert.deepEqual(logins, [{ identifier: 'alice', password: 'long-password-123' }, { identifier: 'alice@example.com', password: 'long-password-123' }]);
  } finally { await context.close(); }
});

test('free accounts without membership sync and back up using canonical paths, and an open menu clears on identity change', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  let signedIn = true;
  const writes: { path: string; owner: string | undefined; body: any }[] = [];
  await page.route('**/api/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'free-A', username: 'alice', nickname: '', email: null, emailVerified: false, role: 'user', disabled: false } : null, enabled: true, emailEnabled: false, csrfToken: 'csrf' } });
    if (req.method() !== 'GET') writes.push({ path, owner: req.headers()['x-account-id'], body: req.postDataJSON() });
    return route.fulfill({ json: path === '/api/account/progress' ? req.method() === 'PUT' ? { version: 1 } : { version: 0, snapshot: null } : { backups: [] } });
  });
  try {
    await mountMenu(page);
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page.getByRole('button', { name: '数据同步与备份' }).click();
    await page.getByRole('button', { name: '创建云端备份' }).click();
    await page.getByText('云端备份已保存。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '立即检查同步' }).click();
    await page.getByText('已同步 · v1', { exact: true }).waitFor();
    assert.ok(writes.some(w => w.path === '/api/account/backups' && w.owner === 'free-A' && w.body.snapshot.progress.datasetId === 'test'));
    assert.ok(writes.some(w => w.path === '/api/account/progress' && w.owner === 'free-A' && w.body.version === 0));
    signedIn = false;
    await page.evaluate(async () => { await (await import('/src/account/state.tsx' as string)).refreshAccount(true); });
    await page.getByRole('button', { name: '返回入口', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '创建云端备份' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '账户菜单', exact: true }).count(), 0);
    assert.equal(await page.locator('.account-badge').count(), 0);
  } finally { await context.close(); }
});
