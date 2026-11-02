// Own the loopback server for the entire test lifetime: no background terminal
// session, production accounts, SMTP configuration, or fixed port is required.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createApplication} from './http-handler.mjs';
import os from 'node:os';
import {createAccounts} from '../server/accounts.mjs';
import {createGuests} from '../server/guests.mjs';

const mode=process.argv[2]||'all';
if(!['all','unit','learning','brand','footer'].includes(mode))throw Error('Use all|unit|learning|brand|footer');
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
await fs.access(path.join(root,'dist/index.html'));
let handler;
const server=http.createServer((req,res)=>handler(req,res));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'wa-browser-fixture-'));
const accounts=createAccounts({dbPath:path.join(fixture,'accounts.sqlite'),origins:[origin],secureCookies:false,allowInsecureLocal:true});
const guests=createGuests({dbPath:path.join(fixture,'guests.sqlite'),origins:[origin],allowInsecureLocal:true});
handler=createApplication({root:path.join(root,'dist'),accounts,guests,secureOrigin:origin,allowInsecureLocal:true});
let child;
const stop=()=>child?.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
try {
 const tests=[];
 const dirs=['src'];
 while(dirs.length){const dir=dirs.pop();for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())dirs.push(file);else if(file.endsWith('.test.ts'))tests.push(file);}}
 const jobs={unit:['--import','tsx','--test','--test-concurrency=1',...tests.sort()],learning:['scripts/e2e.mjs'],brand:['scripts/brand-smoke.mjs'],footer:['scripts/footer-e2e.mjs']};
 for(const name of mode==='all'?Object.keys(jobs):[mode]){
  console.log(`CHECK ${name} with owned loopback server`);
  const code=await new Promise((resolve,reject)=>{child=spawn(process.execPath,jobs[name],{cwd:root,env:{...process.env,ATLAS_BROWSER_TEST_URL:origin,TEST_URL:origin},stdio:'inherit'});child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
  child=undefined;if(code!==0)throw Error(`${name} checks failed with exit ${code}`);
 }
} finally {process.off('SIGTERM',stop);process.off('SIGINT',stop);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));guests.close();accounts.close();await fs.rm(fixture,{recursive:true,force:true});}
