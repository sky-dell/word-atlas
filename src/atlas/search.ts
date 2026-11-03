import type { Atlas, WordRef } from "./types";

export function matchedMeaning(word: WordRef, raw: string) {
  const query = raw.trim().toLowerCase();
  if (!/[一-鿿]/.test(query)) return word.zh;
  const terms = (word.search || word.zh).split(/\s+/).filter(Boolean);
  return terms.find(term => term === query) || terms.find(term => term.includes(query)) || word.zh;
}

export function searchAtlas(atlas: Atlas, raw: string, limit = 40): WordRef[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const zh = /[一-鿿]/.test(q);
  const hits: [number, WordRef][] = [];
  for (const w of atlas.words) {
    let score = 0;
    if (zh) {
      const text = w.search || w.zh;
      const exact = text.split(/[；;，,、/|｜\s]+/).some(term => term === q);
      const i = text.indexOf(q);
      if (exact) score = 1000;
      else if (i >= 0) score = 60 - Math.min(40, i) - text.length * 0.2;
    } else {
      const word = w.word.toLowerCase();
      if (word === q) score = 1000;
      else if (word.startsWith(q)) score = 500 - word.length;
      else if (word.includes(q)) score = 200 - word.indexOf(q) - word.length;
    }
    if (score > 0) hits.push([score, w]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].order - b[1].order);
  const exact = zh ? hits.filter(([score]) => score === 1000) : [];
  return (exact.length ? exact : hits).slice(0, limit).map((h) => h[1]);
}
