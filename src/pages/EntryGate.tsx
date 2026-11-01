import { Logo } from '../ui/Logo';
import { SITE_TAGLINE } from '../config';
import { AccountPanel } from './Account';
import '../styles/account.css';
import '../styles/entry.css';
import {useState} from 'react';
import {useGuest} from '../guest/state';

// IDs and meanings verified against public/atlas/index.json; no catalog fetch
// is needed before the account form becomes usable.
const WORDCARDS = [
  { id: 'explore', word: 'explore', meaning: '探索；探访', label: '从好奇出发', number: '01' },
  { id: 'journey', word: 'journey', meaning: '旅行；行程', label: '让每一步有回响', number: '02' },
  { id: 'horizon', word: 'horizon', meaning: '地平线', label: '看见更远的世界', number: '03' },
];

export function EntryGate({ onGuest }: {
  onGuest: () => void | Promise<void>; initialLogin?: boolean;
}) {
  const guest=useGuest(),[error,setError]=useState('');
  return <main className="auth-entry" aria-label="词与远方 · 开始探索">
    <div className="auth-entry__layout">
      <div className="auth-entry__story">
        <Logo />
        <div className="auth-entry__intro">
          <p className="auth-entry__eyebrow">A WORD IS A WAY INTO THE WORLD</p>
          <h1>多懂一个词，<br /><span>多看一点世界。</span></h1>
          <p className="auth-entry__description">在插画里遇见单词，在声音里熟悉它。<br />把每一次好奇，变成走向远方的一小步。</p>
        </div>
        <div className="auth-entry__atlas" aria-hidden="true">
          <svg className="auth-entry__path" viewBox="0 0 600 280" fill="none">
            <path d="M28 200C100 275 155 30 282 80S426 276 572 55" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 7" />
            <circle cx="28" cy="200" r="4" fill="var(--paper)" stroke="currentColor" />
            <circle cx="572" cy="55" r="4" fill="var(--terra)" />
          </svg>
          {WORDCARDS.map(card => <figure className={`auth-entry__wordcard auth-entry__wordcard--${card.id}`} key={card.id}>
            <div className="auth-entry__word-image">
              <img
                src={`${import.meta.env.BASE_URL}atlas/img/${card.id}.webp`}
                srcSet={`${import.meta.env.BASE_URL}atlas/thumb/${card.id}.webp 256w, ${import.meta.env.BASE_URL}atlas/img/${card.id}.webp 512w`}
                sizes="(max-width: 860px) 26vw, (max-width: 1240px) 17vw, 240px"
                width="512"
                height="512"
                alt={`${card.word} 的插画`}
                decoding="async"
              />
            </div>
            <figcaption><span className="auth-entry__word-number">{card.number}</span><strong lang="en">{card.word}</strong><span>{card.meaning}</span></figcaption>
            <span className="auth-entry__word-note">{card.label}</span>
          </figure>)}
        </div>
        <p className="auth-entry__signature">WORDS &amp; BEYOND <span>·</span> 每个单词，都是一扇窗。</p>
      </div>
      <section className="auth-entry__card" aria-label="账户登录与注册">
        <AccountPanel preferEmailRegistration variant="entry" />
        <div className="auth-entry__guest">
          <button type="button" className="auth-entry__guest-action" aria-label="以游客身份登录" disabled={guest.loading} onClick={()=>{setError('');void Promise.resolve().then(onGuest).catch(e=>setError(e instanceof Error?e.message:'游客服务暂时不可用'));}}>{guest.loading?'正在准备临时身份…':'以游客身份登录'}<span aria-hidden="true"> →</span></button>
          <p>刷新不丢失已暂存记录。闲置24小时失效，最长保留7天。</p>
          {(error||guest.status==='offline')&&<p role="alert">{error||guest.message}</p>}
        </div>
      </section>
      <p className="auth-entry__footer">{SITE_TAGLINE}</p>
    </div>
  </main>;
}
