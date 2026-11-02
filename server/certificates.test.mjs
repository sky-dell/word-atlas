import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  readlink,
  lstat,
  stat,
  rm,
  symlink,
  chown,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import { createCertificateManager } from "./certificates.mjs";

const exec = promisify(execFile);
const domain = "atlas.example.test";
let fixtureDir;
const pairs = {};
const openssl = (...args) =>
  exec("openssl", args, { timeout: 15_000, maxBuffer: 256 * 1024 });
const stamp = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14) + "Z";
const fingerprint = (pem) => new X509Certificate(pem).fingerprint256;

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "wa-cert-fixtures-"));
  const path = (name) => join(fixtureDir, name);
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "365",
    "-subj",
    "/CN=Test Root",
    "-keyout",
    path("root.key"),
    "-out",
    path("root.pem"),
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  await openssl(
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-subj",
    "/CN=Test Intermediate",
    "-keyout",
    path("intermediate.key"),
    "-out",
    path("intermediate.csr"),
  );
  await writeFile(
    path("intermediate.ext"),
    "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    path("intermediate.csr"),
    "-CA",
    path("root.pem"),
    "-CAkey",
    path("root.key"),
    "-CAcreateserial",
    "-days",
    "90",
    "-extfile",
    path("intermediate.ext"),
    "-out",
    path("intermediate.pem"),
  );
  await mkdir(path("issued"));
  await writeFile(path("index"), "");
  await writeFile(path("serial"), "1000\n");
  await writeFile(
    path("ca.cnf"),
    `[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${path("index")}\nserial=${path("serial")}\nnew_certs_dir=${path("issued")}\ncertificate=${path("intermediate.pem")}\nprivate_key=${path("intermediate.key")}\ndefault_md=sha256\ndefault_days=30\npolicy=policy\nunique_subject=no\n[policy]\ncommonName=supplied\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain}\n[wrong]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.example.test\n`,
  );
  const now = Date.now();
  for (const name of [
    "initial",
    "manual",
    "other",
    "automatic",
    "rsa",
    "wrong",
    "weak",
    "expired",
    "soon",
    "future",
  ]) {
    const rsa = name === "rsa" || name === "weak";
    await openssl(
      "req",
      "-new",
      "-newkey",
      rsa ? (name === "weak" ? "rsa:1024" : "rsa:2048") : "ec",
      ...(rsa ? [] : ["-pkeyopt", "ec_paramgen_curve:P-256"]),
      "-nodes",
      "-subj",
      `/CN=${domain}`,
      "-keyout",
      path(`${name}.key`),
      "-out",
      path(`${name}.csr`),
    );
    const dates =
      name === "expired"
        ? [now - 172_800_000, now - 86_400_000]
        : name === "soon"
          ? [now - 60_000, now + 1_800_000]
          : name === "future"
            ? [now + 86_400_000, now + 172_800_000]
            : [now - 60_000, now + (name === "manual" ? 60 : 30) * 86_400_000];
    await openssl(
      "ca",
      "-batch",
      "-notext",
      "-config",
      path("ca.cnf"),
      "-extensions",
      name === "wrong" ? "wrong" : "server",
      "-startdate",
      stamp(dates[0]),
      "-enddate",
      stamp(dates[1]),
      "-in",
      path(`${name}.csr`),
      "-out",
      path(`${name}.pem`),
    );
    pairs[name] = {
      certificatePem:
        (await readFile(path(`${name}.pem`), "utf8")) +
        (await readFile(path("intermediate.pem"), "utf8")),
      privateKeyPem: await readFile(path(`${name}.key`), "utf8"),
    };
  }
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "30",
    "-subj",
    `/CN=${domain}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    `subjectAltName=DNS:${domain}`,
    "-keyout",
    path("self.key"),
    "-out",
    path("self.pem"),
  );
  pairs.self = {
    certificatePem: await readFile(path("self.pem"), "utf8"),
    privateKeyPem: await readFile(path("self.key"), "utf8"),
  };
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "365",
    "-subj",
    "/CN=Untrusted Root",
    "-keyout",
    path("rogue.key"),
    "-out",
    path("rogue.pem"),
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  await writeFile(
    path("server.ext"),
    `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain}\n`,
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    path("manual.csr"),
    "-CA",
    path("rogue.pem"),
    "-CAkey",
    path("rogue.key"),
    "-CAcreateserial",
    "-days",
    "30",
    "-extfile",
    path("server.ext"),
    "-out",
    path("untrusted.pem"),
  );
  pairs.untrusted = {
    certificatePem:
      (await readFile(path("untrusted.pem"), "utf8")) +
      (await readFile(path("rogue.pem"), "utf8")),
    privateKeyPem: pairs.manual.privateKeyPem,
  };
  const rootConfig = (await readFile(path("ca.cnf"), "utf8"))
    .replace(
      `certificate=${path("intermediate.pem")}`,
      `certificate=${path("root.pem")}`,
    )
    .replace(
      `private_key=${path("intermediate.key")}`,
      `private_key=${path("root.key")}`,
    );
  await writeFile(
    path("short-ca.cnf"),
    rootConfig +
      "\n[shortca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  await openssl(
    "ca",
    "-batch",
    "-notext",
    "-config",
    path("short-ca.cnf"),
    "-extensions",
    "shortca",
    "-startdate",
    stamp(now - 60_000),
    "-enddate",
    stamp(now + 1_800_000),
    "-in",
    path("intermediate.csr"),
    "-out",
    path("short-intermediate.pem"),
  );
  pairs.shortChain = {
    certificatePem:
      (await readFile(path("manual.pem"), "utf8")) +
      (await readFile(path("short-intermediate.pem"), "utf8")),
    privateKeyPem: pairs.manual.privateKeyPem,
  };
  await openssl(
    "pkey",
    "-in",
    path("manual.key"),
    "-aes-256-cbc",
    "-passout",
    "pass:test-only",
    "-out",
    path("encrypted.key"),
  );
});
after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function setup(t, changes = {}, initial = pairs.initial) {
  const dir = await mkdtemp(join(tmpdir(), "wa-cert-manager-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = {
    initialCertificatePath: join(dir, "initial.pem"),
    initialKeyPath: join(dir, "initial.key"),
    automaticCertificatePath: join(dir, "automatic.pem"),
    automaticKeyPath: join(dir, "automatic.key"),
  };
  await writeFile(paths.initialCertificatePath, initial.certificatePem);
  await writeFile(paths.initialKeyPath, initial.privateKeyPem);
  await writeFile(
    paths.automaticCertificatePath,
    pairs.automatic.certificatePem,
  );
  await writeFile(paths.automaticKeyPath, pairs.automatic.privateKeyPem);
  const events = [];
  const opts = {
    domain,
    tlsDir: join(dir, "tls"),
    stateDir: join(dir, "state"),
    ...paths,
    trustStore: join(fixtureDir, "root.pem"),
    reload: async () => {
      events.push("reload");
    },
    probe: async (fp) => {
      events.push(fp);
      assert.equal(
        fingerprint(await readFile(join(opts.tlsDir, "current/fullchain.pem"))),
        fp,
      );
    },
    ...changes,
  };
  return { dir, opts, events, manager: createCertificateManager(opts) };
}

test("lazy bootstrap preserves the existing certificate, returns only metadata, and sets restrictive modes", async (t) => {
  const { manager, opts, events } = await setup(t);
  await assert.rejects(lstat(opts.tlsDir), { code: "ENOENT" });
  const status = await manager.status();
  assert.equal(status.mode, "automatic");
  assert.equal(status.previous, null);
  assert.equal(
    status.current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  assert.deepEqual(
    Object.keys(status.current).sort(),
    [
      "subject",
      "issuer",
      "domain",
      "validFrom",
      "validTo",
      "fingerprint256",
      "daysRemaining",
      "serialNumber",
    ].sort(),
  );
  assert.equal(status.current.domain, domain);
  assert.ok(status.current.daysRemaining >= 29);
  assert.deepEqual(events, []);
  assert.ok((await lstat(join(opts.tlsDir, "current"))).isSymbolicLink());
  for (const p of [opts.tlsDir, join(opts.tlsDir, "current")])
    assert.equal((await stat(p)).mode & 0o777, 0o750);
  for (const file of ["fullchain.pem", "privkey.pem"])
    assert.equal(
      (await stat(join(opts.tlsDir, "current", file))).mode & 0o777,
      0o640,
    );
  assert.equal((await stat(opts.stateDir)).mode & 0o777, 0o700);
  if (process.getuid() === 0)
    assert.equal((await stat(join(opts.tlsDir, "current/privkey.pem"))).uid, 0);
  assert.doesNotMatch(JSON.stringify(status), /BEGIN|PRIVATE KEY/);
});

test("stage is opaque, private, expiring, single use; apply persists manual and rollback verifies the previous pair", async (t) => {
  const { manager, opts, events } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  assert.match(staged.stageId, /^[a-f0-9]{32}$/);
  assert.ok(
    Math.abs(Date.parse(staged.expiresAt) - Date.now() - 900_000) < 5000,
  );
  assert.equal(
    staged.certificate.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
  assert.doesNotMatch(JSON.stringify(staged), /BEGIN|PRIVATE KEY/);
  assert.equal(
    (await manager.status()).current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  async function privateTree(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      assert.equal(
        (await lstat(full)).mode & 0o777,
        entry.isDirectory() ? 0o700 : 0o600,
      );
      if (entry.isDirectory()) await privateTree(full);
    }
  }
  await privateTree(opts.stateDir);
  const applied = await manager.apply({ stageId: staged.stageId });
  assert.equal(applied.ok, true);
  assert.equal(
    applied.certificate.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
  assert.deepEqual(events, [
    "reload",
    fingerprint(pairs.manual.certificatePem),
  ]);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
  const restarted = createCertificateManager(opts);
  const status = await restarted.status();
  assert.equal(status.mode, "manual");
  assert.equal(
    status.previous.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  const rolled = await restarted.rollback();
  assert.equal(
    rolled.certificate.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  assert.equal((await restarted.status()).mode, "manual");
});

test("real trust chain, dates, hostname, key strength/pair and strict bounded PEM validation reject unsafe uploads", async (t) => {
  const { manager, events } = await setup(t);
  const invalid = [
    ["self-signed", pairs.self],
    ["untrusted chain", pairs.untrusted],
    ["wrong hostname", pairs.wrong],
    ["weak RSA", pairs.weak],
    ["expired", pairs.expired],
    ["under one hour", pairs.soon],
    ["not yet valid", pairs.future],
    [
      "mismatched key",
      { ...pairs.manual, privateKeyPem: pairs.other.privateKeyPem },
    ],
    [
      "missing intermediate",
      {
        ...pairs.manual,
        certificatePem: new X509Certificate(
          pairs.manual.certificatePem,
        ).toString(),
      },
    ],
    ["non PEM", { ...pairs.manual, certificatePem: "secret-invalid-value" }],
    [
      "trailing garbage",
      {
        ...pairs.manual,
        certificatePem: pairs.manual.certificatePem + "secret-invalid-value",
      },
    ],
    [
      "two keys",
      { ...pairs.manual, privateKeyPem: pairs.manual.privateKeyPem.repeat(2) },
    ],
    [
      "encrypted key",
      {
        ...pairs.manual,
        privateKeyPem: await readFile(
          join(fixtureDir, "encrypted.key"),
          "utf8",
        ),
      },
    ],
    [
      "over limit",
      {
        ...pairs.manual,
        certificatePem: " ".repeat(128 * 1024) + pairs.manual.certificatePem,
      },
    ],
    [
      "non string",
      { certificatePem: {}, privateKeyPem: pairs.manual.privateKeyPem },
    ],
  ];
  for (const [name, input] of invalid) {
    await assert.rejects(
      manager.stage(input),
      (error) => {
        assert.doesNotMatch(
          error.message,
          /BEGIN|secret-invalid-value|openssl|\.key|stderr/i,
        );
        return true;
      },
      name,
    );
  }
  assert.deepEqual(events, []);
  assert.equal(
    (await manager.status()).current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
});

test("a custom trust store is server-only; an upload cannot override system trust", async (t) => {
  const { manager, opts } = await setup(t);
  await manager.status();
  await assert.rejects(
    createCertificateManager({ ...opts, trustStore: undefined }).stage({
      ...pairs.manual,
      trustStore: join(fixtureDir, "root.pem"),
    }),
  );
});

test("expired stages are removed on use and after restart; staged certificates are revalidated at apply time", async (t) => {
  let now = Date.now();
  const { manager, opts } = await setup(t, { now: () => now });
  const staged = await manager.stage(pairs.manual);
  now += 900_000;
  await assert.rejects(
    createCertificateManager(opts).apply({ stageId: staged.stageId }),
  );
  assert.doesNotMatch(JSON.stringify(await manager.status()), /BEGIN/);
  now =
    Date.parse(new X509Certificate(pairs.manual.certificatePem).validTo) -
    3_600_001;
  const lastHour = await manager.stage(pairs.manual);
  now += 2;
  await assert.rejects(manager.apply({ stageId: lastHour.stageId }));
});

test("pending uploads and installed versions stay bounded without deleting unrelated files or symlink targets", async (t) => {
  let now = Date.now();
  const { manager, opts, dir } = await setup(t, { now: () => now });
  await manager.status();
  const untouched = join(dir, "untouched");
  await mkdir(untouched);
  await writeFile(join(untouched, "keep"), "keep");
  await symlink(untouched, join(opts.tlsDir, "versions", "f".repeat(32)));
  await writeFile(join(opts.tlsDir, "versions", "unrelated"), "keep");
  let accepted = 0;
  for (let i = 0; i < 30; i++) {
    try {
      await manager.stage(pairs.manual);
      accepted++;
    } catch {
      /* bounded capacity may reject */
    }
  }
  assert.ok(accepted > 0);
  const pending = await readdir(join(opts.stateDir, "pending"));
  assert.ok(pending.length <= 16, `unbounded pending: ${pending.length}`);
  now += 900_001;
  await manager.status();
  assert.equal((await readdir(join(opts.stateDir, "pending"))).length, 0);
  for (const pair of [pairs.manual, pairs.other, pairs.automatic, pairs.manual])
    await manager.apply({ stageId: (await manager.stage(pair)).stageId });
  const versions = await readdir(join(opts.tlsDir, "versions"), {
    withFileTypes: true,
  });
  assert.equal(versions.filter((v) => v.isDirectory()).length, 2);
  assert.equal(await readFile(join(untouched, "keep"), "utf8"), "keep");
  assert.equal(
    await readFile(join(opts.tlsDir, "versions/unrelated"), "utf8"),
    "keep",
  );
  assert.ok(
    (
      await lstat(join(opts.tlsDir, "versions", "f".repeat(32)))
    ).isSymbolicLink(),
  );
});

for (const failure of ["reload", "probe", "probe-false", "recovery-probe"]) {
  test(`failed ${failure} restores the old symlink, reloads and probes recovery; errors never expose secrets`, async (t) => {
    let calls = 0;
    let failing = true;
    const events = [];
    const secret = pairs.manual.privateKeyPem;
    const { manager, opts } = await setup(t, {
      reload: async () => {
        events.push("reload");
        if (failure === "reload" && ++calls === 1) throw new Error(secret);
      },
      probe: async (fp) => {
        events.push(fp);
        if (
          failing &&
          failure === "probe-false" &&
          fp === fingerprint(pairs.manual.certificatePem)
        )
          return false;
        if (
          failing &&
          (failure === "probe" || failure === "recovery-probe") &&
          fp === fingerprint(pairs.manual.certificatePem)
        )
          throw new Error(secret);
        if (failing && failure === "recovery-probe") throw new Error(secret);
      },
    });
    const staged = await manager.stage(pairs.manual);
    const old = await readlink(join(opts.tlsDir, "current"));
    await assert.rejects(
      manager.apply({ stageId: staged.stageId }),
      (error) => {
        assert.doesNotMatch(error.message, /BEGIN|PRIVATE KEY/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(await readlink(join(opts.tlsDir, "current")), old);
    assert.deepEqual(events.slice(-2), [
      "reload",
      fingerprint(pairs.initial.certificatePem),
    ]);
    if (failure === "recovery-probe")
      await assert.rejects(
        createCertificateManager(opts).status(),
        /recovery requires attention/,
      );
    failing = false;
    const status = await createCertificateManager(opts).status();
    assert.equal(
      status.current.fingerprint256,
      fingerprint(pairs.initial.certificatePem),
    );
    assert.equal(status.mode, "automatic");
    await assert.rejects(manager.apply({ stageId: staged.stageId }));
  });
}

test("concurrent apply transactions (including separate manager instances) are serialized until probing finishes", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const { manager, opts } = await setup(t, {
    reload: async () => {
      order.push("reload");
    },
    probe: async (fp) => {
      order.push(fp);
      if (fp === fingerprint(pairs.manual.certificatePem)) {
        entered();
        await held;
      }
    },
  });
  const a = await manager.stage(pairs.manual);
  const b = await manager.stage(pairs.other);
  const first = manager.apply({ stageId: a.stageId });
  await started;
  let finished = false;
  const second = createCertificateManager(opts)
    .apply({ stageId: b.stageId })
    .then((r) => {
      finished = true;
      return r;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(
    fingerprint(await readFile(join(opts.tlsDir, "current/fullchain.pem"))),
    fingerprint(pairs.manual.certificatePem),
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "reload",
    fingerprint(pairs.manual.certificatePem),
    "reload",
    fingerprint(pairs.other.certificatePem),
  ]);
  const status = await manager.status();
  assert.equal(
    status.current.fingerprint256,
    fingerprint(pairs.other.certificatePem),
  );
  assert.equal(
    status.previous.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
});

test("manual mode survives restart and wins a queued autoInstall; automatic uses only fixed configured paths", async (t) => {
  const { manager, opts, events } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  await Promise.all([
    manager.apply({ stageId: staged.stageId }),
    createCertificateManager(opts).autoInstall(),
  ]);
  const restarted = createCertificateManager(opts);
  assert.equal((await restarted.status()).mode, "manual");
  assert.equal(
    (await restarted.status()).current.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
  assert.deepEqual(events, [
    "reload",
    fingerprint(pairs.manual.certificatePem),
  ]);
  await rm(opts.automaticKeyPath);
  const skipped = await restarted.autoInstall();
  assert.equal(skipped.skipped, true);
  await writeFile(opts.automaticKeyPath, pairs.automatic.privateKeyPem);
  const automatic = await restarted.automatic({
    certificatePem: pairs.other.certificatePem,
  });
  assert.equal(
    automatic.certificate.fingerprint256,
    fingerprint(pairs.automatic.certificatePem),
  );
  assert.equal((await restarted.status()).mode, "automatic");
  await writeFile(opts.automaticCertificatePath, pairs.other.certificatePem);
  await writeFile(opts.automaticKeyPath, pairs.other.privateKeyPem);
  await restarted.autoInstall();
  assert.equal(
    (await restarted.status()).current.fingerprint256,
    fingerprint(pairs.other.certificatePem),
  );
});

test("automatic rejects invalid fixed certificates without clearing persisted manual mode", async (t) => {
  const { manager, opts } = await setup(t);
  await manager.apply({ stageId: (await manager.stage(pairs.manual)).stageId });
  await writeFile(opts.automaticCertificatePath, pairs.self.certificatePem);
  await writeFile(opts.automaticKeyPath, pairs.self.privateKeyPem);
  await assert.rejects(manager.automatic());
  assert.equal((await createCertificateManager(opts).status()).mode, "manual");
  assert.equal(
    (await manager.status()).current.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
});

test("expired previously-valid bootstrap is visible for recovery but cannot be newly activated or rolled back to", async (t) => {
  const { manager } = await setup(t, {
    now: () =>
      Date.parse(new X509Certificate(pairs.initial.certificatePem).validTo) +
      1000,
  });
  assert.ok((await manager.status()).current.daysRemaining < 0);
  await manager.apply({ stageId: (await manager.stage(pairs.manual)).stageId });
  await assert.rejects(manager.rollback());
  assert.equal(
    (await manager.status()).current.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
});

test("stage IDs cannot provide arbitrary file access and managed current must not follow an external symlink", async (t) => {
  const { manager, opts, dir } = await setup(t);
  await manager.status();
  for (const stageId of [
    "../initial.key",
    "/etc/passwd",
    "A".repeat(32),
    "a".repeat(33),
    null,
    {},
  ])
    await assert.rejects(manager.apply({ stageId }));
  await rm(join(opts.tlsDir, "current"));
  await symlink(dir, join(opts.tlsDir, "current"));
  await assert.rejects(createCertificateManager(opts).status());
  assert.equal(
    await readFile(opts.initialKeyPath, "utf8"),
    pairs.initial.privateKeyPem,
  );
});

test("apply awaits a real local TLS server serving the expected CA-signed fingerprint", async (t) => {
  const server = createServer(
    { cert: pairs.initial.certificatePem, key: pairs.initial.privateKeyPem },
    (socket) => socket.end(),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await readFile(join(fixtureDir, "root.pem"));
  let opts;
  const setupResult = await setup(t, {
    reload: async () =>
      server.setSecureContext({
        cert: await readFile(join(opts.tlsDir, "current/fullchain.pem")),
        key: await readFile(join(opts.tlsDir, "current/privkey.pem")),
      }),
    probe: async (expected) =>
      new Promise((resolve, reject) => {
        const socket = connect(
          {
            host: "127.0.0.1",
            port: server.address().port,
            servername: domain,
            ca: root,
          },
          () => {
            try {
              assert.equal(
                socket.getPeerCertificate().fingerprint256,
                expected,
              );
              socket.end();
              resolve();
            } catch (error) {
              socket.destroy();
              reject(error);
            }
          },
        );
        socket.on("error", reject);
        socket.setTimeout(2000, () =>
          socket.destroy(new Error("TLS test timeout")),
        );
      }),
  });
  opts = setupResult.opts;
  const result = await setupResult.manager.apply({
    stageId: (await setupResult.manager.stage(pairs.manual)).stageId,
  });
  assert.equal(
    result.certificate.fingerprint256,
    fingerprint(pairs.manual.certificatePem),
  );
});

test("restart recovers a real helper crash after switching but before probe success and consumes its stage", async (t) => {
  const { manager, opts, events } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  const code = `import { createCertificateManager } from ${JSON.stringify(new URL("./certificates.mjs", import.meta.url).href)};
    const opts = JSON.parse(process.argv[1]);
    const m = createCertificateManager({ ...opts, reload: async () => {}, probe: async () => process.exit(42) });
    await m.apply({stageId: process.argv[2]});`;
  await assert.rejects(
    exec(
      process.execPath,
      ["--input-type=module", "-e", code, JSON.stringify(opts), staged.stageId],
      { timeout: 5000 },
    ),
    { code: 42 },
  );
  assert.equal(
    fingerprint(await readFile(join(opts.tlsDir, "current/fullchain.pem"))),
    fingerprint(pairs.manual.certificatePem),
  );
  const status = await createCertificateManager(opts).status();
  assert.equal(
    status.current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  assert.equal(status.mode, "automatic");
  assert.deepEqual(events, [
    "reload",
    fingerprint(pairs.initial.certificatePem),
  ]);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
});

test("restart completes journalled initial bootstrap without reading or replacing source files", async (t) => {
  const { manager, opts } = await setup(t);
  await manager.status();
  const statePath = join(opts.stateDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.transaction = { from: null, to: state.current };
  state.current = null;
  await writeFile(statePath, JSON.stringify(state));
  await rm(join(opts.tlsDir, "current"));
  await rm(opts.initialCertificatePath);
  await rm(opts.initialKeyPath);
  assert.equal(
    (await createCertificateManager(opts).status()).current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
});

test("fullchain rejects unused extra certificates instead of letting trust verification silently ignore them", async (t) => {
  const { manager } = await setup(t);
  await assert.rejects(
    manager.stage({
      ...pairs.manual,
      certificatePem: pairs.manual.certificatePem + pairs.self.certificatePem,
    }),
  );
});

test("malformed apply payloads always reject asynchronously and pending directory symlinks cannot read arbitrary files", async (t) => {
  const { manager, opts, dir } = await setup(t);
  for (const payload of [null, 12, "x"]) {
    let promise;
    assert.doesNotThrow(() => {
      promise = manager.apply(payload);
    });
    await assert.rejects(promise);
  }
  const staged = await manager.stage(pairs.manual);
  const path = join(opts.stateDir, "pending", staged.stageId);
  await rm(path, { recursive: true });
  await symlink(dir, path);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
  assert.equal(
    await readFile(opts.initialKeyPath, "utf8"),
    pairs.initial.privateKeyPem,
  );
});

test("RSA-2048 and a complete trusted root chain are accepted without modifying the original pair", async (t) => {
  const { manager, opts } = await setup(t);
  const root = await readFile(join(fixtureDir, "root.pem"), "utf8");
  const staged = await manager.stage({
    ...pairs.rsa,
    certificatePem: pairs.rsa.certificatePem + root,
  });
  assert.equal(
    (await manager.apply({ stageId: staged.stageId })).certificate
      .fingerprint256,
    fingerprint(pairs.rsa.certificatePem),
  );
  assert.equal(
    await readFile(opts.initialCertificatePath, "utf8"),
    pairs.initial.certificatePem,
  );
  assert.equal(
    await readFile(opts.initialKeyPath, "utf8"),
    pairs.initial.privateKeyPem,
  );
});

test(
  "applied version and directories preserve the provisioned app group",
  { skip: process.getuid?.() !== 0 },
  async (t) => {
    const { manager, opts } = await setup(t);
    await mkdir(opts.tlsDir);
    await chown(opts.tlsDir, 0, 65534);
    await manager.apply({
      stageId: (await manager.stage(pairs.manual)).stageId,
    });
    for (const path of [
      opts.tlsDir,
      join(opts.tlsDir, "versions"),
      join(opts.tlsDir, "current"),
      join(opts.tlsDir, "current/fullchain.pem"),
      join(opts.tlsDir, "current/privkey.pem"),
    ]) {
      const info = await stat(path);
      assert.equal(info.gid, 65534);
      assert.equal(info.uid, 0);
    }
  },
);

test("tampering a staged key is rejected and consumes the stage without changing the current certificate", async (t) => {
  const { manager, opts, events } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  await writeFile(
    join(opts.stateDir, "pending", staged.stageId, "privkey.pem"),
    pairs.other.privateKeyPem,
  );
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
  assert.equal(
    (await manager.status()).current.fingerprint256,
    fingerprint(pairs.initial.certificatePem),
  );
  assert.deepEqual(events, []);
});

test("two concurrent applies of the same single-use stage activate only once", async (t) => {
  const { manager, opts, events } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  const results = await Promise.allSettled([
    manager.apply({ stageId: staged.stageId }),
    createCertificateManager(opts).apply({ stageId: staged.stageId }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.deepEqual(events, [
    "reload",
    fingerprint(pairs.manual.certificatePem),
  ]);
});

test("rollback rechecks the stored private-key pair rather than trusting previously saved metadata", async (t) => {
  const { manager, opts, events } = await setup(t);
  await manager.apply({ stageId: (await manager.stage(pairs.manual)).stageId });
  const state = JSON.parse(
    await readFile(join(opts.stateDir, "state.json"), "utf8"),
  );
  await writeFile(
    join(opts.tlsDir, "versions", state.previous, "privkey.pem"),
    pairs.other.privateKeyPem,
  );
  await assert.rejects(manager.rollback());
  assert.equal(
    fingerprint(await readFile(join(opts.tlsDir, "current/fullchain.pem"))),
    fingerprint(pairs.manual.certificatePem),
  );
  assert.deepEqual(events, [
    "reload",
    fingerprint(pairs.manual.certificatePem),
  ]);
});

test("an unreadable or substituted pending entry still consumes its single-use stage", async (t) => {
  const { manager, opts } = await setup(t);
  const staged = await manager.stage(pairs.manual);
  const key = join(opts.stateDir, "pending", staged.stageId, "privkey.pem");
  await rm(key);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
  // Restoring a missing file must not resurrect a token already presented.
  await mkdir(join(opts.stateDir, "pending", staged.stageId), {
    recursive: true,
  });
  await writeFile(
    join(opts.stateDir, "pending", staged.stageId, "fullchain.pem"),
    pairs.manual.certificatePem,
  );
  await writeFile(key, pairs.manual.privateKeyPem);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
});

test("expiry crossing during cleanup never orphans a staged private-key directory", async (t) => {
  const base = Date.now();
  let time = base;
  let ticks = [];
  const { manager, opts } = await setup(t, {
    now: () => (ticks.length ? ticks.shift() : time),
  });
  const first = await manager.stage(pairs.manual);
  time += 100;
  const second = await manager.stage(pairs.other);
  const firstExpiry = Date.parse(first.expiresAt);
  const secondExpiry = Date.parse(second.expiresAt);
  ticks = [firstExpiry, secondExpiry - 1, secondExpiry, secondExpiry];
  time = secondExpiry + 1000;
  await manager.status();
  ticks = [];
  await manager.status();
  assert.equal((await readdir(join(opts.stateDir, "pending"))).length, 0);
});

test("the supplied intermediate chain must also have at least an hour remaining", async (t) => {
  const { manager } = await setup(t);
  await assert.rejects(manager.stage(pairs.shortChain));
});

test("post-rename state directory sync failure restores and verifies original current, previous and mode", async (t) => {
  const { manager, opts, events } = await setup(t);
  await manager.automatic();
  const staged = await manager.stage(pairs.manual);
  const originalStatus = await manager.status();
  const statePath = join(opts.stateDir, "state.json");
  const originalState = JSON.parse(await readFile(statePath, "utf8"));
  const originalLink = await readlink(join(opts.tlsDir, "current"));
  assert.equal(originalStatus.mode, "automatic");
  assert.equal(originalStatus.previous.fingerprint256, fingerprint(pairs.initial.certificatePem));
  events.length = 0;

  const realOpen = fsPromises.open;
  let failures = 0;
  t.mock.method(fsPromises, "open", async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === opts.stateDir) {
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (failures === 0 && state.mode === "manual" && state.transaction === null && state.current !== originalState.current) {
          failures++;
          throw Object.assign(new Error("Injected state directory sync failure"), { code: "EIO" });
        }
        return realSync();
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.apply({ stageId: staged.stageId }), (error) => {
      assert.match(error.message, /previous certificate restored/);
      assert.doesNotMatch(error.message, /EIO|Injected|BEGIN|PRIVATE KEY/);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  assert.equal(failures, 1, "fault must occur after the manual commit rename");
  assert.equal(await readlink(join(opts.tlsDir, "current")), originalLink);
  const restored = JSON.parse(await readFile(statePath, "utf8"));
  for (const field of ["current", "previous", "mode", "transaction"])
    assert.equal(restored[field], originalState[field], `restore ${field}`);
  assert.deepEqual(await createCertificateManager(opts).status(), originalStatus);
  assert.deepEqual(events, [
    "reload", fingerprint(pairs.manual.certificatePem),
    "reload", fingerprint(pairs.automatic.certificatePem),
  ]);
  await assert.rejects(manager.apply({ stageId: staged.stageId }));
});
