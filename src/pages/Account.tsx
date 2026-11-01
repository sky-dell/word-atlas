import { UsernameAvailability } from '../account/UsernameAvailability';
import { RegistrationWizard } from '../account/RegistrationWizard';
import {importTemporaryGuest} from '../guest/state';
import {temporaryGuestsEnabled} from '../store/profileStorage';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { accountClient, type User } from '../account/client';
import { accountError, applySnapshot, authAction, backupConflict, readSnapshot, refreshAccount, resolveConflict, stashLocal, syncNow, useAccount } from '../account/state';
import type { Backup } from '../account/sync';
import { importGuestProfile } from '../store/store';
import { profileGeneration } from '../store/profile';
import '../styles/account.css';

export function downloadAccountBackup(text: string, label = 'local') {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `words-and-beyond-${label}-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function validPasswords(password: string, confirmation: string) {
  if ([...password].length < 12 || [...password].length > 128) throw new Error('密码须为 12–128 个字符。');
  if (password !== confirmation) throw new Error('两次密码不一致。');
}
export type AccountMode = 'login' | 'register' | 'reset';
export function AccountPanel({ initialMode = 'login', preferEmailRegistration = false, variant }: { initialMode?: AccountMode; preferEmailRegistration?: boolean; variant?: 'entry' } = {}) {
  const a = useAccount();
  return <section className="panel account-panel" aria-label="账户" aria-busy={a.loading}>
    {(a.loading || !a.enabled || a.user) && <div className="account-heading"><h3 className="eyebrow">账户</h3></div>}
    {a.loading ? <p role="status">正在确认账号与本机资料…</p> : !a.enabled ? <>
      <p className="muted">{a.error || '此入口未启用账号服务。请使用 HTTPS 入口访问账户和游客暂存。'}</p>
      {safeSecureOrigin(a.secureOrigin) && <><a className="btn btn-ghost" href={`${safeSecureOrigin(a.secureOrigin)}/#/account`}>前往 HTTPS 账号入口</a><p className="muted">HTTP 与 HTTPS 的浏览器存储相互独立。请先在当前 HTTP 页面的「数据」中导出游客 JSON 备份，再到 HTTPS 页面登录目标账号并导入；记录不会自动迁移。</p></>}
      <button className="btn btn-ghost" onClick={() => void refreshAccount()}>重新检查账号服务</button>
    </> : a.user ? <SignedIn key={a.user.id} user={a.user} /> : <AuthForms key={initialMode} initialMode={initialMode} emailEnabled={a.emailEnabled} preferEmailRegistration={preferEmailRegistration} variant={variant} />}
  </section>;
}
function safeSecureOrigin(value?: string) {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : ''; } catch { return ''; }
}
function AuthForms({ initialMode, emailEnabled, preferEmailRegistration, variant }: { initialMode: AccountMode; emailEnabled: boolean; preferEmailRegistration: boolean; variant?: 'entry' }) {
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [method, setMethod] = useState<'password' | 'email'>(initialMode === 'register' && preferEmailRegistration && emailEnabled ? 'email' : 'password');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [deadlines, setDeadlines] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const codeHintId=useId();
  const purpose = mode === 'register' ? 'register' : 'login';
  const cooldownKey = `${purpose}:${email.trim().toLowerCase()}`;
  const remaining = Math.max(0, Math.ceil(((deadlines[cooldownKey] || 0) - now) / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const changeMode = (next: AccountMode) => { setMode(next); setMethod(next === 'register' && preferEmailRegistration && emailEnabled ? 'email' : 'password'); setError(''); setNotice(''); setShowPassword(false); };
  const changeMethod=(next:'password'|'email')=>{setMethod(next);setError('');setNotice('');};
  const send = async (form: HTMLFormElement) => {
    const input = form.elements.namedItem('email') as HTMLInputElement;
    if (!input.reportValidity() || busy || remaining || !emailEnabled) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await accountClient.request<{ retryAfter: number; expiresIn: number }>('/api/auth/email-code', { method: 'POST', body: { email: email.trim(), purpose } });
      const time = Date.now(); setNow(time);
      setDeadlines(old => ({ ...old, [cooldownKey]: time + Math.max(60, result.retryAfter || 60) * 1000 }));
      setNotice('请求已接受；若邮箱符合条件，我们会尝试发送验证码，5 分钟内有效。未收到请稍后重试，请勿向他人透露。');
    } catch (e) { setError(accountError(e)); }
    finally { setBusy(false); }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget, data = new FormData(form); setError(''); setNotice('');
    const password = String(data.get('password') || '');
    try {
      if (method === 'email' && mode !== 'reset' && !emailEnabled) throw new Error('邮箱服务尚未启用，请使用用户名方式。');
      if (mode !== 'login') validPasswords(password, String(data.get('confirm') || ''));
      setBusy(true);
      const body = mode === 'reset' ? { token: String(data.get('token') || '').trim(), password } : method === 'email' ? { email: email.trim(), code: String(data.get('code') || ''), ...(mode === 'register' ? { password, nickname: String(data.get('nickname') || '').trim() } : {}) } : { [mode === 'login' ? 'identifier' : 'username']: String(data.get('username') || '').trim(), password, ...(mode === 'register' ? { nickname: String(data.get('nickname') || '').trim() } : {}) };
      await authAction(mode === 'login' && method === 'email' ? 'login-code' : mode, body); form.reset(); setEmail('');
      if (mode === 'reset') { setMode('login'); setNotice('密码已重设，请用新密码登录。'); }
    } catch (e) { setError(accountError(e)); }
    finally { setBusy(false); }
  };
  if(mode==='register'&&variant==='entry')return <RegistrationWizard emailEnabled={emailEnabled} preferEmailRegistration={preferEmailRegistration} onLogin={()=>changeMode('login')}/>;
  return <>
    <header className="account-auth-heading"><span className="account-kicker">Words & Beyond</span><h3>{mode === 'login' ? '欢迎回来。' : mode === 'register' ? '开启你的词与远方之旅。' : '重新找回你的账户。'}</h3><p>{mode === 'register' ? '免费创建账户，让学习进度跨设备延续。' : mode === 'reset' ? '使用管理员提供的一次性凭据重设密码。' : '登录账户，继续点亮你的单词星图。'}</p></header>
    {mode === 'login' ? <div className="account-auth-tabs" role="group" aria-label="登录方式"><button type="button" disabled={busy} aria-pressed={method==='password'} className={method==='password'?'is-on':''} onClick={()=>changeMethod('password')}>账户登录</button><button type="button" disabled={busy} aria-pressed={method==='email'} className={method==='email'?'is-on':''} onClick={()=>changeMethod('email')}>验证码登录</button></div> : <button type="button" className="account-back" disabled={busy} onClick={()=>changeMode('login')}><span aria-hidden="true">←</span>返回登录</button>}
    {mode === 'register' && <div className="account-methods" role="group" aria-label="注册方式"><button type="button" disabled={busy} aria-pressed={method==='password'} onClick={()=>changeMethod('password')}>用户名注册</button><button type="button" disabled={busy} aria-pressed={method==='email'} onClick={()=>changeMethod('email')}>邮箱注册</button></div>}
    {!emailEnabled && <p className="muted">邮箱服务尚未启用，仍可使用用户名注册或密码登录。</p>}
    <form key={`${mode}:${method}`} className="account-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        {mode === 'reset' ? <><p className="muted">忘记密码请联系管理员，通过可信渠道领取短期一次性重置凭据。</p><label>一次性重置凭据<input name="token" required autoComplete="off" spellCheck={false} /></label></> : method === 'email' ? <><label><span className={mode==='login'?'account-visually-hidden':undefined}>邮箱</span><input name="email" type="email" required maxLength={254} placeholder="请输入邮箱" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={e => { setEmail(e.target.value); setNotice(''); }} /></label><div className="account-code-field"><label><span className="account-visually-hidden">六位验证码</span><input name="code" required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="请输入6位验证码" title="六位数字，5 分钟内有效" aria-describedby={codeHintId} autoComplete="one-time-code" /></label><button type="button" className="account-code-send" disabled={!emailEnabled || remaining > 0} onClick={e => void send(e.currentTarget.form!)}>{remaining ? `${remaining} 秒后重发` : '获取验证码'}</button></div><small id={codeHintId} className="account-code-hint" hidden>六位数字，5 分钟内有效；重新发送后旧码失效。</small></> : mode === 'register' ? <UsernameAvailability />: <><label><span className={mode==='login'?'account-visually-hidden':undefined}>用户名或邮箱</span><input name="username" required minLength={1} maxLength={254}  placeholder="请输入账号或邮箱" autoComplete="username" autoCapitalize="none" spellCheck={false} /></label></>}
        {mode === 'register' && <label>昵称（可选）<input name="nickname" maxLength={64} autoComplete="nickname" /></label>}
        {!(mode === 'login' && method === 'email') && <label><span className={mode==='login'?'account-visually-hidden':undefined}>密码</span>{variant === 'entry'
          ? <div className="account-password-field">
              <input name="password" aria-label="密码" type={showPassword ? 'text' : 'password'} required placeholder="请输入密码" minLength={mode === 'login' ? 1 : 12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              <button type="button" className="account-password-toggle" aria-pressed={showPassword} aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(v => !v)}>{showPassword ? '隐藏' : '显示'}</button>
            </div>
          : <input name="password" type="password" required placeholder="请输入密码" minLength={mode === 'login' ? 1 : 12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}</label>}
        {mode !== 'login' && <><small>12–128 个字符，支持粘贴与密码管理器。</small><label>确认密码<input name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label></>}
        <button className="account-primary" type="submit" disabled={method === 'email' && mode !== 'reset' && !emailEnabled}>{busy ? '处理中…' : mode === 'register' ? '创建账号' : mode === 'reset' ? '重设密码' : '登录账号'}<ArrowRight size={16} aria-hidden="true" /></button>
      </fieldset>
    </form>
    {mode === 'login' && <div className={variant === 'entry' ? 'account-auth-actions' : 'account-auth-actions account-auth-actions--stack'}>
      <button type="button" className="account-forgot" aria-label="忘记密码？使用管理员重置凭据" disabled={busy} onClick={() => changeMode('reset')}>忘记密码？</button>
      <span className="account-auth-sep" aria-hidden="true">·</span>
      <p className="account-register-entry">还没有账户？<button type="button" className="account-text-link" disabled={busy} onClick={()=>changeMode('register')}>注册</button></p>
    </div>}
    {error && <p className="warn-text account-auth-feedback" role="alert">{error}</p>}{notice && <p className="account-auth-feedback" role="status">{notice}</p>}
    <p className="account-auth-note"><ShieldCheck size={13} aria-hidden="true" /><span>账户完全免费，支持同步与备份。<br />游客暂存资料仅在你确认导入后复制到账户。</span></p>
  </>;
}
export function SignedIn({ user, view = 'all' }: { user: User; view?: 'all' | 'profile' | 'data' | 'password' }) {
  const a = useAccount(); const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [guestConfirm, setGuestConfirm] = useState(false);
  const act = async (fn: () => Promise<unknown>, success = '') => { setBusy(true); setMessage(''); try { await fn(); setMessage(success); } catch (e) { setMessage(accountError(e)); } finally { setBusy(false); } };
  const password = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget, data = new FormData(form);
    void act(async () => { const password = String(data.get('password') || ''); validPasswords(password, String(data.get('confirm') || '')); await authAction('password', { currentPassword: String(data.get('currentPassword') || ''), password }); form.reset(); });
  };
  const statuses = { idle: '本机学习', pending: '本机更改待同步', syncing: '正在同步…', synced: '已同步', offline: '离线或云端不可用 · 本机更改待同步', conflict: '本机与云端版本冲突', unavailable: '云同步权限不可用' };
  return <div className="account-stack">
    {(view === 'all' || view === 'profile') && <><h3 className="account-section-title">账户注册信息</h3><dl className="account-profile-fields"><div><dt>用户名</dt><dd>{user.username}</dd></div><div><dt>昵称</dt><dd>{user.nickname || '未设置'}</dd></div><div><dt>注册邮箱</dt><dd>{user.email || '未绑定邮箱'}</dd></div><div><dt>邮箱状态</dt><dd>{user.email && user.emailVerified ? '已验证' : '未验证'}</dd></div><div><dt>注册时间</dt><dd>{typeof user.createdAt === 'number' && user.createdAt > 0 && Number.isFinite(new Date(user.createdAt).getTime()) ? new Date(user.createdAt).toLocaleDateString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'}) : '暂不可用'}</dd></div><div><dt>登录方式</dt><dd>{user.email && user.emailVerified ? '用户名或邮箱＋密码、邮箱验证码' : '用户名＋密码'}</dd></div></dl><p className="muted">账户完全免费。支持学习快照同步与每个词库最多 3 份云端历史备份；未完成的答题会话仅保存在本机。</p>
    <div className="account-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => void act(() => authAction('logout'))}>退出账号</button><button className="btn btn-ghost" disabled={busy} onClick={() => void act(() => refreshAccount())}>刷新账户状态</button>{user.role === 'admin' && <a className="btn btn-ghost" href="#/admin">管理账号</a>}</div></>}
    {(view === 'all' || view === 'data') && <><div className="account-sync"><p role="status">{statuses[a.sync.status]}{a.sync.version !== undefined && ` · v${a.sync.version}`}</p>{a.sync.message && <p className="muted">{a.sync.message}</p>}
      {a.sync.status === 'conflict' ? <><p>请先备份本机记录，再明确选择保留哪个版本。不会自动合并统计。</p><div className="account-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => { try { downloadAccountBackup(backupConflict(), 'before-conflict'); } catch (e) { setMessage(accountError(e)); } }}>备份本机记录</button><button className="btn" disabled={busy || !a.sync.backedUp} onClick={() => void act(() => resolveConflict('local'))}>采用本机版本</button><button className="btn btn-ghost" disabled={busy || !a.sync.backedUp} onClick={() => void act(() => resolveConflict('cloud'))}>采用云端版本</button></div></> : <button className="btn btn-ghost" disabled={busy || a.sync.status === 'syncing'} onClick={() => void act(syncNow)}>立即检查同步</button>}
    </div>
    <div><button className="btn btn-ghost" disabled={busy} onClick={() => setGuestConfirm(!guestConfirm)}>导入游客暂存记录</button>{guestConfirm && <div className="account-confirm"><p>将当前词库的游客记录复制到本账号，替换本账号的本机快照。仅在复制成功后清除已导入的游客记录，其他词库保留至到期。请先下载本账号备份。</p><button className="btn" disabled={busy} onClick={() => void act(async () => { const text = JSON.stringify(readSnapshot()); stashLocal(text); downloadAccountBackup(text, 'before-guest-import'); const result = await (temporaryGuestsEnabled() ? importTemporaryGuest() : importGuestProfile()); if (!result.ok) throw new Error(result.error); setGuestConfirm(false); }, '已复制当前词库的游客记录。')}>备份本账号并确认导入游客记录</button></div>}</div>
    <CloudBackups active={a.enabled && !user.disabled && !a.loading} /></>}
    {(view === 'all' || view === 'password') && <details open={view === 'password' ? true : undefined}><summary>修改密码</summary><form className="account-form" onSubmit={password}><fieldset disabled={busy}><label>当前密码<input type="password" name="currentPassword" required autoComplete="current-password" /></label><label>新密码<input type="password" name="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label><label>确认新密码<input type="password" name="confirm" required minLength={12} maxLength={128} autoComplete="new-password" /></label><p className="muted">修改后全部设备会话将退出，请重新登录。</p><button className="btn" type="submit">修改密码</button></fieldset></form></details>}
    {message && <p role="status">{message}</p>}
  </div>;
}
interface BackupInfo { id: string; createdAt: number | string; version: number }
function CloudBackups({ active }: { active: boolean }) {
  const [items, setItems] = useState<BackupInfo[] | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [restore, setRestore] = useState<{ snapshot: Backup; version: number } | null>(null), [backed, setBacked] = useState('');
  const act = async (fn: () => Promise<void>) => { const epoch = profileGeneration(); setBusy(true); setMessage(''); try { await fn(); } catch (e) { if (epoch === profileGeneration()) setMessage(accountError(e)); } finally { if (epoch === profileGeneration()) setBusy(false); } };
  const list = async () => { const r = await accountClient.request<{ backups: BackupInfo[] }>(`/api/account/backups?dataset=${encodeURIComponent(readSnapshot().progress.datasetId)}`); setItems(r.backups); };
  const fetchBackup = (id: string) => accountClient.request<{ snapshot: Backup; version: number }>(`/api/account/backups/${encodeURIComponent(id)}`);
  return <div className="account-backups"><h4>云端备份</h4><p className="muted">同主机保存，每个词库最多保留 3 份，建议定期下载到自己的设备。</p><div className="account-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => void act(list)}>查看已有备份</button><button className="btn btn-ghost" disabled={busy || !active} onClick={() => void act(async () => { const snapshot = readSnapshot(); await accountClient.request(`/api/account/backups?dataset=${encodeURIComponent(snapshot.progress.datasetId)}`, { method: 'POST', body: { snapshot } }); await list(); setMessage('云端备份已保存。'); })}>创建云端备份</button></div>
    {items && (items.length ? <ul className="account-backup-list">{items.map(item => <li key={item.id}><span>{new Date(item.createdAt).toLocaleString()} · v{item.version}</span><div className="account-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => { const r = await fetchBackup(item.id); downloadAccountBackup(JSON.stringify(r.snapshot), 'cloud'); })}>下载</button><button className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => { const r = await fetchBackup(item.id); if (r.snapshot.progress.datasetId !== readSnapshot().progress.datasetId) throw new Error('备份词库不匹配。'); setRestore(r); setBacked(''); })}>选择恢复</button></div></li>)}</ul> : <p>这个词库还没有云端备份。</p>)}
    {restore && <div className="account-confirm"><p>恢复 v{restore.version} 将替换当前词库的本机学习快照。先备份本机记录，然后确认恢复。</p><div className="account-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => { try { const text = JSON.stringify(readSnapshot()); stashLocal(text); downloadAccountBackup(text, 'before-restore'); setBacked(text); } catch (e) { setMessage(accountError(e)); } }}>下载恢复前本机备份</button><button className="btn" disabled={busy || !backed} onClick={() => void act(async () => { if (backed !== JSON.stringify(readSnapshot())) { setBacked(''); throw new Error('本机记录已变化，请重新备份。'); } applySnapshot(restore.snapshot); setRestore(null); setBacked(''); setMessage('已恢复到本机；如云端版本不同，需明确解决同步冲突。'); })}>确认恢复到本机</button><button className="btn btn-ghost" onClick={() => setRestore(null)}>取消</button></div></div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
