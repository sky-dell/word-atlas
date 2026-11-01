import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountClient, type User } from '../account/client';
import { accountError, refreshAccount, useAccount } from '../account/state';
import { profileGeneration } from '../store/profile';
import '../styles/account.css';
interface Audit { id: number | string; actorId: string; targetId: string; action: string; before: unknown; after: unknown; createdAt: number | string }
interface Action { user: User; endpoint: 'status' | 'reset'; body: unknown; label: string }
export function AdminPage() {
  const account = useAccount();
  if (!account.bootstrapped || account.loading) return <div className="page"><p role="status">正在验证管理员身份…</p></div>;
  if (!account.enabled || account.user?.role !== 'admin') return <div className="page"><section className="panel"><h1>账号管理</h1><p>请先登录管理员账号。管理权限由服务器验证。</p><a className="btn btn-ghost" href="#/me">前往账号入口</a></section></div>;
  return <AdminTools key={account.user.id} />;
}
function AdminTools() {
  const [users, setUsers] = useState<User[]>([]), [audit, setAudit] = useState<Audit[]>([]), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [action, setAction] = useState<Action | null>(null), [reset, setReset] = useState<{ username: string; token: string; expiresAt: number | string } | null>(null);
  const sequence = useRef(0);
  const load = async (q = query) => {
    const ticket = ++sequence.current, epoch = profileGeneration(); setLoading(true);
    try {
      const [u, a] = await Promise.all([accountClient.request<{ users: User[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`), accountClient.request<{ audit: Audit[] }>('/api/admin/audit')]);
      if (ticket !== sequence.current || epoch !== profileGeneration()) return;
      setUsers(u.users); setAudit(a.audit);
    } catch (e) { if (ticket === sequence.current && epoch === profileGeneration()) setMessage(accountError(e)); }
    finally { if (ticket === sequence.current && epoch === profileGeneration()) setLoading(false); }
  };
  useEffect(() => { void load(''); return () => { sequence.current++; }; }, []);
  const choose = (next: Action) => { setAction(next); setReset(null); setMessage(''); };
  const execute = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if (!action) return;
    const form = e.currentTarget; const password = String(new FormData(form).get('password') || ''); form.reset();
    const epoch = profileGeneration(); setBusy(true); setMessage('');
    try {
      await accountClient.request('/api/auth/reauth', { method: 'POST', body: { password } });
      if (epoch !== profileGeneration()) return;
      const result = await accountClient.request<{ token?: string; expiresAt?: number | string }>(`/api/admin/users/${encodeURIComponent(action.user.id)}/${action.endpoint}`, { method: 'POST', body: action.body });
      if (epoch !== profileGeneration()) return;
      if (action.endpoint === 'reset' && result.token && result.expiresAt) setReset({ username: action.user.username, token: result.token, expiresAt: result.expiresAt });
      setAction(null); setMessage('操作已完成。'); await load(); await refreshAccount();
    } catch (e) { if (epoch === profileGeneration()) setMessage(accountError(e)); }
    finally { if (epoch === profileGeneration()) setBusy(false); }
  };
  return <div className="page account-admin"><header className="page-head"><p className="eyebrow">管理员</p><h1 className="display">账号管理</h1><p className="muted">账户服务完全免费。此页面不能授予管理员角色；每次敏感操作先重新验证管理员密码。</p></header>
    <section className="panel"><form className="account-search" onSubmit={e => { e.preventDefault(); void load(); }}><input aria-label="搜索用户名或昵称" value={query} onChange={e => setQuery(e.target.value)} maxLength={64} placeholder="搜索用户名或昵称" /><button className="btn" disabled={busy} type="submit">搜索 / 刷新</button></form>
      {message && <p role="status">{message}</p>}
      {action && <div className="account-confirm"><h3>确认：{action.label}</h3><p>目标：{action.user.username}</p><form className="account-form" onSubmit={execute}><fieldset disabled={busy}><label>管理员密码<input key={`${action.user.id}:${action.label}`} name="password" type="password" required autoComplete="current-password" autoFocus /></label><div className="account-actions"><button className="btn" type="submit">{busy ? '处理中…' : '重新验证并执行'}</button><button className="btn btn-ghost" type="button" onClick={() => setAction(null)}>取消操作</button></div></fieldset></form></div>}
      {reset && <div className="account-confirm account-token"><h3>{reset.username} 的一次性重置凭据</h3><p>到期：{new Date(reset.expiresAt).toLocaleString()}。仅显示本次，请通过已有可信渠道手工交付；不会自动发送。生成新凭据会替换旧凭据。</p><label>一次性凭据<textarea aria-label="一次性凭据" readOnly value={reset.token} onFocus={e => e.target.select()} /></label><button className="btn btn-ghost" onClick={() => setReset(null)}>隐藏凭据</button></div>}
      {loading ? <p role="status">正在读取账号…</p> : !users.length ? <p>没有匹配账号。</p> : <div className="account-admin-grid">{users.map(user => <article className="account-admin-user" key={user.id}><div className="account-heading"><h3>{user.username}{user.nickname && ` · ${user.nickname}`}</h3><span className="account-badge">{user.disabled ? '已禁用' : '正常'} · {user.role === 'admin' ? '管理员' : '用户'}</span></div>{user.emailVerified && user.email && <p>已验证邮箱：{user.email}</p>}<div className="account-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={() => choose({ user, endpoint: 'status', body: { disabled: !user.disabled }, label: `${user.username} ${user.disabled ? '恢复账号（需重新登录）' : '禁用账号并撤销会话'}` })}>{user.disabled ? '恢复账号' : '禁用账号'}</button><button className="btn btn-ghost" disabled={busy} onClick={() => choose({ user, endpoint: 'reset', body: {}, label: `${user.username} 生成一次性密码重置凭据` })}>生成重置凭据</button>
      </div></article>)}</div>}
    </section>
    <section className="panel"><h2>操作记录</h2><p className="muted">最近 200 条记录。显示操作者、目标、操作及前后状态，不包含密码或重置凭据。</p><div className="account-audit"><table><thead><tr><th>时间</th><th>操作者 / 目标</th><th>操作</th><th>之前</th><th>之后</th></tr></thead><tbody>{audit.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td>{users.find(u => u.id === row.actorId)?.username || row.actorId}<br />→ {users.find(u => u.id === row.targetId)?.username || row.targetId}</td><td>{row.action.includes('member') ? '历史权限变更' : row.action}</td><td>{JSON.stringify(row.before)}</td><td>{JSON.stringify(row.after)}</td></tr>)}</tbody></table>{!audit.length && !loading && <p>暂无操作记录。</p>}</div></section>
  </div>;
}
export default AdminPage;
