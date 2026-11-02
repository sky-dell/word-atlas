import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;
before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "word-atlas-test-"));
  server = await createServer({
    configFile: false,
    publicDir: false,
    appType: "custom",
    cacheDir,
    optimizeDeps: {
      noDiscovery: true,
      entries: [],
      include: ["react", "react-dom"],
    },
    server: { port: 0, watch: null, hmr: false, preTransformRequests: false },
    plugins: [
      {
        name: "test-page",
        configureServer(s) {
          s.middlewares.use("/test-page", (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>Store tests</title>");
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

async function load(page: Page, id = "test") {
  await page.goto(`${origin}test-page`);
  await page.evaluate(async (id) => {
    const path = "/src/store/store.ts";
    const mod = await import(path);
    Object.assign(window, { atlasStore: mod });
    mod.store.useDataset(id);
    await mod.flush();
  }, id);
}

test("failed saves retain pending changes and retry without another mutation", async () => {
  const context = await browser.newContext();
  await context.addInitScript(`(() => {
    Object.defineProperty(window, "indexedDB", { value: undefined });
    const set = Storage.prototype.setItem;
    let fail = true;
    Storage.prototype.setItem = function (key, value) {
      if (fail) throw new DOMException("quota", "QuotaExceededError");
      return set.call(this, key, value);
    };
    Object.assign(window, { allowWrites: () => { fail = false; } });
  })()`);
  const page = await context.newPage();
  await load(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const { store, flush } = w.atlasStore;
    store.settings({ dailyNew: 23 });
    await flush();
    const failed = store.get().saveError;
    w.allowWrites();
    await flush();
    return {
      failed,
      error: store.get().saveError,
      saved: JSON.parse(localStorage.getItem("word-atlas:settings")!).dailyNew,
    };
  });
  assert.deepEqual(result, { failed: true, error: false, saved: 23 });
  await context.close();
});

test("failed initial hydration notifies subscribers when progress becomes ready", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      value: {
        open() {
          const request: any = {};
          queueMicrotask(() => {
            request.error = new DOMException("unavailable", "UnknownError");
            request.onerror?.();
          });
          return request;
        },
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`${origin}test-page`);
  const result = await page.evaluate(async () => {
    const path = "/src/store/store.ts";
    const mod = await import(path);
    const notifications: boolean[] = [];
    mod.store.subscribe(() => notifications.push(mod.store.get().ready));
    mod.store.useDataset("test");
    await mod.flush();
    return {
      ready: mod.store.get().ready,
      last: notifications.at(-1),
      error: mod.store.get().saveError,
    };
  });
  assert.deepEqual(result, { ready: true, last: true, error: true });
  await context.close();
});

test("interrupting a recording reports stopped rather than completed", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}test-page`);
  const result = await page.evaluate(async () => {
    (window as any).Audio = class {
      onpause?: () => void;
      playbackRate = 1;
      async play() {}
      pause() {
        queueMicrotask(() => this.onpause?.());
      }
    };
    const path = "/src/lib/audio.ts";
    const audio = await import(path);
    const first = audio.play("/a.mp3", "a");
    await new Promise((r) => setTimeout(r, 0));
    const second = audio.play("/b.mp3", "b");
    const interrupted = await first;
    audio.stopAudio();
    await second;
    return interrupted;
  });
  assert.equal(result, "stopped");
  await context.close();
});

test("concurrent tabs merge bookmarks, counters and settings in IndexedDB", async () => {
  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();
  await load(a);
  await load(b);
  for (const [page, word, theme] of [
    [a, "alpha", "light"],
    [b, "beta", null],
  ] as const) {
    await page.evaluate(
      ({ word, theme }) => {
        const { store, bumpDay } = (window as any).atlasStore;
        store.progress((p: any) =>
          bumpDay({ ...p, bookmarks: [word, ...p.bookmarks] }, { r: 1 }),
        );
        store.settings(theme ? { theme } : { dailyNew: 32 });
      },
      { word, theme },
    );
  }
  await Promise.all(
    [a, b].map((page) =>
      page.evaluate(() => (window as any).atlasStore.flush()),
    ),
  );
  const c = await context.newPage();
  await load(c);
  const result = await c.evaluate(() => {
    const { store, dayKey } = (window as any).atlasStore;
    const s = store.get();
    return {
      bookmarks: s.progress.bookmarks.sort(),
      reviews: s.progress.days[dayKey()]?.r,
      theme: s.settings.theme,
      daily: s.settings.dailyNew,
    };
  });
  assert.deepEqual(result.bookmarks, ["alpha", "beta"]);
  assert.equal(result.reviews, 2);
  assert.equal(result.theme, "light");
  assert.equal(result.daily, 32);
  assert.ok((await c.evaluate(() => indexedDB.databases())).length > 0);
  await context.close();
});

test("legacy data migrates and a subsequent reload reads IndexedDB", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}test-page`);
  await page.evaluate(() => {
    localStorage.setItem(
      "word-atlas:settings",
      JSON.stringify({ dailyNew: 41 }),
    );
    localStorage.setItem(
      "word-atlas:v2:test",
      JSON.stringify({ version: 2, bookmarks: ["legacy"] }),
    );
  });
  await load(page);
  await page.evaluate(() => localStorage.clear());
  await load(page);
  assert.deepEqual(
    await page.evaluate(() => {
      const s = (window as any).atlasStore.store.get();
      return [s.settings.dailyNew, s.progress.bookmarks];
    }),
    [41, ["legacy"]],
  );
  await context.close();
});

test("malformed word URI does not crash router initialization or hash changes", async () => {
  const page = await browser.newPage();
  await page.goto(`${origin}test-page#/w/%E0%A4%A`);
  const result = await page.evaluate(async () => {
    const path = "/src/lib/router.ts";
    const router = await import(path);
    const first = router.currentLocation();
    location.hash = "/w/%";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return [first, router.currentLocation()];
  });
  assert.deepEqual(result, [
    { route: { page: "atlas" }, word: null },
    { route: { page: "atlas" }, word: null },
  ]);
  await page.close();
});

test("reading and exercise routes preserve parameters and books aliases", async () => {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}test-page`);
  const result = await page.evaluate(async () => {
    const path = "/src/lib/router.ts";
    const r = await import(path);
    const routes = [
      {
        page: "read",
        tab: "books",
        id: "a & b",
        book: "Book / 一",
        chapter: "2",
      },
      { page: "read", tab: "short", id: "r0001" },
      { page: "paraphrase", id: "a?b" },
      { page: "confuse", id: "one/two" },
    ];
    const roundTrips = routes.map((route) => {
      r.go(route, "word #1", true);
      return r.currentLocation();
    });
    const aliases = [
      "#/read",
      "#/books",
      "#/read/books?book=b&chapter=3",
      "#/paraphrase",
      "#/confuse",
      "#/read?tab=books",
      "#/read?tab=short",
    ].map((hash) => {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      return r.currentLocation().route;
    });
    return { roundTrips, aliases };
  });
  assert.deepEqual(result.roundTrips, [
    {
      route: {
        page: "read",
        tab: "books",
        id: "a & b",
        book: "Book / 一",
        chapter: "2",
      },
      word: "word #1",
    },
    {
      route: {
        page: "read",
        tab: "short",
        id: "r0001",
        book: undefined,
        chapter: undefined,
      },
      word: "word #1",
    },
    { route: { page: "paraphrase", id: "a?b" }, word: "word #1" },
    { route: { page: "confuse", id: "one/two" }, word: "word #1" },
  ]);
  assert.deepEqual(
    result.aliases.map((r: any) => r.page),
    ["read", "read", "read", "paraphrase", "confuse", "read", "read"],
  );
  assert.equal(result.aliases[1].tab, "books");
  assert.equal(result.aliases[2].tab, "books");
  assert.equal(result.aliases[5].tab, "books");
  assert.equal(result.aliases[6].tab, "short");
  assert.equal(result.aliases[2].book, "b");
  assert.equal(result.aliases[2].chapter, "3");
  await page.close();
});

test("aborted IndexedDB transaction remains dirty across dataset switches", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await load(page, "first");
  await page.evaluate(`(() => {
    const put = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (fail && key === 'word-atlas:v2:first') this.transaction.abort();
      return request;
    };
    window.allowWrites = () => { fail = false; };
  })()`);
  const result = await page.evaluate(async () => {
    const { store, flush, bumpDay } = (window as any).atlasStore;
    store.progress((p: any) =>
      bumpDay({ ...p, bookmarks: ["unsaved"] }, { r: 1 }),
    );
    await flush();
    const failed = store.get().saveError;
    store.useDataset("second");
    store.settings({ dailyNew: 27 });
    await flush();
    const stillFailed = store.get().saveError;
    (window as any).allowWrites();
    await flush();
    store.useDataset("first");
    await flush();
    return {
      failed,
      stillFailed,
      error: store.get().saveError,
      progress: store.get().progress,
    };
  });
  assert.equal(result.failed, true);
  assert.equal(result.stillFailed, true);
  assert.equal(result.error, false);
  assert.deepEqual(result.progress.bookmarks, ["unsaved"]);
  assert.equal(
    Object.values(result.progress.days as Record<string, { r: number }>)[0].r,
    1,
  );
  await context.close();
});

test("mutations during a transaction remain visible and are persisted on next flush", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await load(page);
  await page.evaluate(`(() => {
    const put = IDBObjectStore.prototype.put;
    let once = true;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (once && key === 'word-atlas:v2:test') {
        once = false;
        window.atlasStore.store.progress(p => ({...p, bookmarks: ['during', ...p.bookmarks]}));
      }
      return request;
    };
  })()`);
  const visible = await page.evaluate(async () => {
    const { store, flush } = (window as any).atlasStore;
    store.progress((p: any) => ({ ...p, bookmarks: ["before"] }));
    await flush();
    const immediate = [...store.get().progress.bookmarks].sort();
    await flush();
    return immediate;
  });
  assert.deepEqual(visible, ["before", "during"]);
  await load(page);
  assert.deepEqual(
    await page.evaluate(() =>
      (window as any).atlasStore.store.get().progress.bookmarks.sort(),
    ),
    ["before", "during"],
  );
  await context.close();
});

test("reset and import deliberately replace persisted progress without changing synchronous APIs", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await load(page);
  const result = await page.evaluate(async () => {
    const m = (window as any).atlasStore;
    m.store.progress((p: any) => ({ ...p, bookmarks: ["old"] }));
    const immediate = m.store.get().progress.bookmarks;
    await m.flush();
    m.resetProgress();
    await m.flush();
    const reset = m.store.get().progress.bookmarks;
    const imported = m.importBackup(
      JSON.stringify({
        app: "word-atlas",
        version: 2,
        progress: { version: 2, datasetId: "test", bookmarks: ["imported"] },
        settings: { dailyNew: 36 },
      }),
    );
    const exported = JSON.parse(m.exportBackup());
    await m.flush();
    return { immediate, reset, imported, exported };
  });
  assert.deepEqual(result.immediate, ["old"]);
  assert.deepEqual(result.reset, []);
  assert.equal(result.imported.ok, true);
  assert.deepEqual(result.exported.progress.bookmarks, ["imported"]);
  await load(page);
  assert.deepEqual(
    await page.evaluate(() => {
      const s = (window as any).atlasStore.store.get();
      return [s.progress.bookmarks, s.settings.dailyNew];
    }),
    [["imported"], 36],
  );
  await context.close();
});

test("immediate dataset round-trip preserves local unsaved progress", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await load(page, "first");
  const result = await page.evaluate(async () => {
    const { store, flush } = (window as any).atlasStore;
    store.progress((p: any) => ({ ...p, bookmarks: ["pending"] }));
    store.useDataset("second");
    store.useDataset("first");
    const immediate = [...store.get().progress.bookmarks];
    await flush();
    return immediate;
  });
  assert.deepEqual(result, ["pending"]);
  await context.close();
});
