import { AudioLines, Check, CloudRain, Coffee, Flame, Sailboat, Sparkles, Trees, VolumeX, Waves } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AMBIENCE, primeCues, setAmbience, type AmbienceId } from "../lib/sound";
import { store, useStore } from "../store/store";

const ICONS: Record<AmbienceId, typeof CloudRain> = { stars: Sparkles, rain: CloudRain, sea: Waves, forest: Trees, fire: Flame, voyage: Sailboat, cafe: Coffee };

/** Keeps the ambience in sync with settings; browsers only allow audio after a user gesture. */
export function AmbienceController() {
  const ambience = useStore((s) => s.settings.ambience);
  const volume = useStore((s) => s.settings.ambienceVolume);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const arm = () => {
      primeCues();
      setArmed(true);
    };
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);
  useEffect(() => {
    if (armed) void setAmbience(ambience === "off" ? null : ambience, volume);
  }, [armed, ambience, volume]);
  return null;
}

export function AmbiencePicker() {
  const [open, setOpen] = useState(false);
  const ambience = useStore((s) => s.settings.ambience);
  const volume = useStore((s) => s.settings.ambienceVolume);
  const box = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const keyboardOpening = useRef(false);
  const [placement, setPlacement] = useState({left:12,top:12,width:252,maxHeight:1000});
  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const place = () => {
      const anchor = box.current?.getBoundingClientRect(), panel = popup.current;
      if (!anchor || !panel) return;
      const x=viewport?.offsetLeft ?? 0, y=viewport?.offsetTop ?? 0;
      const w=viewport?.width ?? innerWidth, h=viewport?.height ?? innerHeight;
      const width=Math.min(252,Math.max(0,w-24)), maxHeight=Math.max(0,h-24);
      const height=Math.min(panel.scrollHeight+2,maxHeight);
      const next={width,maxHeight,left:Math.max(x+12,Math.min(anchor.right-width,x+w-width-12)),top:Math.max(y+12,Math.min(anchor.bottom+10,y+h-height-12))};
      setPlacement(old=>Object.keys(next).every(key=>old[key as keyof typeof old]===next[key as keyof typeof next])?old:next);
    };
    place();
    if(keyboardOpening.current)popup.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
    const resize=typeof ResizeObserver==='function'?new ResizeObserver(place):null;if(popup.current)resize?.observe(popup.current);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    viewport?.addEventListener('resize',place);viewport?.addEventListener('scroll',place);
    return()=>{resize?.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);viewport?.removeEventListener('resize',place);viewport?.removeEventListener('scroll',place);};
  },[open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if(e instanceof KeyboardEvent){
        const target=e.target as HTMLElement;
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'||e.key==='/'&&target.tagName!=='INPUT'&&target.tagName!=='TEXTAREA'){setOpen(false);return;}
        if(e.key==='Escape'){setOpen(false);box.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});}
        if(e.key==='Tab'){
          const controls=Array.from(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]),first=controls[0],last=controls.at(-1);
          if(first&&(!popup.current?.contains(document.activeElement)||e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last)){e.preventDefault();(e.shiftKey?last:first)?.focus();}
        }
      }else if(!box.current?.contains(e.target as Node)&&!popup.current?.contains(e.target as Node))setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const on = ambience !== "off";
  return (
    <div className="amb" ref={box}>
      <button className={`icon-btn amb-btn ${on ? "is-on" : ""}`} onClick={e => {keyboardOpening.current=e.detail===0;setOpen(o=>!o);}} aria-expanded={open} aria-label="环境声" title="环境声">
        <AudioLines size={19} />
        {on && <span className="amb-bars" aria-hidden="true"><i /><i /><i /></span>}
      </button>
      {open && createPortal(
        <div ref={popup} className="amb-pop amb-pop--portal" style={placement} role="dialog" aria-label="环境声">
          <p className="eyebrow">环境声 · 专注陪伴</p>
          <ul>
            {AMBIENCE.map(({ id, label }) => {
              const Icon = ICONS[id];
              const sel = ambience === id;
              return (
                <li key={id}>
                  <button className={sel ? "is-on" : ""} onClick={() => store.settings({ ambience: sel ? "off" : id })} aria-pressed={sel}>
                    <Icon size={18} strokeWidth={1.7} />
                    <span>{label}</span>
                    {sel && <Check size={16} />}
                  </button>
                </li>
              );
            })}
            <li>
              <button className={!on ? "is-on" : ""} onClick={() => store.settings({ ambience: "off" })} aria-pressed={!on}>
                <VolumeX size={18} strokeWidth={1.7} />
                <span>安静</span>
                {!on && <Check size={16} />}
              </button>
            </li>
          </ul>
          <label className="amb-vol">
            <span>音量</span>
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => store.settings({ ambienceVolume: Number(e.target.value) })} disabled={!on} />
          </label>
          <p className="amb-note">读单词时会自动压低环境声。</p>
        </div>, document.getElementById('root') ?? document.body
      )}
    </div>
  );
}
