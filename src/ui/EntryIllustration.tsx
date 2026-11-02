import { scopedKey, subscribeProfile, notifyExtras } from '../store/profile';
import { useEffect, useState } from "react";
import { Illustration } from "./Illustration";
import { CLASSIC_ILLUSTRATIONS, useAppearance } from "./Appearance";
export function EntryIllustration({
  src,
  word,
  topic,
  eager,
}: {
  src: string | null;
  word: string;
  topic: number;
  eager: boolean;
}) {
  const { illus } = useAppearance();
  const key = scopedKey(`word-atlas:illustration:${word.toLowerCase()}`);
  const readChoice = (): "atlas" | "classic" | null => {
    try {
      const v = localStorage.getItem(key);
      return v === "atlas" || v === "classic" ? v : null;
    } catch {
      return null;
    }
  };
  const [choice, setChoice] = useState(readChoice);
  useEffect(() => { setChoice(readChoice()); return subscribeProfile(() => setChoice(null)); }, [key]);
  const current = choice ?? illus;
  const change = () => {
    const next = current === "classic" ? "atlas" : "classic";
    setChoice(next);
    try {
      localStorage.setItem(key, next); notifyExtras();
    } catch {
      /* Current page remains usable. */
    }
  };
  return (
    <div className="entry-illustration">
      <Illustration
        src={src}
        word={word}
        topic={topic}
        eager={eager}
        alt={`${word} 插画`}
        variant={current}
      />
      {CLASSIC_ILLUSTRATIONS[word.toLowerCase()] && (
        <button
          className="btn illustration-switch"
          onClick={change}
          aria-label="切换插画风格"
        >
          {current === "classic" ? "切换新版插画" : "切换经典插画"}
        </button>
      )}
    </div>
  );
}
