import { test } from 'node:test';
import assert from 'node:assert/strict';

test('identity change rejects an old successful response and aborts its request', async () => {
  const mod = await import('./client').catch(() => null);
  assert.ok(mod?.AccountClient, 'AccountClient must enforce identity generations');
  let complete!: (r: Response) => void; let seen!: RequestInit;
  const client = new mod.AccountClient(async (_url, init) => { seen = init!; return new Promise(r => { complete = r; }); });
  client.setSession('A', 'csrf-A');
  const old = client.request('/api/account/progress?dataset=test', { method: 'PUT', body: { version: 0, snapshot: {} } });
  assert.equal(new Headers(seen.headers).get('X-Account-ID'), 'A');
  assert.equal(new Headers(seen.headers).get('X-CSRF-Token'), 'csrf-A');
  client.setSession('B', 'csrf-B'); complete(Response.json({ version: 1 }));
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(seen.signal?.aborted, true);
});

test('client rejects HTML mirrors and preserves CAS conflict versions', async () => {
  const mod = await import('./client').catch(() => null); assert.ok(mod?.AccountClient);
  const mirror = new mod.AccountClient(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(mirror.request('/api/auth/session'), /账号服务/);
  const client = new mod.AccountClient(async () => Response.json({ error: 'conflict', code: 'conflict', version: 8 }, { status: 409 }));
  await assert.rejects(client.request('/api/account/progress'), (e: any) => e.status === 409 && e.data.version === 8);
});
