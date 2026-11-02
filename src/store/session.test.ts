import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSession, nextNew, todayPlan } from "./session";
import { defaultSettings, emptyProgress, dayKey } from "./store";
import { review, Rating } from "./srs";
import { DEFAULT_APPEARANCE, setAppearance } from "../ui/Appearance";
import type { Atlas, WordRef } from "../atlas/types";
const words: WordRef[] = [
  ["book", 0, 0],
  ["river", 0, 1],
  ["analysis", 5, 0],
].map(([id, cefr, topic], order) => ({
  id: String(id),
  word: String(id),
  zh: "词",
  ipa: "",
  cefr: Number(cefr),
  topic: Number(topic),
  media: 31,
  order,
}));
const atlas = {
  id: "test",
  count: 3,
  words,
  topics: [
    ["education", "教育"],
    ["nature", "自然"],
  ],
  byId: new Map(words.map((w) => [w.id, w])),
} as Atlas;
afterEach(() => setAppearance({ ...DEFAULT_APPEARANCE }));
test("topic route keeps new words inside selected topic, including fallback", () => {
  setAppearance({ route: "topic", routeTopic: "nature" });
  assert.deepEqual(nextNew(atlas, emptyProgress("test"), defaultSettings, 10), [
    "river",
  ]);
});
test("automatic exam plan respects target level and never schedules advanced words above target", () => {
  setAppearance({ planAuto: true, targetBand: 5, examDate: "2099-01-01" });
  const plan = todayPlan(atlas, emptyProgress("test"), defaultSettings);
  assert.equal(plan.fresh.length, 1);
  assert.ok(!plan.fresh.includes("analysis"));
  assert.ok(Number.isFinite(plan.minutes));
});
test("expired or unset exam dates preserve manual daily settings", () => {
  setAppearance({ planAuto: true, examDate: "2020-01-01" });
  assert.equal(
    todayPlan(atlas, emptyProgress("test"), { ...defaultSettings, dailyNew: 0 })
      .fresh.length,
    0,
  );
});
test("an expired exam stops filtering advanced vocabulary", () => {
  setAppearance({ planAuto: true, targetBand: 5, examDate: "2020-01-01" });
  const p = emptyProgress("test");
  for (const id of ["book", "river"])
    p.cards[id] = review(undefined, Rating.Good, Date.now());
  assert.deepEqual(nextNew(atlas, p, defaultSettings, 5), ["analysis"]);
});
test("automatic daily target remains stable as new words are learned today and extra sessions still work", () => {
  const words = Array.from({ length: 20 }, (_, i) => ({
    ...atlas.words[0],
    id: `w${i}`,
    word: `w${i}`,
    order: i,
  }));
  const a = {
    ...atlas,
    count: 20,
    words,
    byId: new Map(words.map((w) => [w.id, w])),
  };
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  setAppearance({ planAuto: true, targetBand: 5, examDate: tomorrow });
  const p = emptyProgress("test");
  const daily = todayPlan(a, p, defaultSettings).daily;
  for (const w of words.slice(0, 7))
    p.cards[w.id] = review(undefined, Rating.Good, Date.now());
  p.days[dayKey()] = { n: 7, r: 7, c: 7, t: 0 };
  const plan = todayPlan(a, p, defaultSettings);
  assert.equal(plan.daily, daily);
  assert.equal(plan.fresh.length, Math.max(0, daily - 7));
  assert.equal(
    buildSession(a, p, defaultSettings, {
      ids: nextNew(a, p, defaultSettings, 5),
    }).newIds.length,
    5,
  );
});
