// Production enables this before React mounts. Legacy migration tests can still
// exercise the old persistence protocol without enabling the new guest mode.
let enabled=false;
const memory=new Map<string,string>(),listeners=new Set<()=>void>();
export const temporaryGuestsEnabled=()=>enabled;
export const isTemporaryKey=(key:string)=>enabled&&!key.startsWith('word-atlas:account:');
export function enableTemporaryGuests(){enabled=true;}
export const guestRecords=()=>Object.fromEntries(memory);
export function replaceGuestRecords(records:Record<string,string>){memory.clear();for(const [k,v]of Object.entries(records))memory.set(k,v);}
export function subscribeGuestRecords(fn:()=>void){listeners.add(fn);return ()=>{listeners.delete(fn);};}
function keys(){
  if(!enabled)return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!).filter(Boolean);
  const account:string[]=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith('word-atlas:account:'))account.push(k);}}catch{/* Guests work with browser persistence disabled. */}
  return [...account,...memory.keys()];
}
export const profileStorage={
  get length(){return keys().length;},key:(index:number)=>keys()[index]??null,
  getItem(key:string){return isTemporaryKey(key)?memory.get(key)??null:localStorage.getItem(key);},
  setItem(key:string,value:string){if(isTemporaryKey(key)){if(memory.get(key)===value)return;memory.set(key,value);listeners.forEach(l=>l());}else localStorage.setItem(key,value);},
  removeItem(key:string){if(isTemporaryKey(key)){if(memory.delete(key))listeners.forEach(l=>l());}else localStorage.removeItem(key);},
};
