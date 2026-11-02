import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openOperationJournal} from './operation-journal.mjs';
test('operation outcomes persist without request payloads and unfinished operations remain explicitly uncertain after restart',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wa-oplog-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'journal.sqlite');
  let journal=openOperationJournal(file);journal.start({id:'a'.repeat(32),actorId:'admin-fixture',action:'apply'});journal.finish('a'.repeat(32),'success','fingerprint');journal.start({id:'b'.repeat(32),actorId:'admin-fixture',action:'rollback'});journal.close();
  journal=openOperationJournal(file);try{assert.equal(journal.list().find(r=>r.id==='a'.repeat(32)).state,'success');assert.equal(journal.list().find(r=>r.id==='b'.repeat(32)).state,'uncertain');assert.equal((await stat(file)).mode&0o777,0o600);assert.doesNotMatch(JSON.stringify(journal.list()),/PRIVATE KEY|certificatePem|privateKeyPem/);}finally{journal.close();}
});
