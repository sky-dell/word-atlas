import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { saveMailConfiguration } from './configure-mail.mjs';
import { normalizeMailConfig } from '../server/mail-config.mjs';
import { readMailStore } from '../server/mail-store.mjs';

const genericConfig = normalizeMailConfig({
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  user: 'sender@example.com',
  password: 'DISPOSABLETESTCODE123',
  from: 'Sender@example.com',
  fromName: 'Words & Beyond',
});

test('private mail configuration never returns its authorization and preserves the OTP secret on replacement',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-mail-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const result=await saveMailConfiguration({directory:dir,config:genericConfig});
  assert.equal((await stat(result.file)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(result).includes('DISPOSABLETESTCODE123'));
  const old=parseEnv(await readFile(result.file,'utf8'));assert.equal(old.SMTP_USER,'sender@example.com');assert.equal(old.SMTP_HOST,'smtp.example.com');assert.equal(old.SMTP_PORT,'587');assert.equal(old.SMTP_SECURE,'0');assert.equal(old.SMTP_PASS,'DISPOSABLETESTCODE123');assert.match(old.MAIL_CODE_SECRET,/^[a-f0-9]{64}$/);
  await assert.rejects(saveMailConfiguration({directory:dir,config:genericConfig}),/replace|已有/);
  const next=await saveMailConfiguration({directory:dir,config:{...genericConfig,password:'ANOTHERDISPOSABLECODE'},replace:true});
  const fresh=parseEnv(await readFile(next.file,'utf8'));assert.equal(fresh.MAIL_CODE_SECRET,old.MAIL_CODE_SECRET);assert.equal(fresh.SMTP_PASS,'ANOTHERDISPOSABLECODE');
  assert.deepEqual(await readMailStore(result.file),{...genericConfig,password:'ANOTHERDISPOSABLECODE'});
});
test('configuration rejects symlinks and newline injection without touching other files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-mail-safety-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(saveMailConfiguration({directory:dir,config:{...genericConfig,password:'secret\nINJECT=yes'}}),/mail configuration/i);
  const outside=join(dir,'preserved');await writeFile(outside,'keep');await symlink(outside,join(dir,'mail.env'));
  await assert.rejects(saveMailConfiguration({directory:dir,config:genericConfig,replace:true}),/mail store/i);
  assert.equal(await readFile(outside,'utf8'),'keep');
});
test('replacement keeps the stored authorization when the CLI password is blank',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-mail-blank-password-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await saveMailConfiguration({directory:dir,config:genericConfig});
  const result=await saveMailConfiguration({
    directory:dir,
    config:{...genericConfig,password:'',fromName:'Updated Sender'},
    replace:true,
  });
  assert.deepEqual(await readMailStore(result.file),{
    ...genericConfig,
    fromName:'Updated Sender',
  });
  assert.doesNotMatch(JSON.stringify(result),/DISPOSABLETESTCODE123/);
});
test('CLI rejects password arguments and noninteractive input without exposing submitted secrets',()=>{
  for(const args of [[],['--password','DO-NOT-PRINT-THIS']]){
    const r=spawnSync(process.execPath,[new URL('./configure-mail.mjs',import.meta.url).pathname,...args],{input:'DO-NOT-PRINT-THIS\n',encoding:'utf8'});
    assert.equal(r.status,1);assert.ok(!`${r.stdout}${r.stderr}`.includes('DO-NOT-PRINT-THIS'));
  }
});
