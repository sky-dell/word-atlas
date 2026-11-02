import { scopedKey, subscribeProfile, notifyExtras } from '../store/profile';
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useAtlas } from "../atlas/context";

export const APPEARANCE_KEY = "word-atlas:appearance";
export interface Appearance {
  theme: "dark" | "light" | "system" | "starlight" | "aurora";
  wordFont: "sans" | "serif" | "classic";
  illus: "atlas" | "classic";
  route: "level" | "topic";
  routeTopic: string;
  recall: boolean;
  repeatGap: 0 | 0.5 | 1;
  examDate: string;
  targetBand: number;
  planAuto: boolean;
}

export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  theme: "starlight", wordFont: "sans", illus: "atlas", route: "level", routeTopic: "",
  recall: true, repeatGap: 0, examDate: "", targetBand: 6.5, planAuto: false,
});

// Only add individually verified, locally available and licensed media here.
// A missing classic image always falls back to the repository illustration.
export let CLASSIC_ILLUSTRATIONS: Readonly<Record<string, string>> = Object.freeze({});
export let classicAvailable = false;
let classicLoad: Promise<void> | undefined;
/** Optional local manifest: { "library": "library.webp" }. Download media first.
 * Publish it as public/atlas/classic/manifest.json; no online media are requested.
 * A real decoded image enables the style. Other images load on demand in
 * Illustration, where failures fall back to the repository artwork.
 */
export function loadClassicManifest(): Promise<void> {
  return classicLoad ??= (async () => {
    try {
      const base = `${import.meta.env.BASE_URL}atlas/classic/`;
      const response = await fetch(`${base}manifest.json`);
      if (!response.ok || !response.headers.get("content-type")?.includes("json")) return;
      const manifest: unknown = await response.json();
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
      const verified: Record<string, string> = {};
      let confirmed = false;
      for (const [word, filename] of Object.entries(manifest)) {
        if (!/^[a-z][a-z '-]{0,80}$/i.test(word) || typeof filename !== "string" || !/^[a-z0-9_-]+\.webp$/i.test(filename)) continue;
        const url = `${base}img/${filename}`;
        // Decode instead of trusting SPA fallback responses or filename extensions.
        const valid = confirmed || await new Promise<boolean>((resolve) => {
          const image = new Image();
          const timer = window.setTimeout(() => { image.src = ""; resolve(false); }, 5000);
          image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); };
          image.onerror = () => { clearTimeout(timer); resolve(false); };
          image.src = url;
        });
        if (valid) { confirmed = true; verified[word.toLowerCase()] = url; }
      }
      CLASSIC_ILLUSTRATIONS = Object.freeze(verified);
      classicAvailable = Object.keys(verified).length > 0;
      snapshot = Object.freeze({ ...snapshot });
      emit();
    } catch { /* Optional local resources; repository artwork remains available. */ }
  })();
}

function normalize(value: unknown): Readonly<Appearance> {
  const s = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const d = DEFAULT_APPEARANCE;
  return Object.freeze({
    theme: ["dark", "light", "system", "starlight", "aurora"].includes(String(s.theme)) ? s.theme as Appearance["theme"] : d.theme,
    wordFont: ["sans", "serif", "classic"].includes(String(s.wordFont)) ? s.wordFont as Appearance["wordFont"] : d.wordFont,
    illus: s.illus === "classic" ? "classic" : "atlas",
    route: s.route === "topic" ? "topic" : "level",
    routeTopic: typeof s.routeTopic === "string" && /^[a-z0-9_-]{0,64}$/i.test(s.routeTopic) ? s.routeTopic : "",
    recall: typeof s.recall === "boolean" ? s.recall : d.recall,
    repeatGap: s.repeatGap === 0.5 || s.repeatGap === 1 ? s.repeatGap : 0,
    examDate: typeof s.examDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.examDate) && !Number.isNaN(Date.parse(`${s.examDate}T12:00:00`)) && new Date(`${s.examDate}T12:00:00`).toISOString().slice(0, 10) === s.examDate ? s.examDate : "",
    targetBand: typeof s.targetBand === "number" && Number.isFinite(s.targetBand) ? Math.round(Math.min(8.5, Math.max(5, s.targetBand)) * 2) / 2 : d.targetBand,
    planAuto: typeof s.planAuto === "boolean" ? s.planAuto : false,
  });
}

function read(): Readonly<Appearance> {
  try { return normalize(JSON.parse(localStorage.getItem(scopedKey(APPEARANCE_KEY)) || "null")); }
  catch { return DEFAULT_APPEARANCE; }
}

// Cached immutable snapshot: getSnapshot must never allocate during rendering.
let snapshot = read();
const listeners = new Set<() => void>();
let saveError = false;
const emit = () => listeners.forEach((listener) => listener());
export function getAppearance() { return snapshot; }
export function setAppearance(patch: Partial<Appearance>) {
  const next = normalize({ ...snapshot, ...patch });
  if (JSON.stringify(next) === JSON.stringify(snapshot) && !saveError) return;
  snapshot = next;
  try { localStorage.setItem(scopedKey(APPEARANCE_KEY), JSON.stringify(next)); saveError = false; }
  catch { saveError = true; }
  emit(); notifyExtras();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== scopedKey(APPEARANCE_KEY) && event.key !== null) return;
    const next = read();
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; emit(); }
  });
}
subscribeProfile(() => { snapshot = read(); saveError = false; emit(); });
if (typeof window !== 'undefined') window.addEventListener('word-atlas:extras-changed', () => { const next = read(); if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; emit(); } });
export const appearance = { getSnapshot: getAppearance, subscribe, settings: setAppearance };
export function useAppearance() {
  return useSyncExternalStore(subscribe, getAppearance, () => DEFAULT_APPEARANCE);
}

/** Mount once in App. Replaces App's legacy useTheme effect. */
export function AppearanceController() {
  const { theme, wordFont, illus } = useAppearance();
  useEffect(() => { void loadClassicManifest(); }, []);
  useEffect(() => {
    const root = document.documentElement;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const skin = theme === "starlight" || theme === "aurora";
      const dark = skin || theme === "dark" || (theme === "system" && media.matches);
      root.dataset.appearance = theme;
      root.dataset.font = wordFont;
      root.dataset.illus = illus;
      if (theme === "system") root.removeAttribute("data-theme");
      else root.dataset.theme = dark ? "dark" : "light";
      if (skin) root.dataset.skin = theme;
      else root.removeAttribute("data-skin");
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "starlight" ? "#080b18" : theme === "aurora" ? "#05060f" : dark ? "#0d1120" : "#f6f1e7");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, wordFont, illus]);
  return null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="field"><div><b>{label}</b>{hint && <small>{hint}</small>}</div>{children}</div>;
}
function Choices<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map(([key, text]) => <button type="button" key={key} className={value === key ? "is-on" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}</div>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <label className="field toggle"><b>{label}</b><input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} /><span className="switch" aria-hidden="true" /></label>;
}

/** Standalone settings; reads/writes only word-atlas:appearance. */
export interface AppearanceCapabilities { route?: boolean; recall?: boolean; repeatGap?: boolean; examPlan?: boolean }
export function AppearanceSettings({ capabilities = {} }: { capabilities?: AppearanceCapabilities }) {
  const s = useAppearance();
  const atlas = useAtlas();
  return <section className="panel settings appearance-settings">
    <h3 className="eyebrow">外观与学习偏好</h3>
    <Field label="外观"><Choices label="主题" value={s.theme} options={[["dark", "深色"], ["light", "浅色"], ["system", "跟随系统"], ["starlight", "星光"], ["aurora", "极光"]]} onChange={(theme) => setAppearance({ theme })} /></Field>
    <Field label="单词字体" hint="Aa · abandon · 在词卡中预览字体。"><Choices label="单词字体" value={s.wordFont} options={[["sans", "无衬线"], ["serif", "衬线"], ["classic", "经典"]]} onChange={(wordFont) => setAppearance({ wordFont })} /><p className="appearance-font-preview" lang="en">Aa · abandon</p></Field>
    <Field label="插画" hint={classicAvailable ? "经典资源缺失的词会使用图鉴插画。" : "当前使用仓库插画，经典插画资源暂未提供。"}>
      <div className="segmented" role="group" aria-label="插画风格"><button type="button" className={s.illus === "atlas" ? "is-on" : ""} aria-pressed={s.illus === "atlas"} onClick={() => setAppearance({ illus: "atlas" })}>图鉴插画</button><button type="button" disabled={!classicAvailable} className={s.illus === "classic" ? "is-on" : ""} aria-pressed={s.illus === "classic"} onClick={() => setAppearance({ illus: "classic" })}>经典插画{!classicAvailable && " · 暂不可用"}</button></div>
    </Field>
    <fieldset disabled={!capabilities.route} className="appearance-group"><legend>学习路线{!capabilities.route && " · 尚未接入学习流程"}</legend>
    <Field label="学习路线" hint="按难度循序渐进，或集中学习一个话题。"><Choices label="学习路线" value={s.route} options={[["level", "按难度"], ["topic", "按话题"]]} onChange={(route) => setAppearance({ route, routeTopic: s.routeTopic || atlas.topics[0]?.[0] || "" })} />{s.route === "topic" && <select aria-label="学习话题" value={s.routeTopic || atlas.topics[0]?.[0] || ""} onChange={(e) => setAppearance({ routeTopic: e.target.value })}>{atlas.topics.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}</Field>
    </fieldset>
    <fieldset disabled={!capabilities.recall} className="appearance-group"><legend>主动回忆{!capabilities.recall && " · 尚未接入学习流程"}</legend>
    <Toggle label="复习时先回想，再揭晓" value={s.recall} onChange={(recall) => setAppearance({ recall })} />
    </fieldset>
    <fieldset disabled={!capabilities.repeatGap} className="appearance-group"><legend>重复朗读{!capabilities.repeatGap && " · 尚未接入发音播放"}</legend>
    <Field label="重复朗读" hint="开启后，再次朗读前留出跟读时间。"><Choices label="重复朗读间隔" value={s.repeatGap} options={[[0, "关闭"], [0.5, "间隔 0.5 秒"], [1, "间隔 1 秒"]]} onChange={(repeatGap) => setAppearance({ repeatGap })} /></Field>
    </fieldset>
    <fieldset disabled={!capabilities.examPlan} className="appearance-group"><legend>考试计划{!capabilities.examPlan && " · 尚未接入每日计划"}</legend>
    <h3 className="eyebrow appearance-section-title">考试计划</h3>
    <Field label="考试日期" hint="可留空，按自己的节奏学习。"><input type="date" aria-label="考试日期" value={s.examDate} onChange={(e) => setAppearance({ examDate: e.target.value })} /></Field>
    <Field label="目标分数"><Choices label="雅思目标分数" value={s.targetBand} options={[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5].map((n) => [n, String(n)] as const)} onChange={(targetBand) => setAppearance({ targetBand })} /></Field>
    <Toggle label="根据考试计划调整每日新词" value={s.planAuto} onChange={(planAuto) => setAppearance({ planAuto })} />
    </fieldset>
    {saveError && <p className="warn-text" role="status">浏览器未能保存偏好，本次设置仅在当前页面有效。</p>}
  </section>;
}
