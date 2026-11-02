import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHelperServer} from './admin-helper.mjs';
import {readMailStore} from './mail-store.mjs';
import {openOperationJournal} from './operation-journal.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('restricted helper rejects arbitrary actions, paths and oversized private-key payloads',async t=>{
  let touched=0;const manager={status:async()=>({mode:'automatic'}),stage:async()=>{touched++;return {};}};
  const server=createHelperServer({manager,services:async()=>({services:[]})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=data=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post({action:'shell',payload:{command:'id'}})).status,400);
  assert.equal((await post({action:'apply',payload:{stageId:'../../etc/passwd'}})).status,400);
  assert.equal((await post({action:'certificate',payload:{path:'/etc/shadow'}})).status,400);
  assert.equal((await post({action:'stage',payload:{certificatePem:'x'.repeat(150000),privateKeyPem:'private'}})).status,413);
  assert.deepEqual(await(await post({action:'certificate',payload:{}})).json(),{mode:'automatic'});assert.equal(touched,0);
  assert.equal((await post({action:'services',payload:{}})).status,400,'Privileged service collection is disabled');
});
test('certificate completion is durably audited even after the caller disconnects',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-disconnect-')),journal=openOperationJournal(path.join(dir,'operations.sqlite'));
  let entered,release;const called=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  const server=createHelperServer({journal,manager:{apply:async()=>{entered();await held;return {ok:true,certificate:{fingerprint256:'new-certificate'}};}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{release();server.closeAllConnections();await new Promise(r=>server.close(r));journal.close();await rm(dir,{recursive:true,force:true});});
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/',method:'POST',headers:{'Content-Type':'application/json'}});req.on('error',()=>{});req.end(JSON.stringify({action:'apply',payload:{stageId:'a'.repeat(32)}}));
  await called;assert.equal(journal.list()[0]?.state,'started');req.destroy();release();
  const deadline=Date.now()+3000;while(journal.list()[0]?.state==='started'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(journal.list()[0].state,'success');assert.equal(journal.list()[0].fingerprint,'new-certificate');
});

test('mail-save accepts only normalized SMTP fields and writes through the injected store',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-mail-helper-'));
  const journal=openOperationJournal(path.join(dir,'operations.sqlite'));
  const mailFile=path.join(dir,'mail.env');
  const writes=[];
  const server=createHelperServer({
    journal,
    manager:{},
    mailFile,
    mailStore:async(file,config)=>{writes.push({file,config});},
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));journal.close();await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const post=data=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const config={
    host:'SMTP.Example.COM.',
    port:587,
    security:'starttls',
    user:' Sender@example.com ',
    password:'helper-provider-secret',
    from:' Sender@Example.com ',
    fromName:' Words & Beyond ',
  };
  const result=await post({
    action:'mail-save',
    payload:config,
    context:{operationId:'d'.repeat(32),actorId:'mail-admin'},
  });
  assert.equal(result.status,200);
  const value=await result.json();
  assert.doesNotMatch(JSON.stringify(value),/helper-provider-secret/);
  assert.equal(writes.length,1);
  assert.equal(writes[0].file,mailFile);
  assert.deepEqual(writes[0].config,{
    host:'smtp.example.com',
    port:587,
    security:'starttls',
    user:'Sender@example.com',
    password:'helper-provider-secret',
    from:'Sender@example.com',
    fromName:'Words & Beyond',
  });
  assert.deepEqual({...journal.list()[0]},{
    id:'d'.repeat(32),
    actorId:'mail-admin',
    action:'mail-save',
    state:'success',
    createdAt:journal.list()[0].createdAt,
    updatedAt:journal.list()[0].updatedAt,
    fingerprint:null,
  });
  assert.doesNotMatch(JSON.stringify(journal.list()),/helper-provider-secret/);

  const rejected=await post({
    action:'mail-save',
    payload:{...config,path:'/etc/shadow'},
  });
  assert.equal(rejected.status,400);
  assert.equal(writes.length,1);
  assert.equal((await post({action:'shell',payload:{}})).status,400);
});

test('mail-save returns the root-generated code secret without returning the provider password',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-mail-helper-secret-'));
  const journal=openOperationJournal(path.join(dir,'operations.sqlite'));
  const codeSecret='9f'.repeat(32);
  const password='helper-provider-password';
  const server=createHelperServer({
    journal,
    manager:{},
    mailStore:async()=>({codeSecret}),
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));journal.close();await rm(dir,{recursive:true,force:true});});
  const response=await fetch('http://127.0.0.1:'+server.address().port,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'mail-save',
      payload:{
        host:'smtp.example.com',
        port:465,
        security:'tls',
        user:'sender@example.com',
        password,
        from:'sender@example.com',
        fromName:'',
      },
      context:{operationId:'a'.repeat(32),actorId:'mail-admin'},
    }),
  });
  const text=await response.text();
  assert.equal(response.status,200);
  assert.equal(JSON.parse(text).codeSecret,codeSecret);
  assert.doesNotMatch(text,new RegExp(password));
  assert.doesNotMatch(JSON.stringify(journal.list()),new RegExp(codeSecret));
});

test('mail-save records failure without returning the password',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-mail-helper-fail-'));
  const journal=openOperationJournal(path.join(dir,'operations.sqlite'));
  const password='failure-provider-secret';
  const server=createHelperServer({
    journal,
    manager:{},
    mailStore:async()=>{throw new Error(`store failed for ${password}`);},
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));journal.close();await rm(dir,{recursive:true,force:true});});
  const response=await fetch('http://127.0.0.1:'+server.address().port,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'mail-save',
      payload:{
        host:'smtp.example.com',
        port:465,
        security:'tls',
        user:'sender@example.com',
        password,
        from:'sender@example.com',
        fromName:'',
      },
      context:{operationId:'e'.repeat(32),actorId:'mail-admin'},
    }),
  });
  assert.equal(response.status,400);
  assert.doesNotMatch(await response.text(),new RegExp(password));
  assert.equal(journal.list()[0].action,'mail-save');
  assert.equal(journal.list()[0].state,'failure');
  assert.doesNotMatch(JSON.stringify(journal.list()),new RegExp(password));
});

test('mail-save stays successful when success journaling throws after the store commits',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-mail-helper-committed-'));
  const realJournal=openOperationJournal(path.join(dir,'operations.sqlite'));
  const journal={
    start:operation=>realJournal.start(operation),
    finish:(id,state,fingerprint)=>{
      if(state==='success')throw new Error('journal success write failed');
      realJournal.finish(id,state,fingerprint);
    },
    list:()=>realJournal.list(),
  };
  const mailFile=path.join(dir,'mail.env');
  const password='committed-provider-secret';
  const server=createHelperServer({journal,manager:{},mailFile});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));realJournal.close();await rm(dir,{recursive:true,force:true});});
  const response=await fetch('http://127.0.0.1:'+server.address().port,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'mail-save',
      payload:{
        host:'smtp.example.com',
        port:465,
        security:'tls',
        user:'sender@example.com',
        password,
        from:'sender@example.com',
        fromName:'',
      },
      context:{operationId:'f'.repeat(32),actorId:'mail-admin'},
    }),
  });
  const responseText=await response.text();
  assert.equal(response.status,200);
  assert.doesNotMatch(responseText,new RegExp(password));
  assert.equal((await readMailStore(mailFile)).password,password);
  assert.equal(realJournal.list()[0].state,'started');
});
