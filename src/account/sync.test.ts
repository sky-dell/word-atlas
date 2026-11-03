import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountClient } from './client';
import type { Backup } from './sync';
import { defaultSettings } from '../store/store';
const snapshot = (words: string[] = []): Backup => ({ app: 'word-atlas', version: 2, progress: { version: 2, datasetId: 'test', cards: {}, bookmarks: words, days: {}, typing: [], session: null, mistakes: [] }, settings: { ...defaultSettings }, extras: {} });

test('first cloud download never overwrites local edits made during the request', async () => {
  const mod = await import('./sync').catch(() => null); assert.ok(mod?.CloudSync);
  let finish!: (r: Response) => void;
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  const client = new AccountClient(async () => new Promise(r => { finish = r; started(); })); client.setSession('A', 'csrf');
  let local: any = snapshot(); let applied = false;
  const sync = new mod.CloudSync(client, { read: () => local, apply: () => { applied = true; }, loadMeta: () => null, saveMeta: () => {}, stash: () => {} }, () => {});
  const pending = sync.run();
  await ready; local = snapshot(['new-local']);
  finish(Response.json({ version: 3, snapshot: snapshot(['cloud']) })); await pending;
  assert.equal(applied, false); assert.equal(sync.get().status, 'conflict'); assert.deepEqual(local.progress.bookmarks, ['new-local']);
});

test('matching version metadata restores cloud when local account data is missing', async () => {
  const { CloudSync, fingerprint } = await import('./sync');
  let local: any = snapshot();
  const cloud = snapshot(['cloud']);
  let applied = false, uploaded = false, saved: any;
  const emptyHash = await fingerprint(snapshot());
  const client = new AccountClient(async (_url, init) => {
    if (init?.method === 'PUT') { uploaded = true; return Response.json({ version: 43 }); }
    return Response.json({ version: 42, snapshot: cloud });
  });
  const sync = new CloudSync(client, {
    read: () => local,
    apply: () => { applied = true; local = structuredClone(cloud); },
    loadMeta: () => ({ version: 42, hash: emptyHash }),
    saveMeta: meta => { saved = meta; },
    stash: () => {},
    persist: async () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, true);
  assert.equal(uploaded, false);
  assert.equal(sync.get().status, 'synced');
  assert.equal(saved.version, 42);
  assert.deepEqual(local.progress.bookmarks, ['cloud']);
});

test('cloud restores when local progress is empty but metadata already matches the cloud hash', async () => {
  const { CloudSync, fingerprint } = await import('./sync');
  let local = snapshot();
  const cloud = snapshot(['cloud']);
  const cloudHash = await fingerprint(cloud);
  let applied = false, uploaded = false;
  const client = new AccountClient(async (_url, init) => {
    if (init?.method === 'PUT') {
      uploaded = true;
      return Response.json({ version: 43 });
    }
    return Response.json({ version: 42, snapshot: cloud });
  });
  const sync = new CloudSync(client, {
    read: () => local,
    apply: () => { applied = true; local = structuredClone(cloud); },
    loadMeta: () => ({ version: 42, hash: cloudHash }),
    saveMeta: () => {},
    stash: () => {},
    persist: async () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, true);
  assert.equal(uploaded, false);
  assert.equal(sync.get().status, 'synced');
  assert.deepEqual(local.progress.bookmarks, ['cloud']);
});

test('stale metadata version restores cloud when local progress is empty', async () => {
  const { CloudSync, fingerprint } = await import('./sync');
  let local = snapshot();
  const cloud = snapshot(['cloud']);
  const staleHash = await fingerprint(snapshot(['stale']));
  let applied = false, uploaded = false;
  const client = new AccountClient(async (_url, init) => {
    if (init?.method === 'PUT') {
      uploaded = true;
      return Response.json({ version: 43 });
    }
    return Response.json({ version: 42, snapshot: cloud });
  });
  const sync = new CloudSync(client, {
    read: () => local,
    apply: () => { applied = true; local = structuredClone(cloud); },
    loadMeta: () => ({ version: 41, hash: staleHash }),
    saveMeta: () => {},
    stash: () => {},
    persist: async () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, true);
  assert.equal(uploaded, false);
  assert.equal(sync.get().status, 'synced');
  assert.deepEqual(local.progress.bookmarks, ['cloud']);
});

test('an explicit local clear uploads an empty snapshot instead of restoring cloud data', async () => {
  const { CloudSync, fingerprint } = await import('./sync');
  const cloud = snapshot(['cloud']);
  const cloudHash = await fingerprint(cloud);
  let applied = false;
  const uploads: Backup[] = [];
  const client = new AccountClient(async (_url, init) => {
    if (init?.method === 'PUT') {
      uploads.push(JSON.parse(init.body as string).snapshot);
      return Response.json({ version: 43 });
    }
    return Response.json({ version: 42, snapshot: cloud });
  });
  const sync = new CloudSync(client, {
    read: () => snapshot(),
    apply: () => { applied = true; },
    loadMeta: () => ({ version: 42, hash: cloudHash, clear: true }),
    saveMeta: () => {},
    stash: () => {},
    persist: async () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, false);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].progress.bookmarks, []);
  assert.equal(sync.get().status, 'synced');
});

test('matching version metadata does not overwrite occupied divergent local data', async () => {
  const { CloudSync, fingerprint } = await import('./sync');
  const local = snapshot(['local']);
  const cloud = snapshot(['cloud']);
  let applied = false;
  const localHash = await fingerprint(local);
  const client = new AccountClient(async () => Response.json({ version: 42, snapshot: cloud }));
  const sync = new CloudSync(client, {
    read: () => local,
    apply: () => { applied = true; },
    loadMeta: () => ({ version: 42, hash: localHash }),
    saveMeta: () => {},
    stash: () => {},
    persist: async () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, false);
  assert.equal(sync.get().status, 'conflict');
  assert.deepEqual(local.progress.bookmarks, ['local']);
});

test('CAS conflicts require backup and explicit local choice at the newly read version', async () => {
  const mod = await import('./sync').catch(() => null); assert.ok(mod?.CloudSync);
  const bodies: any[] = []; let puts = 0;
  const client = new AccountClient(async (url, init) => {
    assert.equal(url, '/api/account/progress?dataset=test');
    if (init?.method === 'PUT') { bodies.push(JSON.parse(init.body as string)); return ++puts === 1 ? Response.json({ code: 'conflict', version: 2 }, { status: 409 }) : Response.json({ version: 3 }); }
    return Response.json({ version: puts ? 2 : 0, snapshot: puts ? snapshot(['cloud']) : null });
  }); client.setSession('A', 'csrf');
  let stashed = false; let saved: any;
  const sync = new mod.CloudSync(client, { read: () => snapshot(['local']) as any, apply: () => {}, loadMeta: () => null, saveMeta: m => { saved = m; }, stash: () => { stashed = true; } }, () => {});
  await sync.run(); assert.equal(sync.get().status, 'conflict');
  await assert.rejects(sync.resolve('local'), /备份/);
  sync.backupLocal(); await sync.resolve('local');
  assert.equal(stashed, true); assert.equal(bodies[1].version, 2); assert.equal(saved.version, 3); assert.equal(sync.get().status, 'synced');
});

test('stopping sync prevents late cloud restore and metadata writes', async () => {
  const mod = await import('./sync').catch(() => null); assert.ok(mod?.CloudSync);
  let finish!: (r: Response) => void; let applied = false;
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  const client = new AccountClient(async () => new Promise(r => { finish = r; started(); }));
  const sync = new mod.CloudSync(client, { read: () => snapshot() as any, apply: () => { applied = true; }, loadMeta: () => null, saveMeta: () => { applied = true; }, stash: () => {} }, () => {});
  const pending = sync.run(); await ready; sync.stop();
  finish(Response.json({ version: 2, snapshot: snapshot(['cloud']) })); await pending;
  assert.equal(applied, false);
});

test('settings edited before first sync do not block cloud learning records', async () => {
  const { CloudSync } = await import('./sync');
  const cloud = snapshot(['cloud']);
  let local: any = { ...snapshot(), settings: { ...defaultSettings, dailyNew: 30 } };
  let applied = false;
  const client = new AccountClient(async () => Response.json({ version: 4, snapshot: cloud }));
  const sync = new CloudSync(client, {
    read: () => local,
    apply: value => { applied = true; local = structuredClone(value); },
    loadMeta: () => null,
    saveMeta: () => {},
    stash: () => {},
  }, () => {});
  await sync.run();
  assert.equal(applied, true);
  assert.equal(sync.get().status, 'synced');
  assert.deepEqual(local.progress.bookmarks, ['cloud']);
});

test('local reading and exercise history still blocks an automatic cloud overwrite', async () => {
  const { CloudSync } = await import('./sync');
  const local: any = snapshot();
  local.extras['word-atlas:extras:v1:test'] = {
    records: [{ id: 'reading-1', score: 4 }],
  };
  let applied = false;
  const client = new AccountClient(async () => Response.json({ version: 4, snapshot: snapshot(['cloud']) }));
  const sync = new CloudSync(client, {
    read: () => local,
    apply: () => { applied = true; },
    loadMeta: () => null,
    saveMeta: () => {},
    stash: () => {},
  }, () => {});

  await sync.run();
  assert.equal(applied, false);
  assert.equal(sync.get().status, 'conflict');
});

test('failed offline upload stays pending and retries at the observed cloud version', async () => {
  const { CloudSync } = await import('./sync'); let offline = true; const saved: { version: number; hash: string }[] = []; const uploads: any[] = [];
  const client = new AccountClient(async (_url, init) => {
    if (offline) throw new TypeError('offline');
    if (init?.method === 'PUT') { uploads.push(JSON.parse(init.body as string)); return Response.json({ version: 1 }); }
    return Response.json({ version: 0, snapshot: null });
  });
  const sync = new CloudSync(client, { read: () => snapshot(['local']) as any, apply: () => {}, loadMeta: () => null, saveMeta: m => { saved.push(m); }, stash: () => {} }, () => {});
  await sync.run(); assert.equal(sync.get().status, 'offline'); assert.equal(saved.length, 0);
  offline = false; await sync.run(); assert.equal(sync.get().status, 'synced'); assert.equal(saved[0].version, 1); assert.deepEqual(uploads[0].snapshot.progress.bookmarks, ['local']);
});

test('edits arriving during asynchronous fingerprinting also block automatic cloud restore', async () => {
  const { CloudSync } = await import('./sync'); let reads = 0; let local: any = snapshot(); let applied = false;
  const client = new AccountClient(async () => Response.json({ version: 3, snapshot: snapshot(['cloud']) }));
  const sync = new CloudSync(client, {
    read: () => { const value = local; if (++reads === 3) queueMicrotask(() => { local = snapshot(['edited-during-hash']); }); return value; },
    apply: () => { applied = true; }, loadMeta: () => null, saveMeta: () => {}, stash: () => {},
  }, () => {});
  await sync.run(); assert.equal(applied, false); assert.equal(sync.get().status, 'conflict');
});

test('failed local durable commit prevents cloud writes and sync acknowledgement',async()=>{
  const {CloudSync}=await import('./sync');let requests=0,saved=false;
  const client=new AccountClient(async(_url,init)=>{requests++;return Response.json(init?.method==='PUT'?{version:1}:{version:0,snapshot:null});});
  const local:any={read:()=>snapshot(['pending-local']),apply:()=>{},loadMeta:()=>null,saveMeta:()=>{saved=true;},stash:()=>{},persist:async()=>{throw new Error('本机保存失败');}};
  const sync=new CloudSync(client,local,()=>{});await sync.run();
  assert.equal(requests,0);assert.equal(saved,false);assert.equal(sync.get().status,'offline');
});
