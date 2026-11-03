import assert from "node:assert/strict";
import test from "node:test";
import type { Entry, IndexRow } from "./types";
import { auditAtlas } from "./audit";

function row(id: string, word: string, search: string): IndexRow {
  return [id, word, "n. 释义", "", 0, 14, 0, search];
}

function entry(id: string, word: string, meaning = "释义"): Entry {
  return {
    id,
    w: word,
    uk: "",
    us: "",
    senses: [{ pos: "n.", zh: meaning, en: "" }],
    ex: [],
    col: [],
    fam: [],
    syn: [],
    ant: [],
    tip: "",
    cefr: "A1",
    topic: "daily",
    m: 0,
  };
}

test("reports missing reference words by group", () => {
  const result = auditAtlas(
    { words: [row("hello", "hello", "n. 你好")] },
    [entry("hello", "hello", "你好")],
    { groups: { greetings: ["hello", "goodbye"] } },
  );

  assert.deepEqual(result.missingByGroup, { greetings: ["goodbye"] });
});

test("reports reference words whose canonical capitalization is wrong", () => {
  const result = auditAtlas(
    { words: [row("march", "march", "n. 三月")] },
    [entry("march", "march", "三月")],
    { groups: { months: ["March"] } },
  );

  assert.deepEqual(result.caseMismatches, [
    { id: "march", expected: "March", actual: "march" },
  ]);
});

test("reports a sense that exists in the entry but not the search index", () => {
  const bank = entry("bank", "bank", "银行");
  bank.senses.push({ pos: "n.", zh: "河岸", en: "" });
  const result = auditAtlas(
    { words: [row("bank", "bank", "n. 银行")] },
    [bank],
    { groups: {} },
  );

  assert.deepEqual(result.searchFailures, [
    { id: "bank", word: "bank", sense: "河岸" },
  ]);
});
