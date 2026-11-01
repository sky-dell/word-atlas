import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Cloud, KeyRound, LogOut, Settings2, ShieldCheck, UserRound } from 'lucide-react';
import { authAction, accountError, useAccount } from '../account/state';
import { SignedIn } from '../pages/Account';
import { go } from '../lib/router';
import '../styles/account.css';

type View = 'menu' | 'profile' | 'data' | 'password';
export function AccountMenu({ open, onToggle, onClose, onEnter }: { open: boolean; onToggle: () => void; onClose: () => void; onEnter: () => void }) {
  const account = useAccount();
  const [view, setView] = useState<View>('menu');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const identity = account.user?.id ?? null;
  useEffect(() => { setView('menu'); setError(''); setBusy(false); }, [identity]);
  useEffect(() => {
    if (!open || !identity) { setView('menu'); setError(''); return; }
    panel.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) closeRef.current(); };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); document.removeEventListener('keydown', key); };
  }, [open, identity]);
  useEffect(() => { if (open) panel.current?.focus({ preventScroll: true }); }, [view, identity, open]);
  const logout = async () => {
    setBusy(true); setError('');
    try { await authAction('logout'); } catch (e) { setError(accountError(e)); } finally { setBusy(false); }
  };
  const user=account.user;
  if(!user) return <button type="button" className="account-entry-link" aria-label="返回入口" title="返回入口" disabled={account.loading} onClick={onEnter}><ArrowLeft size={17} aria-hidden="true" /><span>返回入口</span></button>;
  const name=user.nickname || user.email || user.username;
  return <div className="account-menu" ref={root}>
    <button ref={trigger} type="button" className="icon-btn" aria-label="账户菜单" title="账户" aria-expanded={open} aria-controls={id} onClick={onToggle}><span className="account-trigger-initial" aria-hidden="true">{[...name][0]?.toLocaleUpperCase()}</span></button>
    {open && <div id={id} ref={panel} className={`account-dropdown ${view === 'menu' ? 'account-dropdown--menu' : 'account-dropdown--detail'}`} role="region" aria-label="账户菜单内容" tabIndex={-1}>
      {view !== 'menu' && <button className="account-back" type="button" aria-label="返回账户菜单" onClick={() => setView('menu')}><ArrowLeft size={15} aria-hidden="true" />账户菜单</button>}
      {view === 'menu' ? <>
        <div className="account-menu-header">
          <span className="account-avatar account-avatar--initial" aria-hidden="true">{[...name][0]?.toLocaleUpperCase()}</span>
          <div><span className="account-kicker">Words & Beyond</span><h3>{name}</h3><p>{user.email || `@${user.username}`}</p></div>
        </div>
        <nav className="account-menu-items account-menu-items--signed" aria-label="账户操作">
          <button className="account-menu-row" onClick={() => {go({page:'me'});onClose();}}><UserRound size={17} aria-hidden="true" /><span>个人中心</span><ArrowRight size={14} aria-hidden="true" /></button>
          <button className="account-menu-row" onClick={() => setView('profile')}><UserRound size={17} aria-hidden="true" /><span>账户注册信息</span><ArrowRight size={14} aria-hidden="true" /></button>
          <button className="account-menu-row" onClick={() => setView('data')}><Cloud size={17} aria-hidden="true" /><span>数据同步与备份</span><ArrowRight size={14} aria-hidden="true" /></button>
          <button className="account-menu-row" onClick={() => setView('password')}><KeyRound size={17} aria-hidden="true" /><span>账号安全</span><ArrowRight size={14} aria-hidden="true" /></button>
          {user.role === 'admin' && <a className="account-menu-row" href="#/admin" onClick={onClose}><Settings2 size={17} aria-hidden="true" /><span>管理账号</span><ArrowRight size={14} aria-hidden="true" /></a>}
          <button className="account-menu-row account-menu-row--logout" disabled={busy} onClick={() => void logout()}><LogOut size={17} aria-hidden="true" /><span>退出登录</span></button>
        </nav>
        <div className="account-menu-footnote"><ShieldCheck size={13} aria-hidden="true" /><span>免费账户 · 数据按账户独立保存</span></div>
      </> : <SignedIn key={`${identity}:${view}`} user={user} view={view} />}
      {error && <p role="alert" className="warn-text">{error}</p>}
    </div>}
  </div>;
}
