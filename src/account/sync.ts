import { AccountClient, AccountError } from './client';
import { defaultSettings, type Progress, type Settings } from '../store/store';
export interface Backup { app: 'word-atlas'; version: 2; progress: Progress; settings: Settings; extras: Record<string, unknown> }
export interface SyncMeta { version: number; hash: string; clear?: boolean }
export interface CloudRecord { version: number; snapshot: Backup | null }
export interface SyncState { status: 'idle' | 'pending' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'unavailable'; message?: string; version?: number; backedUp?: boolean }
interface Local {
  read(): Backup; apply(snapshot: Backup): void; stash(text: string): void;
  persist?(): Promise<void>;
  loadMeta(): SyncMeta | null; saveMeta(meta: SyncMeta): void;
}
export async function fingerprint(snapshot: Backup) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hasLearning(b: Backup) {
  const p = b.progress;
  return Object.keys(p.cards).length || p.bookmarks.length || Object.keys(p.days).length || p.typing.length || p.mistakes.length;
}
function occupied(b: Backup) {
  return hasLearning(b) || Object.keys(b.extras).length || Object.entries(b.settings).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaultSettings[key as keyof Settings]));
}
/** One instance per identity + dataset. stop() invalidates every continuation. */
export class CloudSync {
  private state: SyncState = { status: 'idle' };
  private stopped = false;
  private busy = false;
  private backedUp: string | null = null;
  private cloud: CloudRecord | null = null;
  constructor(private client: AccountClient, private local: Local, private changed: (state: SyncState) => void) {}
  get() { return this.state; }
  stop() { this.stopped = true; }
  private set(state: SyncState) { if (!this.stopped) { this.state = state; this.changed(state); } }
  private path() { return `/api/account/progress?dataset=${encodeURIComponent(this.local.read().progress.datasetId)}`; }
  pending() { if (!this.busy && this.state.status !== 'conflict') this.set({ status: 'pending' }); }
  private conflict(record: CloudRecord) { this.cloud = record; this.backedUp = null; this.set({ status: 'conflict', version: record.version, backedUp: false }); }
  private async remember(version: number, snapshot: Backup) {
    await this.local.persist?.();
    if (this.stopped) return;
    const hash = await fingerprint(snapshot);
    if (this.stopped) return;
    this.local.saveMeta({ version, hash });
    const current = await fingerprint(this.local.read());
    this.set({ status: hash === current ? 'synced' : 'pending', version });
  }
  private async upload(record: CloudRecord, snapshot: Backup) {
    await this.local.persist?.();
    if (this.stopped) return;
    const result = await this.client.request<{ version: number }>(this.path(), { method: 'PUT', body: { version: record.version, snapshot } });
    if (!this.stopped) await this.remember(result.version, snapshot);
  }
  private async error(error: unknown) {
    if (this.stopped) return;
    if (error instanceof AccountError && ['storage_quota','cloud_capacity'].includes(String(error.data.code))) {
      this.set({status:'unavailable',message:'云端存储额度不足，本机数据已保留。请下载备份并联系管理员。'});return;
    }
    if (error instanceof AccountError && error.status === 409 && error.data.code === 'conflict') {
      try { const cloud = await this.client.request<CloudRecord>(this.path()); if (!this.stopped) this.conflict(cloud); }
      catch { this.set({ status: 'offline', message: '无法读取冲突版本，本机记录已保留，请重试。' }); }
    } else if (error instanceof AccountError && ([401, 403].includes(error.status) || error.data.code === 'account_changed')) {
      this.set({ status: 'unavailable', message: '云同步权限已失效，请刷新账号状态；本机学习仍可使用。' });
    } else if (!(error instanceof DOMException && error.name === 'AbortError')) this.set({ status: 'offline', message: error instanceof AccountError && error.status === 413 ? '学习快照超过云端 10 MiB 上限，请导出本机备份。' : error instanceof Error && !(error instanceof TypeError) ? error.message : '云端暂时不可用，本机更改待同步。' });
  }
  async run() {
    if (this.stopped || this.busy || this.state.status === 'conflict') return;
    this.busy = true; this.set({ status: 'syncing' });
    try {
      await this.local.persist?.();
      if (this.stopped) return;
      const before = this.local.read(), hash = await fingerprint(before), meta = this.local.loadMeta();
      if (this.stopped) return;
      const cloud = await this.client.request<CloudRecord>(this.path());
      if (this.stopped) return;
      const current = this.local.read(), currentHash = await fingerprint(current);
      if (this.stopped) return;
      if (!cloud.snapshot) { await this.upload(cloud, this.local.read()); return; }
      const cloudHash = await fingerprint(cloud.snapshot);
      if (this.stopped) return;
      if (JSON.stringify(this.local.read()) !== JSON.stringify(current)) { this.conflict(cloud); return; }
      if (meta && !hasLearning(current)) {
        if (meta.clear) { await this.upload(cloud, current); return; }
        this.local.stash(JSON.stringify(current));
        this.local.apply(cloud.snapshot);
        await this.remember(cloud.version, this.local.read());
        return;
      }
      const dirty = !meta || meta.hash !== currentHash;
      if (meta?.version === cloud.version) {
        if (meta.hash !== cloudHash) {
          if (currentHash === cloudHash) {
            this.local.saveMeta({ version: cloud.version, hash: cloudHash });
            this.set({ status: 'synced', version: cloud.version });
          } else if (hash === currentHash && !occupied(current)) {
            this.local.stash(JSON.stringify(current));
            this.local.apply(cloud.snapshot);
            await this.remember(cloud.version, this.local.read());
          } else {
            this.conflict(cloud);
          }
          return;
        }
        if (dirty) await this.upload(cloud, current);
        else this.set({ status: 'synced', version: cloud.version });
      } else if (hash !== currentHash || (dirty && (meta !== null || occupied(current)))) {
        this.conflict(cloud);
      } else {
        this.local.stash(JSON.stringify(current));
        this.local.apply(cloud.snapshot);
        await this.remember(cloud.version, this.local.read());
      }
    } catch (e) { await this.error(e); }
    finally { this.busy = false; }
  }
  /** Caller offers the returned JSON as a download before enabling a resolution. */
  backupLocal() {
    const text = JSON.stringify(this.local.read()); this.local.stash(text); this.backedUp = text;
    this.set({ ...this.state, backedUp: true }); return text;
  }
  async resolve(choice: 'local' | 'cloud') {
    if (this.stopped || this.busy) return;
    if (!this.backedUp || this.backedUp !== JSON.stringify(this.local.read())) { this.backedUp = null; this.set({ ...this.state, backedUp: false }); throw new Error('请先导出当前本机备份，再选择冲突版本。'); }
    if (!this.cloud) throw new Error('请先检查云端版本。');
    this.busy = true;
    try {
      if (choice === 'local') await this.upload(this.cloud, this.local.read());
      else {
        // Re-read so a second device's newer version is never silently accepted.
        const latest = await this.client.request<CloudRecord>(this.path());
        if (this.stopped) return;
        if (latest.version !== this.cloud.version) { this.conflict(latest); return; }
        if (this.backedUp !== JSON.stringify(this.local.read())) throw new Error('本机记录已变化，请重新备份。');
        if (latest.snapshot) this.local.apply(latest.snapshot);
        await this.remember(latest.version, this.local.read());
      }
      this.cloud = null; this.backedUp = null;
    } catch (e) { await this.error(e); if (!(e instanceof AccountError)) throw e; }
    finally { this.busy = false; }
  }
}
