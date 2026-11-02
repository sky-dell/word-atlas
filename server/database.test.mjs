import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.mjs";

test("malformed v1 stores fail migration without publishing v2 schema changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wa-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "broken.db"),
    db = openDatabase(path);
  db.exec(
    "DROP TABLE email_codes; DROP INDEX users_email; ALTER TABLE users DROP COLUMN email; ALTER TABLE users DROP COLUMN email_verified; DROP TABLE progress; PRAGMA user_version=1;",
  );
  db.close();
  assert.throws(
    () => openDatabase(path, { initialize: false }),
    /progress|schema/,
  );
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 1);
  assert.ok(
    !raw
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((row) => row.name === "email"),
  );
  assert.equal(
    raw
      .prepare("SELECT name FROM sqlite_master WHERE name='email_codes'")
      .get(),
    undefined,
  );
});
