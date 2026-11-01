import {useEffect,useId,useRef,useState} from 'react';
import {accountClient} from './client';

export function UsernameAvailability({value,onChange,compact=false}:{value?:string;onChange?:(value:string)=>void;compact?:boolean}={}){
  const [localName,setLocalName]=useState(''),[result,setResult]=useState<{name:string;available?:boolean;suggestions:string[];error?:boolean}|null>(null);
  const name=value??localName;
  const setName=(next:string)=>{setLocalName(next);onChange?.(next);};
  const ref=useRef<HTMLInputElement>(null),id=useId();
  useEffect(()=>{
    const abort=new AbortController();setResult(null);ref.current?.setCustomValidity('');
    if(!/^[a-zA-Z0-9_]{3,32}$/.test(name))return ()=>abort.abort();
    const timer=setTimeout(()=>{
      void accountClient.request<{available:boolean;suggestions:string[]}>('/api/auth/username-availability',{method:'POST',body:{username:name},signal:abort.signal}).then(r=>{
        if(abort.signal.aborted)return;
        if(typeof r.available!=='boolean'||!Array.isArray(r.suggestions))throw Error('invalid response');
        setResult({name,available:r.available,suggestions:r.suggestions.filter(n=>typeof n==='string'&&/^[a-zA-Z0-9_]{3,32}$/.test(n)).slice(0,3)});
        ref.current?.setCustomValidity(r.available?'':'用户名已存在，请选择其他用户名');
      }).catch(()=>{if(!abort.signal.aborted)setResult({name,error:true,suggestions:[]});});
    },350);
    return ()=>{clearTimeout(timer);abort.abort();};
  },[name]);
  const current=result?.name===name?result:null;
  return <div className="username-availability"><label>用户名<input ref={ref} name="username" value={name} onChange={e=>{ref.current?.setCustomValidity('');setResult(null);setName(e.target.value);}} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" placeholder="请输入用户名" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby={id} aria-invalid={current?.available===false?true:undefined}/></label>
    <div id={id} role="status" aria-live="polite"><small>{current?.error?'暂时无法检查，提交注册时会再次校验。':current?.available===false?'用户名已存在':current?.available===true?'该用户名可以使用':'3–32 位英文字母、数字或下划线，不区分大小写。'}</small>
    {current?.available===false&&<div className="account-actions" aria-label="推荐用户名">{current.suggestions.slice(0,compact?1:3).map(n=><button type="button" className="account-text-link" key={n} onClick={()=>{ref.current?.setCustomValidity('');setName(n);ref.current?.focus();}}>{n}</button>)}</div>}</div>
  </div>;
}
