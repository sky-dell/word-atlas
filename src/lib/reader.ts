import {profileStorage} from '../store/profileStorage';
import { scopedKey, notifyExtras, profileGeneration, profileTransitioning } from '../store/profile';
import { useEffect, useState } from 'react';

/** Public reading/drill contracts. Content is loaded from this deployment only. */
export type Judgment = 'T' | 'F' | 'NG';
export interface ReadingItem { id: string; ids: string[]; title: string; titleZh: string; topic: string; cefr: number }
export interface ReadingArticle extends ReadingItem { paras: string[]; zh: string[]; q: { s: string; a: Judgment; why: string }[] }
export interface ParaphraseItem { w: string; src: string; key: string; para: string; ans: string; opts: string[]; note: string; cefr: number }
export interface ConfusableGroup {
  id: string; cefr: number; words: { w: string; id?: string; pos: string; zh: string }[];
  core: string; points: string[]; ex: { en: string; zh: string }[]; hook: string;
  quiz: { en: string; ans: string; zh: string }[];
}
export interface Book { id: string; title: string; titleZh: string; author: string; authorZh: string; level: string; chapterCount: number; coverSmall: string | null; firstLine: string; firstLineZh: string; credit?: string; chapters: { n: number; label: string; labelZh: string; titleZh?: string; minutes: number; words: number; ready?: boolean }[] }
export interface Chapter { book: string; n: number; label: string; labelZh: string; titleZh: string | null; paras: { id: string; kind: string; en: string; zh: string; audio?: string | null; audioZh?: string | null; words: [number, number, string, number][] }[] }
export interface TextPiece { text: string; id?: string; level?: number }

export function localAsset(path: string, base = import.meta.env?.BASE_URL ?? '/') {
  if (!/^(?:atlas\/extras|books)\/[a-zA-Z0-9/_\-.]+$/.test(path) || path.split('/').includes('..')) throw new Error('无效的内容路径');
  return `${base.replace(/\/?$/, '/')}${path}`;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const text = (v: unknown) => typeof v === 'string';
const fields = (v: unknown, keys: string[]) => object(v) && keys.every(k => text(v[k]));
export function isReadingItem(v: unknown): v is ReadingItem { return fields(v, ['id', 'title', 'titleZh', 'topic']) && object(v) && strings(v.ids) && Number.isInteger(v.cefr); }
export function isReadingArticle(v: unknown): v is ReadingArticle {
  return isReadingItem(v) && strings((v as ReadingArticle).paras) && strings((v as ReadingArticle).zh) && Array.isArray((v as ReadingArticle).q) && (v as ReadingArticle).q.every(q => fields(q, ['s', 'why']) && ['T', 'F', 'NG'].includes(q.a));
}
export function isParaphrase(v: unknown): v is ParaphraseItem {
  if (!object(v) || !fields(v, ['w', 'src', 'key', 'para', 'ans', 'note']) || !strings(v.opts) || !Number.isInteger(v.cefr)) return false;
  const p = v as unknown as ParaphraseItem;
  return !!p.ans && p.src.toLowerCase().includes(p.key.toLowerCase()) && p.para.toLowerCase().includes(p.ans.toLowerCase()) && p.opts.length > 0 && !p.opts.some(o => o.toLowerCase() === p.ans.toLowerCase());
}
export function isConfusable(v: unknown): v is ConfusableGroup {
  if (!object(v) || !fields(v, ['id', 'core', 'hook']) || !strings(v.points) || !Array.isArray(v.words) || !Array.isArray(v.quiz) || !Array.isArray(v.ex)) return false;
  const g = v as unknown as ConfusableGroup;
  return g.words.length >= 2 && g.words.every(w => fields(w, ['w', 'pos', 'zh'])) && g.ex.every(e => fields(e, ['en', 'zh'])) && g.quiz.every(q => fields(q, ['en', 'ans', 'zh']) && g.words.some(w => w.w === q.ans));
}
export function isBook(v: unknown): v is Book {
  return object(v) && fields(v, ['id', 'title', 'titleZh', 'author', 'authorZh', 'level']) && Array.isArray(v.chapters) && v.chapters.every(c => object(c) && Number.isInteger(c.n) && fields(c, ['label', 'labelZh']));
}
export function isChapter(v: unknown): v is Chapter {
  return object(v) && fields(v, ['book', 'label', 'labelZh']) && Number.isInteger(v.n) && Array.isArray(v.paras) && v.paras.length > 0 && v.paras.every(p => {
    if (!object(p) || !fields(p, ['id', 'kind', 'en', 'zh']) || !Array.isArray(p.words)) return false;
    let end = 0;
    return p.words.every(w => {
      if (!Array.isArray(w) || w.length !== 4 || !Number.isInteger(w[0]) || !Number.isInteger(w[1]) || w[0] < end || w[1] <= w[0] || w[1] > (p.en as string).length || !text(w[2])) return false;
      end = w[1]; return true;
    });
  });
}

export async function fetchContent<T>(path: string, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
  const response = await fetch(localAsset(path), { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('内容暂时没能打开，请重试。');
  const value: unknown = await response.json();
  if (!validate(value)) throw new Error('内容数据不完整，请重试。');
  return value;
}
export function useReaderContent<T>(path: string, validate: (value: unknown) => value is T) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path });
  useEffect(() => {
    const abort = new AbortController(); setState({ path });
    fetchContent(path, validate, abort.signal).then(data => { if (!abort.signal.aborted) setState({ path, data }); }, error => { if (!abort.signal.aborted) setState({ path, error: error instanceof Error ? error.message : '内容暂时没能打开。' }); });
    return () => abort.abort();
  }, [path, revision, validate]);
  return { ...(state.path === path ? state : { path }), retry: () => setRevision(n => n + 1) };
}
export function collection<T>(key: string, validate: (value: unknown) => value is T) {
  return (v: unknown): v is Record<string, T[]> => object(v) && Array.isArray(v[key]) && (v[key] as unknown[]).every(validate);
}

export function markedText(source: string): TextPiece[] {
  const pieces: TextPiece[] = []; let end = 0;
  for (const match of source.matchAll(/\[\[([^|\]\n]+)\|([^\]\n]+)\]\]/g)) {
    if (match.index! > end) pieces.push({ text: source.slice(end, match.index) });
    pieces.push({ id: match[1], text: match[2] }); end = match.index! + match[0].length;
  }
  if (end < source.length) pieces.push({ text: source.slice(end) });
  return pieces;
}
export function chapterText(en: string, words: Chapter['paras'][number]['words']): TextPiece[] {
  const pieces: TextPiece[] = []; let end = 0;
  for (const [a, b, id, level] of words) {
    if (a < end || b > en.length || b <= a) continue;
    if (a > end) pieces.push({ text: en.slice(end, a) });
    pieces.push({ text: en.slice(a, b), id, level }); end = b;
  }
  if (end < en.length) pieces.push({ text: en.slice(end) });
  return pieces;
}

export function paraphraseLevels(items: ParaphraseItem[], size = 8, order: (id: string) => number = () => 0) {
  if (!Number.isInteger(size) || size < 1) throw new Error('无效的关卡大小');
  const levels: { id: string; n: number; cefr: number; items: ParaphraseItem[] }[] = [];
  for (const cefr of [...new Set(items.map(i => i.cefr))].sort((a, b) => a - b)) {
    const band = items.filter(i => i.cefr === cefr).sort((a, b) => order(a.w) - order(b.w) || a.w.localeCompare(b.w));
    for (let i = 0; i < band.length; i += size) levels.push({ id: `${cefr}-${i / size + 1}`, n: levels.length + 1, cefr, items: band.slice(i, i + size) });
  }
  return levels;
}
export function answerOptions(item: ParaphraseItem): string[] {
  const options = [...new Set([item.ans, ...item.opts])];
  // Stable permutation: answers do not jump after selecting or rerendering.
  let seed = [...item.w].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  for (let i = options.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [options[i], options[j]] = [options[j], options[i]]; }
  return options;
}

export interface ExerciseRecord { attempts: number; correct: number; total: number; best: number; at: number }
export type ExerciseRecords = Record<string, ExerciseRecord>;
export const exerciseKey = (dataset: string) => scopedKey(`word-atlas:extras:v1:${dataset}`);
export function readRecords(dataset: string): ExerciseRecords {
  try {
    const value: unknown = JSON.parse(profileStorage.getItem(exerciseKey(dataset)) || '{}');
    if (!object(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, ExerciseRecord] => {
      const r = pair[1];
      return object(r) && ['attempts', 'correct', 'total', 'best', 'at'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));
    }));
  } catch { return {}; }
}
function assertIdentity(epoch: number) { if (epoch !== profileGeneration() || profileTransitioning()) throw new Error('账号已变化，请重新打开练习。'); }
export function recordExercise(dataset: string, id: string, correct: number, total: number, epoch = profileGeneration()): ExerciseRecords {
  assertIdentity(epoch);
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(correct) || correct < 0 || correct > total) throw new Error('无效的练习成绩');
  const records = readRecords(dataset), old = records[id];
  records[id] = { attempts: (old?.attempts ?? 0) + 1, correct, total, best: Math.max(old?.best ?? 0, correct / total), at: Date.now() };
  profileStorage.setItem(exerciseKey(dataset), JSON.stringify(records));
  notifyExtras();
  return records;
}
export interface ReaderPreferences { size: number; bilingual: boolean; highlight: boolean; language: 'en' | 'zh'; speed: number }
export function readerPreferences(): ReaderPreferences {
  try { const v = JSON.parse(profileStorage.getItem(scopedKey('word-atlas:reader:v1')) || '{}'); return { size: typeof v?.size === 'number' && Number.isFinite(v.size) ? Math.max(16, Math.min(28, v.size)) : 20, bilingual: v?.bilingual === true, highlight: v?.highlight !== false, language: v?.language === 'zh' ? 'zh' : 'en', speed: [.8, 1, 1.2].includes(v?.speed) ? v.speed : 1 }; }
  catch { return { size: 20, bilingual: false, highlight: true, language: 'en', speed: 1 }; }
}
export function saveReaderPreferences(value: ReaderPreferences, epoch = profileGeneration()) { assertIdentity(epoch); profileStorage.setItem(scopedKey('word-atlas:reader:v1'), JSON.stringify(value)); notifyExtras(); }
export interface ReadingPosition { kind: 'short' | 'books'; id: string; chapter?: number; paragraph: number }
export function readPosition(): ReadingPosition | null {
  try { const v = JSON.parse(profileStorage.getItem(scopedKey('word-atlas:reader-position:v1')) || 'null'); return v && ['short', 'books'].includes(v.kind) && typeof v.id === 'string' && Number.isInteger(v.paragraph) && v.paragraph >= 0 && (v.kind === 'short' || Number.isInteger(v.chapter) && v.chapter > 0) ? v : null; } catch { return null; }
}
export function savePosition(value: ReadingPosition, epoch = profileGeneration()) { assertIdentity(epoch); profileStorage.setItem(scopedKey('word-atlas:reader-position:v1'), JSON.stringify(value)); notifyExtras(); }
