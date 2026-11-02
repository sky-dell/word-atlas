import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock3, Film, Play, Repeat2, VolumeX } from 'lucide-react';
import { go } from '../lib/router';
import { localAsset, useReaderContent } from '../lib/reader';
import { stopAudio } from '../lib/audio';
import '../styles/karoline.css';

interface Video { id:string; order:number; title:string; subtitle:string; duration:number; hasAudio:boolean; video:string; poster:string }
interface Library { version:1; videos:Video[] }
function validLibrary(value:unknown):value is Library {
  if(!value||typeof value!=='object')return false;
  const v=value as Library;
  return v.version===1&&Array.isArray(v.videos)&&v.videos.length>0&&new Set(v.videos.map(item=>item?.id)).size===v.videos.length&&v.videos.every((item,index)=>
    item&&/^karoline-\d{2}$/.test(item.id)&&item.order===index+1&&
    typeof item.title==='string'&&typeof item.subtitle==='string'&&typeof item.hasAudio==='boolean'&&
    Number.isFinite(item.duration)&&item.duration>0&&item.video===`atlas/extras/karoline/${item.id}.mp4`&&item.poster===`atlas/extras/karoline/${item.id}.jpg`);
}
const time=(seconds:number)=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
const visit=(id?:string)=>go({page:'read',tab:'karoline',...(id?{id}:{})});

export function Karoline({id}:{id?:string}) {
  const library=useReaderContent('atlas/extras/karoline/index.json',validLibrary);
  if(!library.data)return <section className="panel karoline-status" role="status"><Film size={30}/><h2>{library.error?'视频暂时没能加载':'正在打开卡罗琳特辑……'}</h2>{library.error&&<><p>{library.error}</p><button className="btn btn-ghost" onClick={library.retry}>重试</button></>}</section>;
  const videos=library.data.videos;
  const current=videos.find(video=>video.id===id)??(id==='karoline-16'?videos.find(video=>video.id==='karoline-17'):undefined);
  if(id&&!current)return <section className="panel karoline-status"><p>没有找到这段视频。</p><button className="btn btn-ghost" onClick={()=>visit()}>全部视频</button></section>;
  return <section className="karoline-library" aria-label="卡罗琳视频集">
    {current?<VideoPlayer key={current.id} current={current} videos={videos}/>:<>
      <div className="karoline-intro"><div><p className="eyebrow">Listen. Shadow. Explore.</p><h2>卡罗琳特辑 <span lang="en">Karoline</span></h2><p>在真实的表达里，听见英语的节奏。</p></div><span className="karoline-count"><Film size={16}/>{videos.length} 段视频 · 按序学习</span></div>
      <div className="karoline-grid">{videos.map(video=><button className="karoline-card" data-order={video.order} key={video.id} onClick={()=>visit(video.id)} aria-label={`播放 ${video.title}`}>
        <span className="karoline-poster"><img src={localAsset(video.poster)} alt={`${video.title}视频画面`} loading="lazy" width="640" height="360"/><span className="karoline-number">{String(video.order).padStart(2,'0')}</span><span className="karoline-play"><Play size={24} fill="currentColor"/></span><span className="karoline-duration">{time(video.duration)}</span></span>
        <span className="karoline-card-copy"><span className="eyebrow">Karoline · Shadowing</span><strong>{video.title}</strong><span className="karoline-card-meta">{video.hasAudio?<><span>听力与跟读</span><ArrowRight size={16}/></>:<span className="karoline-silent"><VolumeX size={14}/>原片无音轨</span>}</span></span>
      </button>)}</div>
    </>}
  </section>;
}

function VideoPlayer({current,videos}:{current:Video;videos:Video[]}) {
  const ref=useRef<HTMLVideoElement>(null);
  const [speed,setSpeed]=useState('1'),[loop,setLoop]=useState(false),[error,setError]=useState(false);
  const index=videos.findIndex(v=>v.id===current.id);
  useEffect(()=>{const video=ref.current;return()=>{video?.pause();video?.removeAttribute('src');video?.load();};},[]);
  return <div className="karoline-detail">
    <button className="wa-back" onClick={()=>visit()}><ArrowLeft size={16}/>全部视频</button>
    <div className="karoline-detail-head"><div><p className="eyebrow">Karoline · {String(current.order).padStart(2,'0')} / {videos.length}</p><h2>{current.title}</h2></div><span className="karoline-count"><Clock3 size={16}/>{time(current.duration)}</span></div>
    {!current.hasAudio&&<p className="karoline-warning" role="status"><VolumeX size={18}/>原文件缺少音轨，本视频仅供观看画面，暂不能用于听力训练。</p>}
    <div className="karoline-player"><video ref={ref} src={localAsset(current.video)} poster={localAsset(current.poster)} aria-label={`${current.title}播放器`} controls playsInline preload="metadata" loop={loop} onPlay={()=>{stopAudio();setError(false);}} onError={()=>setError(true)}/></div>
    {error&&<div className="karoline-warning" role="alert">视频暂时无法播放，请检查网络后重试。<button className="btn btn-ghost" onClick={()=>{setError(false);ref.current?.load();}}>重新加载</button></div>}
    <div className="karoline-toolbar"><label>播放速度 <select aria-label="视频播放速度" value={speed} onChange={e=>{setSpeed(e.target.value);if(ref.current)ref.current.playbackRate=Number(e.target.value);}}>{['0.75','1','1.25','1.5','2'].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><button className={`btn btn-ghost ${loop?'is-on':''}`} aria-pressed={loop} onClick={()=>setLoop(v=>!v)}><Repeat2 size={16}/>{loop?'已开启循环':'单集循环'}</button><span>听一遍，再跟读一遍。</span></div>
    <div className="karoline-pagination"><button className="btn btn-ghost" disabled={index===0} onClick={()=>visit(videos[index-1].id)}><ArrowLeft size={16}/>上一集</button><span>{index+1} / {videos.length}</span><button className="btn btn-primary" disabled={index===videos.length-1} onClick={()=>visit(videos[index+1].id)}>下一集<ArrowRight size={16}/></button></div>
  </div>;
}
