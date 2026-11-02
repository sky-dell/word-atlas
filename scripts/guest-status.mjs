// Local, read-only operational summary; never prints identities or study records.
import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {resolve} from 'node:path';
const file=resolve(process.argv[2]||'/var/lib/word-atlas/guests.sqlite');
try{
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error();
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false}),now=Date.now();
  try{
    const sessions=db.prepare('SELECT COUNT(*) total, COALESCE(SUM(last_active<=? OR created_at<=?),0) expired FROM guest_sessions').get(now-86400000,now-604800000);
    const data=db.prepare('SELECT COUNT(*) states,COALESCE(SUM(bytes),0) payloadBytes FROM guest_states').get();
    console.log(JSON.stringify({...sessions,...data,fileBytes:stat.size,quotaBytes:512*1024*1024,warning:data.payloadBytes>0.8*512*1024*1024||sessions.expired>0},null,2));
  }finally{db.close();}
}catch{console.error('Guest status unavailable: check the dedicated guest database path and permissions.');process.exitCode=1;}
