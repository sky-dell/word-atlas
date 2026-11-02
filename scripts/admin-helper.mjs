import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHelperServer} from '../server/admin-helper.mjs';
import {openOperationJournal} from '../server/operation-journal.mjs';
const execute=promisify(execFile),socket='/run/word-atlas-admin/control.sock';
if(process.getuid?.()!==0)throw Error('Restricted component must run as root');
const domain='west.cloud-ip.cc';
const {createCertificateManager}=await import('../server/certificates.mjs');
const reload=async()=>{await execute('/usr/bin/systemctl',['kill','--kill-who=main','--signal=USR2','word-atlas.service'],{timeout:3000,maxBuffer:4096});};
async function probe(expected){
  for(let attempt=0;attempt<10;attempt++){
    const good=await new Promise(resolve=>{
      const connection=tls.connect({host:'127.0.0.1',port:443,servername:domain,rejectUnauthorized:true},()=>{const match=connection.getPeerCertificate().fingerprint256===expected;connection.end();resolve(match);});
      connection.setTimeout(200,()=>connection.destroy());connection.on('error',()=>resolve(false));connection.on('close',()=>resolve(false));
    });if(good)return;await new Promise(r=>setTimeout(r,50));
  }throw Error('Certificate probe failed');
}
const manager=createCertificateManager({domain,tlsDir:'/etc/word-atlas/tls',stateDir:'/var/lib/word-atlas-admin',initialCertificatePath:'/etc/word-atlas/tls/fullchain.pem',initialKeyPath:'/etc/word-atlas/tls/privkey.pem',automaticCertificatePath:'/etc/word-atlas-acme/live/43.133.166.184/fullchain.pem',automaticKeyPath:'/etc/word-atlas-acme/live/43.133.166.184/privkey.pem',reload,probe});
// Bootstrap before the application switches to the atomic current pair.
await manager.status();
const maintenance=setInterval(()=>void manager.status().catch(()=>console.error('Certificate staging maintenance failed')),60000);maintenance.unref();
await fs.mkdir(path.dirname(socket),{recursive:true,mode:0o750});
try{
  const info=await fs.lstat(socket);if(!info.isSocket())throw Error('Refusing non-socket path');
  const alive=await new Promise(resolve=>{const c=net.connect(socket,()=>{c.end();resolve(true);});c.once('error',()=>resolve(false));c.setTimeout(1000,()=>{c.destroy();resolve(true);});});
  if(alive)throw Error('Helper already listening');await fs.unlink(socket);
}catch(error){if(error.code!=='ENOENT')throw error;}
const journal=openOperationJournal('/var/lib/word-atlas-admin/operations.sqlite');
const server=createHelperServer({manager,journal});server.on('error',()=>{console.error('Restricted helper failed');process.exit(1);});
server.listen(socket,async()=>{await fs.chmod(socket,0o660);console.log('Restricted administration component ready');});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>{journal.close();process.exit(0);}));
