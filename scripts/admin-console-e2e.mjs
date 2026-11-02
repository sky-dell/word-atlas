// Real app/admin APIs + Unix helper + TLS hot-swap, entirely in an isolated fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createApplication} from './http-handler.mjs';
import {createAccounts} from '../server/accounts.mjs';
import {createGuests} from '../server/guests.mjs';
import {createOperations} from '../server/operations.mjs';
import {createHelperServer} from '../server/admin-helper.mjs';
import {createCertificateManager} from '../server/certificates.mjs';
import {openOperationJournal} from '../server/operation-journal.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname),dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-admin-e2e-'));
const output=path.join(root,'.local/admin-e2e');await fs.mkdir(output,{recursive:true});
const command=args=>execFileSync('/usr/bin/openssl',args,{cwd:dir,stdio:'ignore',timeout:15000});
command(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','3','-subj','/CN=Admin Fixture CA']);
for(const name of ['original','replacement']){
  command(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=west.cloud-ip.cc','-addext','subjectAltName=DNS:west.cloud-ip.cc']);
  command(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','2','-copy_extensions','copyall']);
}
const tlsDir=path.join(dir,'tls'),stateDir=path.join(dir,'state'),socket=path.join(dir,'helper.sock');let tlsServer;
const manager=createCertificateManager({domain:'west.cloud-ip.cc',tlsDir,stateDir,initialCertificatePath:path.join(dir,'original.pem'),initialKeyPath:path.join(dir,'original.key'),automaticCertificatePath:path.join(dir,'original.pem'),automaticKeyPath:path.join(dir,'original.key'),trustStore:path.join(dir,'ca.pem'),
  reload:async()=>{const version=await fs.realpath(path.join(tlsDir,'current'));tlsServer.setSecureContext({cert:await fs.readFile(path.join(version,'fullchain.pem')),key:await fs.readFile(path.join(version,'privkey.pem'))});},
  probe:async expected=>{const ca=await fs.readFile(path.join(dir,'ca.pem'));await new Promise((resolve,reject)=>{const c=tls.connect({host:'127.0.0.1',port:tlsServer.address().port,servername:'west.cloud-ip.cc',ca},()=>{try{assert.equal(c.getPeerCertificate().fingerprint256,expected);c.end();resolve();}catch(e){c.destroy();reject(e);}});c.on('error',reject);});},
});
await manager.status();tlsServer=https.createServer({cert:await fs.readFile(path.join(dir,'original.pem')),key:await fs.readFile(path.join(dir,'original.key'))},(_req,res)=>res.end('ok'));await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));
const journal=openOperationJournal(path.join(stateDir,'operations.sqlite'));
const helper=createHelperServer({manager,journal});await new Promise(r=>helper.listen(socket,r));
let handler;const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const guests=createGuests({dbPath:path.join(dir,'guests.sqlite'),origins:[origin],allowInsecureLocal:true});
const operations=createOperations({helperSocket:socket,accountsEnabled:true,guestEnabled:true,mailEnabled:false,tlsEnabled:true});
const accounts=createAccounts({dbPath:path.join(dir,'accounts.sqlite'),origins:[origin],allowInsecureLocal:true,secureCookies:false,operations,listGuests:()=>guests.listOnline()});
handler=createApplication({root:path.join(root,'dist'),accounts,guests,secureOrigin:origin,allowInsecureLocal:true});
const browser=await chromium.launch({headless:true}),results=[],errors=[];
try{
  const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  let csrf=(await context.request.get(origin+'/api/auth/session').then(r=>r.json())).csrfToken;
  const call=async(route,body)=>{const headers={Origin:origin,'X-CSRF-Token':csrf};const session=await context.request.get(origin+'/api/auth/session').then(r=>r.json());csrf=session.csrfToken;headers['X-CSRF-Token']=csrf;if(session.user)headers['X-Account-ID']=session.user.id;return body===undefined?context.request.get(origin+route,{headers}):context.request.post(origin+route,{headers,data:body});};
  const user=await call('/api/auth/register',{username:'operator_admin',password:'Abcdef1!'});assert.equal(user.status(),200);const id=(await user.json()).user.id;
  assert.equal((await call('/api/admin/overview')).status(),403);
  accounts.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
  const learningRequests=[];
  page.on('request',r=>{if(/\/atlas\/(index|classic)\//.test(r.url())||new URL(r.url()).pathname==='/atlas/index.json'||/\/api\/(account|member)\/(progress|backups)/.test(r.url()))learningRequests.push(new URL(r.url()).pathname);});
  await page.goto(origin+'/');await page.getByRole('navigation',{name:'管理控制台导航'}).waitFor({timeout:4000});
  assert.equal(new URL(page.url()).hash,'#/admin');assert.deepEqual(learningRequests,[],'Admin startup must not fetch learner catalogs or cloud state');
  for(const route of ['#/today','#/me','#/atlas','#/read','#/learn','#/admin?w=example','#/admin/extra','#admin']){
    await page.evaluate(route=>{location.hash=route;},route);
    await page.waitForFunction(()=>location.hash==='#/admin');
    assert.equal(await page.locator('.topbar,.tabbar,.today,.me,.practice').count(),0);
  }
  await page.screenshot({path:output+'/overview-desktop.png',animations:'disabled'});
  assert.ok((await call('/api/admin/overview').then(r=>r.json())).host.uptimeSeconds>0);
  assert.equal((await call('/api/admin/services')).status(),410);
  assert.equal(await page.getByRole('button',{name:'服务状态',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'返回个人中心'}).count(),0);
  results.push('Admin always lands in the isolated console; service collection is disabled and no learner cloud/catalog requests occur');
  const history=await call('/api/admin/logins?q=operator_admin').then(r=>r.json());assert.ok(history.events.some(e=>e.method==='register'));
  const online=await call('/api/admin/online').then(r=>r.json());assert.ok(online.users.some(u=>u.username==='operator_admin'));
  assert.doesNotMatch(JSON.stringify(online),/token_hash|csrf|peer_hash/);results.push('Named online sessions and persisted login history are available without credentials');
  const pair={certificatePem:await fs.readFile(path.join(dir,'replacement.pem'),'utf8'),privateKeyPem:await fs.readFile(path.join(dir,'replacement.key'),'utf8')};
  assert.equal((await call('/api/admin/certificate/stage',pair)).status(),403);
  assert.equal((await call('/api/auth/reauth',{password:'Abcdef1!'})).status(),200);
  const staged=await call('/api/admin/certificate/stage',pair);assert.equal(staged.status(),200);const value=await staged.json();
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE KEY|BEGIN CERTIFICATE/);
  assert.equal((await call('/api/admin/certificate/apply',{stageId:value.stageId})).status(),200);
  assert.equal((await manager.status()).mode,'manual');assert.equal((await manager.status()).current.fingerprint256,value.certificate.fingerprint256);
  await manager.autoInstall();assert.equal((await manager.status()).current.fingerprint256,value.certificate.fingerprint256);
  assert.equal((await call('/api/admin/certificate/rollback',{})).status(),200);
  const audit=await call('/api/admin/audit').then(r=>r.json());assert.doesNotMatch(JSON.stringify(audit),/PRIVATE KEY|BEGIN CERTIFICATE/);
  results.push('CSRF/reauth-protected certificate upload applies and probes a real TLS endpoint, manual mode resists auto-overwrite, rollback restores old certificate');
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/overview-mobile.png',animations:'disabled'});results.push('Admin layout fits 320/390/768/1440px widths');
  await page.setViewportSize({width:1366,height:768});
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await page.locator('.auth-entry input[name=username]').waitFor();
  assert.equal(await page.locator('.admin-console').count(),0);
  await page.locator('input[name=username]').fill('operator_admin');await page.locator('input[name=password]').fill('Abcdef1!');await page.getByRole('button',{name:'登录账号',exact:true}).click();
  await page.getByRole('navigation',{name:'管理控制台导航'}).waitFor();assert.equal(new URL(page.url()).hash,'#/admin');assert.deepEqual(learningRequests,[]);
  results.push('Administrator logout returns to login, password login opens only the console without learner requests');
  await context.close();assert.deepEqual(errors,[]);console.log(results.join('\n'));
}finally{
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));helper.closeAllConnections();await new Promise(r=>helper.close(r));journal.close();await new Promise(r=>tlsServer.close(r));guests.close();accounts.close();await fs.rm(dir,{recursive:true,force:true});await fs.writeFile(output+'/results.json',JSON.stringify({results,errors},null,2)+'\n');
}
