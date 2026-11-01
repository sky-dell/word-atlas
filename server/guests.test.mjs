import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

async function fixture(t,options={}){
  const {createGuests}=await import('./guests.mjs');
  const dir=await mkdtemp(join(tmpdir(),'wa-guests-'));let time=1000000000,guests;
  const server=createServer((req,res)=>guests.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`,dbPath=join(dir,'guests.sqlite');
  const open=()=>createGuests({dbPath,origins:[origin],allowInsecureLocal:true,now:()=>time,...options});guests=open();
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));guests.close();await rm(dir,{recursive:true,force:true});});
  function client(){let cookie='',csrf='',id='';return {async request(path='/api/guest/session',method='GET',body,headers={}){
    const r=await fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-Guest-Request':'1','X-Guest-CSRF':csrf,'X-Guest-ID':id,...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await r.json();if(data.csrfToken)csrf=data.csrfToken;if(data.guest)id=data.guest.id;return {status:r.status,data};
  }};}
  return {client,advance:ms=>time+=ms,restart:()=>{guests.close();guests=open();},get guests(){return guests;},dbPath};
}
const value={records:{'word-atlas:reader:v1':'{"size":24}','word-atlas:illustration:a priori':'classic'}};
test('guest state survives refresh and restart, CAS prevents stale writes and origin/CSRF isolate guests',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();assert.equal((await a.request()).data.guest,null);
  const s=await a.request(undefined,'POST',{});assert.equal(s.status,200);assert.match(s.data.guest.name,/^游客_/);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:0,state:value})).status,200);
  assert.equal((await a.request('/api/guest/session?version=0','DELETE')).status,409);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:0,state:value})).status,409);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:1,state:value},{'X-Guest-CSRF':'wrong'})).status,403);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:1,state:value},{'X-Guest-ID':'other'})).status,409);
  await b.request(undefined,'POST',{});assert.equal((await b.request('/api/guest/state?dataset=all')).data.state,null);
  f.restart();assert.deepEqual((await a.request('/api/guest/state?dataset=all')).data.state,value);
  assert.equal((await stat(f.dbPath)).mode&0o777,0o600);
  assert.equal((await a.request(undefined,'DELETE')).status,200);assert.equal((await a.request('/api/guest/state?dataset=all')).status,401);
});
test('guest queries never extend idle TTL and seven day cap cannot be renewed',async t=>{
  const f=await fixture(t);let a=f.client();await a.request(undefined,'POST',{});f.advance(23*3600000);assert.equal((await a.request()).status,200);
  f.advance(3600000);assert.equal((await a.request('/api/guest/state?dataset=all')).status,401);
  a=f.client();await a.request(undefined,'POST',{});
  for(let version=0;version<7;version++) {f.advance(23*3600000);assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version,state:value})).status,200);}
  f.advance(7*3600000);assert.equal((await a.request('/api/guest/state?dataset=all')).status,401);
  assert.ok(f.guests.cleanup()>=1);
});
test('guest payload rejects unknown keys and quota rejects without losing the last saved state',async t=>{
  const f=await fixture(t,{guestQuotaBytes:200}),a=f.client();await a.request(undefined,'POST',{});
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:0,state:{records:{'wa_session':'secret'}}})).status,400);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:0,state:value})).status,200);
  assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:1,state:{records:{'word-atlas:reader:v1':'x'.repeat(300)}}})).status,413);
  assert.deepEqual((await a.request('/api/guest/state?dataset=all')).data.state,value);
});
test('failed physical cleanup cannot grant access to an expired session',async t=>{
  const f=await fixture(t),a=f.client();await a.request(undefined,'POST',{});
  const external=new DatabaseSync(f.dbPath);
  try{
    external.exec("CREATE TRIGGER fixture_cleanup_failure BEFORE DELETE ON guest_sessions BEGIN SELECT RAISE(ABORT,'test cleanup failed'); END;");
    f.advance(86400000);assert.throws(()=>f.guests.cleanup());
    assert.equal((await a.request('/api/guest/state?dataset=all')).status,401);
    assert.equal((await a.request('/api/guest/state?dataset=all','PUT',{version:0,state:value})).status,401);
  }finally{external.exec('DROP TRIGGER fixture_cleanup_failure');external.close();}
});
