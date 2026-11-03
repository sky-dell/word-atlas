import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import type { Atlas, Entry, IndexRow } from "./types";
import { searchAtlas } from "./search";

const index = JSON.parse(readFileSync("public/atlas/index.json", "utf8")) as {
  words: IndexRow[];
};
const entries = new Map<string, Entry>();
for (const file of readdirSync("public/atlas/entries")) {
  if (!file.endsWith(".json")) continue;
  for (const entry of JSON.parse(readFileSync(`public/atlas/entries/${file}`, "utf8")) as Entry[]) {
    entries.set(entry.id, entry);
  }
}

test("the public search index contains every Chinese sense", () => {
  for (const row of index.words) {
    const entry = entries.get(row[0]);
    assert.ok(entry, `missing entry for ${row[0]}`);
    for (const sense of entry.senses) {
      assert.ok(row[7]?.includes(sense.zh), `${row[1]} is missing the searchable sense ${sense.zh}`);
    }
  }
});

test("March is searchable by its month meaning", () => {
  const march = index.words.find(row => row[0] === "march");
  assert.ok(march);
  assert.match(march[7] || "", /三月/);
});

test("the real index returns the intended month and excludes longer numeral substrings", () => {
  const words = index.words.map(row => ({
    id: row[0],
    word: row[1],
    zh: row[2],
    ipa: row[3],
    cefr: row[4],
    topic: row[5],
    media: row[6],
    search: row[7],
    order: 0,
  }));
  const atlas = { words } as Atlas;

  assert.deepEqual(searchAtlas(atlas, "三月").map(word => word.id), ["march"]);
  assert.deepEqual(searchAtlas(atlas, "一月").map(word => word.id), ["january"]);
});
