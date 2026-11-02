import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,lstatSync,chmodSync} from 'node:fs';
export function openOperationJournal(file,{now=Date.now}={}){
  try{closeSync(openSync(file,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Invalid operation journal');chmodSync(file,0o600);
  const db=new DatabaseSync(file,{allowExtension:false});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,fingerprint TEXT); UPDATE operations SET state='uncertain' WHERE state='started';`);
  return {
    start({id,actorId,action}){
      if(!/^[a-f0-9]{32}$/.test(id)||typeof actorId!=='string'||actorId.length>80||!['stage','apply','rollback','automatic','auto-install'].includes(action))throw Error('Invalid operation metadata');
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,NULL)').run(id,actorId,action,'started',now(),now());
      db.prepare('DELETE FROM operations WHERE id IN (SELECT id FROM operations ORDER BY updated_at DESC LIMIT -1 OFFSET 2000)').run();
    },
    finish(id,state,fingerprint){if(!['success','failure','uncertain'].includes(state))throw Error('Invalid operation outcome');db.prepare('UPDATE operations SET state=?,fingerprint=?,updated_at=? WHERE id=?').run(state,typeof fingerprint==='string'?fingerprint.slice(0,256):null,now(),id);},
    list(){return db.prepare('SELECT id,actor_id AS actorId,action,state,created_at AS createdAt,updated_at AS updatedAt,fingerprint FROM operations ORDER BY updated_at DESC LIMIT 200').all();},
    close(){db.close();},
  };
}
