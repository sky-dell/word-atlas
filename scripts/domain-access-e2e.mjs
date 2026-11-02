// Live domain smoke: one disposable guest, removed through its own UI.
// No formal accounts are created; no OTP email is sent; TLS checks stay enabled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.TEST_URL||'https://west.cloud-ip.cc';
const output=process.env.CHECK_OUTPUT||'.local/domain-access';await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});const results=[],errors=[];
let context;
try {
  if(origin==='https://west.cloud-ip.cc'){
    for(const path of ['/','/api/auth/session','/atlas/extras/karoline/index.json'])assert.equal((await fetch('https://43.133.166.184'+path,{redirect:'manual'})).status,403,`IP blocked: ${path}`);
    assert.equal((await fetch('http://43.133.166.184/',{redirect:'manual'})).status,403);
    const redirect=await fetch('http://west.cloud-ip.cc/?check=domain',{redirect:'manual'});
    assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'https://west.cloud-ip.cc/?check=domain');
    assert.equal((await fetch(origin+'/api/auth/session',{headers:{Origin:'https://43.133.166.184'}})).status,403);
    results.push('IP HTTP/HTTPS pages, assets and APIs are blocked; domain HTTP redirects to HTTPS; IP Origin denied');
  }
  context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/');
  const entry=page.locator('.auth-entry');
  await entry.locator('input[name=username]').waitFor();
  assert.equal(await entry.locator('input[name=password]').isVisible(),true);
  assert.equal(await page.getByText('Untrusted request host',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
  results.push('Domain HTTPS opens the normal account/email + password login page');
  await page.screenshot({path:output+'/login-desktop.png',animations:'disabled'});
  for(const username of ['domaincheck_'+Date.now().toString(36),'domain-smoke-'+Date.now()+'@example.invalid']){
    await entry.locator('input[name=username]').fill(username);await entry.locator('input[name=password]').fill('Abcdef1!');
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'登录账号',exact:true}).click();
    assert.equal((await response).status(),401,'Unknown test credentials reach authentication, not host/origin rejection');
  }
  results.push('Username and email password submissions reach authentication (expected 401 for nonexistent test identities)');
  await page.getByRole('button',{name:'验证码登录',exact:true}).click();
  assert.equal(await entry.getByPlaceholder('请输入邮箱',{exact:true}).isVisible(),true);
  assert.equal(await entry.locator('input[name=code]').isVisible(),true);
  results.push('Email code login UI works without sending email');
  await page.getByRole('button',{name:'账户登录',exact:true}).click();
  await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();
  await page.locator('main.main').waitFor();
  const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).click();
  await page.locator('.account-guest-trigger').waitFor();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  const before=await page.evaluate(async()=>await (await fetch('/api/guest/session')).json());
  assert.ok(before.guest?.id);
  await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
  await page.getByRole('button',{name:'切换到深色',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
  await page.reload();await page.locator('.account-guest-trigger').waitFor();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  const after=await page.evaluate(async()=>await (await fetch('/api/guest/session')).json());
  assert.equal(after.guest.id,before.guest.id);
  results.push('Guest entry and refresh start in light mode on a dark system and preserve the same temporary identity');
  await page.evaluate(async()=>{
    const session=await fetch('/api/guest/session').then(r=>r.json());
    await fetch('/api/guest/session',{method:'DELETE',headers:{Origin:location.origin,'X-Guest-ID':session.guest.id,'X-Guest-CSRF':session.csrfToken}});
  });
  await page.reload();
  await page.locator('.auth-entry input[name=username]').waitFor();
  assert.equal((await page.evaluate(async()=>await (await fetch('/api/guest/session')).json())).guest,null);
  results.push('Only this smoke-test guest was explicitly cleared through its authenticated DELETE; login entry restored');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.auth-entry input[name=username]').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:output+'/login-mobile.png',animations:'disabled'});
  await context.close();context=undefined;
  const recovery=await browser.newContext();const retry=await recovery.newPage();let first=true;
  await retry.route('**/api/auth/session',route=>{if(first){first=false;return route.fulfill({status:403,json:{error:'Untrusted request host',code:'host'}});}return route.continue();});
  await retry.goto(origin+'/');await retry.getByRole('button',{name:'重新检查账号服务',exact:true}).click();
  await retry.locator('.auth-entry input[name=username]').waitFor();results.push('Recheck button recovers from the original host error to the normal form');
  await recovery.close();assert.deepEqual(errors,[]);console.log(results.join('\n'));
}finally{
  // If an assertion fails after creation, remove only this context's own guest.
  if(context)try{const session=await context.request.get(origin+'/api/guest/session').then(r=>r.json());if(session.guest)await context.request.delete(origin+'/api/guest/session',{headers:{Origin:origin,'X-Guest-ID':session.guest.id,'X-Guest-CSRF':session.csrfToken}});}catch{}
  await browser.close();await fs.writeFile(output+'/results.json',JSON.stringify({results,errors},null,2)+'\n');
}
