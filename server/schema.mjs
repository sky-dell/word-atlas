export const MAX_BODY = 10 * 1024 * 1024;
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const text = (v, max = 200) => typeof v === "string" && v.length <= max;
const keys = (v, allowed) =>
  obj(v) && Object.keys(v).every((k) => allowed.includes(k));
const array = (v, max, check) =>
  Array.isArray(v) && v.length <= max && v.every(check);
const record = (v, max, check) =>
  obj(v) &&
  Object.keys(v).length <= max &&
  Object.entries(v).every(([k, x]) => text(k) && check(x, k));
export const validDataset = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);

// Apply a general complexity and prototype-key bound before the domain checks.
// This includes extras, whose versioned reader keys contain nested JSON values.
export function safeTree(root) {
  const stack = [[root, 0]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (++nodes > 500000 || depth > 16) return false;
    if (typeof v === "string" && v.length > 2_000_000) return false;
    if (typeof v === "number" && !Number.isFinite(v)) return false;
    if (v && typeof v === "object") {
      for (const [k, value] of Object.entries(v)) {
        if (
          k.length > 300 ||
          ["__proto__", "prototype", "constructor"].includes(k)
        )
          return false;
        stack.push([value, depth + 1]);
      }
    }
  }
  return true;
}

function validCard(c) {
  return (
    keys(c, [
      "due",
      "s",
      "d",
      "el",
      "sd",
      "ls",
      "reps",
      "lapses",
      "st",
      "last",
      "seen",
    ]) &&
    ["due", "s", "el", "sd", "ls", "reps", "lapses", "seen"].every((k) =>
      num(c[k]),
    ) &&
    num(c.d, 0, 11) &&
    [0, 1, 2, 3].includes(c.st) &&
    (c.last === undefined || num(c.last))
  );
}
const settingsRules = {
  accent: (v) => ["uk", "us"].includes(v),
  autoplay: (v) => typeof v === "boolean",
  dailyNew: (v) => Number.isInteger(v) && num(v, 0, 100),
  retention: (v) => num(v, 0.7, 0.97),
  theme: (v) => ["system", "light", "dark"].includes(v),
  sfx: (v) => typeof v === "boolean",
  spell: (v) => typeof v === "boolean",
  startLevel: (v) => Number.isInteger(v) && num(v, 0, 5),
  onboarded: (v) => typeof v === "boolean",
  dataset: (v) => ["open", "private"].includes(v),
  ambience: (v) =>
    [
      "off",
      "stars",
      "rain",
      "sea",
      "forest",
      "fire",
      "voyage",
      "cafe",
    ].includes(v),
  ambienceVolume: (v) => num(v, 0, 1),
  splash: (v) => typeof v === "boolean",
};

export function validSnapshot(s, dataset) {
  if (
    !safeTree(s) ||
    !keys(s, [
      "app",
      "version",
      "exported",
      "exportedAt",
      "progress",
      "settings",
      "extras",
    ]) ||
    s.app !== "word-atlas" ||
    s.version !== 2 ||
    ![s.exported, s.exportedAt].every(
      (v) =>
        v === undefined ||
        num(v) ||
        (text(v, 40) && Number.isFinite(Date.parse(v))),
    )
  )
    return false;
  const p = s.progress;
  if (
    !keys(p, [
      "version",
      "datasetId",
      "cards",
      "bookmarks",
      "days",
      "typing",
      "session",
      "mistakes",
    ]) ||
    p.version !== 2 ||
    p.datasetId !== dataset ||
    p.session !== null
  )
    return false;
  if (
    !record(p.cards, 30000, validCard) ||
    !array(p.bookmarks, 20000, (v) => text(v)) ||
    !array(p.mistakes, 300, (v) => text(v))
  )
    return false;
  if (
    !record(
      p.days,
      36600,
      (d, k) =>
        /^\d{4}-\d{2}-\d{2}$/.test(k) &&
        keys(d, ["n", "r", "c", "t"]) &&
        ["n", "r", "c", "t"].every((k) => num(d[k])),
    )
  )
    return false;
  if (
    !array(
      p.typing,
      500,
      (r) =>
        keys(r, ["at", "mode", "items", "wpm", "accuracy"]) &&
        num(r.at) &&
        ["word", "sentence", "dictation"].includes(r.mode) &&
        num(r.items) &&
        num(r.wpm, 0, 400) &&
        num(r.accuracy, 0, 100),
    )
  )
    return false;
  if (
    !obj(s.settings) ||
    !Object.entries(s.settings).every(
      ([k, v]) => Object.hasOwn(settingsRules, k) && settingsRules[k](v),
    )
  )
    return false;
  // Match existing exportExtras: only learning/reader/appearance data, not identity.
  if (!obj(s.extras) || Object.keys(s.extras).length > 20000) return false;
  let total = 0;
  for (const [k, v] of Object.entries(s.extras)) {
    if (
      k.length > 300 ||
      !(
        [
          "word-atlas:appearance",
          "word-atlas:reader:v1",
          "word-atlas:reader-position:v1",
        ].includes(k) ||
        k.startsWith("word-atlas:extras:v1:") ||
        k.startsWith("word-atlas:illustration:")
      )
    )
      return false;
    const serialized = typeof v === "string" ? v : JSON.stringify(v);
    if (
      serialized.length > 2_000_000 ||
      (total += k.length + serialized.length) > 4_000_000
    )
      return false;
  }
  return true;
}
