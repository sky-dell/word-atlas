import { useState } from "react";
import { CLASSIC_ILLUSTRATIONS, useAppearance } from "./Appearance";

const HUES = ["#C4573A", "#7F9B77", "#D9A03A", "#5F7FA3", "#A86B8C", "#4E7C76"];

/** Square illustration with a typographic plate as an intentional fallback. */
export function Illustration({
  src,
  word,
  topic = 0,
  className = "",
  eager = false,
  alt,
  variant,
}: {
  src: string | null;
  word: string;
  topic?: number;
  className?: string;
  eager?: boolean;
  alt?: string;
  variant?: 'atlas'|'classic';
}) {
  const { illus } = useAppearance();
  const classic = (variant ?? illus) === "classic" ? CLASSIC_ILLUSTRATIONS[word.toLowerCase()] : undefined;
  const source = classic || src;
  const [result, setResult] = useState<{ src: string | null; state: "ok" | "error" }>({ src: null, state: "error" });
  const [failedClassic, setFailedClassic] = useState<string | null>(null);
  const resolved = classic && failedClassic === classic ? src : source;
  const resolvedState = result.src === resolved ? result.state : "loading";
  const showImg = resolved && resolvedState !== "error";
  return (
    <figure className={`illo ${showImg && resolvedState === "ok" ? "is-loaded" : ""} ${className}`}>
      {showImg ? (
        <img
          key={resolved}
          src={resolved}
          alt={alt ?? ""}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={() => setResult({ src: resolved, state: "ok" })}
          onError={() => { if (classic && resolved === classic && src) setFailedClassic(classic); else setResult({ src: resolved, state: "error" }); }}
        />
      ) : (
        <div className="plate" style={{ "--hue": HUES[topic % HUES.length], "--len": Math.max(4, word.length) } as React.CSSProperties} aria-hidden="true">
          <span className="plate-initial">{word.slice(0, 1)}</span>
          <span className="plate-word">{word}</span>
          <i className="plate-rule" />
        </div>
      )}
    </figure>
  );
}
