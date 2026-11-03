import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditAtlas } from "../../src/atlas/audit.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const json = args.includes("--json");
const referenceIndex = args.indexOf("--reference");
const referencePath = referenceIndex >= 0
  ? path.resolve(args[referenceIndex + 1])
  : path.join(root, "scripts", "atlas", "foundation-words.json");

function loadReference(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  return {
    groups: {
      reference: text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")),
    },
  };
}

const publicDir = path.join(root, "public", "atlas");
const index = JSON.parse(fs.readFileSync(path.join(publicDir, "index.json"), "utf8"));
const entries = [];
for (const file of fs.readdirSync(path.join(publicDir, "entries"))) {
  if (!file.endsWith(".json")) continue;
  entries.push(...JSON.parse(fs.readFileSync(path.join(publicDir, "entries", file), "utf8")));
}

const reference = loadReference(referencePath);
const result = auditAtlas(index, entries, reference);
const referenceWords = Object.values(reference.groups).flat();
const missing = Object.values(result.missingByGroup).flat();
const failures = {
  missing: missing.length,
  caseMismatch: result.caseMismatches.length,
  unsearchableSense: result.searchFailures.length,
  duplicateId: result.duplicateIds.length,
  duplicateWord: result.duplicateWords.length,
  orphanIndexRow: result.orphanIndexRows.length,
  orphanEntry: result.orphanEntries.length,
};
const report = {
  atlas: {
    words: index.count,
    entries: entries.length,
    referenceWords: referenceWords.length,
    matched: referenceWords.length - missing.length,
    coverage: referenceWords.length ? Number(((referenceWords.length - missing.length) / referenceWords.length).toFixed(4)) : 1,
  },
  failures,
  missingByGroup: result.missingByGroup,
  caseMismatches: result.caseMismatches,
  searchFailures: result.searchFailures,
  duplicateIds: result.duplicateIds,
  duplicateWords: result.duplicateWords,
  orphanIndexRows: result.orphanIndexRows,
  orphanEntries: result.orphanEntries,
};

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log(`Atlas: ${report.atlas.words} words, ${report.atlas.entries} entries`);
  console.log(`Reference coverage: ${report.atlas.matched}/${report.atlas.referenceWords} (${(report.atlas.coverage * 100).toFixed(1)}%)`);
  for (const [group, words] of Object.entries(result.missingByGroup)) {
    console.log(`Missing ${group}: ${words.join(", ")}`);
  }
  if (result.caseMismatches.length) console.log("Case mismatches:", result.caseMismatches);
  if (result.searchFailures.length) console.log(`Unsearchable senses: ${result.searchFailures.length}`);
  if (result.duplicateIds.length) console.log(`Duplicate ids: ${result.duplicateIds.join(", ")}`);
  if (result.duplicateWords.length) console.log(`Duplicate words: ${result.duplicateWords.join(", ")}`);
  if (result.orphanIndexRows.length || result.orphanEntries.length)
    console.log("Orphans:", { index: result.orphanIndexRows, entries: result.orphanEntries });
}

if (strict && Object.values(failures).some(Boolean)) process.exitCode = 1;
