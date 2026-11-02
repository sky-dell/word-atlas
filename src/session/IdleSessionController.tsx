import {useEffect} from 'react';
import {accountState,refreshAccount,renewAccountActivity} from '../account/state';
import {guestState,guestLoginActive,guestLoginGeneration,pauseGuestLogin,refreshGuestLogin} from '../guest/state';
import {createActivityMonitor,type IdleLogin} from './activity';

export function IdleSessionController(){
  useEffect(()=>{
    const read=():IdleLogin|null=>{
      const account=accountState.get(),guest=guestLoginActive()?guestState.get().guest:null;
      const value=account.user?account:guest;
      if(!value||!Number.isFinite(value.idleExpiresAt)||!Number.isFinite(value.serverNow)||!Number.isFinite(value.idleReceivedAt))return null;
      return {key:account.user?'account:'+account.user.id+':'+account.csrfToken:'guest:'+guest!.id+':'+guestLoginGeneration(),
        deadline:value.idleReceivedAt!+value.idleExpiresAt!-value.serverNow!};
    };
    const monitor=createActivityMonitor({read,visible:()=>document.visibilityState==='visible',
      renew:async()=>{if(accountState.get().user)await renewAccountActivity();else await refreshGuestLogin(true);},
      revalidate:async()=>{if(accountState.get().user)await refreshAccount();else await refreshGuestLogin();},
      expire:()=>{if(accountState.get().user)void refreshAccount(true);else pauseGuestLogin();},
    });
    const input=(event:Event)=>{if(event.isTrusted&&document.visibilityState==='visible'){monitor.interact();void monitor.check();}};
    let guestCheck=false;
    const check=()=>{
      // Read-only server validation also catches suspended tabs and clock jumps.
      // Unlike explicit entry/activity, this never renews either deadline.
      if(!accountState.get().user&&guestLoginActive()&&!guestCheck){
        guestCheck=true;void refreshGuestLogin().catch(()=>{}).finally(()=>{guestCheck=false;void monitor.check();});
      }else void monitor.check();
    };
    const events=['pointerdown','keydown','wheel','touchstart'] as const;
    for(const event of events)window.addEventListener(event,input,{passive:true,capture:true});
    window.addEventListener('focus',check);window.addEventListener('pageshow',check);document.addEventListener('visibilitychange',check);
    const timer=setInterval(check,15000);
    return ()=>{monitor.dispose();clearInterval(timer);for(const event of events)window.removeEventListener(event,input,true);window.removeEventListener('focus',check);window.removeEventListener('pageshow',check);document.removeEventListener('visibilitychange',check);};
  },[]);
  return null;
}
