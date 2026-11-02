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
const secureOrigin=process.env.PUBLIC_ORIGIN||'https://43.133.166.184';
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
let mailer;
if(enabled) {
  const {createAccounts}=await import('../server/accounts.mjs');
  const {createMailerFromEnv}=await import('../server/mailer.mjs');
  mailer=createMailerFromEnv(process.env);
  accounts=createAccounts({dbPath:process.env.ACCOUNTS_DB,origins:(process.env.APP_ORIGINS||secureOrigin).split(',').filter(Boolean),secureCookies:!allowInsecureLocal,allowInsecureLocal,initializeDatabase:process.env.NODE_ENV!=='production',accountQuotaBytes:Number(process.env.ACCOUNT_QUOTA_BYTES||40*1024*1024),cloudQuotaBytes:Number(process.env.CLOUD_QUOTA_BYTES||512*1024*1024),sendEmailCode:mailer.enabled?mailer.sendCode:undefined,emailCodeSecret:process.env.MAIL_CODE_SECRET});
}
const handler=createApplication({root,accounts,acmeRoot:process.env.ACME_ROOT||'/var/lib/word-atlas/acme',secureOrigin,allowInsecureLocal});
const servers=[http.createServer(handler)];
if(tlsEnabled) servers.push(https.createServer({key:fs.readFileSync(process.env.TLS_KEY),cert:fs.readFileSync(process.env.TLS_CERT),minVersion:'TLSv1.2'},handler));
for(const [i,server] of servers.entries()) {
  server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
  server.on('error',error=>{console.error('Words & Beyond listener failed:',error.code||'unknown');process.exit(1);});
  server.listen(i===0?port:Number(process.env.HTTPS_PORT||443),host,()=>console.log('Words & Beyond '+(i?'HTTPS':'HTTP')+' listening on '+(i?process.env.HTTPS_PORT||443:port)));
}
let stopping=false;
function stop() {
  if(stopping) return;stopping=true;
  const timer=setTimeout(()=>process.exit(1),10000);timer.unref();
  Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve)))).then(()=>{accounts?.close();mailer?.close();clearTimeout(timer);process.exit(0);});
}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
