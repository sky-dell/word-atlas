import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectServices,createOperations} from './operations.mjs';
test('disabled service catalog never invokes systemctl or another collector',async()=>{
  let calls=0;const result=await collectServices({run:async()=>{calls++;return '[]';}});
  assert.equal(calls,0);assert.equal(result.disabled,true);assert.deepEqual(result.services,[]);
});
test('overview reports real bounded runtime and filesystem metrics without exposing process environment',async()=>{
  const ops=createOperations({mailEnabled:true,guestEnabled:true,accountsEnabled:true,tlsEnabled:true});
  const value=await ops.overview();assert.ok(value.project.uptimeSeconds>=0);assert.ok(value.host.uptimeSeconds>0);assert.ok(value.host.memory.total>0);assert.ok(value.host.disk.total>0);assert.equal(value.checks.find(c=>c.name==='邮件服务').status,'ok');assert.doesNotMatch(JSON.stringify(value),/SMTP_PASS|MAIL_CODE_SECRET|privkey/);
});
