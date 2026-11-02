import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  mailConfigFromEnv,
  mailEnvFile,
  normalizeMailConfig,
} from "./mail-config.mjs";

function storeError() {
  return Object.assign(new Error("Invalid mail store"), {
    code: "invalid_mail_store",
  });
}

function validFileInfo(info) {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.uid === 0 &&
    (info.mode & 0o077) === 0
  );
}

async function validateDirectory(file) {
  const directory = dirname(resolve(file));
  let info;
  try {
    info = await lstat(directory);
  } catch {
    throw storeError();
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0
  ) {
    throw storeError();
  }
  return directory;
}

async function openExisting(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw storeError();
  }
  if (!validFileInfo(info)) throw storeError();

  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      !validFileInfo(opened) ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino
    ) {
      throw storeError();
    }
    return { handle, info: opened };
  } catch {
    await handle?.close().catch(() => {});
    throw storeError();
  }
}

async function readDocument(file) {
  await validateDirectory(file);
  const opened = await openExisting(file);
  if (!opened) return null;
  let source;
  try {
    source = await opened.handle.readFile("utf8");
  } catch {
    throw storeError();
  } finally {
    await opened.handle.close().catch(() => {});
  }

  try {
    const env = parseEnv(source);
    const config = mailConfigFromEnv(env);
    if (!config) throw storeError();
    const secret = env.MAIL_CODE_SECRET;
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/i.test(secret)) {
      throw storeError();
    }
    return { config, secret };
  } catch {
    throw storeError();
  }
}

export async function readMailStore(file) {
  const stored = await readDocument(file);
  return stored?.config ?? null;
}

export async function writeMailStore(file, config) {
  const directory = await validateDirectory(file);
  const stored = await readDocument(file);
  const normalized = normalizeMailConfig(config, {
    currentPassword: stored?.config.password,
  });
  const secret = stored?.secret ?? randomBytes(32).toString("hex");
  const data = mailEnvFile(normalized, secret);
  const temporary = join(
    directory,
    `.mail-${process.pid}-${randomUUID()}.tmp`,
  );

  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    renamed = true;
    await open(directory, constants.O_RDONLY)
      .then(async (directoryHandle) => {
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      })
      .catch(() => {});
  } catch {
    throw storeError();
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}
