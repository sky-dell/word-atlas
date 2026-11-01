import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,Check,CheckCircle2,Eye,EyeOff} from 'lucide-react';
import {AccountError,accountClient} from './client';
import {accountError,authAction} from './state';
import {UsernameAvailability} from './UsernameAvailability';

type Proof={email:string;registrationToken:string;expiresAt:number};
export function RegistrationWizard({emailEnabled,preferEmailRegistration,onLogin}:{emailEnabled:boolean;preferEmailRegistration:boolean;onLogin:()=>void}){
  const [method,setMethod]=useState<'email'|'username'>(emailEnabled&&preferEmailRegistration?'email':'username');
  const [step,setStep]=useState(1),[email,setEmail]=useState(''),[username,setUsername]=useState(''),[code,setCode]=useState('');
  const [proof,setProof]=useState<Proof|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[shown,setShown]=useState(false),[confirmShown,setConfirmShown]=useState(false);
  const [deadlines,setDeadlines]=useState<Record<string,number>>({}),[now,setNow]=useState(Date.now());
  const heading=useRef<HTMLHeadingElement>(null),hint=useId();
  const normalized=email.trim().toLowerCase(),remaining=Math.max(0,Math.ceil(((deadlines[normalized]||0)-now)/1000));
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[step]);
  const resetPasswords=()=>{setPassword('');setConfirm('');setShown(false);setConfirmShown(false);};
  const back=()=>{setStep(1);resetPasswords();setError('');setNotice('');};
  const changeMethod=(next:'email'|'username')=>{if(next===method)return;setMethod(next);setProof(null);setCode('');resetPasswords();setError('');setNotice('');};
  const send=async(form:HTMLFormElement)=>{
    const input=form.elements.namedItem('email') as HTMLInputElement;
    if(!input.reportValidity()||busy||remaining||!emailEnabled)return;
    setBusy(true);setError('');setNotice('');setProof(null);
    try{
      const result=await accountClient.request<{retryAfter:number}>('/api/auth/email-code',{method:'POST',body:{email:normalized,purpose:'register'}});
      const time=Date.now();setNow(time);setDeadlines(old=>({...old,[normalized]:time+Math.max(60,result.retryAfter||60)*1000}));
      setNotice('若邮箱符合条件，验证码将发送至该邮箱，5分钟内有效。');
    }catch(e){setError(accountError(e));}finally{setBusy(false);}
  };
  const next=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
    try{
      if(method==='email'){
        if(!proof||proof.email!==normalized||proof.expiresAt<=Date.now()){
          const verified=await accountClient.request<Proof>('/api/auth/register-verify',{method:'POST',body:{email:normalized,code}});
          setProof(verified);
        }
      }else{
        // Availability is advisory, not a reservation. Its own rate limit or
        // outage must not disable registration; the final INSERT is unique.
        let available:boolean|undefined;
        try{const result=await accountClient.request<{available:boolean}>('/api/auth/username-availability',{method:'POST',body:{username:username.trim()}});available=result.available;}
        catch{setNotice('暂时无法预检查，完成注册时会再次校验用户名。');}
        if(available===false)throw new Error('用户名已存在，请选择推荐名称或修改用户名。');
      }
      setStep(2);
    }catch(e){setError(accountError(e));}finally{setBusy(false);}
  };
  const submit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();if(busy)return;setError('');setNotice('');
    if([...password].length<12||[...password].length>128){setError('密码须为12–128个字符。');return;}
    if(password!==confirm){setError('两次密码不一致，请重新输入。');return;}
    if(method==='email'&&(!proof||proof.expiresAt<=Date.now())){back();setProof(null);setCode('');setError('验证已过期，请重新获取验证码。');return;}
    setBusy(true);
    try{await authAction('register',method==='email'?{email:normalized,registrationToken:proof!.registrationToken,password}:{username:username.trim(),password});}
    catch(e){
      if(e instanceof AccountError&&['invalid_code','username_taken'].includes(String(e.data.code))){back();setProof(null);setCode('');}
      setError(accountError(e));
    }finally{setBusy(false);}
  };
  return <div className="registration-wizard">
    <header className="account-auth-heading"><span className="account-kicker">Words &amp; Beyond</span><h3 ref={heading} tabIndex={-1}>{step===1?'开启你的词与远方之旅。':'最后一步，开启远方。'}</h3><p>{step===1?'免费创建账户，让学习进度跨设备延续。':'设置密码，保存你的学习进度。'}</p></header>
    <ol className="registration-steps" aria-label={`注册进度，第${step}步，共2步`}>
      <li className={step===2?'is-complete':'is-current'} aria-current={step===1?'step':undefined}><span>{step===2?<Check size={16} aria-hidden="true"/>:'1'}</span>验证身份</li>
      <li className={step===2?'is-current':''} aria-current={step===2?'step':undefined}><span>2</span>设置密码</li>
    </ol>
    {step===1?<>
      <div className="account-methods" role="group" aria-label="注册方式"><button type="button" disabled={busy} aria-pressed={method==='username'} onClick={()=>changeMethod('username')}>用户名注册</button><button type="button" disabled={busy||!emailEnabled} aria-pressed={method==='email'} onClick={()=>changeMethod('email')}>邮箱注册</button></div>
      <form className="account-form" onSubmit={next}><fieldset disabled={busy}>
        {method==='email'?<><label>邮箱<input name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="请输入邮箱" value={email} onChange={e=>{setEmail(e.target.value);setProof(null);setCode('');setError('');setNotice('');}}/></label><div className="account-code-field"><label><span className="account-visually-hidden">六位验证码</span><input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" placeholder="请输入6位验证码" title="六位数字，5分钟内有效" aria-describedby={hint} value={code} onChange={e=>setCode(e.target.value)}/></label><button className="account-code-send" type="button" disabled={remaining>0} onClick={e=>void send(e.currentTarget.form!)}>{remaining?`${remaining}秒后重发`:'获取验证码'}</button></div><span id={hint} className="account-visually-hidden">验证码5分钟内有效；重新发送后旧码失效。</span></>:<UsernameAvailability value={username} onChange={v=>{setUsername(v);setError('');}} compact/>}
        <button className="account-primary" type="submit">{busy?'正在验证…':'下一步'}<ArrowRight size={16} aria-hidden="true"/></button>
      </fieldset></form>
    </>:<>
      <div className="registration-identity"><CheckCircle2 size={17} aria-hidden="true"/><span title={method==='email'?normalized:username}><b>{method==='email'?'邮箱已验证':'用户名已确认'}</b><span>{method==='email'?normalized:username}</span></span><button type="button" disabled={busy} onClick={back}>修改</button></div>
      <form className="account-form" onSubmit={submit}><fieldset disabled={busy}>
        <label><span>设置密码，至少12位</span><div className="account-password-field"><input aria-label="密码" name="password" type={shown?'text':'password'} minLength={12} maxLength={128} required placeholder="请输入12–128个字符" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/><button className="account-password-toggle" type="button" aria-label={shown?'隐藏密码':'显示密码'} aria-pressed={shown} onClick={()=>setShown(v=>!v)}>{shown?'隐藏':'显示'}</button></div></label>
        <label><span>再次输入密码</span><div className="account-password-field"><input aria-label="确认密码" name="confirm" type={confirmShown?'text':'password'} minLength={12} maxLength={128} required placeholder="请再次输入密码" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/><button className="account-password-toggle" type="button" aria-label={confirmShown?'隐藏确认密码':'显示确认密码'} aria-pressed={confirmShown} onClick={()=>setConfirmShown(v=>!v)}>{confirmShown?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
        <button className="account-primary" type="submit">{busy?'正在创建…':'完成注册'}<ArrowRight size={16} aria-hidden="true"/></button>
      </fieldset></form>
    </>}
    <div className="registration-feedback" aria-live="polite">{error?<p className="warn-text" role="alert">{error}</p>:notice?<p role="status">{notice}</p>:null}</div>
    {step===2&&<button type="button" className="registration-back" disabled={busy} onClick={back}><ArrowLeft size={14} aria-hidden="true"/>返回验证</button>}
    <div className="registration-footer">已有账户？<button type="button" className="account-text-link" disabled={busy} onClick={onLogin}>登录</button></div>
  </div>;
}
