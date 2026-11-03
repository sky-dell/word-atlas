import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

export function augmentAtlas(base = root) {
  const publicDir = path.join(base, "public", "atlas");
  const entriesDir = path.join(publicDir, "entries");
  const overrides = JSON.parse(
    fs.readFileSync(path.join(base, "scripts", "atlas", "content-overrides.json"), "utf8"),
  );
  const entries = new Map();

  for (const file of fs.readdirSync(entriesDir).filter((name) => name.endsWith(".json"))) {
    const target = path.join(entriesDir, file);
    const chunk = JSON.parse(fs.readFileSync(target, "utf8"));
    let changed = false;
    for (const entry of chunk) {
      const extraSenses = overrides[entry.id]?.senses ?? [];
      for (const sense of extraSenses) {
        if (entry.senses.some((current) => current.pos === sense.pos && current.zh === sense.zh)) continue;
        entry.senses.push(sense);
        changed = true;
      }
      entries.set(entry.id, entry);
    }
    if (changed) fs.writeFileSync(target, JSON.stringify(chunk));
  }

  const indexPath = path.join(publicDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.fields = [...index.fields.filter((field) => field !== "search"), "search"];
  for (const row of index.words) {
    const entry = entries.get(row[0]);
    if (!entry) throw new Error(`Search index references missing entry ${row[0]}`);
    row.length = 8;
    row[7] = entry.senses
      .map((sense) => `${sense.pos} ${sense.zh}`.trim())
      .join(" ");
  }
  fs.writeFileSync(indexPath, JSON.stringify(index));

  const dataPath = path.join(base, "data", "word-atlas.json");
  if (fs.existsSync(dataPath)) {
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    for (const entry of data) {
      if (!overrides[entry.id]) continue;
      const updated = entries.get(entry.id);
      if (updated) entry.senses = updated.senses;
    }
    writeJson(dataPath, data);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  augmentAtlas();
}
