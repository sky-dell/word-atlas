import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(dbPath, { initialize = true } = {}) {
  if (typeof dbPath !== "string" || !dbPath || dbPath === ":memory:")
    throw new Error("A dedicated file-backed dbPath is required");
  const path = resolve(dbPath);
  if (!initialize) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("An initialized regular account database is required");
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1, 2].includes(version))
      throw new Error(`Unsupported accounts migration version ${version}`);
    if (version === 0) {
      if (!initialize)
        throw new Error(
          "Account database is not initialized; use the local init command",
        );
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get()
      )
        throw new Error("Unversioned nonempty database; refusing migration");
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE users (
          id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          nickname TEXT NOT NULL, password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
          disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
          permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0,1)),
          expires_at INTEGER, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
          reauth_at INTEGER, peer_hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE reset_tokens (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
        CREATE INDEX limits_expiry ON rate_limits(expires_at);
        CREATE TABLE progress (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, dataset TEXT NOT NULL,
          version INTEGER NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id,dataset)
        ) STRICT;
        CREATE TABLE backups (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          dataset TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX backups_owner ON backups(user_id,dataset,created_at);
        CREATE TABLE audit (
          id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL REFERENCES users(id),
          action TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version=1;
        COMMIT;`);
    }
    if (version < 2) {
      // Do not publish a new schema version over an incomplete legacy store.
      for (const query of [
        "SELECT id,username,nickname,password_hash,role,disabled,permanent,expires_at,created_at FROM users LIMIT 0",
        "SELECT token_hash,user_id,csrf,expires_at,created_at,reauth_at,peer_hash FROM sessions LIMIT 0",
        "SELECT token_hash,user_id,expires_at FROM reset_tokens LIMIT 0",
        "SELECT key,count,expires_at FROM rate_limits LIMIT 0",
        "SELECT user_id,dataset,version,snapshot,updated_at FROM progress LIMIT 0",
        "SELECT id,user_id,dataset,version,snapshot,created_at FROM backups LIMIT 0",
        "SELECT id,actor_id,target_id,action,before_json,after_json,created_at FROM audit LIMIT 0",
      ])
        db.prepare(query).all();
      if (
        db.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").get()
      )
        throw new Error(
          "Accounts database integrity check failed before migration",
        );
      transaction(db, () =>
        db.exec(`
        ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
        ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1));
        CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
        CREATE TABLE email_codes (
          email TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('register','login')),
          nonce TEXT NOT NULL, code_hash TEXT NOT NULL,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
          ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY(email,purpose)
        ) STRICT;
        CREATE INDEX email_codes_expiry ON email_codes(expires_at);
        PRAGMA user_version=2;
      `),
      );
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    // Validate expected tables/columns even for an already-versioned database.
    for (const sql of [
      "SELECT id,password_hash,role,disabled,permanent,expires_at,email,email_verified FROM users LIMIT 0",
      "SELECT email,purpose,nonce,code_hash,user_id,attempts,ready,created_at,expires_at FROM email_codes LIMIT 0",
      "SELECT token_hash,user_id,csrf,expires_at,reauth_at,peer_hash FROM sessions LIMIT 0",
      "SELECT token_hash,user_id,expires_at FROM reset_tokens LIMIT 0",
      "SELECT key,count,expires_at FROM rate_limits LIMIT 0",
      "SELECT user_id,dataset,version,snapshot,updated_at FROM progress LIMIT 0",
      "SELECT id,user_id,dataset,version,snapshot,created_at FROM backups LIMIT 0",
      "SELECT id,actor_id,target_id,action,before_json,after_json,created_at FROM audit LIMIT 0",
    ])
      db.prepare(sql).all();
    if (
      db.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get()
    )
      throw new Error("Accounts database integrity check failed");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
