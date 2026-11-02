import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createActivityMonitor} from './activity';

function fixture(){
  let time=0,session:{key:string;deadline:number}|null={key:'account:A',deadline:7200000};
  let renewals=0,expired=0,checks=0;
  const monitor=createActivityMonitor({now:()=>time,visible:()=>true,read:()=>session,
    renew:async()=>{renewals++;session={...session!,deadline:time+7200000};},
    revalidate:async()=>{checks++;},expire:()=>{expired++;}});
  return {monitor,advance:(ms:number)=>time+=ms,set:(s:typeof session)=>session=s,get stats(){return {renewals,expired,checks};}};
}
test('passive polling reaches the exact deadline without renewing and expires once',async()=>{
  const f=fixture();f.advance(7199999);await f.monitor.check();assert.equal(f.stats.renewals,0);assert.equal(f.stats.expired,0);
  f.advance(1);await f.monitor.check();await f.monitor.check();assert.equal(f.stats.expired,1);assert.equal(f.stats.renewals,0);
});
test('real interaction renews with a bounded rate while idle checks do not send activity',async()=>{
  const f=fixture();f.advance(60000);f.monitor.interact();await f.monitor.check();assert.equal(f.stats.renewals,1);
  for(let i=0;i<10;i++){f.monitor.interact();await f.monitor.check();}assert.equal(f.stats.renewals,1);
  f.advance(60000);await f.monitor.check();assert.equal(f.stats.renewals,2);
  f.advance(60000);await f.monitor.check();assert.equal(f.stats.renewals,2);
});
test('an input after the deadline cannot revive a timed-out session',async()=>{
  const f=fixture();f.advance(7200000);f.monitor.interact();await f.monitor.check();assert.equal(f.stats.expired,1);assert.equal(f.stats.renewals,0);
});
test('another tab renewing the server session prevents false local logout',async()=>{
  let time=7200000,expired=0;
  let s={key:'A',deadline:7200000};
  const m=createActivityMonitor({now:()=>time,visible:()=>true,read:()=>s,renew:async()=>{},revalidate:async()=>{s={key:'A',deadline:14400000};},expire:()=>expired++});
  // Calibrate against server response rather than the browser wall-clock origin.
  time=0;await m.check();time=7200000;await m.check();assert.equal(expired,0);
});
test('a stale expiry check cannot log out a newly selected identity',async()=>{
  let time=0,s={key:'A',deadline:1},expired=0;
  const m=createActivityMonitor({now:()=>time,visible:()=>true,read:()=>s,renew:async()=>{},revalidate:async()=>{s={key:'B',deadline:99999};},expire:()=>expired++});
  await m.check();time=1;await m.check();assert.equal(expired,0);
});
test('hidden pages do not renew and resume checking the server at expiry',async()=>{
  let time=0,expired=0,renewals=0;
  const m=createActivityMonitor({now:()=>time,visible:()=>false,read:()=>({key:'guest:A',deadline:14400000}),renew:async()=>{renewals++;},revalidate:async()=>{},expire:()=>expired++});
  m.interact();await m.check();assert.equal(renewals,0);
  time=14400000;await m.check();assert.equal(expired,1);assert.equal(renewals,0);
});
test('explicit re-entry of a retained guest starts a new monitored login',async()=>{
  const f=fixture();f.advance(7200000);await f.monitor.check();assert.equal(f.stats.expired,1);
  f.set(null);await f.monitor.check();f.set({key:'account:A',deadline:14400000});
  f.monitor.interact();await f.monitor.check();assert.equal(f.stats.renewals,1);
});
test('a newly confirmed deadline re-arms activity after a temporary expired view',async()=>{
  const f=fixture();f.advance(7200000);await f.monitor.check();assert.equal(f.stats.expired,1);
  f.set({key:'account:A',deadline:14400000});f.monitor.interact();await f.monitor.check();assert.equal(f.stats.renewals,1);
});
