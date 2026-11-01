import fs from "node:fs/promises";
import { existsSync } from "node:fs";
const base = "https://0xlei.tech/words/atlas/classic/";
const response = await fetch(base + "index.json");
if (!response.ok) throw Error("Classic index unavailable");
const { ids } = await response.json();
const words = JSON.parse(
  await fs.readFile("public/atlas/index.json", "utf8"),
).words;
const byId = new Map(words.map((r) => [r[0], r[1]]));
await fs.mkdir("public/atlas/classic/img", { recursive: true });
for (let i = 0; i < ids.length; i += 8) {
  await Promise.all(
    ids.slice(i, i + 8).map(async (id) => {
      const dest = `public/atlas/classic/img/${id}.webp`;
      if (existsSync(dest)) return;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch(base + `img/${id}.webp`);
          if (!r.ok) throw Error(`${id}: ${r.status}`);
          await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
          return;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }),
  );
  if (i % 1200 === 0) console.log(`classic ${i}/${ids.length}`);
}
const manifest = Object.fromEntries(
  ids.map((id) => [String(byId.get(id) || id).toLowerCase(), `${id}.webp`]),
);
await fs.writeFile(
  "public/atlas/classic/manifest.json",
  JSON.stringify(manifest),
);
console.log(`Classic images: ${ids.length}`);
