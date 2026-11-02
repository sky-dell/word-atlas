import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { normalizeMailConfig } from "./mail-config.mjs";
import { readMailStore, writeMailStore } from "./mail-store.mjs";

const config = normalizeMailConfig({
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "sender@example.com",
  password: "store-provider-secret",
  from: "Sender@Example.com",
  fromName: "词与远方",
});

async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-mail-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "mail.env") };
}

test("writes a root-private generic SMTP file atomically", async (t) => {
  const { directory, file } = await storeFixture(t);

  await writeMailStore(file, config);

  const info = await lstat(file);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual(await readMailStore(file), config);
  const env = parseEnv(await readFile(file, "utf8"));
  assert.equal(env.SMTP_HOST, "smtp.example.com");
  assert.equal(env.SMTP_PORT, "587");
  assert.equal(env.SMTP_SECURE, "0");
  assert.equal(env.SMTP_USER, "sender@example.com");
  assert.equal(env.SMTP_FROM, "Sender@example.com");
  assert.match(env.MAIL_CODE_SECRET, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("preserves the existing mail-code secret", async (t) => {
  const { file } = await storeFixture(t);
  await writeMailStore(file, config);
  const first = parseEnv(await readFile(file, "utf8")).MAIL_CODE_SECRET;

  await writeMailStore(
    file,
    normalizeMailConfig({
      ...config,
      host: "mail.example.net",
      password: "replacement-provider-secret",
    }),
  );

  const second = parseEnv(await readFile(file, "utf8")).MAIL_CODE_SECRET;
  assert.equal(second, first);
  assert.equal((await readMailStore(file)).host, "mail.example.net");
});

test("merges a blank password only when a stored provider exists", async (t) => {
  const { file } = await storeFixture(t);
  await writeMailStore(file, config);

  const edited = { ...config, password: "", fromName: "Updated Sender" };
  await writeMailStore(file, edited);
  assert.deepEqual(await readMailStore(file), {
    ...config,
    password: config.password,
    fromName: "Updated Sender",
  });

  await unlink(file);
  await assert.rejects(
    writeMailStore(file, { ...config, password: "" }),
    /invalid mail configuration/i,
  );
});

test("rejects symlinks unsafe ownership and unsafe modes", async (t) => {
  const { directory, file } = await storeFixture(t);
  const outside = join(directory, "outside.env");
  await writeFile(outside, "preserve");
  await symlink(outside, file);
  await assert.rejects(readMailStore(file), /mail store/i);
  await assert.rejects(writeMailStore(file, config), /mail store/i);
  assert.equal(await readFile(outside, "utf8"), "preserve");
  await unlink(file);

  await writeMailStore(file, config);
  await chmod(file, 0o644);
  await assert.rejects(readMailStore(file), /mail store/i);
  await assert.rejects(writeMailStore(file, config), /mail store/i);

  await chmod(file, 0o600);
  await chown(file, 1, 1);
  await assert.rejects(readMailStore(file), /mail store/i);
  await assert.rejects(writeMailStore(file, config), /mail store/i);

  await chown(file, 0, 0);
  await chmod(directory, 0o777);
  await assert.rejects(writeMailStore(file, config), /mail store/i);
});
