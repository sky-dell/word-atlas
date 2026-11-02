// Read-only HTTPS UI checks. Never submits registration, login, or email requests.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin=process.env.TEST_URL||'https://43.133.166.184';
const output=path.resolve(process.env.AUTH_OUTPUT||'.local/auth-entry/public');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({args:['--no-sandbox']});
const errors=[],results=[];
try {
 for(const [width,height] of [[1920,900],[1440,900],[1366,768],[1280,640],[1280,600],[390,844],[390,700],[375,667],[320,640]])for(const theme of ['light','dark']) {
  const ctx=await browser.newContext({viewport:{width,height}});
  await ctx.addInitScript(theme=>{localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false,sfx:false}));localStorage.setItem('word-atlas:appearance',JSON.stringify({theme}));localStorage.setItem('word-atlas:reader:v1',JSON.stringify({size:25}));},theme);
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  // Exercise public UI without creating server-side visitor identities or data.
  await page.route('**/api/guest/**',route=>{
    const session={guest:{id:'public-readonly-fixture',name:'游客_布局核验',createdAt:Date.now(),expiresAt:Date.now()+86400000,hardExpiresAt:Date.now()+604800000},csrfToken:'fixture'};
    return route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/state')?{...session,version:0,state:{records:{'word-atlas:settings':JSON.stringify({onboarded:true,splash:false,sfx:false})}}}:session});
  });
  const response=await page.goto(origin+'/');assert.equal(response.status(),200);
  const entry=page.locator('.auth-entry');await entry.locator('input[name=username]').waitFor();
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;delete document.documentElement.dataset.skin;},theme);
  const guestAction=page.getByRole('button',{name:'以游客身份登录',exact:true});
  for(const hovered of [false,true]){
    if(hovered)await guestAction.hover();
    const style=await guestAction.evaluate(el=>({border:getComputedStyle(el).borderTopWidth,background:getComputedStyle(el).backgroundColor}));
    assert.equal(style.border,'0px');assert.equal(style.background,'rgba(0, 0, 0, 0)');
  }
  await page.mouse.move(0,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),true,`${width}x${height}: account login fits without vertical scroll`);
  assert.equal(await page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
  assert.equal(await page.locator('.account-dropdown,[aria-modal=true]').count(),0);
  await page.screenshot({path:path.join(output,`auth-${width}-${height}-${theme}.png`),animations:'disabled'});
  await page.getByRole('button',{name:'注册',exact:true}).click();await entry.locator('input[name=email]').waitFor();await entry.locator('input[name=code]').fill('012345');assert.equal(await entry.locator('input[name=code]').inputValue(),'012345');
  await page.getByRole('button',{name:'下一步',exact:true}).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.getByRole('button',{name:'用户名注册',exact:true}).click();await entry.locator('input[name=username]').waitFor();
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'验证码登录',exact:true}).click();await entry.locator('input[name=code]').waitFor();
  assert.deepEqual(await entry.locator('.account-auth-tabs button').allTextContents(),['账户登录','验证码登录']);
  assert.equal(await entry.locator('.account-methods').count(),0);
  assert.equal(await entry.getByPlaceholder('请输入邮箱').count(),1);
  assert.equal(await entry.getByPlaceholder('请输入6位验证码').count(),1);
  const field=await entry.locator('.account-code-field').boundingBox(),send=await entry.getByRole('button',{name:'获取验证码',exact:true}).boundingBox();
  assert.ok(field&&send&&send.x>=field.x&&send.x+send.width<=field.x+field.width+1);
  assert.equal(await entry.locator('.account-code-hint').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.evaluate(()=>scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),true,`${width}x${height}: code login fits without vertical scroll`);
  const guest=await page.getByRole('button',{name:/以游客身份登录/}).boundingBox();
  assert.ok(guest&&guest.y>=0&&guest.y+guest.height<=height,'Guest action remains fully in viewport');
  await page.screenshot({path:path.join(output,`code-${width}-${height}-${theme}.png`),animations:'disabled'});
  await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('word-atlas:entry-mode')),null);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('word-atlas:entry-mode')),'guest');
  assert.equal(await page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
  await page.getByRole('button',{name:/^游客账户菜单/}).click();await page.getByRole('button',{name:'退出游客模式',exact:true}).click();await entry.locator('input[name=username]').waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('word-atlas:entry-mode')),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('word-atlas:reader:v1')),'{"size":25}');
  for(const route of ['account','admin']){await page.goto(origin+'/?entry-check='+route+'#/'+route);await entry.locator('input[name=username]').waitFor();assert.equal(await page.locator('.account-dropdown').count(),0);}
  const tab=await ctx.newPage();await tab.goto(origin+'/#/atlas');await tab.locator('.auth-entry input[name=username]').waitFor();await tab.close();
  results.push(`${width}x${height}px ${theme}: no login scroll or clipped controls, email/username modes, guest return, protected routes, no modal, records retained`);console.log('PASS '+results.at(-1));await ctx.close();
 }
 assert.deepEqual(errors,[]);
} finally {await browser.close();await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));}
