import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './http-handler.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(process.env.STATIC_ROOT||path.join(project,'dist'));
const port=Number(process.env.PORT||80);
const host=process.env.BIND_HOST||'0.0.0.0';
const secureOrigin=process.env.PUBLIC_ORIGIN||'https://west.cloud-ip.cc';
const allowInsecureLocal=process.env.ALLOW_INSECURE_LOCAL==='1'&&process.env.NODE_ENV!=='production';
const tlsEnabled=Boolean(process.env.TLS_KEY&&process.env.TLS_CERT);
const enabled=process.env.ACCOUNTS_ENABLED==='1';
if(enabled&&!process.env.ACCOUNTS_DB) throw new Error('ACCOUNTS_DB must be configured');
// Initialization is an explicit local operation. A missing production DB must
// not look like a successful startup with all accounts silently replaced.
if(enabled&&process.env.NODE_ENV==='production') {
  const info=fs.lstatSync(process.env.ACCOUNTS_DB);
  if(!info.isFile()||info.isSymbolicLink()) throw new Error('Account database must be an initialized regular file');
}
if(enabled&&!tlsEnabled&&!allowInsecureLocal) throw new Error('Account service requires TLS');
if(enabled&&allowInsecureLocal&&host!=='127.0.0.1'&&host!=='::1') throw new Error('Insecure test accounts must bind loopback');

let accounts;
let guests;
let mailer;
const {createOperations}=await import('../server/operations.mjs');
if(enabled) {
  const {createAccounts}=await import('../server/accounts.mjs');
  const {createMailRuntime}=await import('../server/mailer.mjs');
  const {mailConfigFromEnv}=await import('../server/mail-config.mjs');
  const initialMailConfig=mailConfigFromEnv(process.env);
  mailer=createMailRuntime(initialMailConfig);
  const operations=createOperations({helperSocket:process.env.ADMIN_SOCKET,mailEnabled:()=>mailer.status().configured,guestEnabled:true,accountsEnabled:true,tlsEnabled,dataPath:project});
  if(process.env.ADMIN_SOCKET)void operations.request('certificate').then(()=>console.log('Restricted administration component reachable'),()=>console.error('Restricted administration component unavailable; public application remains enabled'));
  accounts=createAccounts({operations,listGuests:()=>guests?.listOnline()??[],dbPath:process.env.ACCOUNTS_DB,origins:(process.env.APP_ORIGINS||secureOrigin).split(',').filter(Boolean),secureCookies:!allowInsecureLocal,allowInsecureLocal,initializeDatabase:process.env.NODE_ENV!=='production',accountQuotaBytes:Number(process.env.ACCOUNT_QUOTA_BYTES||40*1024*1024),cloudQuotaBytes:Number(process.env.CLOUD_QUOTA_BYTES||512*1024*1024),sendEmailCode:mailer.sendCode,mailRuntime:mailer,mailPassword:initialMailConfig?.password,emailCodeSecret:process.env.MAIL_CODE_SECRET});
  const {createGuests}=await import('../server/guests.mjs');
  const guestPath=process.env.GUESTS_DB||path.join(path.dirname(process.env.ACCOUNTS_DB),'guests.sqlite');
  if(path.resolve(guestPath)===path.resolve(process.env.ACCOUNTS_DB))throw Error('Guest and account databases must be separate');
  guests=createGuests({dbPath:guestPath,origins:(process.env.APP_ORIGINS||secureOrigin).split(',').filter(Boolean),allowInsecureLocal});
}
const handler=createApplication({root,accounts,guests,acmeRoot:process.env.ACME_ROOT||'/var/lib/word-atlas/acme',secureOrigin,allowInsecureLocal,domainOnly:process.env.DOMAIN_ONLY==='1'});
const servers=[http.createServer(handler)];
function tlsFiles(){const certificatePath=fs.realpathSync(process.env.TLS_CERT);const keyPath=process.env.TLS_KEY.includes('/current/')?path.join(path.dirname(certificatePath),'privkey.pem'):process.env.TLS_KEY;return {key:fs.readFileSync(keyPath),cert:fs.readFileSync(certificatePath),minVersion:'TLSv1.2'};}
if(tlsEnabled) servers.push(https.createServer(tlsFiles(),handler));
if(tlsEnabled)process.on('SIGUSR2',()=>{
  try{
    servers[1].setSecureContext(tlsFiles());
    console.log('HTTPS certificate context reloaded');
  }catch{console.error('HTTPS certificate context reload rejected; previous context retained');}
});
for(const [i,server] of servers.entries()) {
  server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
  server.on('error',error=>{console.error('Words & Beyond listener failed:',error.code||'unknown');process.exit(1);});
  server.listen(i===0?port:Number(process.env.HTTPS_PORT||443),host,()=>console.log('Words & Beyond '+(i?'HTTPS':'HTTP')+' listening on '+(i?process.env.HTTPS_PORT||443:port)));
}
let stopping=false;
function stop() {
  if(stopping) return;stopping=true;
  const timer=setTimeout(()=>process.exit(1),10000);timer.unref();
  Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve)))).then(()=>{guests?.close();accounts?.close();mailer?.close();clearTimeout(timer);process.exit(0);});
}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
