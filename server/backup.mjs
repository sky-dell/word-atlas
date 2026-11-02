import { backup } from "node:sqlite";
import {
  open,
  chmod,
  unlink,
  mkdir,
  lstat,
  readdir,
  rename,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// node:sqlite's online backup includes committed WAL pages. Reserve the target
// exclusively; never overwrite an existing database or follow a target symlink.
export async function backupDatabase(db, destination) {
  const target = resolve(destination);
  const file = await open(target, "wx", 0o600);
  await file.close();
  try {
    await backup(db, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
  return target;
}

export async function backupWithRetention(
  db,
  directory,
  { now = Date.now } = {},
) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      "Backup directory must be a real private directory, not a symlink",
    );
  await chmod(dir, 0o700);
  const stamp = new Date(now()).toISOString().replaceAll(":", "-");
  const name = `accounts-${stamp}-${randomUUID()}.sqlite`;
  const partial = join(dir, `.${name}.partial`),
    target = join(dir, name);
  await backupDatabase(db, partial);
  try {
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  // Only our own complete, regular copies are retention candidates. Never
  // follow symlinks or remove another program's backups/temporary files.
  const files = [];
  for (const entry of await readdir(dir)) {
    if (
      !/^accounts-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.sqlite$/.test(
        entry,
      )
    )
      continue;
    const stat = await lstat(join(dir, entry)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isFile() && !stat.isSymbolicLink()) files.push(entry);
  }
  files.sort().reverse();
  for (const old of files.slice(7))
    await unlink(join(dir, old)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  return target;
}
