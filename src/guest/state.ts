import {useSyncExternalStore} from 'react';
import {guestClient,GuestError,type Guest} from './client';
import {guestRecords,replaceGuestRecords,subscribeGuestRecords,temporaryGuestsEnabled} from '../store/profileStorage';
import {flush,store,switchProfile,exportBackup,importBackup,exportExtras} from '../store/store';
import {getProfile,notifyExtras,profileGeneration,profileTransitioning} from '../store/profile';

interface State {guest:Guest|null;status:'idle'|'saving'|'saved'|'pending'|'offline'|'expired'|'conflict';message:string;loading:boolean}
let state:State={guest:null,status:'idle',message:'',loading:false},active=false,version=0,revision=0,epoch=0;
let timer:ReturnType<typeof setTimeout>|undefined,inflight:Promise<void>|null=null;
const listeners=new Set<()=>void>();const emit=(patch:Partial<State>)=>{state={...state,...patch};listeners.forEach(l=>l());};
export const guestState={get:()=>state,subscribe(fn:()=>void){listeners.add(fn);return ()=>{listeners.delete(fn);};}};
export function useGuest(){return useSyncExternalStore(guestState.subscribe,guestState.get,guestState.get);}
const path='/api/guest/state?dataset=all';
function pending(){
  if(!active||getProfile()!==null||!state.guest||['expired','conflict'].includes(state.status))return;
  revision++;emit({status:'pending',message:'变更待暂存'});clearTimeout(timer);timer=setTimeout(()=>void flushGuest().catch(()=>{}),700);
}
subscribeGuestRecords(pending);
let lastStore='';
store.subscribe(()=>{if(!active||getProfile()!==null)return;const value=JSON.stringify({progress:store.get().progress,settings:store.get().settings});if(value!==lastStore){lastStore=value;pending();}});
if(typeof window!=='undefined'){
  window.addEventListener('beforeunload',e=>{if(active&&['pending','saving','offline','conflict'].includes(state.status)){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flushGuest().catch(()=>{});});
}
export async function beginGuest(restoreOnly=false){
  if(state.loading)throw Error('正在准备游客身份，请稍候。');
  if(active)await flushGuest();
  emit({loading:true,message:''});const current=++epoch;active=false;
  try{
    await flush();guestClient.setSession('','');
    let session=await guestClient.request<{guest:Guest|null;csrfToken?:string}>('/api/guest/session');
    if(restoreOnly&&!session.guest)throw new GuestError('游客暂存已过期，请重新选择游客进入或登录正式账户。','guest_expired',401);
    if(session.guest)guestClient.setSession(session.guest.id,session.csrfToken!);
    session=await guestClient.request<{guest:Guest;csrfToken:string}>('/api/guest/session','POST',{});
    guestClient.setSession(session.guest!.id,session.csrfToken!);
    const saved=await guestClient.request<{state:{records:Record<string,string>}|null;version:number}>(path);
    if(epoch!==current)return;
    replaceGuestRecords(saved.state?.records||{});version=saved.version;revision=0;
    await switchProfile(null);if(epoch!==current)return;
    lastStore=JSON.stringify({progress:store.get().progress,settings:store.get().settings});
    active=true;emit({guest:session.guest,status:'saved',loading:false,message:'已暂存 · 闲置24小时失效，最长保留7天'});notifyExtras();
  }catch(e){if(current===epoch)emit({loading:false,status:'offline',message:e instanceof Error?e.message:'游客服务不可用'});throw e;}
}
export function suspendGuest(){active=false;clearTimeout(timer);}
export async function flushGuest():Promise<void>{
  if(!temporaryGuestsEnabled()||!active||getProfile()!==null||!state.guest)return;
  if(['expired','conflict'].includes(state.status))throw Error(state.message);
  await flush();
  if(inflight){await inflight;if(state.status==='pending')return flushGuest();return;}
  if(state.status==='offline')emit({status:'pending',message:'正在重试暂存…'});
  if(state.status!=='pending')return;
  const current=epoch,rev=revision,payload={records:guestRecords()};emit({status:'saving',message:'正在暂存…'});
  const work=async()=>{try{
    const r=await guestClient.request<{version:number;guest:Guest}>(path,'PUT',{version,state:payload});
    if(current!==epoch)return;version=r.version;
    emit({guest:r.guest,status:rev===revision?'saved':'pending',message:rev===revision?'已暂存 · 闲置24小时失效，最长保留7天':'变更待暂存'});
    if(rev!==revision){clearTimeout(timer);timer=setTimeout(()=>void flushGuest().catch(()=>{}),700);}
  }catch(e){if(current===epoch)emit({status:e instanceof GuestError&&e.status===401?'expired':e instanceof GuestError&&e.code==='guest_conflict'?'conflict':'offline',message:e instanceof Error?e.message:'暂存失败；刷新会丢失尚未保存的变更。'});throw e;}};
  inflight=work();try{await inflight;}finally{inflight=null;}
}
export async function retryGuestSave(){if(state.status==='expired'||state.status==='conflict')throw Error(state.message);emit({status:'pending'});await flushGuest();}
export async function clearGuest(expectedVersion?:number){
  clearTimeout(timer);await inflight?.catch(()=>{});
  try{await guestClient.request('/api/guest/session'+(expectedVersion===undefined?'':`?version=${expectedVersion}`),'DELETE');}catch(e){if(!(e instanceof GuestError&&e.status===401))throw e;}
  epoch++;active=false;guestClient.setSession('','');replaceGuestRecords({});
  if(getProfile()===null)await switchProfile(null);emit({guest:null,status:'idle',message:'',loading:false});
}
export async function importTemporaryGuest(){
  if(getProfile()===null)throw Error('请先登录目标账户。');
  const target=getProfile(),generation=profileGeneration(),dataset=store.get().progress.datasetId;
  const assertTarget=()=>{if(getProfile()!==target||profileGeneration()!==generation||profileTransitioning()||store.get().progress.datasetId!==dataset)throw Error('账户或词库已变化，已停止导入；游客原记录保留。');};
  // Read the latest server copy without extending its lifetime. Nothing is copied
  // until the user confirms; the user's current account is already backed up by UI.
  const session=await guestClient.request<{guest:Guest|null;csrfToken?:string}>('/api/guest/session');
  assertTarget();
  if(!session.guest)throw Error('游客记录不存在或已过期。');guestClient.setSession(session.guest.id,session.csrfToken!);
  const saved=await guestClient.request<{state:{records:Record<string,string>}|null;version:number}>(path);
  assertTarget();
  if(!saved.state)throw Error('没有可导入的游客记录。');
  const records=saved.state.records;
  const progress=JSON.parse(records[`word-atlas:v2:${dataset}`]||'null');if(!progress)throw Error('当前词库没有游客记录。');
  const extras:Record<string,unknown>={...exportExtras()};
  for(const [key,value]of Object.entries(records)){
    if(key.startsWith('word-atlas:extras:v1:')&&key!==`word-atlas:extras:v1:${dataset}`)continue;
    if(!/^word-atlas:(reader|reader-position|extras:v1|illustration|appearance)/.test(key))continue;
    try{extras[key]=JSON.parse(value);}catch{extras[key]=value;}
  }
  assertTarget();
  const result=importBackup(JSON.stringify({app:'word-atlas',version:2,progress:{...progress,session:null},settings:JSON.parse(records['word-atlas:settings']||'{}'),extras}));
  if(!result.ok)throw Error(result.error);await flush();assertTarget();if(store.get().saveError)throw Error('账户本机保存失败，游客原记录保留。');
  const remaining={...records};delete remaining[`word-atlas:v2:${dataset}`];
  if(Object.keys(remaining).some(k=>k.startsWith('word-atlas:v2:')))await guestClient.request(path,'PUT',{version:saved.version,state:{records:remaining}});
  else await clearGuest(saved.version);return result;
}
export const exportGuestBackup=()=>exportBackup();
