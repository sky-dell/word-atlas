import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const pub = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const base = "https://0xlei.tech/words/";
async function download(name) {
  const r = await fetch(base + name);
  if (!r.ok) throw Error(`${name}: ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const dest = path.join(pub, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return bytes;
}
const idx = JSON.parse(await download("atlas/index.json"));
const files = Array.from(
  { length: Math.ceil(idx.count / idx.chunk) },
  (_, i) => `atlas/entries/${i}.json`,
);
for (let i = 0; i < files.length; i += 8)
  await Promise.all(files.slice(i, i + 8).map(download));
// The public release includes fewer second-example recordings than the live site.
const missing = idx.words.filter(
  (r) =>
    r[6] & 16 && !existsSync(path.join(pub, `atlas/audio/ex2/${r[0]}.mp3`)),
);
for (let i = 0; i < missing.length; i += 12) {
  await Promise.all(
    missing
      .slice(i, i + 12)
      .map((r) => download(`atlas/audio/ex2/${r[0]}.mp3`)),
  );
  if (i % 600 === 0) console.log(`second-example audio ${i}/${missing.length}`);
}
console.log(
  JSON.stringify({
    words: idx.count,
    chunks: files.length,
    addedSecondExampleAudio: missing.length,
  }),
);
