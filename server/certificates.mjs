import { constants } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  readlink,
  symlink,
  rename,
  unlink,
  rmdir,
  readdir,
  chmod,
  chown,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_PEM = 128 * 1024;
const STAGE_TTL = 15 * 60 * 1000;
const MAX_PENDING = 8;
const ID = /^[a-f0-9]{32}$/;
const queues = new Map();
const id = () => randomBytes(16).toString("hex");
const fail = (message) => {
  throw new CertificateError(message);
};
class CertificateError extends Error {
  constructor(message) {
    super(message);
    this.name = "CertificateError";
  }
}

// One root helper owns a TLS store. Share the queue between manager instances in
// that process; every operation reloads disk state rather than caching mode.
export function createCertificateManager(opts) {
  const {
    domain,
    initialCertificatePath,
    initialKeyPath,
    automaticCertificatePath,
    automaticKeyPath,
    trustStore,
    reload,
    probe,
    now = Date.now,
  } = opts;
  if (
    typeof domain !== "string" ||
    !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(domain) ||
    typeof reload !== "function" ||
    typeof probe !== "function" ||
    typeof now !== "function"
  )
    fail("Invalid certificate manager configuration");
  for (const path of [
    opts.tlsDir,
    opts.stateDir,
    initialCertificatePath,
    initialKeyPath,
    automaticCertificatePath,
    automaticKeyPath,
    ...(trustStore === undefined ? [] : [trustStore]),
  ]) {
    if (typeof path !== "string" || !path || path.includes("\0"))
      fail("Invalid certificate manager configuration");
  }
  const tlsDir = resolve(opts.tlsDir);
  const stateDir = resolve(opts.stateDir);
  if (tlsDir === stateDir) fail("Invalid certificate manager configuration");
  const versionsDir = join(tlsDir, "versions");
  const pendingDir = join(stateDir, "pending");
  const statePath = join(stateDir, "state.json");
  const currentPath = join(tlsDir, "current");
  let gid;
  const clock = () => {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) fail("Invalid certificate clock");
    return value;
  };

  async function directory(path, mode, group) {
    try {
      await mkdir(path, { mode });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Unsafe certificate directory");
    if (process.getuid?.() === 0) await chown(path, 0, group ?? info.gid);
    await chmod(path, mode);
    return info;
  }

  async function readBounded(path, limit = MAX_PEM, fixedSource = false) {
    const file = await open(
      path,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (fixedSource ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit)
        fail("Certificate input exceeds limits or is not a regular file");
      const buffer = Buffer.alloc(limit + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          count,
          buffer.length - count,
          null,
        );
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > limit) fail("Certificate input exceeds limits");
      return buffer.toString("utf8", 0, count);
    } finally {
      await file.close();
    }
  }

  async function writePrivate(path, contents, mode = 0o600, group = 0) {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      if (process.getuid?.() === 0) await file.chown(0, group);
      await file.chmod(mode);
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async function syncDir(path) {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async function save(state) {
    const tmp = join(stateDir, `.state-${id()}`);
    try {
      await writePrivate(tmp, JSON.stringify(state));
      await rename(tmp, statePath);
      await syncDir(stateDir);
    } finally {
      await unlink(tmp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  function checkState(state) {
    const validId = (value) =>
      value === null || (typeof value === "string" && ID.test(value));
    if (
      !state ||
      state.format !== 1 ||
      !["automatic", "manual"].includes(state.mode) ||
      !validId(state.current) ||
      !validId(state.previous) ||
      !Array.isArray(state.versions) ||
      state.versions.length > 64 ||
      !state.versions.every((v) => typeof v === "string" && ID.test(v)) ||
      !Array.isArray(state.stages) ||
      state.stages.length > MAX_PENDING ||
      !state.stages.every(
        (s) =>
          s &&
          typeof s.id === "string" &&
          ID.test(s.id) &&
          Number.isFinite(s.expiresAt),
      )
    )
      fail("Invalid certificate state");
    if (
      (state.current && !state.versions.includes(state.current)) ||
      (state.previous && !state.versions.includes(state.previous))
    )
      fail("Invalid certificate state");
    if (
      state.transaction !== null &&
      (!state.transaction ||
        state.transaction.from !== state.current ||
        !ID.test(state.transaction.to) ||
        !state.versions.includes(state.transaction.to))
    )
      fail("Invalid certificate state");
    return state;
  }

  function parsePair({ certificatePem, privateKeyPem } = {}) {
    if (
      typeof certificatePem !== "string" ||
      typeof privateKeyPem !== "string" ||
      Buffer.byteLength(certificatePem) + Buffer.byteLength(privateKeyPem) >
        MAX_PEM
    )
      fail("Invalid certificate input or size");
    const blocks = certificatePem.match(
      /-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----/g,
    );
    if (
      !blocks?.length ||
      blocks.length > 16 ||
      certificatePem
        .replace(
          /-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----/g,
          "",
        )
        .trim()
    )
      fail("Invalid certificate PEM");
    if (
      !/^\s*-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----\s*$/.test(
        privateKeyPem,
      )
    )
      fail("A single unencrypted private key is required");
    let certificates, key;
    try {
      certificates = blocks.map((pem) => new X509Certificate(pem));
      key = createPrivateKey(privateKeyPem);
    } catch {
      fail("Invalid certificate or private key");
    }
    const leaf = certificates[0];
    if (
      leaf.ca ||
      !leaf.checkHost(domain, { subject: "never", partialWildcards: false })
    )
      fail("Certificate does not match the configured domain");
    if (leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey))
      fail("Self-signed certificates are not accepted");
    if (
      new Set(certificates.map((cert) => cert.fingerprint256)).size !==
      certificates.length
    )
      fail("Invalid certificate chain");
    for (let index = 0; index + 1 < certificates.length; index++) {
      const issuer = certificates[index + 1];
      if (
        !issuer.ca ||
        !certificates[index].checkIssued(issuer) ||
        !certificates[index].verify(issuer.publicKey)
      )
        fail("Invalid certificate chain");
    }
    const details = key.asymmetricKeyDetails;
    const type = key.asymmetricKeyType;
    const strong =
      ((type === "rsa" || type === "rsa-pss") &&
        details?.modulusLength >= 2048 &&
        details.publicExponent >= 65537n) ||
      (type === "ec" &&
        ["prime256v1", "secp384r1", "secp521r1"].includes(
          details?.namedCurve,
        )) ||
      type === "ed25519" ||
      type === "ed448";
    if (!strong) fail("Private key does not meet security requirements");
    const actual = createPublicKey(key).export({ type: "spki", format: "der" });
    const expected = leaf.publicKey.export({ type: "spki", format: "der" });
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      fail("Certificate and private key do not match");
    return { blocks, certificates, certificatePem, privateKeyPem, leaf };
  }

  function metadata(leaf) {
    return {
      subject: leaf.subject,
      issuer: leaf.issuer,
      domain,
      validFrom: new Date(leaf.validFrom).toISOString(),
      validTo: new Date(leaf.validTo).toISOString(),
      fingerprint256: leaf.fingerprint256,
      daysRemaining: Math.floor(
        (Date.parse(leaf.validTo) - clock()) / 86_400_000,
      ),
      serialNumber: leaf.serialNumber,
    };
  }

  async function validate(pair, allowExpired = false) {
    const parsed = parsePair(pair);
    const time = clock();
    if (
      parsed.certificates.some(
        (cert) =>
          Date.parse(cert.validFrom) > time ||
          (!allowExpired && Date.parse(cert.validTo) - time < 3_600_000),
      )
    )
      fail("Certificate validity period is not acceptable");
    // Recovery bootstrap alone can check a previously-valid pair at a time when
    // the entire chain was valid. New activation always verifies at today's time.
    const at = allowExpired
      ? Math.min(
          time,
          ...parsed.certificates.map((c) => Date.parse(c.validTo) - 1000),
        )
      : time;
    if (parsed.certificates.some((c) => Date.parse(c.validFrom) > at))
      fail("Certificate validity period is not acceptable");
    const temp = join(stateDir, `verify-${id()}`);
    await directory(temp, 0o700, 0);
    try {
      await writePrivate(join(temp, "leaf.pem"), parsed.blocks[0] + "\n");
      const args = [
        "verify",
        "-purpose",
        "sslserver",
        "-verify_hostname",
        domain,
        "-auth_level",
        "2",
        "-attime",
        String(Math.floor(at / 1000)),
      ];
      if (trustStore !== undefined)
        args.push("-CAfile", resolve(trustStore), "-no-CApath", "-no-CAstore");
      if (parsed.blocks.length > 1) {
        await writePrivate(
          join(temp, "chain.pem"),
          parsed.blocks.slice(1).join("\n") + "\n",
        );
        args.push("-untrusted", join(temp, "chain.pem"));
      }
      args.push(join(temp, "leaf.pem"));
      try {
        await exec("openssl", args, {
          timeout: 10_000,
          maxBuffer: 32 * 1024,
          windowsHide: true,
        });
      } catch {
        fail("Certificate trust validation failed");
      }
    } finally {
      await removeDirectory(temp, ["leaf.pem", "chain.pem"]);
    }
    return parsed;
  }

  // Never recurse or follow links during retention. Only registered random IDs
  // and this operation's temporary directory may be considered for removal.
  async function removeDirectory(
    path,
    allowed = ["fullchain.pem", "privkey.pem"],
  ) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const names = await readdir(path);
    if (names.some((name) => !allowed.includes(name))) return;
    for (const name of names)
      if (!(await lstat(join(path, name))).isFile()) return;
    for (const name of names) await unlink(join(path, name));
    await rmdir(path);
  }

  async function readPair(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Unsafe certificate directory");
    return {
      certificatePem: await readBounded(join(path, "fullchain.pem")),
      privateKeyPem: await readBounded(join(path, "privkey.pem")),
    };
  }

  async function fixedPair(certificatePath, keyPath) {
    return {
      certificatePem: await readBounded(certificatePath, MAX_PEM, true),
      privateKeyPem: await readBounded(keyPath, MAX_PEM, true),
    };
  }

  async function checkLink(expected) {
    let link;
    try {
      link = await readlink(currentPath);
    } catch (error) {
      if (error.code === "ENOENT" && expected === null) return;
      fail("Unsafe current certificate link");
    }
    if (expected === null || link !== `versions/${expected}`)
      fail("Unsafe current certificate link");
  }

  async function switchLink(target) {
    const info = await lstat(join(versionsDir, target));
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Unsafe certificate version");
    const temp = join(tlsDir, `.current-${id()}`);
    try {
      await symlink(`versions/${target}`, temp);
      await rename(temp, currentPath);
      await syncDir(tlsDir);
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async function cleanup(state) {
    const time = clock();
    const expired = state.stages.filter((s) => s.expiresAt <= time);
    for (const entry of expired)
      await removeDirectory(join(pendingDir, entry.id));
    state.stages = state.stages.filter((s) => s.expiresAt > time);
    const keep = [state.current, state.previous, state.transaction?.to];
    for (const version of state.versions)
      if (!keep.includes(version))
        await removeDirectory(join(versionsDir, version));
    state.versions = state.versions.filter((version) => keep.includes(version));
    await save(state);
  }

  async function newVersion(state, pair) {
    const version = id();
    state.versions.push(version);
    await save(state);
    const path = join(versionsDir, version);
    await directory(path, 0o750, gid);
    await writePrivate(
      join(path, "fullchain.pem"),
      pair.certificatePem,
      0o640,
      gid,
    );
    await writePrivate(
      join(path, "privkey.pem"),
      pair.privateKeyPem,
      0o640,
      gid,
    );
    await syncDir(path);
    await syncDir(versionsDir);
    return version;
  }

  async function reloadAndProbe(version) {
    const pair = parsePair(await readPair(join(versionsDir, version)));
    await reload();
    if ((await probe(pair.leaf.fingerprint256)) === false)
      fail("Certificate probe failed");
  }

  async function recover(state) {
    const old = state.transaction.from;
    if (old === null) {
      // An initial migration has no previous managed link. Finish that same
      // validated snapshot, never reissue or require the source pair again.
      const target = state.transaction.to;
      await validate(await readPair(join(versionsDir, target)), true);
      await switchLink(target);
      state.current = target;
      state.transaction = null;
      await save(state);
      await cleanup(state);
      return;
    }
    try {
      await switchLink(old);
      await reloadAndProbe(old);
    } catch {
      fail("Certificate activation failed; recovery requires attention");
    }
    state.transaction = null;
    await save(state);
    await cleanup(state);
  }

  async function initialize() {
    const tlsInfo = await directory(tlsDir, 0o750);
    gid = tlsInfo.gid;
    await directory(versionsDir, 0o750, gid);
    await directory(stateDir, 0o700, 0);
    await directory(pendingDir, 0o700, 0);
    let state;
    try {
      state = checkState(JSON.parse(await readBounded(statePath, 256 * 1024)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A pre-existing unmanaged link must not be adopted or overwritten.
      await checkLink(null);
      state = {
        format: 1,
        mode: "automatic",
        current: null,
        previous: null,
        versions: [],
        stages: [],
        transaction: null,
      };
      await save(state);
    }
    if (state.transaction) await recover(state);
    await checkLink(state.current);
    await cleanup(state);
    if (!state.current) {
      const parsed = await validate(
        await fixedPair(initialCertificatePath, initialKeyPath),
        true,
      );
      const version = await newVersion(state, parsed);
      // Persist before changing the symlink, so startup can recover even if the
      // helper exits immediately after the initial rename.
      state.transaction = { from: null, to: version };
      await save(state);
      await switchLink(version);
      state.current = version;
      state.transaction = null;
      await save(state);
    }
    return state;
  }

  async function activate(state, version, mode, parsed) {
    const old = state.current;
    const recoveryState = {
      ...state,
      transaction: { from: old, to: version },
    };
    await save(recoveryState);
    try {
      await switchLink(version);
      await reloadAndProbe(version);
      state.previous = old;
      state.current = version;
      state.mode = mode;
      state.transaction = null;
      await save(state);
    } catch {
      // The commit rename may have succeeded before its directory sync failed.
      // Re-journal the original current, previous and mode even when disk already
      // contains the proposed commit; only claim restoration after reload/probe.
      await save(recoveryState);
      await recover(recoveryState);
      fail("Certificate activation failed; previous certificate restored");
    }
    await cleanup(state);
    return { ok: true, certificate: metadata(parsed.leaf) };
  }

  function serial(operation) {
    const key = tlsDir;
    const preceding = queues.get(key) ?? Promise.resolve();
    const result = preceding.then(operation).catch((error) => {
      if (error instanceof CertificateError) throw error;
      // No filesystem paths, process stderr, uploaded input, or error causes
      // cross the helper's public boundary.
      throw new CertificateError("Certificate operation failed");
    });
    const tail = result.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }

  async function automaticInstall(state) {
    const parsed = await validate(
      await fixedPair(automaticCertificatePath, automaticKeyPath),
    );
    return activate(
      state,
      await newVersion(state, parsed),
      "automatic",
      parsed,
    );
  }

  return {
    status: () =>
      serial(async () => {
        const state = await initialize();
        return {
          mode: state.mode,
          current: metadata(
            parsePair(await readPair(join(versionsDir, state.current))).leaf,
          ),
          previous: state.previous
            ? metadata(
                parsePair(await readPair(join(versionsDir, state.previous)))
                  .leaf,
              )
            : null,
        };
      }),
    stage: (input) =>
      serial(async () => {
        const state = await initialize();
        const parsed = await validate(input);
        if (state.stages.length >= MAX_PENDING)
          fail("Too many pending certificates");
        const stageId = id();
        const expiresAt = clock() + STAGE_TTL;
        state.stages.push({ id: stageId, expiresAt });
        await save(state);
        const path = join(pendingDir, stageId);
        await directory(path, 0o700, 0);
        await writePrivate(join(path, "fullchain.pem"), parsed.certificatePem);
        await writePrivate(join(path, "privkey.pem"), parsed.privateKeyPem);
        await syncDir(path);
        await syncDir(pendingDir);
        return {
          stageId,
          certificate: metadata(parsed.leaf),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }),
    apply: (input) =>
      serial(async () => {
        const stageId = input?.stageId;
        if (typeof stageId !== "string" || !ID.test(stageId))
          fail("Invalid certificate stage");
        const state = await initialize();
        const entry = state.stages.find((s) => s.id === stageId);
        if (!entry || entry.expiresAt <= clock())
          fail("Certificate stage is unavailable or expired");
        const path = join(pendingDir, stageId);
        // Consume the token before validation, reload, or probe can fail.
        // Keep an expired tombstone until removal completes, so a crash cannot
        // either resurrect the token or leave an untracked private-key directory.
        entry.expiresAt = 0;
        await save(state);
        let pair;
        try {
          pair = await readPair(path);
        } finally {
          await removeDirectory(path);
          state.stages = state.stages.filter((s) => s.id !== stageId);
          await save(state);
        }
        const parsed = await validate(pair);
        return activate(
          state,
          await newVersion(state, parsed),
          "manual",
          parsed,
        );
      }),
    rollback: () =>
      serial(async () => {
        const state = await initialize();
        if (!state.previous) fail("No previous certificate is available");
        const parsed = await validate(
          await readPair(join(versionsDir, state.previous)),
        );
        return activate(state, state.previous, "manual", parsed);
      }),
    automatic: () => serial(async () => automaticInstall(await initialize())),
    autoInstall: () =>
      serial(async () => {
        const state = await initialize();
        if (state.mode === "manual") return { ok: true, skipped: true };
        return automaticInstall(state);
      }),
  };
}
