import { randomUUID } from "node:crypto";
import { transaction } from "./database.mjs";
import { hashPassword } from "./passwords.mjs";

function username(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(value))
    throw new Error(
      "Username must contain 3–32 ASCII letters, digits or underscores",
    );
}
export async function createAdministrator(
  db,
  { username: name, password, nickname = "" },
) {
  username(name);
  if (typeof nickname !== "string" || [...nickname].length > 80)
    throw new Error("Invalid nickname");
  const encoded = await hashPassword(password);
  return transaction(db, () => {
    if (
      db
        .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
        .get(name)
    )
      throw new Error(
        "Username already exists; local bootstrap does not promote existing users",
      );
    const id = randomUUID(),
      createdAt = Date.now();
    db.prepare(
      "INSERT INTO users(id,username,nickname,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)",
    ).run(id, name, nickname, encoded, createdAt);
    db.prepare(
      "INSERT INTO audit(actor_id,target_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, id, "cli_create_admin", "{}", '{"role":"admin"}', createdAt);
    return db
      .prepare(
        "SELECT id,username,nickname,role,disabled,permanent,expires_at FROM users WHERE id=?",
      )
      .get(id);
  });
}
export async function resetAdministrator(db, { username: name, password }) {
  username(name);
  const target = db
    .prepare(
      "SELECT id,password_hash FROM users WHERE username=? COLLATE NOCASE AND role='admin'",
    )
    .get(name);
  if (!target) throw new Error("Administrator not found");
  const encoded = await hashPassword(password);
  transaction(db, () => {
    const result = db
      .prepare(
        "UPDATE users SET password_hash=? WHERE id=? AND role='admin' AND password_hash=?",
      )
      .run(encoded, target.id, target.password_hash);
    if (result.changes !== 1)
      throw new Error("Administrator changed during password reset; retry");
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    db.prepare("DELETE FROM reset_tokens WHERE user_id=?").run(target.id);
    db.prepare(
      "DELETE FROM email_codes WHERE user_id=? OR email=(SELECT email FROM users WHERE id=?)",
    ).run(target.id, target.id);
    db.prepare(
      "INSERT INTO audit(actor_id,target_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(target.id, target.id, "cli_reset_admin", "{}", "{}", Date.now());
  });
}
