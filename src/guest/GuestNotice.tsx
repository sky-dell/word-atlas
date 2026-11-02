import {useState} from 'react';
import {useAccount} from '../account/state';
import {exportGuestBackup,retryGuestSave,useGuest} from './state';
import {downloadAccountBackup} from '../pages/Account';

export function GuestNotice(){
  const account=useAccount(),guest=useGuest(),[error,setError]=useState('');
  if(account.user||!guest.guest)return null;
  return <aside className="guest-notice" aria-label="游客模式">
    <div><strong>{guest.guest.name}</strong><span>游客模式</span><p role="status">{guest.status==='saved'?'已暂存':guest.message}</p></div>
    {guest.status==='offline'&&<div className="account-actions">
      <button className="btn btn-ghost" onClick={()=>void retryGuestSave().catch(e=>setError(e.message))}>重试暂存</button>
    </div>}
    {error&&<p role="alert">{error}</p>}
  </aside>;
}

// Save failures must stay visible even when the account menu is closed.
export function GuestAlerts({onOpen}:{onOpen?:()=>void}){
  const account=useAccount(),guest=useGuest();
  if(account.user||!guest.guest||!['offline','expired','conflict'].includes(guest.status))return null;
  return <aside className="guest-alert" role="alert"><span>{guest.message}</span>{onOpen?<button className="btn btn-ghost" onClick={onOpen}>处理暂存问题</button>:<button className="btn btn-ghost" onClick={()=>downloadAccountBackup(exportGuestBackup(),'guest')}>导出游客备份</button>}</aside>;
}
