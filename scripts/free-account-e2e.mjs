import {createGuests} from '../server/guests.mjs';
import {leaveGuest} from './guest-ui-test-utils.mjs';
// Real HTTPS/browser integration; all identities, messages and credentials are
// disposable fixtures in a temporary database. No external email is sent.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createAccounts } from '../server/accounts.mjs';
import { createApplication } from './http-handler.mjs';

const mobile=process.env.MOBILE_E2E==='1';
const defaultViewport=mobile?{width:390,height:844}:{width:1440,height:1000};
const output=path.resolve(mobile?'.local/mobile-account':'.local/implementation');await fs.mkdir(output,{recursive:true});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-free-email-'));
let guests,server,accounts,browser,handler;let clock=Date.now();const mail=[],errors=[],results=[];
const password='Abcdef1!',email='fixture@example.com';let owner;
async function poll(fn){const end=Date.now()+12000;do{const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,80));}while(Date.now()<end);throw Error('Expected durable result did not arrive');}
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:e.message});for(const c of browser?.contexts()||[])for(const p of c.pages())console.error('UI state:',p.url(),(await p.locator('body').innerText().catch(()=>'' )).slice(0,1800));throw e;}}
async function api(page,url,method='GET',body,override){return page.evaluate(async({url,method,body,override})=>{
  const s=await fetch('/api/auth/session',{cache:'no-store'}).then(r=>r.json());
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrfToken,...(s.user?{'X-Account-ID':s.user.id}:{}),...override},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};
},{url,method,body,override});}
async function welcome(page){const modal=page.getByRole('dialog',{name:'欢迎',exact:true});try{await modal.waitFor({timeout:2000});}catch{if(!await modal.isVisible())return;}try{await modal.getByRole('button',{name:'出发'}).click({timeout:5000});}catch(e){if(await modal.isVisible())throw e;}}
async function openMenu(page){await page.locator('main.main').waitFor();await welcome(page);const trigger=page.getByRole('button',{name:'账户菜单',exact:true});if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();const menu=page.getByRole('region',{name:'账户菜单内容',exact:true});const back=menu.getByRole('button',{name:'返回账户菜单',exact:true});if(await back.count())await back.click();return menu;}
try {
  server=https.createServer({key:await fs.readFile('/etc/word-atlas/tls/privkey.pem'),cert:await fs.readFile('/etc/word-atlas/tls/fullchain.pem')},(req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='https://127.0.0.1:'+server.address().port;
  const options={dbPath:path.join(dir,'accounts.sqlite'),origins:[origin],secureCookies:true,now:()=>clock,emailCodeSecret:'a'.repeat(64),sendEmailCode:async message=>{mail.push({...message});}};
  accounts=createAccounts(options);guests=createGuests({dbPath:path.join(dir,'guests.sqlite'),origins:[origin]});
  handler=createApplication({guests,root:path.resolve('dist'),accounts,secureOrigin:origin});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  async function context(){const ctx=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true,viewport:defaultViewport,...(mobile?{isMobile:true,hasTouch:true}: {})});await ctx.addInitScript(()=>{sessionStorage.setItem('word-atlas:entry-mode','guest');if(!localStorage.getItem('atlas-free-setup')){localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false,sfx:false,autoplay:false}));localStorage.setItem('atlas-free-setup','1');}});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));return{ctx,page};}
  const a=await context(),b=await context();
  await check('anonymous users have a direct standalone auth page, never an auth dropdown',async()=>{
    await a.page.goto(origin+'/#/atlas');await a.page.getByRole('button',{name:'以游客身份登录',exact:true}).click();
    await a.page.locator('main.main').waitFor();await welcome(a.page);assert.equal(await a.page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
    await leaveGuest(a.page);
    for(const width of [1440,390,320]){await a.page.setViewportSize({width,height:900});const panel=a.page.getByRole('region',{name:'账户',exact:true});await panel.locator('input[name=username]').waitFor();
      assert.equal(await a.page.locator('.sheet-root,[aria-modal=true],.account-dropdown').count(),0);assert.equal(await a.page.evaluate(()=>document.documentElement.classList.contains('is-locked')),false);
      await a.page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
      await a.page.screenshot({path:path.join(output,`auth-entry-${width}.png`),animations:'disabled'});
      await panel.getByRole('button',{name:'注册',exact:true}).click();await panel.locator('input[name=email]').waitFor();
      await panel.getByRole('button',{name:'下一步',exact:true}).click({trial:true});
      await panel.getByRole('button',{name:'用户名注册',exact:true}).click();await panel.locator('input[name=username]').waitFor();await panel.getByRole('button',{name:'登录',exact:true}).click();
    }await a.page.setViewportSize(defaultViewport);
  });
  await check('email registration requires the delivered six-digit code and marks email verified',async()=>{
    const menu=a.page.getByRole('region',{name:'账户',exact:true});await menu.getByRole('button',{name:'注册',exact:true}).click();await menu.locator('input[name=email]').fill(email);await menu.getByRole('button',{name:'获取验证码',exact:true}).click();
    const sent=await poll(()=>mail.find(m=>m.email===email&&m.purpose==='register'));assert.match(sent.code,/^\d{6}$/);
    await menu.locator('input[name=code]').fill(sent.code==='000000'?'111111':'000000');await menu.getByRole('button',{name:'下一步',exact:true}).click();await menu.getByRole('alert').waitFor();assert.equal((await api(a.page,'/api/auth/session')).data.user,null);
    await menu.locator('input[name=code]').fill(sent.code);await menu.getByRole('button',{name:'下一步',exact:true}).click();
    await menu.getByRole('button',{name:'修改',exact:true}).click();await menu.getByRole('button',{name:'邮箱注册',exact:true}).click();
    assert.equal(await menu.locator('input[name=code]').inputValue(),sent.code);
    await menu.getByRole('button',{name:'下一步',exact:true}).click();
    await menu.locator('input[name=password]').fill(password);await menu.locator('input[name=confirm]').fill(password);await menu.getByRole('button',{name:'完成注册',exact:true}).click();await a.page.locator('main.main').waitFor();await welcome(a.page);
    const s=(await api(a.page,'/api/auth/session')).data;owner=s.user.id;assert.equal(s.user.emailVerified,true);const c=(await a.ctx.cookies()).find(c=>c.name==='wa_session');assert.ok(c.secure&&c.httpOnly);
  });
  await check('signed-in menu exposes real registration information and personal center without auth forms',async()=>{
    let menu=await openMenu(a.page);assert.equal(await menu.getByRole('button',{name:'返回登录',exact:true}).count(),0);assert.equal(await menu.getByRole('button',{name:'注册',exact:true}).count(),0);
    await menu.getByRole('button',{name:'账户注册信息',exact:true}).click();await menu.getByText('注册时间',{exact:true}).waitFor();assert.match(await menu.innerText(),/fixture@example.com/);assert.equal(await menu.getByText('暂不可用',{exact:true}).count(),0);
    assert.doesNotMatch(await menu.innerText(),/账户完全免费。支持学习快照同步|未完成的答题会话仅保存在本机/);
    assert.equal(await menu.getByRole('button',{name:'退出账号',exact:true}).count(),0);
    assert.equal(await menu.getByRole('button',{name:'刷新账户状态',exact:true}).count(),0);
    for(const theme of ['light','dark'])for(const [width,height]of [[1440,900],[1366,768],[1280,640],[390,844],[390,700],[375,667],[320,640],[320,568]]){
      await a.page.setViewportSize({width,height});await a.page.evaluate(theme=>{document.documentElement.dataset.theme=theme;delete document.documentElement.dataset.skin;},theme);
      const size=await menu.evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth}));
      assert.ok(size.scrollHeight<=size.height+1,`${width}x${height}/${theme}: profile must not scroll internally`);
      assert.ok(size.scrollWidth<=size.width+1);
      for(const name of ['返回账户菜单']){const box=await menu.getByRole('button',{name,exact:true}).boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=height,`${width}x${height}/${theme}: ${name} is fully visible`);}
      if(width===1440||width===390&&height===700)await a.page.screenshot({path:path.join(output,`account-profile-${width}-${height}-${theme}.png`)});
    }
    await a.page.setViewportSize(defaultViewport);
    const s=(await api(a.page,'/api/auth/session')).data;assert.equal(s.user.createdAt,accounts.db.prepare('SELECT created_at FROM users WHERE id=?').get(owner).created_at);
    assert.ok(s.user.createdAt>0);assert.equal(await menu.locator('input[name=password]').count(),0);
    await menu.getByRole('button',{name:'返回账户菜单',exact:true}).click();await menu.getByRole('button',{name:'个人中心',exact:true}).click();await a.page.waitForURL('**/#/me');await menu.waitFor({state:'detached'});
  });
  await check('a registered account receives free durable synchronization and cloud backup',async()=>{
    const menu=await openMenu(a.page);await menu.getByRole('button',{name:'数据同步与备份',exact:true}).click();await menu.getByRole('button',{name:'立即检查同步',exact:true}).click();
    const cloud=await poll(async()=>{const r=await api(a.page,'/api/account/progress?dataset=word-atlas-open');return r.status===200&&r.data.version>0&&r.data;});assert.equal(cloud.snapshot.progress.session,null);
    await menu.getByRole('button',{name:'创建云端备份',exact:true}).click();await menu.getByText('云端备份已保存。',{exact:true}).waitFor();
    assert.equal((await api(a.page,'/api/admin/users?q=')).status,403);assert.equal((await api(a.page,'/api/account/progress?dataset=word-atlas-open','PUT',{version:0,snapshot:cloud.snapshot})).status,409);
    assert.equal((await api(a.page,'/api/account/backups?dataset=word-atlas-open','GET',undefined,{'X-Account-ID':'another'})).status,409);
  });
  await check('ordinary username registration stays available and cannot read another account backup',async()=>{
    // The advisory lookup has its own limit; exhausting it cannot disable the
    // independent authoritative registration endpoint.
    await b.page.goto(origin);await b.page.locator('.auth-entry input[name=username]').waitFor();let lookup;
    for(let i=0;i<31;i++)lookup=await api(b.page,'/api/auth/username-availability','POST',{username:'username_fixture'});
    assert.equal(lookup.status,429);
    await b.page.goto(origin+'/#/account');await b.page.getByRole('button',{name:'注册',exact:true}).click();await b.page.getByRole('button',{name:'用户名注册',exact:true}).click();await b.page.locator('input[name=username]').fill('username_fixture');await b.page.getByRole('button',{name:'下一步',exact:true}).click();await b.page.locator('input[name=password]').fill(password);await b.page.locator('input[name=confirm]').fill(password);await b.page.getByRole('button',{name:'完成注册',exact:true}).click();await b.page.locator('main.main').waitFor();await welcome(b.page);
    const s=(await api(b.page,'/api/auth/session')).data;assert.equal(s.user.email,null);assert.notEqual(s.user.id,owner);assert.equal((await api(b.page,'/api/account/progress?dataset=word-atlas-open')).status,200);
    const own=(await api(a.page,'/api/account/backups?dataset=word-atlas-open')).data.backups;assert.ok(own.length);assert.equal((await api(b.page,'/api/account/backups/'+own[0].id)).status,404);
  });
  await check('email and password login restores the original account and its backup',async()=>{
    let menu=await openMenu(a.page);await menu.getByRole('button',{name:'退出登录',exact:true}).click();await a.page.locator('input[name=username]').fill(email);await a.page.locator('input[name=password]').fill(password);await a.page.getByRole('button',{name:'登录账号',exact:true}).click();await a.page.locator('main.main').waitFor();assert.equal((await api(a.page,'/api/auth/session')).data.user?.id,owner);await welcome(a.page);assert.ok((await api(a.page,'/api/account/backups?dataset=word-atlas-open')).data.backups.length);
  });
  await check('email code login is purpose-bound, five-minute, single use and survives backend reopen',async()=>{
    let menu=await openMenu(a.page);await menu.getByRole('button',{name:'退出登录',exact:true}).click();await a.page.getByRole('button',{name:'验证码登录',exact:true}).click();clock+=61000;
    await a.page.locator('input[name=email]').fill(email);await a.page.getByRole('button',{name:'获取验证码',exact:true}).click();const sent=await poll(()=>mail.findLast(m=>m.email===email&&m.purpose==='login'));
    await poll(()=>accounts.db.prepare('SELECT ready FROM email_codes WHERE email=? AND purpose=?').get(email,'login')?.ready===1);
    accounts.close();accounts=createAccounts({...options,initializeDatabase:false});handler=createApplication({guests,root:path.resolve('dist'),accounts,secureOrigin:origin});
    await a.page.locator('input[name=code]').fill(sent.code);await a.page.getByRole('button',{name:'登录账号',exact:true}).click();await a.page.locator('main.main').waitFor();assert.equal((await api(a.page,'/api/auth/session')).data.user?.id,owner);await welcome(a.page);
    assert.equal((await api(a.page,'/api/auth/login-code','POST',{email,code:sent.code})).status,400);
    clock+=61000;const r=await api(a.page,'/api/auth/email-code','POST',{email,purpose:'login'});assert.equal(r.status,200);const late=mail.findLast(m=>m.email===email&&m.purpose==='login');clock+=300000;assert.equal((await api(a.page,'/api/auth/login-code','POST',{email,code:late.code})).status,400);
  });
  await check('password change from dropdown revokes the session and returns to entry',async()=>{
    const menu=await openMenu(a.page);await menu.getByRole('button',{name:'账号安全',exact:true}).click();await menu.locator('input[name=currentPassword]').fill(password);await menu.locator('input[name=password]').fill('Replacement disposable password 2026!');await menu.locator('input[name=confirm]').fill('Replacement disposable password 2026!');await menu.getByRole('button',{name:'修改密码',exact:true}).click();await a.page.locator('.auth-entry input[name=username]').waitFor();assert.equal((await api(a.page,'/api/auth/session')).data.user,null);
  });
  await check('anonymous protected routes always use the central auth entry and allow guest escape',async()=>{
    const c=await context();try{for(const route of ['account','admin']){await c.page.goto(origin+'/#/'+route);await c.page.locator('.auth-entry input[name=username]').waitFor();assert.equal(await c.page.locator('.account-dropdown').count(),0);await c.page.getByRole('button',{name:'以游客身份登录',exact:true}).click();await c.page.locator('main.main').waitFor();}}finally{await c.ctx.close();}
  });
  await check('all major routes remove membership and GitHub presentation',async()=>{
    for(const route of ['','atlas','me','read','practice','about','paraphrase','confuse','account','admin']){await b.page.goto(origin+'/#/'+route);if(route==='admin')await b.page.getByRole('heading',{name:'管理后台',exact:true}).waitFor();else await b.page.locator('main.main').waitFor();assert.doesNotMatch(await b.page.locator('body').innerText(),/会员|github/i);assert.equal(await b.page.locator('a[href*="github" i],.lucide-github').count(),0);}
  });
  await check('expired server sessions return to auth entry without deleting the old account profile',async()=>{
    const s=(await api(b.page,'/api/auth/session')).data;const key='word-atlas:account:'+encodeURIComponent(s.user.id)+':word-atlas:reader:v1';const saved=JSON.stringify({size:24,bilingual:true,language:'zh',speed:1});await b.page.evaluate(({key,saved})=>localStorage.setItem(key,saved),{key,saved});
    accounts.db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.user.id);await b.page.reload();await b.page.locator('.auth-entry input[name=username]').waitFor();assert.equal(await b.page.evaluate(key=>localStorage.getItem(key),key),saved);assert.equal((await api(b.page,'/api/auth/session')).data.user,null);
  });
  if(mobile)await check('mobile administrator account list remains inside the screen',async()=>{
    accounts.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner);
    await a.page.goto(origin);await a.page.locator('.auth-entry input[name=username],.account-guest-trigger').first().waitFor();if(await a.page.locator('.account-guest-trigger').isVisible())await leaveGuest(a.page);await a.page.locator('.auth-entry input[name=username]').fill(email);await a.page.locator('input[name=password]').fill('Replacement disposable password 2026!');await a.page.getByRole('button',{name:'登录账号',exact:true}).click();await a.page.locator('.admin-console').waitFor();assert.equal(new URL(a.page.url()).hash,'#/admin');assert.equal(await a.page.locator('main.main,.topbar,.tabbar').count(),0);
    await a.page.getByRole('button',{name:'展开管理导航',exact:true}).click();await a.page.getByRole('navigation',{name:'管理控制台导航'}).getByRole('button',{name:'账号管理',exact:true}).click();await a.page.locator('.account-admin-user').first().waitFor();
    assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await a.page.screenshot({path:path.join(output,'admin-mobile.png'),animations:'disabled'});
  });
  await a.ctx.close();await b.ctx.close();assert.deepEqual(errors,[]);
} finally {
  await fs.writeFile(path.join(output,'free-account-e2e.json'),JSON.stringify({results,errors},null,2));await browser?.close();if(server)await new Promise(r=>server.close(r));guests?.close();accounts?.close();await fs.rm(dir,{recursive:true,force:true});
}
