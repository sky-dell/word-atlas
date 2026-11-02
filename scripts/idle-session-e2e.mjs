// Isolated browser + real SQLite/API verification. No production clock/data/SMTP.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createAccounts} from '../server/accounts.mjs';
import {createGuests} from '../server/guests.mjs';
import {createApplication} from './http-handler.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-idle-e2e-'));
let time=Date.now(),handler;const activity=[];
const server=http.createServer((req,res)=>{if(req.url?.endsWith('/activity'))activity.push(req.url);return handler(req,res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const accounts=createAccounts({dbPath:path.join(directory,'accounts.sqlite'),origins:[origin],allowInsecureLocal:true,secureCookies:false,now:()=>time});
const guests=createGuests({dbPath:path.join(directory,'guests.sqlite'),origins:[origin],allowInsecureLocal:true,now:()=>time});
handler=createApplication({root:path.join(root,'dist'),accounts,guests,secureOrigin:origin,allowInsecureLocal:true});
const browser=await chromium.launch({headless:true}),results=[],errors=[];
try{
  const account=await browser.newContext();const page=await account.newPage();page.on('pageerror',e=>errors.push(e.message));
  const anon=await account.request.get(origin+'/api/auth/session').then(r=>r.json());
  const registered=await account.request.post(origin+'/api/auth/register',{headers:{Origin:origin,'X-CSRF-Token':anon.csrfToken},data:{username:'idle_e2e',password:'Abcdef1!'}});assert.equal(registered.status(),200);
  await page.goto(origin);await page.locator('.topbar').waitFor();
  const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).click();
  await page.clock.install({time:new Date(time)});
  // The welcome click is trusted input; the following clock advance is passive.
  const initialCount=activity.length;
  time+=120*60000;await page.clock.fastForward(120*60000);
  await page.locator('.auth-entry input[name=username]').waitFor();
  assert.equal(activity.length,initialCount,'Passive polling must not send an activity heartbeat');
  assert.equal(accounts.db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  results.push('Formal account returns to login after 120 idle minutes; polling cannot renew; user data remains');
  await page.locator('input[name=username]').fill('idle_e2e');await page.locator('input[name=password]').fill('Abcdef1!');await page.getByRole('button',{name:'登录账号',exact:true}).click();
  await page.locator('.topbar').waitFor();results.push('Password re-login succeeds after timeout');await account.close();

  const guest=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const gp=await guest.newPage();gp.on('pageerror',e=>errors.push(e.message));
  await gp.goto(origin);await gp.getByRole('button',{name:'以游客身份登录',exact:true}).click();await gp.locator('.account-guest-trigger').waitFor();
  const gw=gp.getByRole('dialog',{name:'欢迎',exact:true});if(await gw.isVisible())await gw.getByRole('button',{name:'出发',exact:true}).click();
  await gp.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
  const session=await guest.request.get(origin+'/api/guest/session').then(r=>r.json());
  const headers={Origin:origin,'X-Guest-ID':session.guest.id,'X-Guest-CSRF':session.csrfToken};
  const read=()=>guest.request.get(origin+'/api/guest/state?dataset=all',{headers}).then(r=>r.json());
  const previous=await read();const records={...previous.state?.records,'word-atlas:reader:v1':'{"size":24}'};
  assert.equal((await guest.request.put(origin+'/api/guest/state?dataset=all',{headers,data:{version:previous.version,state:{records}}})).status(),200);
  await gp.clock.install({time:new Date(time)});time+=240*60000;await gp.clock.fastForward(240*60000);
  await gp.locator('.auth-entry input[name=username]').waitFor().catch(async error=>{
    console.error('Guest timeout diagnostics',JSON.stringify({session:await guest.request.get(origin+'/api/guest/session').then(r=>r.json()).then(s=>({loginRequired:s.loginRequired,idleExpiresAt:s.guest?.idleExpiresAt,serverNow:s.guest?.serverNow})),client:await gp.evaluate(()=>({time:Date.now(),mode:sessionStorage.getItem('word-atlas:entry-mode'),body:document.body.innerText.slice(0,700)})),activity}));throw error;
  });
  assert.equal((await guest.request.get(origin+'/api/guest/state?dataset=all',{headers})).status(),401);
  await gp.reload();await gp.locator('.auth-entry input[name=username]').waitFor();
  results.push('Mobile guest returns to entry after 240 idle minutes; refresh cannot bypass the idle gate');
  await gp.getByRole('button',{name:'以游客身份登录',exact:true}).click();await gp.locator('.account-guest-trigger').waitFor();
  const resumed=await guest.request.get(origin+'/api/guest/session').then(r=>r.json());
  assert.equal(resumed.guest.id,session.guest.id);assert.equal((await read()).state.records['word-atlas:reader:v1'],'{"size":24}');
  results.push('Explicit guest re-entry resumes the same retained identity and data');await guest.close();
  assert.deepEqual(errors,[]);console.log(results.join('\n'));
}finally{
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));guests.close();accounts.close();await fs.rm(directory,{recursive:true,force:true});
  await fs.mkdir(path.join(root,'.local/idle-e2e'),{recursive:true});await fs.writeFile(path.join(root,'.local/idle-e2e/results.json'),JSON.stringify({results,errors},null,2)+'\n');
}
