#!/usr/bin/env node
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, transaction } from "../server/database.mjs";
import { createAdministrator, resetAdministrator } from "../server/admin.mjs";
import { validPassword, PASSWORD_ERROR } from "../server/passwords.mjs";
import { backupDatabase, backupWithRetention } from "../server/backup.mjs";

const usage =
  "Usage: node scripts/admin.mjs init|invalidate-sessions [--db PATH]\n       node scripts/admin.mjs create-admin|reset-admin --username NAME [--db PATH]\n       node scripts/admin.mjs backup [--db PATH] [--output FILE]\nPasswords are accepted only at the interactive local TTY prompt.";

// Raw TTY input is never echoed or placed in argv, environment, readline
// history, logs or temporary files. Pipes and redirected input are rejected.
export function promptPassword(label) {
  const input = process.stdin,
    output = process.stderr;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function")
    throw new Error("Password entry requires an interactive local TTY");
  return new Promise((resolve, reject) => {
    let value = "",
      done = false;
    const wasRaw = input.isRaw;
    const finish = (error) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
      value = "";
    };
    const onEnd = () => finish(new Error("Password entry canceled"));
    const onError = () => finish(new Error("Password input failed"));
    const onData = (chunk) => {
      for (const char of chunk) {
        if (done) break;
        if (char === "\r" || char === "\n") finish();
        else if (char === "\u0003" || char === "\u0004" || char === "\u001b")
          finish(new Error("Password entry canceled"));
        else if (char === "\u007f" || char === "\b")
          value = [...value].slice(0, -1).join("");
        else if (char >= " " && [...value].length < 129) value += char;
      }
    };
    output.write(label);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "--help" && rest.length === 0) {
    console.log(usage);
    return;
  }
  if (!["init", "invalidate-sessions", "create-admin", "reset-admin", "backup"].includes(command))
    throw new Error(usage);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i],
      value = rest[i + 1];
    if (
      !["--db", "--username", "--output"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(options, flag)
    )
      throw new Error("Invalid arguments or unsupported option. " + usage);
    options[flag] = value;
  }
  if (
    ["backup","init","invalidate-sessions"].includes(command)
      ? options["--username"] || (command !== "backup" && options["--output"])
      : !options["--username"] || options["--output"]
  )
    throw new Error("Invalid arguments. " + usage);
  const dbPath = resolve(
    options["--db"] ||
      process.env.ACCOUNTS_DB ||
      "/var/lib/word-atlas/accounts.sqlite",
  );
  let password;
  if (["create-admin", "reset-admin"].includes(command)) {
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(options["--username"]))
      throw new Error("Invalid username");
    password = await promptPassword("New password (8–128 characters, uppercase, lowercase, digit and symbol): ");
    if (!validPassword(password))
      throw new Error(PASSWORD_ERROR);
    const confirm = await promptPassword("Confirm new password: ");
    if (password !== confirm) throw new Error("Passwords do not match");
  }
  // A timer typo must not silently create and back up a new empty accounts DB.
  try {
    const info = lstatSync(dbPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Database must be a regular file, not a symlink");
  } catch (error) {
    if (!(["create-admin","init"].includes(command) && error.code === "ENOENT")) throw error;
  }
  // Maintenance must never turn an accidentally truncated/uninitialized file
  // into an apparently valid empty backup or a successful restore operation.
  const db = openDatabase(dbPath, {
    initialize: command === "init" || command === "create-admin",
  });
  try {
    if (command === "init") {
      console.log('Account database initialized; no user or default password created.');
    } else if (command === "invalidate-sessions") {
      transaction(db,()=>{db.exec('DELETE FROM sessions; DELETE FROM reset_tokens; DELETE FROM email_codes;');});
      console.log('All temporary sessions and reset credentials invalidated; durable accounts and learning data preserved.');
    } else if (command === "create-admin") {
      await createAdministrator(db, {
        username: options["--username"],
        password,
      });
      console.log("Administrator created.");
    } else if (command === "reset-admin") {
      await resetAdministrator(db, {
        username: options["--username"],
        password,
      });
      console.log("Administrator password reset; all sessions revoked.");
    } else {
      const file = options["--output"]
        ? await backupDatabase(db, options["--output"])
        : await backupWithRetention(
            db,
            process.env.ACCOUNT_BACKUP_DIR || "/var/lib/word-atlas/backups",
          );
      console.log(`Consistent account backup saved: ${file}`);
    }
  } finally {
    password = undefined;
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // SQLite errors may contain internals. Only show controlled usage/TTY and
    // operational errors; never print supplied arguments or password values.
    console.error(
      error.code?.startsWith("ERR_SQLITE")
        ? "Account database operation failed"
        : error.message,
    );
    process.exitCode = 1;
  });
}
