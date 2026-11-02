// Disposable real-API/browser registration and responsive checks; no SMTP or production writes.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createAccounts} from '../server/accounts.mjs';
import {createApplication} from './http-handler.mjs';

const output=path.resolve('.local/registration');await fs.mkdir(output,{recursive:true});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-registration-'));
let browser,accounts,handler,server,clock=Date.now();const mail=[],errors=[],results=[],layoutIssues=[],metrics=[];
try{
  server=https.createServer({key:await fs.readFile('/etc/word-atlas/tls/privkey.pem'),cert:await fs.readFile('/etc/word-atlas/tls/fullchain.pem')},(req,res)=>handler(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='https://127.0.0.1:'+server.address().port;
  accounts=createAccounts({dbPath:path.join(dir,'accounts.sqlite'),origins:[origin],now:()=>clock,emailCodeSecret:'registration fixture secret '.repeat(3),sendEmailCode:async m=>mail.push(m)});
  handler=createApplication({root:path.resolve('dist'),accounts,secureOrigin:origin});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByRole('button',{name:'注册',exact:true}).waitFor();
  const card=page.locator('.auth-entry__card');
  async function fit(label,expected){
    await page.evaluate(()=>scrollTo(0,0));
    const v=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
    const box=await card.boundingBox();
    metrics.push({label,...v,cardHeight:box.height,baseline:expected});
    if(v.scrollWidth>v.width)layoutIssues.push(`${label}: horizontal overflow`);
    if(v.scrollHeight>v.height+1)layoutIssues.push(`${label}: page ${v.scrollHeight} > viewport ${v.height}`);
    if(expected&&Math.abs(box.height-expected)>1)layoutIssues.push(`${label}: card ${box.height} != login ${expected}`);
    for(const el of [page.locator('.account-primary'),page.getByRole('button',{name:'以游客身份登录',exact:true})]){
      const b=await el.boundingBox();if(!b||b.y<0||b.y+b.height>v.height)layoutIssues.push(`${label}: clipped action`);
    }
    return box.height;
  }
  for(const theme of ['light','dark'])for(const [width,height] of [[1920,900],[1366,768],[1280,640],[1280,600],[390,844],[390,700],[375,667],[320,640]]){
    await page.setViewportSize({width,height});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;delete document.documentElement.dataset.skin;},theme);
    const baseline=await fit(`${width}x${height}/${theme}/login`);
    await page.getByRole('button',{name:'注册',exact:true}).click();await fit(`${width}x${height}/${theme}/email`,baseline);
    await page.getByRole('button',{name:'用户名注册',exact:true}).click();
    await page.getByLabel('用户名',{exact:true}).fill('explorer');await page.getByRole('button',{name:'下一步',exact:true}).click();
    await page.getByRole('button',{name:'完成注册',exact:true}).waitFor();
    await fit(`${width}x${height}/${theme}/password`,baseline);
    await page.getByLabel('密码',{exact:true}).fill('registration fixture password');
    await page.getByLabel('确认密码',{exact:true}).fill('different fixture password');
    await page.getByRole('button',{name:'完成注册',exact:true}).click();await page.getByRole('alert').waitFor();
    await fit(`${width}x${height}/${theme}/validation`,baseline);
    await page.screenshot({path:path.join(output,`password-${width}-${height}-${theme}.png`)});
    await page.getByRole('button',{name:'修改',exact:true}).click();await fit(`${width}x${height}/${theme}/back`,baseline);
    assert.equal(await page.getByLabel('用户名',{exact:true}).inputValue(),'explorer');
    await page.getByRole('button',{name:'登录',exact:true}).click();clock+=61000;
    results.push(`${width}x${height}/${theme}: stable login/identity/password/error/back; no overflow`);console.log('PASS '+results.at(-1));
  }
  // Capture the exact approved verified-email state, using an in-memory mailbox.
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dataset.theme='light';delete document.documentElement.dataset.skin;});
  await page.getByRole('button',{name:'注册',exact:true}).click();await page.getByLabel('邮箱',{exact:true}).fill('hello@example.com');
  await page.getByRole('button',{name:'获取验证码',exact:true}).click();
  assert.ok(mail.at(-1)?.code);await page.getByLabel('六位验证码',{exact:true}).fill(mail.at(-1).code);
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:'完成注册',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'approved-state-desktop.png')});
  await card.screenshot({path:path.join(output,'approved-state-card.png')});
  assert.deepEqual(errors,[]);
  assert.deepEqual(layoutIssues,[]);
  assert.equal(accounts.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  console.log('PASS verified email screenshot, no real email and no accounts created');
}finally{
  await fs.writeFile(path.join(output,'responsive-results.json'),JSON.stringify({results,errors,layoutIssues,metrics},null,2));
  await browser?.close();if(server)await new Promise(r=>server.close(r));accounts?.close();await fs.rm(dir,{recursive:true,force:true});
}
