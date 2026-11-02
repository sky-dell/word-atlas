import { profileGeneration } from '../store/profile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Languages, Pause, Play, Search, Volume2 } from 'lucide-react';
import { useAtlas } from '../atlas/context';
import { go, openWord, useLocation } from '../lib/router';
import { useStore } from '../store/store';
import { stopAudio } from '../lib/audio';
import { chapterText, collection, isBook, isChapter, isReadingArticle, isReadingItem, localAsset, markedText, readPosition, readRecords, readerPreferences, recordExercise, savePosition, saveReaderPreferences, useReaderContent } from '../lib/reader';
import type { Book, Chapter, Judgment, ReadingArticle, ReadingPosition, TextPiece } from '../lib/reader';
import '../styles/reading-drills.css';
import { Karoline } from './Karoline';

const readingIndex = collection('items', isReadingItem);
const bookIndex = collection('books', isBook);
// Structural view permits this isolated page to compile while route additions land.
type ReadingRoute = { page: string; id?: string; book?: string; chapter?: number | string; tab?: string };
function navigate(route: ReadingRoute) { go(route as Parameters<typeof go>[0]); }

export function Reading() {
  const { route } = useLocation(); const r = route as ReadingRoute;
  const tab = r.tab === 'karoline' ? 'karoline' : r.book || r.tab !== 'short' && !r.id ? 'books' : 'short';
  const [query, setQuery] = useState(''), [level, setLevel] = useState('all'), [limit, setLimit] = useState(24);
  const atlas = useAtlas();
  const readings = useReaderContent('atlas/extras/readings/index.json', readingIndex);
  const books = useReaderContent('books/index.json', bookIndex);
  const resume = readPosition();
  const book = books.data?.books.find(b => b.id === r.book);
  const articleId = r.id && /^[a-zA-Z0-9_-]+$/.test(r.id) ? r.id : undefined;
  const chapter = Number(r.chapter) > 0 && Number.isInteger(Number(r.chapter)) ? Number(r.chapter) : 1;
  const filtered = useMemo(() => (readings.data?.items ?? []).filter(a => (level === 'all' || String(a.cefr) === level) && `${a.title} ${a.titleZh}`.toLowerCase().includes(query.toLowerCase())), [readings.data, level, query]);
  const openResume = () => resume && navigate({ page: 'read', ...(resume.kind === 'books' ? { book: resume.id, chapter: resume.chapter } : { id: resume.id, tab: 'short' }) });
  return <div className="page wa-reading">
    <header className="page-head"><p className="eyebrow">Reading room</p><h1 className="display">书房</h1><p className="lede">把学过的词，读进故事里。</p></header>
    <nav className="segmented wa-tabs" aria-label="书房分类">{(['books', 'short', 'karoline'] as const).map(t => <button key={t} className={tab === t ? 'is-on' : ''} aria-pressed={tab === t} onClick={() => navigate({ page: 'read', tab: t })}>{t === 'books' ? '原版书' : t === 'short' ? '词与远方短文' : '卡罗琳特辑（Karoline）'}</button>)}</nav>
    {tab !== 'karoline' && !r.id && !r.book && resume && <button className="wa-resume panel" onClick={openResume}><BookOpen size={20} /><span>继续上次阅读 <small>{resume.kind === 'books' ? `第 ${resume.chapter} 章` : readings.data?.items.find(a => a.id === resume.id)?.titleZh ?? resume.id}</small></span><ArrowRight size={18} /></button>}
    {tab === 'karoline' ? <Karoline id={r.id} /> : tab === 'books' ? r.book ? book ? <>
      <button className="wa-back" onClick={() => navigate({ page: 'read', tab: 'books' })}><ArrowLeft size={16} /> 全部书籍</button>
      <div className="wa-chapter-select"><label htmlFor="wa-chapter">{book.titleZh} · 章节</label><select id="wa-chapter" value={chapter} onChange={e => navigate({ page: 'read', book: book.id, chapter: Number(e.target.value) })}>{book.chapters.map(c => <option key={c.n} value={c.n}>{c.labelZh} · {c.titleZh}</option>)}</select></div>
      <BookChapter key={`${book.id}-${chapter}`} book={book} number={chapter} />
    </> : <ContentStatus error={books.error || (books.data ? '没有找到这本书。' : undefined)} retry={books.retry} /> : books.data ? <div className="wa-books">{books.data.books.map(b => <button className="wa-book panel" key={b.id} onClick={() => navigate({ page: 'read', book: b.id, chapter: 1 })}>
      {b.coverSmall && <img src={localAsset(b.coverSmall)} alt={`${b.titleZh}封面`} />}<span className="wa-book-copy"><small className="eyebrow">{b.level} · {b.chapterCount} 章</small><strong>{b.titleZh}</strong><span lang="en">{b.title}</span><small>{b.authorZh} · {b.author}</small><em>{b.firstLineZh}</em><span className="btn btn-primary">开始阅读 <ArrowRight size={16} /></span></span>
    </button>)}</div> : <ContentStatus error={books.error} retry={books.retry} /> : <>
      {articleId && <><button className="wa-back" onClick={() => navigate({ page: 'read', tab: 'short' })}><ArrowLeft size={16} /> 全部短文</button><ShortArticle key={articleId} id={articleId} /></>}
      <section className="wa-library" aria-labelledby="wa-library-title"><div className="wa-section-head"><h2 id="wa-library-title">短文列表 <small>{readings.data?.items.length ?? 0} 篇</small></h2><label className="wa-search"><Search size={16} /><input aria-label="搜索短文" placeholder="搜索英文标题或中文" value={query} onChange={e => { setQuery(e.target.value); setLimit(24); }} /></label></div>
        <div className="segmented wa-filters" role="group" aria-label="短文难度"><button className={level === 'all' ? 'is-on' : ''} aria-pressed={level === 'all'} onClick={() => { setLevel('all'); setLimit(24); }}>全部</button>{atlas.cefr.map((label, i) => <button key={label} className={level === String(i) ? 'is-on' : ''} aria-pressed={level === String(i)} onClick={() => { setLevel(String(i)); setLimit(24); }}>{label}</button>)}</div>
        {readings.data ? <><div className="wa-short-grid">{filtered.slice(0, limit).map(a => <ShortCard key={a.id} item={a} current={articleId === a.id} />)}</div>{!filtered.length && <p className="muted">没有找到符合条件的短文。</p>}{limit < filtered.length && <button className="btn btn-ghost wa-more" onClick={() => setLimit(n => n + 24)}>再看 {Math.min(24, filtered.length - limit)} 篇</button>}</> : <ContentStatus error={readings.error} retry={readings.retry} />}
      </section>
    </>}
  </div>;
}

function ShortCard({ item, current }: { item: ReadingArticle | import('../lib/reader').ReadingItem; current: boolean }) {
  const atlas = useAtlas(), cards = useStore(s => s.progress.cards);
  const done = !!readRecords(atlas.id)[`read:${item.id}`];
  const learned = item.ids.filter(id => !!cards[id]).length;
  return <button className={`wa-short-card panel ${current ? 'is-current' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => navigate({ page: 'read', id: item.id, tab: 'short' })}><span className="chip">{atlas.cefr[item.cefr]}</span><strong lang="en">{item.title}</strong><span>{item.titleZh}</span><small>{learned}/{item.ids.length} 个词已学 <span>{done ? '✓ 已练习' : '未练习'}</span></small></button>;
}
export function ContentStatus({ error, retry }: { error?: string; retry: () => void }) { return <section className="panel wa-status" role="status" aria-busy={!error}><BookOpen size={28} /><h2>{error ? '内容暂时没能打开' : '正在加载……'}</h2>{error && <><p>{error}</p><button className="btn btn-ghost" onClick={retry}>重试</button></>}</section>; }

function ShortArticle({ id }: { id: string }) {
  const resource = useReaderContent(`atlas/extras/readings/${id}.json`, isReadingArticle);
  if (!resource.data) return <ContentStatus error={resource.error} retry={resource.retry} />;
  const a = resource.data;
  return <><ReaderArticle position={{ kind: 'short', id, paragraph: 0 }} title={a.title} subtitle={a.titleZh} kicker="词与远方短文" paragraphs={a.paras.map((p, i) => ({ id: String(i), pieces: markedText(p), zh: a.zh[i] }))} />{a.q.length > 0 && <ReadingQuiz key={a.id} article={a} />}</>;
}
function BookChapter({ book, number }: { book: Book; number: number }) {
  const resource = useReaderContent(`books/${book.id}/ch-${number}.json`, isChapter);
  if (!resource.data) return <ContentStatus error={resource.error} retry={resource.retry} />;
  const chapter: Chapter = resource.data;
  return <><ReaderArticle position={{ kind: 'books', id: book.id, chapter: number, paragraph: 0 }} title={`${book.title} · ${chapter.label}`} subtitle={chapter.titleZh || chapter.labelZh} kicker={book.titleZh} paragraphs={chapter.paras.map(p => ({ id: p.id, pieces: chapterText(p.en, p.words), zh: p.zh, audio: p.audio, audioZh: p.audioZh }))} /><p className="wa-credit muted">{book.author} 原著 · {book.credit ?? '书源与翻译说明待补充。'}</p><div className="wa-next-chapter"><button className="btn btn-ghost" disabled={number <= 1} onClick={() => navigate({ page: 'read', book: book.id, chapter: number - 1 })}>上一章</button><span>{number} / {book.chapterCount}</span><button className="btn btn-primary" disabled={number >= book.chapterCount} onClick={() => navigate({ page: 'read', book: book.id, chapter: number + 1 })}>下一章 <ArrowRight size={16} /></button></div></>;
}
function ReaderArticle({ title, subtitle, kicker, paragraphs, position }: { title: string; subtitle: string; kicker: string; paragraphs: { id: string; pieces: TextPiece[]; zh?: string; audio?: string | null; audioZh?: string | null }[]; position: ReadingPosition }) {
  const epoch = profileGeneration();
  const atlas = useAtlas(), cards = useStore(s => s.progress.cards);
  const [prefs, setPrefs] = useState(readerPreferences), [notice, setNotice] = useState(''); const body = useRef<HTMLDivElement>(null);
  const [saved] = useState(readPosition);
  const [speaking, setSpeaking] = useState(false), [activeParagraph, setActiveParagraph] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement>(null), generation = useRef(0), audioPath = useRef('');
  const hasAudio = paragraphs.some(p => p.audio || p.audioZh);
  const pause = () => { generation.current++; audio.current?.pause(); setSpeaking(false); };
  const startAudio = (index: number, settings = prefs) => {
    const target = paragraphs.findIndex((p, i) => i >= index && !!(settings.language === 'en' ? p.audio : p.audioZh));
    const a = audio.current; if (!a || target < 0) { pause(); return; }
    const path = settings.language === 'en' ? paragraphs[target].audio : paragraphs[target].audioZh;
    if (!path) return;
    stopAudio(); const token = ++generation.current; a.pause();
    try { audioPath.current = localAsset(path); a.src = audioPath.current; a.playbackRate = settings.speed; setActiveParagraph(target); setSpeaking(true); setNotice('');
      body.current?.querySelector(`[data-paragraph="${target}"]`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      void a.play().catch(() => { if (token === generation.current) { setSpeaking(false); setNotice('这段录音暂时无法播放，请重试。'); } });
    } catch { setSpeaking(false); setNotice('这段录音路径无效。'); }
  };
  const toggleAudio = () => {
    if (speaking) { pause(); return; }
    const index = activeParagraph ?? (saved?.kind === position.kind && saved.id === position.id && saved.chapter === position.chapter ? saved.paragraph : 0);
    const a = audio.current, paragraph = paragraphs[index]; const path = prefs.language === 'en' ? paragraph?.audio : paragraph?.audioZh;
    if (a && path && audioPath.current === localAsset(path) && !a.ended) { stopAudio(); const token = ++generation.current; a.playbackRate = prefs.speed; setSpeaking(true); void a.play().catch(() => { if (token === generation.current) { setSpeaking(false); setNotice('这段录音暂时无法播放，请重试。'); } }); }
    else startAudio(index);
  };
  const update = (patch: Partial<typeof prefs>) => { const next = { ...prefs, ...patch }; setPrefs(next); if (audio.current) audio.current.playbackRate = next.speed; if (patch.language && speaking) startAudio(activeParagraph ?? 0, next); try { saveReaderPreferences(next, epoch); } catch { setNotice('浏览器无法保存阅读设置，本次阅读仍可使用。'); } };
  useEffect(() => { const a = audio.current; return () => { generation.current++; a?.pause(); a?.removeAttribute('src'); a?.load(); }; }, []);
  useEffect(() => {
    const root = body.current; if (!root) return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-paragraph]'));
    const match = saved?.kind === position.kind && saved.id === position.id && saved.chapter === position.chapter;
    let observer: IntersectionObserver | undefined;
    const frame = requestAnimationFrame(() => {
      if (match && saved.paragraph > 0) targets[Math.min(saved.paragraph, targets.length - 1)]?.scrollIntoView({ block: 'start' });
      if (typeof IntersectionObserver === 'undefined') return;
      observer = new IntersectionObserver(entries => {
        const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) try { savePosition({ ...position, paragraph: Number((visible.target as HTMLElement).dataset.paragraph) }, epoch); } catch { setNotice('浏览器无法保存阅读位置。'); }
      }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });
      targets.forEach(p => observer!.observe(p));
    });
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, []); // The article is keyed by its route; settings never reset the position.
  return <article className="wa-article panel"><header><p className="eyebrow">{kicker}</p><h2 lang="en">{title}</h2><p className="wa-subtitle">{subtitle}</p></header>
    <div className="wa-reader-tools" role="toolbar" aria-label="阅读设置"><button className={`btn btn-ghost ${prefs.bilingual ? 'is-on' : ''}`} aria-pressed={prefs.bilingual} onClick={() => update({ bilingual: !prefs.bilingual })}><Languages size={17} />中英对照</button><label><input type="checkbox" checked={prefs.highlight} onChange={e => update({ highlight: e.target.checked })} />标出词汇</label><div className="wa-size" role="group" aria-label="文字大小"><button disabled={prefs.size <= 16} aria-label="缩小字号" onClick={() => update({ size: prefs.size - 2 })}>字−</button><output>{prefs.size}px</output><button disabled={prefs.size >= 28} aria-label="放大字号" onClick={() => update({ size: prefs.size + 2 })}>字＋</button></div></div>
    {hasAudio && <div className="wa-audio-tools" role="group" aria-label="听书设置"><button className="btn btn-primary" aria-pressed={speaking} onClick={toggleAudio}>{speaking ? <Pause size={17} /> : <Play size={17} />}{speaking ? '暂停朗读' : activeParagraph !== null ? '继续朗读' : '开始朗读'}</button><label>朗读语言<select aria-label="朗读语言" value={prefs.language} onChange={e => update({ language: e.target.value as 'en' | 'zh' })}><option value="en">英文</option><option value="zh">中文</option></select></label><label>朗读速度<select aria-label="朗读速度" value={prefs.speed} onChange={e => update({ speed: Number(e.target.value) })}>{[.8, 1, 1.2].map(speed => <option value={speed} key={speed}>{speed}×</option>)}</select></label><audio ref={audio} preload="none" onEnded={() => { if (speaking) startAudio((activeParagraph ?? 0) + 1); }} onError={() => { if (audioPath.current) { pause(); setNotice('这段录音暂时无法播放，请重试。'); } }} /></div>}
    <div className={`wa-reader-body ${prefs.highlight ? 'is-highlighted' : ''}`} ref={body} style={{ fontSize: prefs.size }}>{paragraphs.map((p, i) => <section key={p.id} data-paragraph={i} className={`wa-paragraph ${speaking && activeParagraph === i ? 'is-speaking' : ''}`}><p lang="en">{p.pieces.map((piece, j) => piece.id && atlas.byId.has(piece.id) ? <button key={j} className={`wa-word ${cards[piece.id] ? 'is-learned' : ''}`} aria-label={`${piece.text}，查看词卡`} onClick={() => { pause(); openWord(piece.id!); }}>{piece.text}</button> : <span key={j}>{piece.text}</span>)}</p>{prefs.bilingual && p.zh && <p lang="zh-CN" className="wa-translation">{p.zh}</p>}{hasAudio && (prefs.language === 'en' ? p.audio : p.audioZh) && <button className="wa-paragraph-play" onClick={() => startAudio(i)} aria-label={`从第 ${i + 1} 段开始${prefs.language === 'en' ? '英文' : '中文'}朗读`}><Volume2 size={14} />从这一段开始朗读</button>}</section>)}</div>
    <p className="wa-legend muted">金色实线是你学过的词，虚线是还没学的。点一下查看词卡。</p>{notice && <p role="status">{notice}</p>}
  </article>;
}
const judgments: { value: Judgment; en: string; zh: string; help: string }[] = [{ value: 'T', en: 'TRUE', zh: '正确', help: '与原文信息一致' }, { value: 'F', en: 'FALSE', zh: '错误', help: '与原文信息矛盾' }, { value: 'NG', en: 'NOT GIVEN', zh: '未提及', help: '原文信息不足，无法判断' }];
function ReadingQuiz({ article }: { article: ReadingArticle }) {
  const epoch = profileGeneration();
  const atlas = useAtlas(); const [answers, setAnswers] = useState<Record<number, Judgment>>({}), [notice, setNotice] = useState('');
  const answerRef = useRef<Record<number, Judgment>>({});
  const correct = article.q.filter((q, i) => answers[i] === q.a).length, done = Object.keys(answers).length === article.q.length;
  const select = (i: number, value: Judgment) => {
    if (answerRef.current[i]) return;
    const next = { ...answerRef.current, [i]: value }; answerRef.current = next; setAnswers(next);
    if (Object.keys(next).length === article.q.length) try { recordExercise(atlas.id, `read:${article.id}`, article.q.filter((q, j) => next[j] === q.a).length, article.q.length, epoch); } catch { setNotice('浏览器无法保存本轮成绩。'); }
  };
  return <section className="wa-reading-quiz panel"><p className="eyebrow">判断题 · {article.q.length} 道</p><h2>检查理解</h2><dl className="wa-judgment-help">{judgments.map(j => <div key={j.value}><dt>{j.en} · {j.zh}</dt><dd>{j.help}</dd></div>)}</dl><ol className="wa-questions">{article.q.map((q, i) => <li key={i}><h3 lang="en"><small>{i + 1}</small> {q.s}</h3><div className="wa-choices" role="group" aria-label={`第 ${i + 1} 题`}>{judgments.map(j => <button key={j.value} disabled={!!answers[i]} aria-pressed={answers[i] === j.value} className={`wa-choice ${answers[i] ? j.value === q.a ? 'is-correct' : answers[i] === j.value ? 'is-wrong' : 'is-dim' : ''}`} onClick={() => select(i, j.value)}><b>{j.en}</b><small>{j.zh}</small></button>)}</div>{answers[i] && <p className="wa-feedback" role="status"><strong>{answers[i] === q.a ? '答对了。' : `正确答案：${q.a}。`}</strong>{q.why}</p>}</li>)}</ol>{done && <div className="wa-result" role="status"><Check size={24} /><strong>{correct} / {article.q.length} · {correct === article.q.length ? '本轮全部答对。' : '再读一遍，核对标出的答案。'}</strong><button className="btn btn-ghost" onClick={() => { answerRef.current = {}; setAnswers({}); setNotice(''); }}>重新练习</button></div>}<p className="muted">阅读练习单独记录，不计入单词复习进度。{notice}</p></section>;
}
