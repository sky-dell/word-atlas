import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from './database.mjs';
import {createGuests} from './guests.mjs';
import {backupWithRetention} from './backup.mjs';
import {DatabaseSync} from 'node:sqlite';
test('formal database backup never includes the independent guest store',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-guest-backup-'));
  const account=openDatabase(join(dir,'accounts.sqlite')),guest=createGuests({dbPath:join(dir,'guests.sqlite'),origins:[]});
  t.after(async()=>{guest.close();account.close();await rm(dir,{recursive:true,force:true});});
  const out=join(dir,'backups'),file=await backupWithRetention(account,out);
  assert.equal((await readdir(out)).length,1);
  const restored=new DatabaseSync(file,{readOnly:true});
  try{assert.equal(restored.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('guest_sessions','guest_states')").get().n,0);assert.equal(restored.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='users'").get().n,1);}finally{restored.close();}
});
