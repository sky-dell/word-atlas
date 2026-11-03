import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const TOPICS = [
  "education", "work", "technology", "science", "environment", "health", "society",
  "government", "economy", "media", "arts", "travel", "city", "nature", "daily",
  "emotion", "thinking", "sport", "history",
];

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
  const files = fs.readdirSync(entriesDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const lastFile = files.at(-1);
  let lastChunk = [];
  let lastTarget = "";

  for (const file of files) {
    const target = path.join(entriesDir, file);
    const chunk = JSON.parse(fs.readFileSync(target, "utf8"));
    let changed = false;
    const kept = [];
    for (const entry of chunk) {
      const override = overrides[entry.id] ?? {};
      if (override.entry && file !== lastFile) {
        changed = true;
        continue;
      }
      kept.push(entry);
      if (override.word && entry.w !== override.word) {
        entry.w = override.word;
        changed = true;
      }
      const extraSenses = override.senses ?? [];
      for (const sense of extraSenses) {
        if (entry.senses.some((current) => current.pos === sense.pos && current.zh === sense.zh)) continue;
        entry.senses.push(sense);
        changed = true;
      }
      entries.set(entry.id, entry);
    }
    lastChunk = file === lastFile ? kept : lastChunk;
    lastTarget = target;
    if (changed) fs.writeFileSync(target, JSON.stringify(kept));
  }

  let lastChanged = false;
  for (const [id, override] of Object.entries(overrides)) {
    if (!override.entry) continue;
    let entry = entries.get(id);
    if (!entry) {
      entry = { ...override.entry, id, m: 1 };
      entries.set(id, entry);
    }
    if (!lastChunk.some((current) => current.id === id)) {
      lastChunk.push(entry);
      lastChanged = true;
    }
  }
  if (lastChanged) fs.writeFileSync(lastTarget, JSON.stringify(lastChunk));

  const indexPath = path.join(publicDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.fields = [...index.fields.filter((field) => field !== "search"), "search"];
  for (const [id, override] of Object.entries(overrides)) {
    if (!override.entry || index.words.some((row) => row[0] === id)) continue;
    const entry = entries.get(id);
    const first = entry.senses[0];
    index.words.push([
      id, entry.w, `${first.pos} ${first.zh}`.trim(), entry.uk || entry.us,
      CEFR.indexOf(entry.cefr), TOPICS.indexOf(entry.topic), entry.m || 0, "",
    ]);
  }
  for (const row of index.words) {
    const entry = entries.get(row[0]);
    if (!entry) throw new Error(`Search index references missing entry ${row[0]}`);
    row[1] = entry.w;
    row.length = 8;
    row[7] = entry.senses
      .map((sense) => `${sense.pos} ${sense.zh}`.trim())
      .join(" ");
  }
  index.count = index.words.length;
  index.examples = [...entries.values()].reduce((total, entry) => total + entry.ex.length, 0);
  index.illustrated = index.words.filter((row) => row[6] & 1).length;
  index.voiced = index.words.filter((row) => row[6] & 2).length;
  fs.writeFileSync(indexPath, JSON.stringify(index));

  const dataPath = path.join(base, "data", "word-atlas.json");
  if (fs.existsSync(dataPath)) {
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    for (const entry of data) {
      if (!overrides[entry.id]) continue;
      const updated = entries.get(entry.id);
      if (updated) {
        entry.w = updated.w;
        entry.senses = updated.senses;
      }
    }
    for (const [id, override] of Object.entries(overrides)) {
      if (!override.entry || data.some((entry) => entry.id === id)) continue;
      const { m: _media, ...entry } = entries.get(id);
      data.push(entry);
    }
    writeJson(dataPath, data);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  augmentAtlas();
}
