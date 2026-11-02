import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
const base = "https://0xlei.tech/words/";
const visited = new Set(),
  queue = [
    "atlas/extras/paraphrase.json",
    "atlas/extras/confusables.json",
    "atlas/extras/readings/index.json",
    "books/index.json",
  ];
function enqueue(name) {
  if (
    /^(?:atlas\/extras|books)\/[a-zA-Z0-9/_\-.]+$/.test(name) &&
    !name.split("/").includes("..") &&
    !visited.has(name)
  )
    queue.push(name);
}
function paths(value) {
  if (
    typeof value === "string" &&
    /^books\/.*\.(?:json|webp|jpg|png|mp3)$/.test(value)
  )
    enqueue(value);
  else if (Array.isArray(value)) value.forEach(paths);
  else if (value && typeof value === "object")
    Object.values(value).forEach(paths);
}
async function download(name) {
  const dest = path.join("public", name);
  if (!name.endsWith(".json") && existsSync(dest)) return;
  let data;
  for (let attempt = 0; attempt < 4; attempt++)
    try {
      const r = await fetch(base + name);
      if (!r.ok) throw Error(`${name} ${r.status}`);
      data = Buffer.from(await r.arrayBuffer());
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);
  if (name.endsWith(".json")) {
    const value = JSON.parse(data);
    paths(value);
    if (name === "atlas/extras/readings/index.json")
      for (const item of value.items)
        enqueue(`atlas/extras/readings/${item.id}.json`);
    if (name === "books/index.json")
      for (const b of value.books)
        for (const c of b.chapters)
          if (c.ready) enqueue(`books/${b.id}/ch-${c.n}.json`);
  }
}
while (queue.length) {
  const batch = [...new Set(queue.splice(0, 8))].filter((p) => !visited.has(p));
  batch.forEach((p) => visited.add(p));
  await Promise.all(batch.map(download));
}
console.log(`Synced ${visited.size} reading, drill and book resources`);
