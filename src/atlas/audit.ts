import type { Entry, IndexRow } from "./types";

export interface CoverageReference {
  groups: Record<string, string[]>;
}

export interface SearchFailure {
  id: string;
  word: string;
  sense: string;
}

export interface CaseMismatch {
  id: string;
  expected: string;
  actual: string;
}

export interface AtlasAuditResult {
  missingByGroup: Record<string, string[]>;
  caseMismatches: CaseMismatch[];
  searchFailures: SearchFailure[];
  duplicateIds: string[];
  duplicateWords: string[];
  orphanIndexRows: string[];
  orphanEntries: string[];
}

export function auditAtlas(
  index: { words: IndexRow[] },
  entries: Entry[],
  reference: CoverageReference,
): AtlasAuditResult {
  const byWord = new Map<string, IndexRow>();
  const duplicateIds = new Set<string>();
  const duplicateWords = new Set<string>();
  const ids = new Set<string>();

  for (const row of index.words) {
    if (ids.has(row[0])) duplicateIds.add(row[0]);
    ids.add(row[0]);
    const key = row[1].toLowerCase();
    if (byWord.has(key)) duplicateWords.add(key);
    else byWord.set(key, row);
  }

  const missingByGroup: Record<string, string[]> = {};
  const caseMismatches: CaseMismatch[] = [];
  for (const [group, expectedWords] of Object.entries(reference.groups)) {
    const missing = expectedWords.filter(word => !byWord.has(word.toLowerCase()));
    if (missing.length) missingByGroup[group] = missing;
    for (const expected of expectedWords) {
      const row = byWord.get(expected.toLowerCase());
      if (row && row[1] !== expected)
        caseMismatches.push({ id: row[0], expected, actual: row[1] });
    }
  }

  const rowsById = new Map(index.words.map(row => [row[0], row]));
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  const searchFailures: SearchFailure[] = [];
  for (const entry of entries) {
    const row = rowsById.get(entry.id);
    if (!row) continue;
    const search = row[7] || row[2];
    for (const sense of entry.senses) {
      if (!search.includes(sense.zh))
        searchFailures.push({ id: entry.id, word: entry.w, sense: sense.zh });
    }
  }

  return {
    missingByGroup,
    caseMismatches,
    searchFailures,
    duplicateIds: [...duplicateIds].sort(),
    duplicateWords: [...duplicateWords].sort(),
    orphanIndexRows: index.words.filter(row => !entriesById.has(row[0])).map(row => row[0]),
    orphanEntries: entries.filter(entry => !rowsById.has(entry.id)).map(entry => entry.id),
  };
}
