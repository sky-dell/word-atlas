import assert from "node:assert/strict";
import test from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { matchedMeaning, searchAtlas } from "../atlas/search";

function word(id: string, text: string, zh: string, search: string, order: number): WordRef {
  return { id, word: text, zh, search, ipa: "", cefr: 0, topic: 0, media: 0, order } as WordRef;
}

function atlas(words: WordRef[]): Atlas {
  return { words } as Atlas;
}

test("searches Chinese definitions from every sense", () => {
  const bank = word("bank", "bank", "n. 银行", "n. 银行 n. 河岸；湖岸 v. 把钱存入银行", 0);
  const march = word("march", "March", "v. 齐步行进", "v. 齐步行进 n. 三月", 1);
  const book = atlas([bank, march]);

  assert.deepEqual(searchAtlas(book, "河岸").map(result => result.id), ["bank"]);
  assert.deepEqual(searchAtlas(book, "三月").map(result => result.id), ["march"]);
  assert.equal(matchedMeaning(bank, "河岸"), "河岸；湖岸");
  assert.equal(matchedMeaning(march, "三月"), "三月");
});

test("prefers an exact Chinese definition over a shorter substring", () => {
  const january = word("january", "January", "n. 一月", "n. 一月", 0);
  const november = word("november", "November", "n. 十一月", "n. 十一月", 1);

  assert.deepEqual(
    searchAtlas(atlas([january, november]), "一月").map(result => result.id),
    ["january"],
  );
});
