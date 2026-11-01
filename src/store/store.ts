import {isTemporaryKey,profileStorage} from './profileStorage';
import { useSyncExternalStore } from "react";
import { activateProfile, beginProfileSwitch, finishProfileSwitch, getProfile, notifyExtras, profileGeneration, profilePrefix, profileTransitioning, scopedKey } from './profile';
import type { Accent } from "../atlas/types";
import type { CardState, Grade } from "./srs";
import {
  apply,
  changes,
  persist,
  readLegacy,
  type Change,
} from "./persistence";

export type QuizKind = "meaning" | "picture" | "listen" | "spell";
export type Step =
  | { id: string; kind: "intro" }
  | { id: string; kind: QuizKind; retry?: boolean; options?: string[] };

export interface ActiveSession {
  id: string;
  started: number;
  steps: Step[];
  index: number;
  /** First-attempt grade per word; retries never change it. */
  graded: Record<string, Grade>;
  newIds: string[];
  reviewIds: string[];
  /** Answer shown but not yet continued; survives reload without double counting. */
  pending?: { correct: boolean; value: string };
  finished?: number;
}

export interface DayStat {
  n: number; // new words met
  r: number; // graded reviews (first attempts)
  c: number; // correct first attempts
  t: number; // active seconds
}

export interface TypingRound {
  at: number;
  mode: "word" | "sentence" | "dictation";
  items: number;
  wpm: number;
  accuracy: number;
}

export interface Progress {
  version: 2;
  datasetId: string;
  cards: Record<string, CardState>;
  bookmarks: string[];
  days: Record<string, DayStat>;
  typing: TypingRound[];
  session: ActiveSession | null;
  /** Rolling list of recent mistakes, newest first. */
  mistakes: string[];
}

export interface Settings {
  accent: Accent;
  autoplay: boolean;
  dailyNew: number;
  retention: number;
  theme: "system" | "light" | "dark";
  sfx: boolean;
  spell: boolean;
  startLevel: number;
  onboarded: boolean;
  dataset: "open" | "private";
  ambience:
    "off" | "stars" | "rain" | "sea" | "forest" | "fire" | "voyage" | "cafe";
  ambienceVolume: number;
  splash: boolean;
}

export const defaultSettings: Settings = {
  accent: "uk",
  autoplay: true,
  dailyNew: 10,
  retention: 0.9,
  theme: "dark",
  sfx: true,
  spell: true,
  startLevel: 0,
  onboarded: false,
  dataset: "open",
  ambience: "stars",
  ambienceVolume: 0.45,
  splash: true,
};

export const emptyProgress = (datasetId: string): Progress => ({
  version: 2,
  datasetId,
  cards: {},
  bookmarks: [],
  days: {},
  typing: [],
  session: null,
  mistakes: [],
});

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const settingsKey = () => scopedKey("word-atlas:settings");
const progressKey = (id: string) => scopedKey(`word-atlas:v2:${id}`);

function read<T>(key: string): T | null {
  return readLegacy(key) as T | null;
}

/* ---------- validation (backups and stored data are untrusted) ---------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo = -Infinity, hi = Infinity) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function validCard(v: unknown): v is CardState {
  return (
    isObj(v) &&
    num(v.due, 0) &&
    num(v.s, 0) &&
    num(v.d, 0, 11) &&
    num(v.el, 0) &&
    num(v.sd, 0) &&
    num(v.ls, 0) &&
    num(v.reps, 0) &&
    num(v.lapses, 0) &&
    [0, 1, 2, 3].includes(v.st as number) &&
    (v.last === undefined || num(v.last, 0)) &&
    num(v.seen, 0)
  );
}

export function sanitizeProgress(v: unknown, datasetId: string): Progress {
  const out = emptyProgress(datasetId);
  if (!isObj(v) || v.version !== 2) return out;
  if (isObj(v.cards))
    for (const [k, c] of Object.entries(v.cards))
      if (validCard(c) && k.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(k)) {
        const { due, s, d, el, sd, ls, reps, lapses, st, seen, last } = c;
        Object.defineProperty(out.cards, k, { value: { due, s, d, el, sd, ls, reps, lapses, st, seen, ...(last === undefined ? {} : { last }) }, enumerable: true, writable: true, configurable: true });
      }
  if (Array.isArray(v.bookmarks))
    out.bookmarks = v.bookmarks
      .filter((x): x is string => typeof x === "string" && x.length <= 200)
      .slice(0, 20000);
  if (Array.isArray(v.mistakes))
    out.mistakes = v.mistakes
      .filter((x): x is string => typeof x === "string" && x.length <= 200)
      .slice(0, 300);
  if (isObj(v.days))
    for (const [k, d] of Object.entries(v.days))
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(k) &&
        isObj(d) &&
        num(d.n, 0) &&
        num(d.r, 0) &&
        num(d.c, 0) &&
        num(d.t, 0)
      )
        out.days[k] = {
          n: d.n as number,
          r: d.r as number,
          c: d.c as number,
          t: d.t as number,
        };
  if (Array.isArray(v.typing))
    out.typing = v.typing
      .filter(
        (t): t is TypingRound =>
          isObj(t) &&
          num(t.at, 0) &&
          ["word", "sentence", "dictation"].includes(t.mode as string) &&
          num(t.items, 0) &&
          num(t.wpm, 0, 400) &&
          num(t.accuracy, 0, 100),
      )
      .slice(-500).map(({ at, mode, items, wpm, accuracy }) => ({ at, mode, items, wpm, accuracy }));
  const s = v.session;
  if (
    isObj(s) &&
    typeof s.id === "string" &&
    Array.isArray(s.steps) &&
    num(s.index, 0) &&
    isObj(s.graded)
  )
    out.session = s as unknown as ActiveSession;
  return out;
}

export function sanitizeSettings(v: unknown): Settings {
  const s = { ...defaultSettings };
  if (!isObj(v)) return s;
  if (v.accent === "uk" || v.accent === "us") s.accent = v.accent;
  if (typeof v.autoplay === "boolean") s.autoplay = v.autoplay;
  if (num(v.dailyNew, 0, 100)) s.dailyNew = Math.round(v.dailyNew as number);
  if (num(v.retention, 0.7, 0.97)) s.retention = v.retention as number;
  if (v.theme === "system" || v.theme === "light" || v.theme === "dark")
    s.theme = v.theme;
  if (typeof v.sfx === "boolean") s.sfx = v.sfx;
  if (typeof v.spell === "boolean") s.spell = v.spell;
  if (num(v.startLevel, 0, 5))
    s.startLevel = Math.round(v.startLevel as number);
  if (typeof v.onboarded === "boolean") s.onboarded = v.onboarded;
  if (v.dataset === "open" || v.dataset === "private") s.dataset = v.dataset;
  if (
    [
      "off",
      "stars",
      "rain",
      "sea",
      "forest",
      "fire",
      "voyage",
      "cafe",
    ].includes(v.ambience as string)
  )
    s.ambience = v.ambience as Settings["ambience"];
  if (num(v.ambienceVolume, 0, 1))
    s.ambienceVolume = v.ambienceVolume as number;
  if (typeof v.splash === "boolean") s.splash = v.splash;
  return s;
}

/* ---------- store ---------- */

interface State {
  progress: Progress;
  settings: Settings;
  saveError: boolean;
  ready: boolean;
}

let state: State = {
  progress: emptyProgress("word-atlas-open"),
  settings: sanitizeSettings(read(settingsKey())),
  saveError: false,
  ready: false,
};
const listeners = new Set<() => void>();
let saveTimer: number | undefined;
const keyInfo = new Map<string, { epoch: number; plain: string }>();
const pending = new Map<string, Change[]>();
const snapshots = new Map<string, Progress>();
const failures = new Set<string>();
let work: Promise<void> = Promise.resolve();
/** Progress is written only after it has been read from storage for this dataset. */
let loadedId: string | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 250);
}

function enqueue(key: string, patch: Change[]) {
  if (!keyInfo.has(key)) keyInfo.set(key, { epoch: profileGeneration(), plain: key.slice(profilePrefix().length) });
  if (patch.length) pending.set(key, [...(pending.get(key) ?? []), ...patch]);
}

function saveStatus() {
  const prefix = profilePrefix();
  const saveError = [...failures].some(key => prefix ? key.startsWith(prefix) : !key.startsWith('word-atlas:account:'));
  if (saveError !== state.saveError) {
    state = { ...state, saveError };
    emit();
  }
}

function sync(key: string): Promise<void> {
  const info = keyInfo.get(key) ?? { epoch: profileGeneration(), plain: key.slice(profilePrefix().length) };
  keyInfo.set(key, info);
  const { epoch, plain } = info;
  const isSettings = plain === 'word-atlas:settings';
  const id = plain.slice("word-atlas:v2:".length);
  work = work.then(async () => {
    const batch = pending.get(key) ?? [];
    const sanitize = (v: unknown) =>
      isSettings ? sanitizeSettings(v) : sanitizeProgress(v, id);
    try {
      const value = await persist(
        key,
        isSettings ? defaultSettings : emptyProgress(id),
        batch,
        sanitize,
      );
      const rest = (pending.get(key) ?? []).slice(batch.length);
      if (rest.length) pending.set(key, rest);
      else pending.delete(key);
      failures.delete(key);
      const current = sanitize(apply(value, rest));
      if (epoch !== profileGeneration()) return;
      if (isSettings) state = { ...state, settings: current as Settings };
      else {
        snapshots.set(id, current as Progress);
        if (loadedId === id)
          state = { ...state, progress: current as Progress, ready: true };
      }
      saveStatus();
      emit();
      if (batch.length && !isTemporaryKey(key)) {
        channel?.postMessage(key);
        // Also wake tabs that do not support BroadcastChannel. Never publish stale snapshots.
        try {
          profileStorage.setItem(
            "word-atlas:changed",
            JSON.stringify([key, Date.now(), Math.random()]),
          );
        } catch {
          /* IDB is already committed */
        }
      }
    } catch {
      failures.add(key);
      if (epoch !== profileGeneration()) return;
      if (!isSettings && loadedId === id) state = { ...state, ready: true };
      saveStatus();
      emit();
      // Keep the exact batch for a later flush, including across dataset switches.
      if (typeof window !== "undefined") {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flush(), 1000);
      }
    }
  });
  return work;
}

export function flush(): Promise<void> {
  window.clearTimeout(saveTimer);
  for (const key of new Set([...pending.keys(), ...failures])) void sync(key);
  return work;
}

const channel =
  typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("word-atlas")
    : null;
function refresh(key: unknown) {
  if (key === settingsKey() || (loadedId && key === progressKey(loadedId)))
    void sync(key as string);
}
if (channel) channel.onmessage = (e) => refresh(e.data);
if (typeof window !== "undefined") {
  void sync(settingsKey());
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener(
    "visibilitychange",
    () => document.visibilityState === "hidden" && flush(),
  );
  // Another tab saved: adopt its data instead of keeping a stale copy.
  window.addEventListener("storage", (e) => {
    try {
      if (e.key === "word-atlas:changed" && e.newValue)
        refresh(JSON.parse(e.newValue)[0]);
      else refresh(e.key);
    } catch {
      /* ignore malformed writes */
    }
  });
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  useDataset(datasetId: string) {
    flush();
    if (loadedId) snapshots.set(loadedId, state.progress);
    state = {
      ...state,
      progress:
        snapshots.get(datasetId) ??
        sanitizeProgress(read(progressKey(datasetId)), datasetId),
      ready: false,
    };
    loadedId = datasetId;
    emit();
    void sync(progressKey(datasetId));
  },
  progress(fn: (p: Progress) => Progress) {
    if (profileTransitioning()) return;
    const before = structuredClone(state.progress);
    state = { ...state, progress: fn(state.progress) };
    if (loadedId === state.progress.datasetId)
      enqueue(progressKey(loadedId), changes(before, state.progress));
    emit();
    scheduleSave();
  },
  settings(patch: Partial<Settings>) {
    if (profileTransitioning()) return;
    const before = state.settings;
    state = { ...state, settings: { ...state.settings, ...patch } };
    enqueue(settingsKey(), changes(before, state.settings));
    emit();
    scheduleSave();
  },
};

let switching: Promise<void> = Promise.resolve();
export function switchProfile(id: string | null): Promise<void> {
  beginProfileSwitch();
  switching = switching.catch(() => {}).then(async () => {
    beginProfileSwitch();
    await flush();
    const datasetId = state.progress.datasetId;
    activateProfile(id);
    snapshots.clear(); loadedId = datasetId;
    keyInfo.set(settingsKey(), { epoch: profileGeneration(), plain: 'word-atlas:settings' });
    keyInfo.set(progressKey(datasetId), { epoch: profileGeneration(), plain: `word-atlas:v2:${datasetId}` });
    state = { progress: emptyProgress(datasetId), settings: sanitizeSettings(null), ready: false, saveError: false };
    emit();
    await sync(settingsKey()); await sync(progressKey(datasetId));
    finishProfileSwitch(); notifyExtras(); emit();
  });
  return switching;
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(state),
    () => select(state),
  );
}

export function bumpDay(p: Progress, patch: Partial<DayStat>): Progress {
  const k = dayKey();
  const d = p.days[k] ?? { n: 0, r: 0, c: 0, t: 0 };
  return {
    ...p,
    days: {
      ...p.days,
      [k]: {
        n: d.n + (patch.n ?? 0),
        r: d.r + (patch.r ?? 0),
        c: d.c + (patch.c ?? 0),
        t: d.t + (patch.t ?? 0),
      },
    },
  };
}

export function toggleBookmark(id: string) {
  store.progress((p) => ({
    ...p,
    bookmarks: p.bookmarks.includes(id)
      ? p.bookmarks.filter((x) => x !== id)
      : [id, ...p.bookmarks],
  }));
}

/* ---------- backup ---------- */

const backupKey = (key: string) =>
  [
    "word-atlas:appearance",
    "word-atlas:reader:v1",
    "word-atlas:reader-position:v1",
  ].includes(key) ||
  key.startsWith("word-atlas:extras:v1:") ||
  key.startsWith("word-atlas:illustration:");
export function exportExtras(profile: string | null = getProfile()) {
  const extras: Record<string, unknown> = {};
  try {
    for (let i = 0; i < profileStorage.length; i++) {
      const physical = profileStorage.key(i);
      const prefix = profilePrefix(profile);
      const key = physical?.startsWith(prefix) ? physical.slice(prefix.length) : null;
      if (physical && key && backupKey(key)) {
        const value = profileStorage.getItem(physical);
        if (value !== null)
          try {
            extras[key] = JSON.parse(value);
          } catch {
            extras[key] = value;
          }
      }
    }
  } catch {
    /* Main progress remains exportable. */
  }
  return sanitizeExtras(extras);
}

export function exportBackup() {
  flush();
  const { progress, settings } = state;
  return JSON.stringify(
    {
      app: "word-atlas",
      version: 2,
      exported: new Date().toISOString(),
      progress: { ...sanitizeProgress(progress, progress.datasetId), session: null },
      settings: sanitizeSettings(settings),
      extras: exportExtras(),
    },
    null,
    1,
  );
}

export function importBackup(
  text: string,
): { ok: true; cards: number } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件不是有效的 JSON。" };
  }
  if (
    !isObj(data) ||
    data.app !== "word-atlas" ||
    data.version !== 2 ||
    !isObj(data.progress)
  )
    return { ok: false, error: "这不是词与远方的学习备份。" };
  const id = state.progress.datasetId;
  if (data.progress.datasetId !== id)
    return { ok: false, error: "备份来自另一个词库，请先切换到对应词库。" };
  if (profileTransitioning()) return { ok: false, error: '正在切换账号，请稍后重试。' };
  let extras: Record<string, unknown>;
  try { extras = sanitizeExtras(data.extras); } catch { return { ok: false, error: '备份中的附加数据过大或无效。' }; }
  if (isObj(extras)) {
    const prefix=profilePrefix();
    const previous=new Map<string,string>();
    const incoming=new Map<string,string>();
    try {
      for(let i=0;i<profileStorage.length;i++) {
        const key=profileStorage.key(i);
        if(!key || (prefix ? !key.startsWith(prefix) : key.startsWith('word-atlas:account:'))) continue;
        if(backupKey(key.slice(prefix.length))) previous.set(key,profileStorage.getItem(key)!);
      }
      for (const [key, value] of Object.entries(extras)) {
        if (!backupKey(key)) continue;
        const serialized =
          typeof value === "string" ? value : JSON.stringify(value);
        if (serialized.length > 5_000_000)
          return { ok: false, error: "备份中的附加数据过大。" };
        incoming.set(scopedKey(key),serialized);
      }
      // Validate everything before touching storage. Replace this profile's
      // restoreable extras only; credentials, sync metadata and other users stay.
      for(const [key,value] of incoming) profileStorage.setItem(key,value);
      for(const key of previous.keys()) if(!incoming.has(key)) profileStorage.removeItem(key);
    } catch {
      // A quota failure must not leave a half-restored theme/reader history.
      // Removing new entries first frees the quota required by the old snapshot.
      try {
        for(const key of incoming.keys()) if(!previous.has(key)) profileStorage.removeItem(key);
        for(const [key,value] of previous) profileStorage.setItem(key,value);
      } catch { /* Main progress is still untouched; keep its safety export. */ }
      return {
        ok: false,
        error: "浏览器无法恢复附加学习数据，请检查存储空间。",
      };
    }
    if(typeof window!=='undefined')
      for(const key of new Set([...previous.keys(),...incoming.keys()]))
        window.dispatchEvent(new StorageEvent('storage',{key,newValue:incoming.get(key)??null}));
  }
  notifyExtras();
  const progress = sanitizeProgress({ ...data.progress, session: null }, id);
  enqueue(progressKey(id), [{ path: [], kind: "set", value: progress }]);
  enqueue(
    settingsKey(),
    changes(state.settings, {
      ...sanitizeSettings(data.settings),
      onboarded: true,
    }),
  );
  state = {
    ...state,
    progress,
    settings: { ...sanitizeSettings(data.settings), onboarded: true },
  };
  emit();
  flush();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("word-atlas:profile-restored"));
  return { ok: true, cards: Object.keys(progress.cards).length };
}

export function resetProgress() {
  try {
    profileStorage.removeItem(scopedKey(`word-atlas:extras:v1:${state.progress.datasetId}`));
  } catch {
    /* Main progress reset still runs. */
  }
  state = { ...state, progress: emptyProgress(state.progress.datasetId) };
  enqueue(progressKey(state.progress.datasetId), [
    { path: [], kind: "set", value: state.progress },
  ]);
  emit();
  flush();
}

/** Shared backup wire format; extras whitelist excludes identity, tokens and sync metadata. */
export function sanitizeExtras(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObj(value)) return out;
  const entries = Object.entries(value);
  if (entries.length > 20000) throw new Error('Too many extras');
  let total = 0;
  for (const [key, v] of entries) {
    if (!backupKey(key) || key.length > 300) continue;
    const serialized = typeof v === 'string' ? v : JSON.stringify(v);
    if (serialized === undefined || serialized.length > 2_000_000) throw new Error('Extra too large');
    total += key.length + serialized.length;
    if (total > 4_000_000) throw new Error('Extras too large');
    Object.defineProperty(out, key, { value: v, enumerable: true });
  }
  return out;
}
export async function importGuestProfile() {
  if (getProfile() === null) throw new Error('请先登录目标账号。');
  const epoch = profileGeneration(), id = state.progress.datasetId;
  const progress = await persist(`word-atlas:v2:${id}`, emptyProgress(id), [], v => sanitizeProgress(v, id));
  const settings = await persist('word-atlas:settings', defaultSettings, [], sanitizeSettings);
  if (epoch !== profileGeneration() || profileTransitioning()) throw new Error('账号已变化，请重试。');
  return importBackup(JSON.stringify({ app: 'word-atlas', version: 2, progress: { ...progress, session: null }, settings, extras: exportExtras(null) }));
}
