/** Changes, rather than stale whole snapshots, are replayed inside a read/write transaction. */
export type Change = { path: string[]; value?: unknown; kind: "set" | "delete" | "add" | "list"; remove?: unknown[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function changes(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (equal(before, after)) return [];
  if (path[0] === "days" && path.length === 3 && typeof after === "number")
    return [{ path, kind: "add", value: after - (typeof before === "number" ? before : 0) }];
  if (path.length === 1 && ["bookmarks", "mistakes", "typing"].includes(path[0]) && Array.isArray(before) && Array.isArray(after))
    return [{ path, kind: "list", value: after.filter(a => !before.some(b => equal(a, b))), remove: before.filter(b => !after.some(a => equal(a, b))) }];
  // A card and a session each represent one coherent revision, never a mixture of two answers.
  if (object(after) && (object(before) || before === undefined) && path[0] !== "session" && !(path[0] === "cards" && path.length === 2)) {
    const prev = object(before) ? before : {};
    return [...new Set([...Object.keys(prev), ...Object.keys(after)])].flatMap(k => changes(prev[k], after[k], [...path, k]));
  }
  return [{ path, kind: after === undefined ? "delete" : "set", value: after }];
}

export function apply<T>(base: T, patch: Change[]): T {
  let result = structuredClone(base) as any;
  for (const c of patch) {
    if (!c.path.length) { result = structuredClone(c.value); continue; }
    let target = result;
    for (const k of c.path.slice(0, -1)) {
      // Define own properties so untrusted IDs cannot mutate Object.prototype.
      if (!Object.hasOwn(target, k) || !object(target[k])) Object.defineProperty(target, k, { value: {}, writable: true, enumerable: true, configurable: true });
      target = target[k];
    }
    const k = c.path.at(-1)!;
    const old = Object.hasOwn(target, k) ? target[k] : undefined;
    let value = c.value;
    if (c.kind === "delete") { delete target[k]; continue; }
    if (c.kind === "add") value = (typeof old === "number" ? old : 0) + (c.value as number);
    if (c.kind === "list") {
      const added = c.value as unknown[];
      const kept = (Array.isArray(old) ? old : []).filter(v => !c.remove?.some(r => equal(v, r)) && !added.some(a => equal(v, a)));
      value = k === "typing" ? [...kept, ...added].slice(-500) : [...added, ...kept].slice(0, k === "mistakes" ? 300 : 20000);
    }
    Object.defineProperty(target, k, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
  }
  return result;
}

export function readLegacy(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("word-atlas", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("records");
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}

export async function persist<T>(key: string, fallback: T, patch: Change[], sanitize: (v: unknown) => T): Promise<T> {
  // Old browsers retain localStorage support. An available but failing IDB must not
  // silently switch authorities and later resurrect stale data.
  if (typeof indexedDB === "undefined") {
    const commit = () => {
      const value = sanitize(apply(sanitize(readLegacy(key) ?? fallback), patch));
      if (patch.length || readLegacy(key) === null) localStorage.setItem(key, JSON.stringify(value));
      return value;
    };
    return typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request(`word-atlas:${key}`, commit) : commit();
  }
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const records = tx.objectStore("records");
    const req = records.get(key);
    let result: T;
    req.onsuccess = () => {
      try {
        result = sanitize(apply(sanitize(req.result ?? readLegacy(key) ?? fallback), patch));
        if (patch.length || req.result === undefined) records.put(result, key);
      } catch { try { tx.abort(); } catch { /* A storage failure may already have aborted the transaction. */ } }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => { /* onabort is the final outcome */ };
  });
}
