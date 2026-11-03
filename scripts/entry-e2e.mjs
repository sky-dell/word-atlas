import {createGuests} from '../server/guests.mjs';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createAccounts } from '../server/accounts.mjs';
import { createApplication } from './http-handler.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-entry-'));
let guests,accounts,server,browser;const errors=[],results=[];
async function check(name,fn){try{await fn();results.push(name);console.log('PASS '+name);}catch(e){for(const c of browser?.contexts()||[])for(const p of c.pages())console.error('Failure state:',p.url(),(await p.locator('body').innerText().catch(()=>'' )).slice(0,1600));throw e;}}
async function maybeWelcome(p){const w=p.getByRole('dialog',{name:'欢迎',exact:true});try{await w.waitFor({timeout:2000});}catch{if(!await w.isVisible())return;}try{await w.getByRole('button',{name:'出发'}).click({timeout:5000});if(await p.locator('.guest-notice').isVisible())await p.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});}catch(e){if(await w.isVisible())throw e;}}
try {
  server=https.createServer({key:await fs.readFile('/etc/word-atlas/tls/privkey.pem'),cert:await fs.readFile('/etc/word-atlas/tls/fullchain.pem')},(req,res)=>handler(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='https://127.0.0.1:'+server.address().port;
  accounts=createAccounts({dbPath:path.join(dir,'test.sqlite'),origins:[origin],secureCookies:true});
  guests=createGuests({dbPath:path.join(dir,'guests.sqlite'),origins:[origin]});
  const handler=createApplication({guests,root:path.resolve('dist'),accounts,secureOrigin:origin});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const ctx=await browser.newContext({ignoreHTTPSErrors:true});
  await ctx.addInitScript(()=>localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false,sfx:false})));
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  ctx.on('response',async r=>{if(r.url().includes('/api/auth/')&&r.status()>=400){const v=await r.json().catch(()=>({}));console.error('Auth response',r.status(),v.code);}});
  await check('entry directly offers auth and guest entry; guest choice is tab-only and preserves records',async()=>{
    await page.goto(origin+'/#/atlas');
    await page.locator('.auth-entry').waitFor({timeout:6000});
    await page.evaluate(()=>localStorage.setItem('word-atlas:reader:v1',JSON.stringify({size:25})));
    await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();
    assert.deepEqual(await page.evaluate(()=>({temporary:sessionStorage.getItem('word-atlas:entry-mode'),permanent:localStorage.getItem('word-atlas:entry-mode'),reader:localStorage.getItem('word-atlas:reader:v1')})),{temporary:'guest',permanent:null,reader:'{"size":25}'});
    await page.reload();await page.locator('main.main').waitFor();assert.equal(await page.locator('.auth-entry').count(),0);
  });
  await check('unsigned account deep link can return to guest without reopening the account dialog',async()=>{
    const c=await browser.newContext({ignoreHTTPSErrors:true});await c.addInitScript(()=>localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:true})));
    try {const p=await c.newPage();await p.goto(origin+'/#/account');await p.getByRole('button',{name:'以游客身份登录',exact:true}).click();await p.locator('main.main').waitFor();await maybeWelcome(p);assert.equal(await p.locator('.account-dropdown:visible').count(),0);assert.equal(new URL(p.url()).hash,'#/me');}finally{await c.close();}
  });
  const second=await ctx.newPage();second.on('pageerror',e=>errors.push(e.message));
  await check('new tab asks again; registration from account entry and existing login bypass the gate',async()=>{
    await second.goto(origin+'/');
    const panel=second.getByRole('region',{name:'账户',exact:true});await panel.getByRole('button',{name:'注册',exact:true}).click();await panel.getByRole('button',{name:'用户名注册',exact:true}).click();
    await panel.locator('input[name=username]').fill('entry_learner');await panel.getByRole('button',{name:'下一步',exact:true}).click();await panel.locator('input[name=password]').fill('Entry fixture password only 2026!');await panel.locator('input[name=confirm]').fill('Entry fixture password only 2026!');
    await panel.getByRole('button',{name:'完成注册',exact:true}).click();await second.locator('main.main').waitFor();
    await maybeWelcome(second);
    assert.equal(await second.evaluate(()=>sessionStorage.getItem('word-atlas:entry-mode')),null);
    await page.waitForFunction(()=>sessionStorage.getItem('word-atlas:entry-mode')===null);
    await second.reload();await second.locator('main.main').waitFor();assert.equal(await second.locator('.auth-entry').count(),0);
  });
  await check('default guest refresh does not restore the obsolete splash',async()=>{
    const c=await browser.newContext({ignoreHTTPSErrors:true});
    await c.addInitScript(()=>localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:true})));
    try {const p=await c.newPage();await p.goto(origin+'/');await p.getByRole('button',{name:'以游客身份登录',exact:true}).click();await p.locator('main.main').waitFor();await maybeWelcome(p);await p.reload();await p.locator('main.main').waitFor();await maybeWelcome(p);
      assert.equal(await p.locator('.splash').count(),0);await p.locator('.topbar').getByRole('button',{name:/^游客账户菜单/}).click({trial:true});
    } finally {await c.close();}
  });
  await check('logout returns to entry and existing account can log in again',async()=>{
    await maybeWelcome(second);
    await second.locator('.topbar').getByRole('button',{name:'账户菜单',exact:true}).click();await second.getByRole('button',{name:'退出登录',exact:true}).click();
    
    await second.locator('input[name=username]').fill('entry_learner');await second.locator('input[name=password]').fill('Entry fixture password only 2026!');await second.getByRole('button',{name:'登录账号',exact:true}).click();await second.locator('main.main').waitFor();
  });
  await check('ordinary user login from the admin route returns to the personal center',async()=>{
    const c=await browser.newContext({ignoreHTTPSErrors:true});
    try{
      const p=await c.newPage();
      await p.goto(origin+'/#/admin');
      await p.locator('.auth-entry').waitFor();
      await p.locator('input[name=username]').fill('entry_learner');
      await p.locator('input[name=password]').fill('Entry fixture password only 2026!');
      await p.getByRole('button',{name:'登录账号',exact:true}).click();
      await p.waitForFunction(()=>location.hash==='#/me',null,{timeout:8000});
      await p.locator('main.main').waitFor();
      assert.equal(await p.getByText('请先登录管理员账号。管理权限由服务器验证。',{exact:true}).count(),0);
    }finally{await c.close();}
  });
  await check('learner tabs fit desktop viewports without a page scrollbar',async()=>{
    for(const [width,height] of [[1366,768],[1280,720]]){
      await second.setViewportSize({width,height});
      await second.goto(origin+'/#/me');
      await second.locator('.me-tabs').waitFor();
      for(const label of ['学习概览','学习设置','外观与计划','数据管理']){
        await second.getByRole('tab',{name:label,exact:true}).click();
        assert.equal(await second.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true,`${width}x${height} ${label}`);
      }
    }
  });
  await check('word search finds alternate Chinese senses and prioritizes exact months',async()=>{
    await second.goto(origin+'/#/me');
    await second.locator('.me-tabs').waitFor();
    await second.getByRole('button',{name:'搜索单词',exact:true}).click();
    const input=second.getByRole('dialog',{name:'搜索单词',exact:true}).locator('input');
    for(const [query,expectedWord,expectedMeaning] of [['三月','March','三月'],['五月','May','五月'],['一月','January','一月'],['河岸','bank','河岸；湖岸']]){
      await input.fill(query);
      await second.waitForFunction(()=>document.querySelectorAll('[role="option"]').length===1);
      const option=await second.getByRole('option').innerText();
      assert.match(option,new RegExp(expectedWord,'i'));
      assert.match(option,new RegExp(expectedMeaning));
    }
    await input.fill('五月');
    await second.getByRole('option').click();
    const maySheet=second.getByRole('dialog',{name:'May 词条',exact:true});
    await maySheet.waitFor();
    await maySheet.getByText('五月',{exact:true}).waitFor();
    await second.keyboard.press('Escape');
  });
  await check('account deep-link registration enters learning without stacked dialogs and logout returns to choices',async()=>{
    const c=await browser.newContext({ignoreHTTPSErrors:true});
    try {const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/#/account');await p.getByRole('button',{name:'注册',exact:true}).click();await p.getByRole('button',{name:'用户名注册',exact:true}).click();
      await p.locator('input[name=username]').fill('deep_link_user');await p.getByRole('button',{name:'下一步',exact:true}).click();await p.locator('input[name=password]').fill('Deep link fixture password 2026!');await p.locator('input[name=confirm]').fill('Deep link fixture password 2026!');await p.getByRole('button',{name:'完成注册',exact:true}).click();
      await p.locator('main.main').waitFor();await maybeWelcome(p);await p.waitForURL('**/#/me');assert.equal(await p.locator('.account-dropdown').count(),0);
      await maybeWelcome(p);
      await p.goto(origin+'/#/account');await p.getByRole('button',{name:'退出登录',exact:true}).click();await p.locator('.auth-entry').waitFor();assert.equal(new URL(p.url()).hash,'#/me');
    }finally{await c.close();}
  });
  await check('every page has no GitHub text, links or icons; footer uses the new tagline',async()=>{
    for(const route of ['','atlas','me','read','practice','about','paraphrase','confuse','account','admin','learn']) {
      await second.goto(origin+'/#/'+route);await second.locator('main.main').waitFor();
      assert.equal(await second.locator('a[href*="github" i],.lucide-github').count(),0,route);
      assert.doesNotMatch(await second.locator('body').innerText(),/github|会员/i,route);
      if(route!=='learn')assert.match(await second.locator('footer.footer').innerText(),/多懂一个词，多看一点世界。/);
    }
  });
  await ctx.close();
  await check('mobile and blocked session storage still allow guest entry',async()=>{
    const mobile=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
    await mobile.addInitScript(()=>{localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false}));Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('blocked','SecurityError');}});});
    const p=await mobile.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/');
    await p.getByRole('button',{name:'以游客身份登录',exact:true}).click();await p.locator('main.main').waitFor();await maybeWelcome(p);await p.reload();await p.locator('.auth-entry').waitFor();
    await p.screenshot({path:path.resolve('.local/implementation/entry-mobile.png')});await mobile.close();
  });
  assert.deepEqual(errors,[]);await fs.writeFile('.local/implementation/entry-e2e.json',JSON.stringify({passed:results.length,results,errors},null,2));
} finally {
  await browser?.close();if(server)await new Promise(r=>server.close(r));guests?.close();accounts?.close();await fs.rm(dir,{recursive:true,force:true});
}
