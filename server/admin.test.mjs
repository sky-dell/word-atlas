import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.mjs";
import { createAdministrator, resetAdministrator } from "./admin.mjs";
import { verifyPassword } from "./passwords.mjs";

test("local bootstrap has no defaults, no web promotion, protects ordinary users and revokes sessions on reset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wa-admin-"));
  const db = openDatabase(join(dir, "accounts.db"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  const user = await createAdministrator(db, {
    username: "LocalAdmin",
    password: "a secure local secret",
    nickname: "Operator",
  });
  assert.equal(user.role, "admin");
  assert.equal(user.permanent, 0);
  assert.equal(user.password_hash, undefined);
  assert.equal(
    await verifyPassword(
      "a secure local secret",
      db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id)
        .password_hash,
    ),
    true,
  );
  await assert.rejects(
    createAdministrator(db, {
      username: "localadmin",
      password: "a secure local secret",
    }),
  );
  db.prepare(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,peer_hash) VALUES('test',?,'test',9999999999999,1,'test')",
  ).run(user.id);
  await resetAdministrator(db, {
    username: "LOCALADMIN",
    password: "a different local secret",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(
    await verifyPassword(
      "a different local secret",
      db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id)
        .password_hash,
    ),
    true,
  );
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(user.id);
  await assert.rejects(
    resetAdministrator(db, {
      username: "LocalAdmin",
      password: "another secure secret",
    }),
  );
});

test("CLI rejects password flags, unknown flags and noninteractive password input", () => {
  const cli = new URL("../scripts/admin.mjs", import.meta.url);
  for (const args of [
    ["create-admin", "--db", "/never-created.db", "--username", "operator"],
    ["create-admin", "--password", "do-not-log-this"],
    ["reset-admin", "--password-file", "/tmp/secret"],
    ["create-admin", "--unknown", "x"],
  ]) {
    const r = spawnSync(process.execPath, [cli.pathname, ...args], {
      input: "a secure password\n",
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.ok(!`${r.stdout}${r.stderr}`.includes("do-not-log-this"));
    assert.match(r.stderr, /interactive|TTY|arguments|option|usage/i);
  }
});

test('database initialization is explicit and ordinary production opens reject missing or empty files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-init-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'accounts.sqlite');
  assert.throws(()=>openDatabase(target,{initialize:false}),/ENOENT|initialized|missing/);
  const cli=new URL('../scripts/admin.mjs',import.meta.url);
  const run=spawnSync(process.execPath,[cli.pathname,'init','--db',target],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const db=openDatabase(target,{initialize:false});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);db.close();
});

test('restoring database can invalidate temporary credentials without deleting permanent account or progress',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-restored-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'accounts.sqlite'),db=openDatabase(target);
  const user=await createAdministrator(db,{username:'restore_operator',password:'only a restore test password'});
  db.prepare("INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,peer_hash) VALUES('temporary',?,'csrf',9999999999999,1,'test')").run(user.id);
  db.prepare("INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES('temporary-reset',?,9999999999999)").run(user.id);
  db.prepare("INSERT INTO progress(user_id,dataset,version,snapshot,updated_at) VALUES(?,'open',1,'kept',1)").run(user.id);db.close();
  const r=spawnSync(process.execPath,[new URL('../scripts/admin.mjs',import.meta.url).pathname,'invalidate-sessions','--db',target],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const restored=openDatabase(target,{initialize:false});
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM reset_tokens').get().n,0);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
  assert.equal(restored.prepare('SELECT snapshot FROM progress').get().snapshot,'kept');restored.close();
});

test('operational CLI rejects existing zero-byte databases without initializing or backing them up',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-empty-operations-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const command of ['backup','invalidate-sessions']) {
    const target=join(dir,command+'.sqlite');await writeFile(target,'');
    const output=join(dir,'unexpected-backup.sqlite');
    const args=[new URL('../scripts/admin.mjs',import.meta.url).pathname,command,'--db',target];
    if(command==='backup') args.push('--output',output);
    const result=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(result.status,1,`${command} must reject an uninitialized database`);
    assert.equal((await stat(target)).size,0,'An operational command must not create a schema');
    await assert.rejects(stat(output),{code:'ENOENT'});
  }
});
