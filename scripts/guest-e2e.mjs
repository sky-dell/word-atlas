// Real HTTPS integration using disposable account/guest databases and a test clock.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createAccounts} from '../server/accounts.mjs';
import {createGuests} from '../server/guests.mjs';
import {openGuestMenu,leaveGuest} from './guest-ui-test-utils.mjs';
import {createApplication} from './http-handler.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-guest-e2e-')),output=path.resolve('.local/guests/screenshots');await fs.mkdir(output,{recursive:true});
let server,browser,accounts,guests,handler,time=Date.now();const errors=[],results=[];
async function check(name,fn){try{await fn();results.push(name);console.log('PASS '+name);}catch(e){for(const c of browser.contexts())for(const p of c.pages())console.error((await p.locator('body').innerText()).slice(0,1800));throw e;}}
async function welcome(page){const dialog=page.getByRole('dialog',{name:'欢迎',exact:true});try{await dialog.waitFor({timeout:1500});await dialog.getByRole('button',{name:'出发',exact:true}).click();}catch{if(await dialog.isVisible())throw Error('Welcome not dismissed');}}
async function openLearningSettings(page){await page.getByRole('tab',{name:'学习设置',exact:true}).click();}
try{
  server=https.createServer({key:await fs.readFile('/etc/word-atlas/tls/privkey.pem'),cert:await fs.readFile('/etc/word-atlas/tls/fullchain.pem')},(req,res)=>handler(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='https://127.0.0.1:'+server.address().port;
  accounts=createAccounts({dbPath:path.join(dir,'accounts.sqlite'),origins:[origin]});
  const openGuests=()=>createGuests({dbPath:path.join(dir,'guests.sqlite'),origins:[origin],now:()=>time});guests=openGuests();
  const updateHandler=()=>handler=createApplication({root:path.resolve('dist'),accounts,guests,secureOrigin:origin});updateHandler();
  browser=await chromium.launch({args:['--no-sandbox']});const ctx=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true});
  await ctx.addInitScript(()=>{localStorage.setItem('word-atlas:reader:v1','{"size":28}');});
  let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));let name;
  await check('guest identity is temporary, does not create users and ignores historical local learning',async()=>{
    await page.goto(origin+'/#/me');await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();await welcome(page);
    name=await page.locator('.guest-notice strong').innerText();assert.match(name,/^游客_/);assert.equal(accounts.db.prepare('SELECT count(*) n FROM users').get().n,0);
    assert.equal(await page.locator('main .guest-notice').count(),0);assert.doesNotMatch(await page.locator('body').innerText(),/不会创建正式账户|闲置24小时失效，最长保留7天/);
    await page.getByRole('tab',{name:'数据管理',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出备份',exact:true}).click();assert.match((await download).suggestedFilename(),/\.json$/);
    assert.equal(await page.evaluate(()=>localStorage.getItem('word-atlas:reader:v1')),'{"size":28}');
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('word-atlas:v2:')).length),0);
    assert.equal(await page.evaluate(async()=>(await indexedDB.databases()).some(db=>db.name==='word-atlas')),false);
  });
  await check('a learning settings change is saved server-side and survives refresh, close and service reopen',async()=>{
    await openLearningSettings(page);
    await page.getByRole('button',{name:'15',exact:true}).click();await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
    await page.reload();await page.locator('main.main').waitFor();assert.equal(await page.locator('.guest-notice strong').innerText(),name);await openLearningSettings(page);assert.match(await page.getByRole('button',{name:'15',exact:true}).getAttribute('class'),/is-on/);
    await page.close();page=await ctx.newPage();await page.goto(origin+'/#/me');await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();assert.equal(await page.locator('.guest-notice strong').innerText(),name);await openLearningSettings(page);
    guests.close();guests=openGuests();updateHandler();await page.reload();await page.locator('main.main').waitFor();await openLearningSettings(page);assert.match(await page.getByRole('button',{name:'15',exact:true}).getAttribute('class'),/is-on/);
    await page.screenshot({path:path.join(output,'guest-desktop.png'),fullPage:true});
  });
  await check('two tabs never silently overwrite each other and show a recoverable conflict',async()=>{
    const second=await ctx.newPage();
    try{
      await second.goto(origin+'/#/me');await second.getByRole('button',{name:'以游客身份登录',exact:true}).click();await second.locator('main.main').waitFor();
      await openLearningSettings(second);
      await page.getByRole('button',{name:'20',exact:true}).click();await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
      await second.getByRole('button',{name:'30',exact:true}).click();await second.locator('.guest-notice [role=status]').filter({hasText:'另一标签页'}).waitFor({state:'attached'});
      await second.getByRole('alert').filter({hasText:'另一标签页'}).waitFor();await second.getByRole('tab',{name:'数据管理',exact:true}).click();assert.equal(await second.getByRole('button',{name:'导出备份',exact:true}).isVisible(),true);
    }finally{await second.close();}
  });
  await check('returning to login retains the visitor and re-entry resumes the same temporary identity',async()=>{
    await leaveGuest(page);await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();assert.equal(await page.locator('.guest-notice strong').innerText(),name);
    await openGuestMenu(page);assert.equal(await page.getByRole('button',{name:'退出游客模式',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'退出游客模式',exact:true}).click();await page.locator('.auth-entry').waitFor();
    await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();assert.equal(await page.locator('.guest-notice strong').innerText(),name);
  });
  await check('idle expiry is enforced by server clock and stale browser cannot revive the old visitor',async()=>{
    const old=await page.locator('.guest-notice strong').innerText();time+=86400001;
    await page.reload();await page.locator('.auth-entry').waitFor();await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await page.locator('main.main').waitFor();assert.notEqual(await page.locator('.guest-notice strong').innerText(),old);
  });
  await check('registration never auto-imports guest data; confirmed import copies to the formal account then clears the guest',async()=>{
    const c=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true});const p=await c.newPage();
    try{
      await p.goto(origin+'/#/me');await p.getByRole('button',{name:'以游客身份登录',exact:true}).click();await p.locator('main.main').waitFor();await welcome(p);
      await openLearningSettings(p);
      await p.getByRole('button',{name:'15',exact:true}).click();await p.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
      await leaveGuest(p);await p.getByRole('button',{name:'注册',exact:true}).click();await p.getByRole('button',{name:'用户名注册',exact:true}).click();
      await p.getByLabel('用户名',{exact:true}).fill('migration_learner');await p.getByRole('button',{name:'下一步',exact:true}).click();await p.getByLabel('密码',{exact:true}).fill('Temporary guest fixture password 1!');await p.getByLabel('确认密码',{exact:true}).fill('Temporary guest fixture password 1!');
      await p.getByRole('button',{name:'完成注册',exact:true}).click();await p.locator('main.main').waitFor();await welcome(p);
      await openLearningSettings(p);
      assert.doesNotMatch(await p.getByRole('button',{name:'15',exact:true}).getAttribute('class')||'',/is-on/);
      await p.getByRole('button',{name:'账户菜单',exact:true}).click();await p.getByRole('button',{name:'数据同步与备份',exact:true}).click();
      await p.getByRole('button',{name:'导入游客暂存记录',exact:true}).click();await p.getByRole('button',{name:'备份本账号并确认导入游客记录',exact:true}).click();
      await p.getByText('已复制当前词库的游客记录。',{exact:true}).waitFor();
      assert.match(await p.getByRole('button',{name:'15',exact:true}).getAttribute('class'),/is-on/);
      assert.equal(await p.evaluate(async()=>(await(await fetch('/api/guest/session')).json()).guest),null);
      assert.equal(accounts.db.prepare('SELECT count(*) n FROM users').get().n,1);
    }finally{await c.close();}
  });
  assert.deepEqual(errors,[]);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}guests?.close();accounts?.close();await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));await fs.rm(dir,{recursive:true,force:true});}
