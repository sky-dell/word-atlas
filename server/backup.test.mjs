import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  stat,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.mjs";
import { backupWithRetention } from "./backup.mjs";

test("nightly backup directory is private; retains seven newest complete copies, preserving unrelated files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wa-backup-"));
  const db = openDatabase(join(dir, "source.db"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const out = join(dir, "backups");
  let last;
  for (let i = 0; i < 9; i++)
    last = await backupWithRetention(db, out, {
      now: () => Date.UTC(2026, 9, 28, 0, 0, i),
    });
  await writeFile(join(out, "unrelated.txt"), "preserve");
  const files = (await readdir(out)).filter((name) => name.endsWith(".sqlite"));
  assert.equal(files.length, 7);
  assert.ok(files.includes(last.split("/").pop()));
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  for (const file of files)
    assert.equal((await stat(join(out, file))).mode & 0o777, 0o600);
  const restored = openDatabase(last);
  assert.equal(
    restored.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  restored.close();
  assert.ok((await readdir(out)).includes("unrelated.txt"));
  await symlink(out, join(dir, "linked"));
  await assert.rejects(
    backupWithRetention(db, join(dir, "linked")),
    /directory|symlink/i,
  );
});

test("overlapping backup runs never fail retention on files removed by another run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wa-backup-overlap-"));
  const db = openDatabase(join(dir, "source.db"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      backupWithRetention(db, join(dir, "backups")),
    ),
  );
  assert.equal(
    results.filter((r) => r.status === "rejected").length,
    0,
    results
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason.message)
      .join("\n"),
  );
  assert.equal(
    (await readdir(join(dir, "backups"))).filter((n) => n.endsWith(".sqlite"))
      .length,
    7,
  );
});
