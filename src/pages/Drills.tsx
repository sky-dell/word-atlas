import { profileGeneration } from '../store/profile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RotateCcw, Search, Star } from 'lucide-react';
import { useAtlas, useEntry } from '../atlas/context';
import { go, href, openWord, useLocation } from '../lib/router';
import { answerOptions, collection, isConfusable, isParaphrase, paraphraseLevels, readRecords, recordExercise, useReaderContent } from '../lib/reader';
import type { ConfusableGroup, ExerciseRecords, ParaphraseItem } from '../lib/reader';
import { ContentStatus } from './Reading';
import '../styles/reading-drills.css';

const paraphrases = collection('items', isParaphrase), confusables = collection('groups', isConfusable);
type Mode = 'paraphrase' | 'confuse';
function navigate(mode: Mode, id?: string) { go({ page: mode, ...(id ? { id } : {}) } as Parameters<typeof go>[0]); }

export function Drills({ mode }: { mode: Mode }) {
  return mode === 'paraphrase' ? <Paraphrase /> : <Confusables />;
}
function DrillHeader({ mode }: { mode: Mode }) {
  return <><a href="#/practice" className="wa-back" onClick={e => { e.preventDefault(); go({ page: 'practice' }); }}><ArrowLeft size={16} />练习</a><header className="page-head wa-drill-hero"><div><p className="eyebrow">雅思专项 · {mode === 'paraphrase' ? '同义替换' : '易混词'}</p><h1 className="display">{mode === 'paraphrase' ? <>换个说法，<br />也认得出。</> : <>长得像，<br />不一样。</>}</h1><p className="lede">{mode === 'paraphrase' ? '在句子里，找出与原文意思相近的表达。' : '对照词义和例句，再做小测，分清容易混淆的用法。'}</p></div>{mode === 'paraphrase' && <figure className="wa-demo"><small>原文</small><p lang="en">Visitor numbers <mark>increased sharply</mark> last year.</p><b aria-hidden="true">≈</b><small>题目</small><p lang="en">There was <mark>a steep rise</mark> in tourists.</p></figure>}</header></>;
}

function Paraphrase() {
  const atlas = useAtlas(), { route } = useLocation(); const id = (route as { id?: string }).id;
  const resource = useReaderContent('atlas/extras/paraphrase.json', paraphrases);
  const levels = useMemo(() => paraphraseLevels(resource.data?.items ?? [], 8, id => atlas.byId.get(id)?.order ?? 1e9), [resource.data, atlas]);
  const [records, setRecords] = useState<ExerciseRecords>(() => readRecords(atlas.id));
  useEffect(() => setRecords(readRecords(atlas.id)), [atlas.id]);
  const selected = levels.find(l => String(l.n) === id || l.id === id);
  const passed = levels.filter(l => (records[`para:${l.id}`]?.best ?? 0) >= .5).length;
  const next = levels.find(l => (records[`para:${l.id}`]?.best ?? 0) < .5) ?? levels[0];
  const refresh = () => setRecords(readRecords(atlas.id));
  if (id && resource.data && selected) return <ParaphraseLevel key={`${atlas.id}-${selected.id}`} level={selected} onResult={refresh} hasNext={selected.n < levels.length} />;
  return <div className="page wa-drills"><DrillHeader mode="paraphrase" />{resource.data ? id && !selected ? <section className="panel wa-status"><h2>没有找到这一关</h2><button className="btn btn-primary" onClick={() => navigate('paraphrase')}>关卡地图</button></section> : <>
    {next && <section className="panel wa-level-status"><div><p className="eyebrow">{passed === levels.length ? '全部关卡已通过' : '继续下一关'}</p><h2>第 {next.n} 关 <small>{atlas.cefr[next.cefr]}</small></h2><p className="muted">这一关的 {next.items.length} 个词</p><p lang="en">{next.items.slice(0, 4).map(i => atlas.byId.get(i.w)?.word ?? i.w).join(' · ')}</p><button className="btn btn-primary btn-xl" onClick={() => navigate('paraphrase', String(next.n))}>开始练习 <ArrowRight size={18} /></button></div><dl className="wa-stats"><div><dt>已通关</dt><dd>{passed}<small> / {levels.length} 关</small></dd></div><div><dt>关卡星级</dt><dd>{levels.reduce((n, l) => n + stars(records[`para:${l.id}`]?.best ?? 0), 0)}<small> / {levels.length * 3}</small></dd></div></dl></section>}
    <section className="wa-map" aria-label="关卡地图"><h2>全部关卡</h2>{[...new Set(levels.map(l => l.cefr))].map(band => <details key={band} open={next?.cefr === band || undefined}><summary><b>{atlas.cefr[band]}</b><span>全部关卡 · {levels.filter(l => l.cefr === band).length} 关</span></summary><ol className="wa-map-nodes">{levels.filter(l => l.cefr === band).map(l => { const record = records[`para:${l.id}`], count = stars(record?.best ?? 0); return <li key={l.id}><a href={href({ page: 'paraphrase', id: String(l.n) } as Parameters<typeof href>[0])} className={`wa-level-node ${count ? 'is-passed' : ''}`} aria-label={`第 ${l.n} 关${count ? `，已通关，${count} 颗星` : '，未通关'}`} onClick={e => { e.preventDefault(); navigate('paraphrase', String(l.n)); }}><b>{l.n}</b><span aria-hidden="true">{[0, 1, 2].map(i => <Star key={i} size={11} fill={i < count ? 'currentColor' : 'none'} />)}</span></a></li>; })}</ol></details>)}</section><p className="muted">练习成绩单独记录，不计入单词复习进度。</p>
  </> : <ContentStatus error={resource.error} retry={resource.retry} />}</div>;
}
function stars(ratio: number) { return ratio >= 1 ? 3 : ratio >= .75 ? 2 : ratio >= .5 ? 1 : 0; }
function highlight(source: string, target: string) {
  const index = source.toLowerCase().indexOf(target.toLowerCase());
  return index < 0 ? source : <>{source.slice(0, index)}<mark>{source.slice(index, index + target.length)}</mark>{source.slice(index + target.length)}</>;
}
function ParaphraseLevel({ level, hasNext, onResult }: { level: ReturnType<typeof paraphraseLevels>[number]; hasNext: boolean; onResult: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const questions = useMemo(() => level.items.map((i: ParaphraseItem) => ({ id: i.w, prompt: i.para, source: i.src, sourceKey: i.key, options: answerOptions(i), answer: i.ans, explanation: i.note, word: i.w })), [level]);
  return <div className="page wa-drills"><button className="wa-back" onClick={() => navigate('paraphrase')}><ArrowLeft size={16} />关卡地图</button><ExerciseRound key={attempt} id={`para:${level.id}`} title={`第 ${level.n} 关 · 同义替换`} help="找出与原文画线部分意思相近的表达。" questions={questions} onResult={onResult} onAgain={() => setAttempt(n => n + 1)} onExit={() => navigate('paraphrase')} next={hasNext ? () => navigate('paraphrase', String(level.n + 1)) : undefined} /></div>;
}

function Confusables() {
  const atlas = useAtlas(), { route } = useLocation(); const id = (route as { id?: string }).id;
  const resource = useReaderContent('atlas/extras/confusables.json', confusables);
  const [query, setQuery] = useState(''), [level, setLevel] = useState('all'), [status, setStatus] = useState('all');
  const [records, setRecords] = useState<ExerciseRecords>(() => readRecords(atlas.id));
  useEffect(() => setRecords(readRecords(atlas.id)), [atlas.id]);
  const groups = resource.data?.groups ?? [], selected = groups.find(g => g.id === id);
  const passed = (g: ConfusableGroup) => g.quiz.length >= 3 && records[`confuse:${g.id}`]?.best === 1;
  const filtered = groups.filter(g => (level === 'all' || String(g.cefr) === level) && (status === 'all' || (status === 'passed') === passed(g)) && `${g.words.map(w => `${w.w} ${w.zh}`).join(' ')} ${g.core}`.toLowerCase().includes(query.toLowerCase()));
  if (selected) return <ConfusableDetail key={`${atlas.id}-${selected.id}`} group={selected} groups={groups} passed={passed(selected)} onResult={() => setRecords(readRecords(atlas.id))} />;
  return <div className="page wa-drills"><DrillHeader mode="confuse" />{resource.data ? id ? <section className="panel wa-status"><h2>没有找到这一组</h2><p>未找到这组易混词。请选择其他词组。</p><button className="btn btn-primary" onClick={() => navigate('confuse')}>全部易混词</button></section> : <><div className="wa-confuse-filters"><label className="wa-search"><Search size={17} /><input aria-label="搜索易混词" placeholder="搜索单词或中文释义" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="按难度筛选" value={level} onChange={e => setLevel(e.target.value)}><option value="all">全部难度</option>{atlas.cefr.map((s, i) => <option key={s} value={i}>{s}</option>)}</select><select aria-label="按小测结果筛选" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部</option><option value="unpassed">未通过</option><option value="passed">已通过</option></select></div><p className="muted">共 {groups.length} 组，已通过 {groups.filter(passed).length} 组 · 找到 {filtered.length} 组</p><div className="wa-confuse-grid">{filtered.map(g => <a href={href({ page: 'confuse', id: g.id } as Parameters<typeof href>[0])} className="panel wa-confuse-card" key={g.id} onClick={e => { e.preventDefault(); navigate('confuse', g.id); }}><span className="chip">{atlas.cefr[g.cefr]}</span><h2 lang="en">{g.words.map(w => w.w).join(' / ')}</h2><p>{g.core}</p><small>{passed(g) ? '✓ 已通过' : `${g.quiz.length} 题小测`} <ArrowRight size={15} /></small></a>)}</div>{!filtered.length && <section className="panel wa-status"><p>没有找到符合条件的易混词，试试其他关键词或筛选条件。</p><button className="btn btn-ghost" onClick={() => { setQuery(''); setLevel('all'); setStatus('all'); }}>显示全部</button></section>}</> : <ContentStatus error={resource.error} retry={resource.retry} />}</div>;
}
function ConfusableDetail({ group, groups, passed, onResult }: { group: ConfusableGroup; groups: ConfusableGroup[]; passed: boolean; onResult: () => void }) {
  const atlas = useAtlas(); const [attempt, setAttempt] = useState(0); const index = groups.findIndex(g => g.id === group.id);
  const questions: Question[] = group.quiz.map((q, i) => ({ id: `${group.id}-${i}`, prompt: q.en, translation: q.zh, options: group.words.map(w => w.w), answer: q.ans, explanation: `${q.zh} ${group.core}`, word: group.words.find(w => w.w === q.ans)?.id }));
  return <div className="page wa-drills"><button className="wa-back" onClick={() => navigate('confuse')}><ArrowLeft size={16} />全部易混词</button><header className="page-head"><p className="eyebrow">第 {index + 1} 组 · {atlas.cefr[group.cefr]} {passed ? '· 已通过' : ''}</p><h1 className="display" lang="en">{group.words.map(w => w.w).join(' / ')}</h1><p className="lede">{group.core}</p></header><div className="wa-comparison">{group.words.map((w, i) => { const wordId = w.id ?? atlas.words.find(a => a.word.toLowerCase() === w.w.toLowerCase())?.id; return <section className="panel" key={w.w}><h2 lang="en">{w.w}</h2><p><span className="pos">{w.pos}</span> {w.zh}</p><p>{group.points[i]}</p>{group.ex[i] && <blockquote><p lang="en">{group.ex[i].en}</p><p className="muted">{group.ex[i].zh}</p></blockquote>}{wordId && <button className="btn btn-ghost" onClick={() => openWord(wordId)}>查看词卡 <ArrowRight size={15} /></button>}</section>; })}</div><aside className="wa-memory panel"><p className="eyebrow">记忆提示</p><p>{group.hook}</p></aside>{questions.length ? <ExerciseRound key={attempt} id={`confuse:${group.id}`} title={`小测 · ${questions.length} 题`} help="选出空格里该用的词" questions={questions} onResult={onResult} onAgain={() => setAttempt(n => n + 1)} onExit={() => navigate('confuse')} requirePerfect /> : <p className="muted">这组暂时没有可用的小测，可先看例句。</p>}<nav className="wa-next-chapter" aria-label="切换易混词组"><button className="btn btn-ghost" disabled={index === 0} onClick={() => navigate('confuse', groups[index - 1].id)}>上一组</button><span>{index + 1} / {groups.length}</span><button className="btn btn-primary" disabled={index === groups.length - 1} onClick={() => navigate('confuse', groups[index + 1].id)}>下一组 <ArrowRight size={16} /></button></nav></div>;
}

interface Question { id: string; prompt: string; source?: string; sourceKey?: string; options: string[]; answer: string; explanation: string; translation?: string; word?: string }
function ExerciseRound({ id, title, help, questions, onResult, onAgain, onExit, next, requirePerfect = false }: { id: string; title: string; help: string; questions: Question[]; onResult: () => void; onAgain: () => void; onExit: () => void; next?: () => void; requirePerfect?: boolean }) {
  const atlas = useAtlas(); const [index, setIndex] = useState(0), [answers, setAnswers] = useState<Record<number, string>>({}), [done, setDone] = useState(false), [notice, setNotice] = useState('');
  const epoch = profileGeneration();
  const locked = useRef<Record<number, string>>({}), advanceLock = useRef(false); const nextButton = useRef<HTMLButtonElement>(null), firstChoice = useRef<HTMLButtonElement>(null);
  const q = questions[index], selected = answers[index], correct = questions.filter((question, i) => answers[i] === question.answer).length;
  const choose = (value: string) => { if (locked.current[index] || done) return; const values = { ...locked.current, [index]: value }; locked.current = values; setAnswers(values); };
  const advance = () => {
    if (!selected || done || advanceLock.current) return;
    advanceLock.current = true;
    if (index + 1 < questions.length) setIndex(n => n + 1);
    else { setDone(true); try { recordExercise(atlas.id, id, correct, questions.length, epoch); onResult(); } catch { setNotice('浏览器无法保存本轮成绩。'); } }
  };
  useEffect(() => { advanceLock.current = false; }, [index]);
  useEffect(() => { if (selected) nextButton.current?.focus(); else firstChoice.current?.focus({ preventScroll: true }); }, [index, selected]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key) - 1;
      if (!selected && !done && n >= 0 && n < q.options.length && /^[1-9]$/.test(e.key)) { e.preventDefault(); choose(q.options[n]); }
    };
    addEventListener('keydown', handler); return () => removeEventListener('keydown', handler);
  });
  if (done) {
    const passed = requirePerfect ? correct === questions.length && questions.length >= 3 : correct / questions.length >= .5;
    return <section className="panel wa-round-result"><p className="eyebrow">{title}</p><h2>{passed ? correct === questions.length ? '本轮全部答对。' : '已通关' : '对照例句看看用法，再试一次。'}</h2><p className="wa-big-score">{correct}<small> / {questions.length}</small></p><p>正确率 {Math.round(correct / questions.length * 100)}%</p><ul className="wa-result-list">{questions.map((question, i) => <li key={`${question.id}-${i}`}><span>{answers[i] === question.answer ? '✓' : '×'}</span><span lang="en">{question.sourceKey ?? question.prompt}</span><strong lang="en">{question.answer}</strong>{answers[i] !== question.answer && <small>你的选择：{answers[i]}</small>}</li>)}</ul><div className="wa-result-actions"><button className="btn btn-primary" onClick={onAgain}><RotateCcw size={17} />重新练习</button>{next && passed && <button className="btn btn-primary" onClick={next}>下一关 <ArrowRight size={17} /></button>}<button className="btn btn-ghost" onClick={onExit}>{requirePerfect ? '全部易混词' : '关卡地图'}</button></div><p className="muted">练习成绩单独记录，不计入单词复习进度。{notice}</p></section>;
  }
  return <section className="panel wa-round"><header className="wa-round-top"><span className="eyebrow">{title}</span><span>第 {index + 1} / {questions.length} 题</span></header><progress max={questions.length} value={index} aria-label="练习进度" /><h2>{help}</h2>{q.source && <div className="wa-question-source"><p className="eyebrow">原文</p><p lang="en">{highlight(q.source, q.sourceKey ?? '')}</p></div>}<div className="wa-question-prompt"><p className="eyebrow">{q.source ? '题目' : '填空'}</p><p lang="en">{q.prompt}</p></div><div className="wa-choices wa-drill-choices" role="group" aria-label="选项">{q.options.map((option, i) => <button key={option} ref={i === 0 ? firstChoice : undefined} className={`wa-choice ${selected ? option === q.answer ? 'is-correct' : option === selected ? 'is-wrong' : 'is-dim' : ''}`} disabled={!!selected} aria-pressed={selected === option} onClick={() => choose(option)}><span className="wa-option-key">{i + 1}</span><b lang="en">{option}</b>{selected && option === q.answer && <Check size={18} />}</button>)}</div>{selected ? <><div className="wa-feedback" role="status"><strong>{selected === q.answer ? '答对了' : `正确答案：${q.answer}`}</strong><p>{q.explanation}</p>{q.word && atlas.byId.has(q.word) && <WordFeedback id={q.word} />}</div><button ref={nextButton} className="btn btn-primary wa-next-question" onClick={advance}>{index + 1 === questions.length ? '查看结果' : '下一题'} <ArrowRight size={17} /></button></> : <p className="muted">选择选项，或按数字键 1–{q.options.length}。</p>}</section>;
}
function WordFeedback({ id }: { id: string }) {
  const { entry } = useEntry(id);
  return <div className="wa-word-feedback">{entry?.syn.length ? <p>近义表达：{entry.syn.join(' · ')}</p> : null}{entry?.ant.length ? <p>反义表达：{entry.ant.join(' · ')}</p> : null}{entry?.tip && <p>{entry.tip}</p>}<button className="btn btn-ghost" onClick={() => openWord(id)}>查看词卡 <ArrowRight size={15} /></button></div>;
}
