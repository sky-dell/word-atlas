import {test} from 'node:test';
import assert from 'node:assert/strict';
test('temporary guest storage never reads legacy data or writes browser storage, formal namespace remains durable',async()=>{
  const {profileStorage,enableTemporaryGuests,guestRecords,replaceGuestRecords}=await import('./profileStorage');
  const saved=new Map([['word-atlas:reader:v1','old']]);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{get length(){return saved.size;},key:(i:number)=>[...saved.keys()][i]??null,getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v),removeItem:(k:string)=>saved.delete(k)}});
  enableTemporaryGuests();assert.equal(profileStorage.getItem('word-atlas:reader:v1'),null);
  profileStorage.setItem('word-atlas:reader:v1','temporary');assert.equal(saved.get('word-atlas:reader:v1'),'old');
  profileStorage.setItem('word-atlas:account:abc:word-atlas:reader:v1','formal');assert.equal(saved.get('word-atlas:account:abc:word-atlas:reader:v1'),'formal');
  assert.equal(guestRecords()['word-atlas:reader:v1'],'temporary');replaceGuestRecords({});assert.equal(profileStorage.getItem('word-atlas:reader:v1'),null);
});
