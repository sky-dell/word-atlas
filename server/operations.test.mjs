import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectServices,createOperations,helperRequest} from './operations.mjs';
test('disabled service catalog never invokes systemctl or another collector',async()=>{
  let calls=0;const result=await collectServices({run:async()=>{calls++;return '[]';}});
  assert.equal(calls,0);assert.equal(result.disabled,true);assert.deepEqual(result.services,[]);
});
test('overview reports real bounded runtime and filesystem metrics without exposing process environment',async()=>{
  const ops=createOperations({mailEnabled:true,guestEnabled:true,accountsEnabled:true,tlsEnabled:true});
  const value=await ops.overview();assert.ok(value.project.uptimeSeconds>=0);assert.ok(value.host.uptimeSeconds>0);assert.ok(value.host.memory.total>0);assert.ok(value.host.disk.total>0);assert.equal(value.checks.find(c=>c.name==='邮件服务').status,'ok');assert.doesNotMatch(JSON.stringify(value),/SMTP_PASS|MAIL_CODE_SECRET|privkey/);
});
test('overview reads the mail status getter on every request',async()=>{
  let enabled=false;
  const ops=createOperations({mailEnabled:()=>enabled});
  assert.equal((await ops.overview()).checks.find(c=>c.name==='邮件服务').status,'unavailable');
  enabled=true;
  assert.equal((await ops.overview()).checks.find(c=>c.name==='邮件服务').status,'ok');
});
test('mail helper transport failures use a sanitized mail-specific error',async()=>{
  await assert.rejects(
    helperRequest('mail-save',{password:'never-return-this'},'/tmp/atlas-missing-helper-'+process.pid+'.sock'),
    error=>error.code==='mail_operation_failed'&&!error.message.includes('证书')&&!error.message.includes('never-return-this'),
  );
});
