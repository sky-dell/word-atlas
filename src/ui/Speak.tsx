import { Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { audioGeneration, play } from "../lib/audio";
import { useAppearance } from "./Appearance";

export function Speak({
  url,
  text,
  accent = "uk",
  label,
  size = "md",
  rate = 1,
  className = "",
  kbd,
}: {
  url: string | null;
  text: string;
  accent?: "uk" | "us";
  label?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  rate?: number;
  className?: string;
  kbd?: string;
}) {
  const [on, setOn] = useState(false);
  const { repeatGap } = useAppearance();
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setOn(true);
    const mine = ++sequence.current;
    try {
      const result = await play(url, text, accent, rate);
      const generation = audioGeneration();
      if (repeatGap && result !== "stopped" && result !== "unsupported") {
        await new Promise((r) => setTimeout(r, repeatGap * 1000));
        if (mine === sequence.current && generation === audioGeneration())
          await play(url, text, accent, rate);
      }
    } finally {
      if (mine === sequence.current) setOn(false);
    }
  };
  return (
    <button
      type="button"
      className={`speak speak-${size} ${on ? "is-on" : ""} ${label ? "has-label" : ""} ${className}`}
      onClick={run}
      aria-label={typeof label === "string" ? `朗读 ${label}` : `朗读 ${text}`}
      title={kbd ? `朗读（${kbd}）` : "朗读"}
    >
      <span className="speak-icon">
        <Volume2
          size={size === "lg" ? 22 : size === "sm" ? 15 : 18}
          strokeWidth={1.8}
        />
        <span className="speak-waves" />
      </span>
      {label && <span className="speak-label">{label}</span>}
    </button>
  );
}
