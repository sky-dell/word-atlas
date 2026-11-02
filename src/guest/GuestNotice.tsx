import {useEffect,useState} from 'react';
import {useAccount} from '../account/state';
import {clearGuest,exportGuestBackup,retryGuestSave,useGuest} from './state';
import {clearGuestEntry} from '../account/entry';
import {downloadAccountBackup} from '../pages/Account';

export function GuestNotice(){
  const account=useAccount(),guest=useGuest(),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[time,setTime]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setTime(Date.now()),60000);return()=>clearInterval(timer);},[]);
  if(account.user||!guest.guest)return null;
  const expiring=guest.guest.expiresAt-time<3600000;
  return <aside className="guest-notice" aria-label="游客临时身份">
    <div><strong>{guest.guest.name}</strong><span>临时身份 · 不会创建正式账户</span><p role="status">{guest.message}{expiring?' · 即将到期，请导出备份或注册后导入记录。':''}</p></div>
    <div className="account-actions">
      {guest.status==='offline'&&<button className="btn btn-ghost" onClick={()=>void retryGuestSave().catch(e=>setError(e.message))}>重试暂存</button>}
      <button className="btn btn-ghost" onClick={()=>downloadAccountBackup(exportGuestBackup(),'guest')}>导出游客备份</button>
      <button className="btn btn-ghost" onClick={()=>setConfirm(!confirm)}>退出并清除游客数据</button>
    </div>
    {confirm&&<div className="guest-notice__confirm"><p>此操作会清除该临时身份的服务器记录，并退出所有使用该身份的页面。请先导出备份；仅返回登录页无需清除。</p><button className="btn" disabled={busy} onClick={()=>{setBusy(true);void clearGuest().then(()=>{clearGuestEntry();location.reload();}).catch(e=>{setError(e.message);setBusy(false);});}}>确认清除并退出</button><button className="btn btn-ghost" disabled={busy} onClick={()=>setConfirm(false)}>取消</button></div>}
    {error&&<p role="alert">{error}</p>}
  </aside>;
}
