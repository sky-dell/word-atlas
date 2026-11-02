import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const scope = "https://atlas.test/words/";
const prefix = `word-atlas:${scope}:`;
const shell = `${prefix}v2-shell`;
const key = (req: Request | string) => typeof req === "string" ? req : req.url;

function worker() {
  const data = new Map<string, Map<string, Response>>();
  const handlers: Record<string, (event: any) => void> = {};
  let network: () => Promise<Response> = async () => response("fresh");
  let put: () => Promise<void> = async () => {};
  const cache = (name: string) => {
    if (!data.has(name)) data.set(name, new Map());
    return {
      match: async (req: Request | string) => data.get(name)?.get(key(req))?.clone(),
      put: async (req: Request | string, res: Response) => { await put(); data.get(name)!.set(key(req), res.clone()); },
      keys: async () => [...data.get(name)!.keys()],
      delete: async (req: Request | string) => data.get(name)!.delete(key(req)),
    };
  };
  runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
    self: { registration: { scope }, addEventListener: (name: string, cb: (e: any) => void) => { handlers[name] = cb; }, clients: { claim: async () => {} }, skipWaiting: () => {} },
    location: { origin: new URL(scope).origin }, URL,
    caches: { keys: async () => [...data.keys()], delete: async (name: string) => data.delete(name), open: async (name: string) => cache(name) },
    fetch: () => network(),
  });
  return {
    data, cache, network: (fn: typeof network) => { network = fn; }, put: (fn: typeof put) => { put = fn; },
    activate: async () => {
      let done: Promise<unknown> | undefined;
      handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    },
    fetch: (path: string, options: { navigate?: boolean; range?: boolean; method?: string } = {}) => {
      const req = new Request(new URL(path, scope), { method: options.method, headers: options.range ? { range: "bytes=0-10" } : {} });
      if (options.navigate) Object.defineProperty(req, "mode", { value: "navigate" });
      let response: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      handlers.fetch({ request: req, respondWith: (p: Promise<Response>) => { response = p; }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      return { response, done: Promise.all(waits), waits };
    },
  };
}
function response(text: string) {
  const res = new Response(text);
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
}

test("activation deletes only outdated caches owned by this registration", async () => {
  const w = worker();
  for (const name of [shell, `${prefix}v2-media`, `${prefix}v1-shell`, "other-app", "atlas-v1-shell", "word-atlas:https://atlas.test/elsewhere/:v1-shell"])
    w.cache(name);
  await w.activate();
  assert.equal(w.data.has(`${prefix}v1-shell`), false);
  assert.equal(w.data.size, 5);
  assert.ok(w.data.has("other-app"));
});

test("same-URL app and JSON resources refresh and writes belong to fetch lifetime", async () => {
  const w = worker();
  const url = new URL("atlas/data.json", scope).href;
  await w.cache(shell).put(url, response("stale"));
  const event = w.fetch(url);
  assert.equal(await (await event.response!).text(), "fresh");
  assert.ok(event.waits.length > 0);
  await event.done;
  assert.equal(await (await w.cache(shell).match(url))!.text(), "fresh");
  w.network(async () => { throw new Error("offline"); });
  assert.equal(await (await w.fetch(url).response!).text(), "fresh");
});

test("cache failure preserves successful network response and scoped offline navigation", async () => {
  const w = worker();
  await w.cache(shell).put(scope, response("app shell"));
  w.put(async () => { throw new Error("quota"); });
  assert.equal(await (await w.fetch("app.js").response!).text(), "fresh");
  w.network(async () => { throw new Error("offline"); });
  assert.equal(await (await w.fetch("deep/link", { navigate: true }).response!).text(), "app shell");
  await assert.rejects(w.fetch("missing/index.json").response!, /offline/);
});

test("media stays cache-first and unrelated requests are not intercepted", async () => {
  const w = worker();
  await w.cache(`${prefix}v2-media`).put(new URL("atlas/img/a.webp", scope).href, response("image"));
  w.network(async () => { throw new Error("should not fetch"); });
  assert.equal(await (await w.fetch("atlas/img/a.webp").response!).text(), "image");
  for (const [url, options] of [["https://other.test/a", {}], ["/elsewhere/a", {}], ["a", { range: true }], ["a", { method: "POST" }]] as const)
    assert.equal(w.fetch(url, options).response, undefined);
});

test("account and admin API requests always bypass the service worker", () => {
  const w=worker();
  for(const p of ['/api/auth/session','/api/admin/users','/words/api/member/progress'])
    assert.equal(w.fetch(p).response,undefined);
});

test("activation removes previously cached identity responses across application scopes", async () => {
  const w=worker();
  const foreign='word-atlas:https://atlas.test/:v2-shell';
  await w.cache(foreign).put('https://atlas.test/api/auth/session',response('private'));
  await w.cache(foreign).put('https://atlas.test/atlas/index.json',response('public'));
  await w.activate();
  assert.equal(await w.cache(foreign).match('https://atlas.test/api/auth/session'),undefined);
  assert.ok(await w.cache(foreign).match('https://atlas.test/atlas/index.json'));
});

test("no-store responses are not placed into offline caches", async () => {
  const w=worker();
  w.network(async()=>{const r=response('private');r.headers.set('Cache-Control','no-store');return r;});
  const event=w.fetch('private.json');await event.response;await event.done;
  assert.equal(await w.cache(shell).match(new URL('private.json',scope).href),undefined);
});
