import {useSyncExternalStore} from 'react';
import {guestClient,GuestError,type Guest} from './client';
import {guestRecords,replaceGuestRecords,subscribeGuestRecords,temporaryGuestsEnabled} from '../store/profileStorage';
import {flush,store,switchProfile,exportBackup,importBackup,exportExtras} from '../store/store';
import {getProfile,notifyExtras,profileGeneration,profileTransitioning} from '../store/profile';
import {clearGuestEntry} from '../account/entry';

interface State {guest:Guest|null;status:'idle'|'saving'|'saved'|'pending'|'offline'|'expired'|'conflict';message:string;loading:boolean;recoveryAvailable?:boolean}
let state:State={guest:null,status:'idle',message:'',loading:false},active=false,version=0,revision=0,epoch=0;
let timer:ReturnType<typeof setTimeout>|undefined,inflight:Promise<void>|null=null;
let paused:{id:string;version:number;records:Record<string,string>;backup:string;conflict:boolean}|null=null;
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
  window.addEventListener('beforeunload',e=>{if(paused||(active&&['pending','saving','offline','conflict'].includes(state.status))){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flushGuest().catch(()=>{});});
}
export async function beginGuest(restoreOnly=false){
  if(state.loading)throw Error('正在准备游客身份，请稍候。');
  if(active)await flushGuest();
  emit({loading:true,message:''});const current=++epoch;active=false;
  try{
    await flush();guestClient.setSession('','');
    let session=await guestClient.request<{guest:Guest|null;csrfToken?:string;loginRequired?:boolean}>('/api/guest/session');
    if(restoreOnly&&session.loginRequired)throw new GuestError('游客登录已闲置240分钟，请点击游客入口重新进入，暂存记录仍保留。','guest_idle',401);
    if(restoreOnly&&!session.guest)throw new GuestError('游客暂存已过期，请重新选择游客进入或登录正式账户。','guest_expired',401);
    if(paused&&session.guest?.id!==paused.id)throw new GuestError('原游客身份已过期，未暂存记录仍保留在本页。请先导出这些记录，再刷新页面重新进入。','guest_recovery_required',409);
    if(session.guest)guestClient.setSession(session.guest.id,session.csrfToken!);
    if(!restoreOnly)session=await guestClient.request<{guest:Guest;csrfToken:string}>('/api/guest/session','POST',{});
    guestClient.setSession(session.guest!.id,session.csrfToken!);
    const saved=await guestClient.request<{state:{records:Record<string,string>}|null;version:number}>(path);
    if(epoch!==current)return;
    const recovery=paused?.id===session.guest!.id?paused:null;
    const conflict=!!recovery&&(recovery.conflict||recovery.version!==saved.version);
    const records={...(recovery?.records??saved.state?.records)};
    // Each guest entry starts in daylight without removing learning records.
    const appearanceKey='word-atlas:appearance';
    if(records[appearanceKey]){
      let appearance:Record<string,unknown>={};
      try{const value=JSON.parse(records[appearanceKey]);if(value&&typeof value==='object'&&!Array.isArray(value))appearance=value;}catch{/* Use safe defaults for malformed preferences. */}
      records[appearanceKey]=JSON.stringify({...appearance,theme:'light'});
    }
    replaceGuestRecords(records);version=saved.version;revision=0;
    await switchProfile(null);if(epoch!==current)return;
    lastStore=JSON.stringify({progress:store.get().progress,settings:store.get().settings});
    active=true;emit({guest:{...session.guest!,idleReceivedAt:Date.now()},status:conflict?'conflict':'saved',loading:false,recoveryAvailable:!!recovery,message:conflict?'已恢复本页未暂存资料，但服务器版本已变化；请先导出备份，再刷新加载服务器版本，避免覆盖。':'已暂存 · 闲置24小时失效，最长保留7天'});
    if(recovery){recovery.conflict=conflict;if(!conflict)pending();}
    notifyExtras();
  }catch(e){if(current===epoch)emit({loading:false,status:'offline',message:e instanceof Error?e.message:'游客服务不可用'});throw e;}
}
export function suspendGuest(){active=false;clearTimeout(timer);}
export const guestLoginActive=()=>active;
export const guestLoginGeneration=()=>epoch;
export function pauseGuestLogin(){
  if(active&&state.guest&&getProfile()===null&&['pending','saving','offline','expired','conflict'].includes(state.status)){
    const current=store.get();
    paused={id:state.guest.id,version,records:{...guestRecords(),[`word-atlas:v2:${current.progress.datasetId}`]:JSON.stringify(current.progress),'word-atlas:settings':JSON.stringify(current.settings)},backup:exportBackup(),conflict:state.status==='conflict'||!!paused?.conflict};
  }
  suspendGuest();clearGuestEntry();
  epoch++;guestClient.setSession('','');
  emit({guest:null,status:'idle',loading:false,recoveryAvailable:!!paused,message:'游客登录已超时，请重新进入；暂存记录仍保留。'});
  window.dispatchEvent(new Event('word-atlas:guest-login-expired'));
}
export async function refreshGuestLogin(renew=false){
  if(!active||!state.guest)return;
  const id=state.guest.id,current=epoch;
  const response=await guestClient.request<{guest:Guest|null;loginRequired?:boolean}>(renew?'/api/guest/activity':'/api/guest/session',renew?'POST':'GET',renew?{}:undefined);
  if(current!==epoch||!active||state.guest?.id!==id)return;
  if(!response.guest||response.loginRequired){pauseGuestLogin();return;}
  if(response.guest.id!==id){pauseGuestLogin();return;}
  emit({guest:{...response.guest,idleReceivedAt:Date.now()}});
}
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
    if(rev===revision&&paused?.id===r.guest.id)paused=null;
    emit({guest:{...r.guest,idleReceivedAt:Date.now()},recoveryAvailable:!!paused,status:rev===revision?'saved':'pending',message:rev===revision?'已暂存 · 闲置24小时失效，最长保留7天':'变更待暂存'});
    if(rev!==revision){clearTimeout(timer);timer=setTimeout(()=>void flushGuest().catch(()=>{}),700);}
  }catch(e){if(current===epoch)emit({status:e instanceof GuestError&&e.status===401?'expired':e instanceof GuestError&&e.code==='guest_conflict'?'conflict':'offline',message:e instanceof Error?e.message:'暂存失败；刷新会丢失尚未保存的变更。'});throw e;}};
  inflight=work();try{await inflight;}finally{inflight=null;}
}
export async function retryGuestSave(){if(state.status==='expired'||state.status==='conflict')throw Error(state.message);emit({status:'pending'});await flushGuest();}
export async function clearGuest(expectedVersion?:number){
  clearTimeout(timer);await inflight?.catch(()=>{});
  try{await guestClient.request('/api/guest/session'+(expectedVersion===undefined?'':`?version=${expectedVersion}`),'DELETE');}catch(e){if(!(e instanceof GuestError&&e.status===401))throw e;}
  epoch++;active=false;paused=null;guestClient.setSession('','');replaceGuestRecords({});
  if(getProfile()===null)await switchProfile(null);emit({guest:null,status:'idle',message:'',loading:false,recoveryAvailable:false});
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
export function exportPausedGuestBackup(){if(!paused)throw Error('没有待恢复的游客记录。');return paused.backup;}
