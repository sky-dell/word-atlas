export class AccountError extends Error {
  constructor(message: string, public status = 0, public data: Record<string, unknown> = {}) { super(message); }
}
export interface User {
  id: string; username: string; nickname: string; role: 'user' | 'admin'; disabled: boolean;
  email: string | null; emailVerified: boolean;
  createdAt?: number;
  /** Legacy response compatibility only; never an authorization signal. */
  membership?: { active: boolean; permanent: boolean; expiresAt: number | string | null };
}
export interface Session { user: User | null; csrfToken: string; enabled: boolean; emailEnabled: boolean; secureOrigin?: string }
export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
/** No readable credential is persisted. Each request captures both identity and generation. */
export class AccountClient {
  private identity: string | null = null;
  private csrf = '';
  private generation = 0;
  private controllers = new Set<AbortController>();
  constructor(private transport: typeof fetch = (...args) => fetch(...args)) {}
  invalidate() { this.generation++; this.controllers.forEach(c => c.abort()); this.controllers.clear(); }
  setSession(id: string | null, csrf: string) { if (id !== this.identity) this.invalidate(); this.identity = id; this.csrf = csrf; }
  async request<T = Record<string, unknown>>(url: string, options: RequestOptions = {}): Promise<T> {
    if (!url.startsWith('/api/')) throw new Error('Invalid account API path');
    const epoch = this.generation, controller = new AbortController(); this.controllers.add(controller);
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.identity !== null) headers['X-Account-ID'] = this.identity;
    if (options.method && options.method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = this.csrf; }
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.transport(url, { method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.stringify(options.body), headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      if (controller.signal.aborted || epoch !== this.generation) throw new DOMException('账号已变化', 'AbortError');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new AccountError('此站点暂未提供账号服务，本地学习仍可使用。');
      const data = await response.json();
      if (controller.signal.aborted || epoch !== this.generation) throw new DOMException('账号已变化', 'AbortError');
      if (!response.ok) throw new AccountError(typeof data.error === 'string' ? data.error : '请求未完成，请重试。', response.status, data);
      return data as T;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); options.signal?.removeEventListener('abort',abort); }
  }
}
export const accountClient = new AccountClient();
