import { useEffect, useSyncExternalStore } from 'react';
import { accountClient, AccountError, type Session } from './client';
import { CloudSync, type Backup, type SyncMeta, type SyncState } from './sync';
import { exportBackup, flush, importBackup, store, switchProfile } from '../store/store';
import { beginProfileSwitch, getProfile, profileGeneration, scopedKey, subscribeProfile } from '../store/profile';

export interface AccountState extends Session {
  bootstrapped: boolean; loading: boolean; error: string; profileKey: string; sync: SyncState;
}
let state: AccountState = { user: null, csrfToken: '', enabled: false, emailEnabled: false, bootstrapped: false, loading: true, error: '', profileKey: 'guest:0', sync: { status: 'idle' } };
const listeners = new Set<() => void>();
const update = (patch: Partial<AccountState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
export const accountState = { get: () => state, subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; } };
let cloud: CloudSync | null = null;
let cloudKey = '';
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let refreshWork: Promise<void> | null = null;
let refreshEpoch = 0;
let owners = 0;
let cleanup: (() => void) | null = null;
let restoreRevision = 0;
const identityEvent = 'word-atlas:identity-changed';
let identityChannel: BroadcastChannel | null = null;
let lastIdentitySignal = '';
export function readSnapshot(): Backup {
  const { exported: _exported, ...snapshot } = JSON.parse(exportBackup());
  if (Object.keys(snapshot.extras).length > 20000) throw new Error('附加学习记录超过云端 20,000 项上限，请保留本机 JSON 备份。');
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 10 * 1024 * 1024) throw new Error('学习记录超过云端 10 MiB 上限，请保留本地导出文件。');
  return snapshot;
}
export function applySnapshot(snapshot: Backup) {
  const result = importBackup(JSON.stringify(snapshot));
  if (!result.ok) throw new Error(result.error);
}
export function stashLocal(text: string) {
  // A durable local safety copy is required before replacing learning data.
  localStorage.setItem(scopedKey(`word-atlas:safety:${store.get().progress.datasetId}`), text);
}
function stopCloud() { clearTimeout(syncTimer); cloud?.stop(); cloud = null; cloudKey = ''; }
function configureCloud() {
  const s = store.get();
  const key = state.enabled && state.bootstrapped && !state.loading && state.user && !state.user.disabled && s.ready && !s.saveError && getProfile() === state.user.id ? `${state.user.id}:${s.progress.datasetId}:${profileGeneration()}` : '';
  if (key === cloudKey) return;
  stopCloud();
  if (!key) { update({ sync: { status: 'idle' } }); return; }
  cloudKey = key;
  const metaKey = scopedKey(`word-atlas:sync:${s.progress.datasetId}`);
  cloud = new CloudSync(accountClient, {
    read: readSnapshot, apply: applySnapshot, stash: stashLocal,
    async persist() {
      await flush();
      if(store.get().saveError) throw new Error('本机保存失败，暂不上传或确认云同步。请先导出备份并检查浏览器存储空间。');
    },
    loadMeta() { try { const m = JSON.parse(localStorage.getItem(metaKey) || 'null'); return m && Number.isSafeInteger(m.version) && typeof m.hash === 'string' ? m as SyncMeta : null; } catch { return null; } },
    saveMeta(m) { localStorage.setItem(metaKey, JSON.stringify(m)); },
  }, sync => {
    update({ sync });
    if (sync.status === 'pending') { clearTimeout(syncTimer); syncTimer = setTimeout(() => void cloud?.run(), 1000); }
    if (sync.status === 'unavailable') void refreshAccount();
  });
  scheduleSync();
}
export function scheduleSync() {
  if (!cloud) return;
  cloud.pending(); clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void cloud?.run(), 1000);
}
export async function syncNow() { if (cloud) await cloud.run(); }
export function backupConflict() { if (!cloud) throw new Error('云同步未启用。'); return cloud.backupLocal(); }
export async function resolveConflict(choice: 'local' | 'cloud') { if (cloud) await cloud.resolve(choice); }
export function broadcastIdentityChange() {
  const signal = JSON.stringify([Date.now(), Math.random()]);
  identityChannel?.postMessage(signal);
  try { localStorage.setItem(identityEvent, signal); } catch { /* Focus/poll revalidation is the fallback. */ }
}
export function refreshAccount(invalidate = false): Promise<void> {
  if (invalidate) {
    refreshEpoch++; accountClient.invalidate(); stopCloud(); beginProfileSwitch();
    update({ loading: true, sync: { status: 'idle' } });
    refreshWork = null;
  }
  if (refreshWork) return refreshWork;
  const epoch = refreshEpoch;
  const job = (async () => {
    try {
      // Cookies are shared by tabs. Serialize bootstrap so two tabs cannot
      // replace each other's newly created anonymous CSRF session after logout.
      const readSession = () => {
        if (epoch !== refreshEpoch) throw new DOMException('Stale session refresh', 'AbortError');
        return accountClient.request<Session>('/api/auth/session');
      };
      const session = typeof navigator !== 'undefined' && navigator.locks
        ? await navigator.locks.request('word-atlas:session-bootstrap', readSession)
        : await readSession();
      if (epoch !== refreshEpoch) return;
      if (!session.enabled && session.csrfToken == null) session.csrfToken = '';
      if (typeof session.enabled !== 'boolean' || typeof session.csrfToken !== 'string' || (session.user && typeof session.user.id !== 'string')) throw new Error('此站点暂未提供可用的账号服务。');
      const changed = getProfile() !== (session.user?.id ?? null);
      if (changed || invalidate) {
        stopCloud(); accountClient.invalidate(); update({ loading: true });
        await switchProfile(session.user?.id ?? null);
        if (epoch !== refreshEpoch) return;
      }
      accountClient.setSession(session.user?.id ?? null, session.csrfToken);
      update({ ...session, emailEnabled: session.emailEnabled === true, bootstrapped: true, loading: false, error: '', profileKey: `${session.user?.id ?? 'guest'}:${profileGeneration()}:${restoreRevision}` });
      configureCloud();
    } catch (e) {
      if (epoch !== refreshEpoch) return;
      if (e instanceof DOMException && e.name === 'AbortError' && !invalidate) return;
      // Unknown cookie identity must never leave the previous account's learning data visible.
      if (invalidate || !state.bootstrapped) { await switchProfile(null); accountClient.setSession(null, ''); }
      stopCloud();
      update({ ...(invalidate ? { user: null } : {}), bootstrapped: true, loading: false, enabled: false, emailEnabled: false, error: e instanceof Error ? e.message : '账号服务暂时不可用，本地学习仍可使用。', profileKey: `${getProfile() ?? 'guest'}:${profileGeneration()}:${restoreRevision}` });
    }
  })();
  refreshWork = job;
  void job.finally(() => { if (refreshWork === job) refreshWork = null; });
  return job;
}
export async function authAction(action: 'login' | 'login-code' | 'register' | 'logout' | 'password' | 'reset', body: unknown = {}) {
  if (!state.enabled || state.loading) throw new Error('账号服务尚未启用。');
  // Flush to the captured local profile before changing the shared session cookie.
  await flush();
  try {
    const mutateSession = () => accountClient.request(`/api/auth/${action}`, { method: 'POST', body });
    if (typeof navigator !== 'undefined' && navigator.locks)
      await navigator.locks.request('word-atlas:session-bootstrap', mutateSession);
    else await mutateSession();
  }
  catch (e) {
    if (e instanceof AccountError && ['csrf', 'account_changed'].includes(String(e.data.code))) { await refreshAccount(true); throw new Error('会话已更新，请重新提交。'); }
    throw e;
  }
  broadcastIdentityChange();
  await refreshAccount(true);
}
function mountAccount() {
  owners++;
  if (owners === 1 && typeof window !== 'undefined') {
    const identitySignal = (signal: string | null) => { if (signal && signal === lastIdentitySignal) return; lastIdentitySignal = signal || ''; void refreshAccount(true); };
    if (typeof BroadcastChannel !== 'undefined') { identityChannel = new BroadcastChannel(identityEvent); identityChannel.onmessage = e => identitySignal(typeof e.data === 'string' ? e.data : null); }
    const onStore = () => { configureCloud(); scheduleSync(); };
    const offStore = store.subscribe(onStore);
    const offProfile = subscribeProfile(() => update({ profileKey: `${getProfile() ?? 'guest'}:${profileGeneration()}:${restoreRevision}` }));
    const storage = (e: StorageEvent) => {
      if (e.key === identityEvent || e.key === null) identitySignal(e.newValue);
      else if (e.key?.startsWith(scopedKey('word-atlas:'))) scheduleSync();
    };
    const revalidate = () => void refreshAccount().then(() => { configureCloud(); scheduleSync(); });
    const extras = () => scheduleSync();
    const restored = () => { restoreRevision++; update({ profileKey: `${getProfile() ?? 'guest'}:${profileGeneration()}:${restoreRevision}` }); };
    window.addEventListener('storage', storage); window.addEventListener('focus', revalidate); window.addEventListener('online', revalidate);
    window.addEventListener('word-atlas:extras-changed', extras); window.addEventListener('word-atlas:profile-restored', restored);
    const timer = setInterval(revalidate, 30000);
    cleanup = () => { identityChannel?.close(); identityChannel = null; clearInterval(timer); clearTimeout(syncTimer); offStore(); offProfile(); stopCloud(); window.removeEventListener('storage', storage); window.removeEventListener('focus', revalidate); window.removeEventListener('online', revalidate); window.removeEventListener('word-atlas:extras-changed', extras); window.removeEventListener('word-atlas:profile-restored', restored); };
  }
  if (!state.bootstrapped) void refreshAccount(); else configureCloud();
  return () => { if (--owners === 0) { cleanup?.(); cleanup = null; } };
}
export function useAccount() {
  const snapshot = useSyncExternalStore(accountState.subscribe, accountState.get, accountState.get);
  useEffect(mountAccount, []);
  return snapshot;
}
/** Standalone root effect; no context provider or children required. */
export function AccountController() { useAccount(); return null; }
export function accountError(error: unknown) {
  if (error instanceof AccountError && error.status === 429) return '尝试过于频繁，请稍后再试。';
  if (error instanceof DOMException && error.name === 'AbortError') return '请求已取消，账号可能已变化，请重试。';
  return error instanceof Error ? error.message : '请求未完成，请重试。';
}
