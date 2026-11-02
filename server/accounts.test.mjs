import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createAccounts } from "./accounts.mjs";
import { hashPassword, verifyPassword, passwordWork } from "./passwords.mjs";
import { backupDatabase } from "./backup.mjs";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another strong password here";
const snapshot = (datasetId = "open") => ({
  app: "word-atlas",
  version: 2,
  exportedAt: 123,
  progress: {
    version: 2,
    datasetId,
    cards: {},
    bookmarks: ["hello"],
    days: {},
    typing: [],
    session: null,
    mistakes: [],
  },
  settings: { accent: "uk", dailyNew: 10, retention: 0.9, theme: "dark" },
  extras: {},
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wa-accounts-"));
  let time = Date.UTC(2026, 9, 28);
  const origin = "http://127.0.0.1";
  let accounts = createAccounts({
    dbPath: join(dir, "accounts.db"),
    origins: [origin],
    secureCookies: false,
    allowInsecureLocal: true,
    now: () => time,
    ...options,
  });
  const server = createServer(async (req, res) => {
    if (!(await accounts.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The canonical Host must include the bound port, independent of Origin.
  const url = `http://127.0.0.1:${server.address().port}`;
  accounts.close();
  accounts = createAccounts({
    dbPath: join(dir, "accounts.db"),
    origins: [url],
    secureCookies: false,
    allowInsecureLocal: true,
    now: () => time,
    ...options,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    accounts.close();
    await rm(dir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "",
      csrf = "",
      user = null;
    return {
      get cookie() {
        return cookie;
      },
      get csrf() {
        return csrf;
      },
      get user() {
        return user;
      },
      async request(
        path,
        {
          method = "GET",
          body,
          headers = {},
          raw,
          noCsrf = false,
          noOwner = false,
        } = {},
      ) {
        const response = await fetch(url + path, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            Origin: url,
            ...(method !== "GET"
              ? {
                  "Content-Type": "application/json",
                  ...(!noCsrf ? { "X-CSRF-Token": csrf } : {}),
                }
              : {}),
            ...(user && !noOwner ? { "X-Account-ID": user.id } : {}),
            ...headers,
          },
          body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        const data = await response.json();
        if (data.csrfToken) csrf = data.csrfToken;
        if ("user" in data && !path.startsWith("/api/admin/")) user = data.user;
        assert.equal(response.headers.get("cache-control"), "no-store");
        return { status: response.status, data, headers: response.headers };
      },
      async bootstrap() {
        return this.request("/api/auth/session");
      },
      async register(username = "learner") {
        await this.bootstrap();
        return this.request("/api/auth/register", {
          method: "POST",
          body: { username, password: PASSWORD },
        });
      },
      async login(username = "learner", password = PASSWORD) {
        await this.bootstrap();
        return this.request("/api/auth/login", {
          method: "POST",
          body: { username, password },
        });
      },
    };
  }
  return {
    dir,
    url,
    client,
    get accounts() {
      return accounts;
    },
    advance(ms) {
      time += ms;
    },
    restart() {
      accounts.close();
      accounts = createAccounts({
        dbPath: join(dir, "accounts.db"),
        origins: [url],
        secureCookies: false,
        allowInsecureLocal: true,
        now: () => time,
        ...options,
      });
    },
    restore(path) {
      accounts.close();
      accounts = createAccounts({
        dbPath: path,
        origins: [url],
        secureCookies: false,
        allowInsecureLocal: true,
        now: () => time,
      });
    },
    async admin() {
      const c = client();
      await c.register("operator");
      accounts.db
        .prepare("UPDATE users SET role='admin' WHERE id=?")
        .run(c.user.id);
      await c.bootstrap();
      return c;
    },
  };
}
const post = (body, extra = {}) => ({ method: "POST", body, ...extra });
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "background operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
const member = (id, action) => `/api/admin/users/${id}/${action}`;
async function reauthenticate(admin) {
  const response = await admin.request(
    "/api/auth/reauth",
    post({ password: PASSWORD }),
  );
  assert.equal(response.status, 200);
  return response;
}

test("anonymous CSRF is reusable; register rotates hashed session; uniqueness and validation", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const first = await c.bootstrap();
  const cookie = c.cookie,
    csrf = c.csrf;
  assert.equal(first.data.enabled, true);
  assert.equal(first.data.user, null);
  assert.match(first.headers.get("set-cookie"), /HttpOnly.*SameSite=Lax/);
  await c.bootstrap();
  assert.equal(c.cookie, cookie);
  assert.equal(c.csrf, csrf);
  assert.equal(
    (
      await c.request(
        "/api/auth/register",
        post({ username: "x", password: PASSWORD }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/register",
        post({ username: "hello", password: "short" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/register",
        post({ username: "hello", password: PASSWORD, role: "admin" }),
      )
    ).status,
    400,
  );
  const r = await c.register("Learner");
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "user");
  assert.notEqual(c.cookie, cookie);
  assert.notEqual(c.csrf, csrf);
  const token = c.cookie.split("=")[1];
  const row = f.accounts.db
    .prepare("SELECT * FROM sessions WHERE token_hash=?")
    .get(createHash("sha256").update(token).digest("hex"));
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(token));
  const other = f.client();
  assert.equal((await other.register("LEARNER")).status, 409);
  const race = [f.client(), f.client()];
  await Promise.all(race.map((c) => c.bootstrap()));
  assert.deepEqual(
    (
      await Promise.all(
        race.map((c) =>
          c.request(
            "/api/auth/register",
            post({ username: "racing", password: PASSWORD }),
          ),
        ),
      )
    )
      .map((r) => r.status)
      .sort(),
    [200, 409],
  );
});

test("public user retains registration createdAt across later login and session restart", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const registered = await c.register();
  assert.equal(registered.status, 200);
  assert.equal(registered.data.user.createdAt, Date.UTC(2026, 9, 28));
  assert.equal(typeof registered.data.user.createdAt, "number");
  const expectedUser = {
    id: registered.data.user.id,
    username: "learner",
    nickname: "",
    role: "user",
    disabled: false,
    email: null,
    emailVerified: false,
    createdAt: Date.UTC(2026, 9, 28),
    membership: { active: true, permanent: true, expiresAt: null },
  };
  assert.deepEqual(registered.data.user, expectedUser);

  f.advance(2 * 86400000);
  f.restart();
  const session = await c.bootstrap();
  const other = f.client();
  const loggedIn = await other.login();
  f.advance(86400000);
  f.restart();
  const laterSession = await other.bootstrap();
  for (const response of [registered, session, loggedIn, laterSession]) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.user, expectedUser);
    assert.doesNotMatch(
      JSON.stringify(response.data.user),
      /password|secret|token|csrf/i,
    );
  }
});

test("free accounts expose email capability and canonical cloud routes without grants", async (t) => {
  const f = await fixture(t),
    c = f.client();
  assert.equal((await c.bootstrap()).data.emailEnabled, false);
  const r = await c.register();
  assert.deepEqual(r.data.user.membership, {
    active: true,
    permanent: true,
    expiresAt: null,
  });
  assert.equal(r.data.user.email, null);
  assert.equal(r.data.user.emailVerified, false);
  assert.equal(
    (await c.request("/api/account/progress?dataset=open")).status,
    200,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "a@example.com", purpose: "register" }),
      )
    ).status,
    503,
  );
});

test("verified email registration, password aliases, one-use OTP and purpose isolation", async (t) => {
  const sent = [];
  const f = await fixture(t, {
      sendEmailCode: async (m) => {
        sent.push(m);
      },
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  assert.equal((await c.bootstrap()).data.emailEnabled, true);
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "Test@EXAMPLE.com", purpose: "register" }),
      )
    ).status,
    200,
  );
  assert.match(sent[0].code, /^\d{6}$/);
  assert.equal(sent[0].email, "test@example.com");
  const row = f.accounts.db.prepare("SELECT * FROM email_codes").get();
  assert.equal(row.expires_at - row.created_at, 300000);
  assert.notEqual(row.code_hash, sent[0].code);
  assert.equal(
    (
      await c.request(
        "/api/auth/login-code",
        post({ email: sent[0].email, code: sent[0].code }),
      )
    ).status,
    400,
  );
  const r = await c.request(
    "/api/auth/register",
    post({ email: sent[0].email, code: sent[0].code, password: PASSWORD }),
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.user.emailVerified, true);
  const other = f.client();
  await other.bootstrap();
  assert.equal(
    (
      await other.request(
        "/api/auth/register",
        post({ email: sent[0].email, code: sent[0].code, password: PASSWORD }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await other.request(
        "/api/auth/login",
        post({ identifier: "TEST@example.com", password: PASSWORD }),
      )
    ).status,
    200,
  );
  f.advance(60000);
  assert.equal(
    (
      await other.request(
        "/api/auth/email-code",
        post({ email: sent[0].email, purpose: "login" }),
      )
    ).status,
    200,
  );
  const login = sent.at(-1),
    clients = [f.client(), f.client()];
  await Promise.all(clients.map((c) => c.bootstrap()));
  assert.deepEqual(
    (
      await Promise.all(
        clients.map((c) =>
          c.request(
            "/api/auth/login-code",
            post({ email: login.email, code: login.code }),
          ),
        ),
      )
    )
      .map((r) => r.status)
      .sort(),
    [200, 400],
  );
});

test("OTP exact expiry, five attempts, resend, cooldown and restart durability", async (t) => {
  const sent = [];
  const f = await fixture(t, {
      sendEmailCode: async (m) => {
        sent.push(m);
      },
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  const email = "limits@example.com",
    send = () =>
      c.request("/api/auth/email-code", post({ email, purpose: "register" }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  f.restart();
  assert.equal((await send()).status, 429);
  f.advance(60000);
  assert.equal((await send()).status, 200);
  const use = (code) =>
    c.request("/api/auth/register", post({ email, code, password: PASSWORD }));
  assert.equal((await use(sent[0].code)).status, 400);
  for (let i = 0; i < 4; i++)
    assert.equal((await use("not-six-digits")).status, 400);
  // Malformed attempts do not consume expensive password work; valid wrong codes exhaust the challenge.
  const wrong = sent[1].code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++) assert.equal((await use(wrong)).status, 400);
  assert.equal((await use(sent[1].code)).status, 400);
  f.advance(60000);
  assert.equal((await send()).status, 200);
  f.advance(300000);
  assert.equal((await use(sent[2].code)).status, 400);
});

test("mail failures clean pending codes, unknown email is generic, and configuration fails closed", async (t) => {
  const f = await fixture(t, {
      sendEmailCode: async () => {
        throw new Error("private smtp detail");
      },
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  const r = await c.request(
    "/api/auth/email-code",
    post({ email: "fail@example.com", purpose: "register" }),
  );
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes("private"));
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
  const generic = await c.request(
    "/api/auth/email-code",
    post({ email: "unknown@example.com", purpose: "login" }),
  );
  assert.deepEqual(generic.data, { ok: true, retryAfter: 60, expiresIn: 300 });
  assert.throws(
    () =>
      createAccounts({
        sendEmailCode: async () => {},
        emailCodeSecret: "weak",
      }),
    /secret/i,
  );
});

test("v1 migration preserves IDs, password hashes, sessions, progress and backups", async (t) => {
  const f = await fixture(t),
    c = f.client();
  await c.register("legacy_user");
  await c.request("/api/account/progress?dataset=open", {
    method: "PUT",
    body: { version: 0, snapshot: snapshot() },
  });
  await c.request(
    "/api/account/backups?dataset=open",
    post({ snapshot: snapshot() }),
  );
  const tables = ["users", "sessions", "progress", "backups"];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      f.accounts.db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
  // Remove only v2 additions to reproduce the original v1 schema exactly.
  f.accounts.db.exec(
    "DROP TABLE email_codes; DROP INDEX users_email; ALTER TABLE users DROP COLUMN email; ALTER TABLE users DROP COLUMN email_verified; PRAGMA user_version=1;",
  );
  f.restart();
  for (const table of tables) {
    const after = f.accounts.db.prepare(`SELECT * FROM ${table}`).all();
    assert.deepEqual(
      after.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !["email", "email_verified"].includes(k),
          ),
        ),
      ),
      before[table].map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !["email", "email_verified"].includes(k),
          ),
        ),
      ),
    );
  }
  assert.equal(
    f.accounts.db.prepare("PRAGMA user_version").get().user_version,
    2,
  );
  assert.equal((await c.bootstrap()).data.user.id, c.user.id);
  assert.equal(
    (await c.request("/api/account/progress?dataset=open")).data.version,
    1,
  );
  assert.equal(
    (await c.request("/api/account/backups?dataset=open")).data.backups.length,
    1,
  );
});

test("email registration rechecks expiry and single-use atomically after async hashing", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    sendEmailCode: async (m) => {
      sent.push(m);
    },
    emailCodeSecret: "s".repeat(64),
  });
  const c = f.client();
  await c.bootstrap();
  const email = "hashing@example.com";
  await c.request("/api/auth/email-code", post({ email, purpose: "register" }));
  const pending = c.request(
    "/api/auth/register",
    post({ email, code: sent[0].code, password: PASSWORD }),
  );
  while (passwordWork().active === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  f.advance(300000);
  assert.equal((await pending).status, 400);
  assert.equal(
    f.accounts.db
      .prepare("SELECT COUNT(*) n FROM users WHERE email=?")
      .get(email).n,
    0,
  );
  await c.request("/api/auth/email-code", post({ email, purpose: "register" }));
  const clients = [c, f.client()];
  await clients[1].bootstrap();
  const raced = await Promise.all(
    clients.map((c) =>
      c.request(
        "/api/auth/register",
        post({ email, code: sent.at(-1).code, password: PASSWORD }),
      ),
    ),
  );
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    f.accounts.db
      .prepare("SELECT COUNT(*) n FROM users WHERE email=?")
      .get(email).n,
    1,
  );
});

test("pending deliveries are unusable and concurrent sends are bounded with failure cleanup", async (t) => {
  const pending = [];
  const f = await fixture(t, {
    sendEmailCode: (m) =>
      new Promise((resolve, reject) => {
        pending.push({ m, resolve, reject });
      }),
    emailCodeSecret: "s".repeat(64),
  });
  const clients = Array.from({ length: 5 }, () => f.client());
  await Promise.all(clients.map((c) => c.bootstrap()));
  const requests = clients
    .slice(0, 4)
    .map((c, i) =>
      c.request(
        "/api/auth/email-code",
        post({ email: `pending${i}@example.com`, purpose: "register" }),
      ),
    );
  while (pending.length < 4)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(
    (
      await clients[4].request(
        "/api/auth/email-code",
        post({ email: "overflow@example.com", purpose: "register" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await clients[4].request(
        "/api/auth/register",
        post({
          email: pending[0].m.email,
          code: pending[0].m.code,
          password: PASSWORD,
        }),
      )
    ).status,
    400,
  );
  pending[0].reject(new Error("private"));
  for (const item of pending.slice(1)) item.resolve();
  assert.deepEqual(
    (await Promise.all(requests)).map((r) => r.status),
    [200, 200, 200, 200],
  );
  await waitFor(
    () =>
      f.accounts.db
        .prepare("SELECT COUNT(*) n FROM email_codes WHERE ready=1")
        .get().n === 3,
  );
  assert.equal(
    f.accounts.db
      .prepare("SELECT COUNT(*) n FROM email_codes WHERE ready=1")
      .get().n,
    3,
  );
  assert.equal(
    f.accounts.db
      .prepare("SELECT COUNT(*) n FROM email_codes WHERE email=?")
      .get(pending[0].m.email).n,
    0,
  );
});

test("email/IP/global send quotas are durable and forwarded addresses cannot bypass them", async (t) => {
  const f = await fixture(t, {
      sendEmailCode: async () => {},
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (
        await c.request(
          "/api/auth/email-code",
          post({ email: "quota@example.com", purpose: "register" }),
        )
      ).status,
      200,
    );
    f.advance(60000);
  }
  f.restart();
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "QUOTA@example.com", purpose: "login" }),
      )
    ).status,
    429,
  );
  const digest = (x) => createHash("sha256").update(x).digest("hex");
  const global = digest("email_global:global:");
  assert.equal(
    f.accounts.db
      .prepare("SELECT count FROM rate_limits WHERE key=?")
      .get(global).count,
    5,
  );
  f.accounts.db
    .prepare("UPDATE rate_limits SET count=200 WHERE key=?")
    .run(global);
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "global@example.com", purpose: "register" }),
      )
    ).status,
    429,
  );
  f.accounts.db
    .prepare("UPDATE rate_limits SET count=5 WHERE key=?")
    .run(global);
  const ip = f.accounts.db
    .prepare("SELECT key FROM rate_limits WHERE count=5 AND key<>?")
    .all(global)
    .find((row) => row.key === digest("email_ip:127.0.0.1:"));
  assert.ok(ip);
  f.accounts.db
    .prepare("UPDATE rate_limits SET count=20 WHERE key=?")
    .run(ip.key);
  f.restart();
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post(
          { email: "ip@example.com", purpose: "register" },
          { headers: { "X-Forwarded-For": "192.0.2.100" } },
        ),
      )
    ).status,
    429,
  );
});

test("password changes, admin resets and disable revoke email challenges", async (t) => {
  const sent = [];
  const f = await fixture(t, {
      sendEmailCode: async (m) => {
        sent.push(m);
      },
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  const email = "revoke@example.com";
  await c.request("/api/auth/email-code", post({ email, purpose: "register" }));
  await c.request(
    "/api/auth/register",
    post({ email, code: sent.at(-1).code, password: PASSWORD }),
  );
  const id = c.user.id,
    a = await f.admin();
  await reauthenticate(a);
  const anon = f.client();
  await anon.bootstrap();
  const issue = async () => {
    f.advance(60000);
    assert.equal(
      (
        await anon.request(
          "/api/auth/email-code",
          post({ email, purpose: "login" }),
        )
      ).status,
      200,
    );
    return sent.at(-1).code;
  };
  let code = await issue();
  assert.equal(
    (
      await c.request(
        "/api/auth/password",
        post({ currentPassword: PASSWORD, password: NEW_PASSWORD }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await anon.request("/api/auth/login-code", post({ email, code }))).status,
    400,
  );
  code = await issue();
  await a.request(member(id, "reset"), post({}));
  assert.equal(
    (await anon.request("/api/auth/login-code", post({ email, code }))).status,
    400,
  );
  code = await issue();
  await a.request(member(id, "status"), post({ disabled: true }));
  assert.equal(
    (await anon.request("/api/auth/login-code", post({ email, code }))).status,
    400,
  );
  const count = sent.length;
  f.advance(60000);
  assert.equal(
    (
      await anon.request(
        "/api/auth/email-code",
        post({ email, purpose: "login" }),
      )
    ).status,
    200,
  );
  assert.equal(sent.length, count);
});

test("email validation rejects header injection, noncanonical shapes and authority fields", async (t) => {
  const sent = [];
  const f = await fixture(t, {
      sendEmailCode: async (m) => {
        sent.push(m);
      },
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  for (const email of [
    "a@example.com\r\nBcc:other@example.com",
    " a@example.com",
    "a@example.com ",
    "a..b@example.com",
    ".a@example.com",
    "a@-example.com",
    "a@example..com",
    "a@localhost",
    `${"a".repeat(65)}@example.com`,
    `${"a".repeat(64)}@${"b".repeat(190)}.com`,
  ])
    assert.equal(
      (
        await c.request(
          "/api/auth/email-code",
          post({ email, purpose: "register" }),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "a@example.com", purpose: "reset" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "a@example.com", purpose: "register", role: "admin" }),
      )
    ).status,
    400,
  );
  assert.equal(sent.length, 0);
});

test("email delivery total timeout removes challenge and late completion cannot reactivate it", async (t) => {
  let finish, delivered;
  const f = await fixture(t, {
      sendEmailCode: (m) =>
        new Promise((resolve) => {
          delivered = m;
          finish = resolve;
        }),
      emailCodeSecret: "s".repeat(64),
    }),
    c = f.client();
  await c.bootstrap();
  const r = await c.request(
    "/api/auth/email-code",
    post({ email: "timeout@example.com", purpose: "register" }),
  );
  assert.equal(r.status, 200);
  await waitFor(() => !!finish);
  assert.equal(
    f.accounts.db
      .prepare("SELECT COUNT(*) n FROM email_codes WHERE ready=0")
      .get().n,
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 15100));
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (
      await c.request(
        "/api/auth/register",
        post({
          email: delivered.email,
          code: delivered.code,
          password: PASSWORD,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
});

test("email acceptance never waits for SMTP and is identical for enabled, disabled and unknown accounts when busy or rejected", async (t) => {
  const pending = [];
  let rejectDelivery = false;
  const f = await fixture(t, {
      emailCodeSecret: "s".repeat(64),
      sendEmailCode: (m) => {
        if (rejectDelivery)
          return Promise.reject(new Error("private smtp result"));
        return new Promise((resolve, reject) =>
          pending.push({ m, resolve, reject }),
        );
      },
    }),
    c = f.client();
  await c.bootstrap();
  for (const [name, email, disabled] of [
    ["enabled", "enabled@example.com", 0],
    ["disabled", "disabled@example.com", 1],
  ]) {
    await c.register(name);
    f.accounts.db
      .prepare(
        "UPDATE users SET email=?,email_verified=1,disabled=? WHERE id=?",
      )
      .run(email, disabled, c.user.id);
    // Disabled clients cannot retain a valid session; use a fresh bootstrap below.
    if (disabled) await c.bootstrap();
  }
  const accepted = { ok: true, retryAfter: 60, expiresIn: 300 };
  const ask = (email, purpose = "login") =>
    c.request("/api/auth/email-code", post({ email, purpose }));
  // This request must finish before its injected sender settles.
  const first = await Promise.race([
    ask("enabled@example.com"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HTTP waited for SMTP")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, accepted);
  for (let i = 0; i < 3; i++)
    assert.equal((await ask(`fill${i}@example.com`, "register")).status, 200);
  await waitFor(() => pending.length === 4);
  f.advance(60000);
  for (const email of [
    "enabled@example.com",
    "disabled@example.com",
    "unknown@example.com",
  ]) {
    const r = await ask(email);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, accepted);
  }
  assert.equal(pending.length, 4, "capacity must not enqueue more work");
  for (const item of pending) item.reject(new Error("private smtp result"));
  await waitFor(
    () =>
      f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n === 0,
  );
  rejectDelivery = true;
  f.advance(60000);
  for (const email of [
    "enabled@example.com",
    "disabled@example.com",
    "unknown@example.com",
  ]) {
    const r = await ask(email);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, accepted);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
});

test("synchronous close revokes pending email work and late resolution/rejection never touches closed SQLite", async (t) => {
  const pending = [];
  const f = await fixture(t, {
      emailCodeSecret: "s".repeat(64),
      sendEmailCode: (m) =>
        new Promise((resolve, reject) => pending.push({ m, resolve, reject })),
    }),
    c = f.client();
  await c.bootstrap();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await c.request(
          "/api/auth/email-code",
          post({ email: `close${i}@example.com`, purpose: "register" }),
        )
      ).status,
      200,
    );
  await waitFor(() => pending.length === 2);
  f.restart();
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
  pending[0].resolve();
  pending[1].reject(new Error("private"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) n FROM email_codes").get().n,
    0,
  );
  f.advance(60000);
  assert.equal(
    (
      await c.request(
        "/api/auth/email-code",
        post({ email: "after-close@example.com", purpose: "register" }),
      )
    ).status,
    200,
  );
  await waitFor(() => pending.length === 3);
  pending[2].resolve();
});

test("origin, CSRF, content type, Host, JSON and expected owner fail closed", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.register();
  assert.equal(
    (await c.request("/api/auth/logout", post({}, { noCsrf: true }))).status,
    403,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/logout",
        post({}, { headers: { Origin: "https://evil.example" } }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/logout",
        post({}, { headers: { "X-Account-ID": "other" } }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await c.request(
        "/api/auth/logout",
        post({}, { headers: { "Content-Type": "text/plain" } }),
      )
    ).status,
    415,
  );
  assert.equal(
    (await c.request("/api/auth/logout", { method: "POST", raw: "{" })).status,
    400,
  );
  const badHost = await new Promise((resolve, reject) => {
    const req = httpRequest(
      f.url + "/api/auth/session",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await c.request("/api/auth/session")).data.user.id, c.user.id);
});

test("persisted sessions, generic login errors, logout, password revokes every device", async (t) => {
  const f = await fixture(t);
  const a = f.client();
  await a.register();
  const b = f.client();
  const wrong = await b.login("learner", "incorrect password here");
  const absent = await b.login("absent", PASSWORD);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, absent.data);
  assert.equal((await b.login()).status, 200);
  f.restart();
  assert.equal((await a.bootstrap()).data.user.username, "learner");
  assert.equal(
    (
      await a.request(
        "/api/auth/password",
        post({ currentPassword: PASSWORD, password: NEW_PASSWORD }),
      )
    ).status,
    200,
  );
  assert.equal((await b.bootstrap()).data.user, null);
  assert.equal((await a.bootstrap()).data.user, null);
  assert.equal((await a.login("learner", NEW_PASSWORD)).status, 200);
  assert.equal((await a.request("/api/auth/logout", post({}))).status, 200);
  assert.equal((await a.bootstrap()).data.user, null);
});

test("live role, reauth five minute boundary, removed grants and status audit", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  const id = c.user.id;
  assert.equal((await c.request("/api/admin/users")).status, 403);
  assert.equal(
    (await a.request(member(id, "membership"), post({ days: 30 }))).status,
    403,
  );
  await reauthenticate(a);
  for (const days of [30, 90, 365, "permanent", "cancel", "30"])
    assert.equal(
      (await a.request(member(id, "membership"), post({ days }))).status,
      410,
    );
  assert.equal((await c.bootstrap()).data.user.membership.active, true);
  f.advance(300000);
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: false }))).status,
    403,
  );
  assert.equal((await reauthenticate(a)).status, 200);
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: true }))).status,
    200,
  );
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: false }))).status,
    200,
  );
  assert.equal(
    (await a.request("/api/admin/users?q=LEARN")).data.users.length,
    1,
  );
  const audit = (await a.request("/api/admin/audit")).data.audit;
  assert.ok(audit.length >= 2);
  assert.ok(!JSON.stringify(audit).includes(PASSWORD));
  f.accounts.db
    .prepare("UPDATE users SET role='user' WHERE id=?")
    .run(a.user.id);
  assert.equal((await a.request("/api/admin/audit")).status, 403);
});

test("CAS, actual owned IDOR, account header, backup retention and free downloads", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  const d = f.client();
  await d.register("second");
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).status,
    200,
  );
  await reauthenticate(a);
  await reauthenticate(a);
  assert.equal(
    (await c.request("/api/member/progress?dataset=open", { noOwner: true }))
      .status,
    409,
  );
  assert.deepEqual(
    (await c.request("/api/member/progress?dataset=open")).data,
    { version: 0, snapshot: null },
  );
  const put = { method: "PUT", body: { version: 0, snapshot: snapshot() } };
  const raced = await Promise.all([
    c.request("/api/member/progress?dataset=open", put),
    c.request("/api/member/progress?dataset=open", put),
  ]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
  assert.equal(raced.find((r) => r.status === 409).data.version, 1);
  assert.deepEqual(
    (await d.request("/api/member/progress?dataset=open")).data,
    { version: 0, snapshot: null },
  );
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await c.request(
      "/api/member/backups?dataset=open",
      post({ snapshot: snapshot() }),
    );
    assert.equal(r.status, 200);
    ids.push(r.data.id);
  }
  assert.equal(
    (await c.request("/api/member/backups?dataset=open")).data.backups.length,
    3,
  );
  assert.equal((await c.request(`/api/member/backups/${ids[0]}`)).status, 404);
  assert.equal((await d.request(`/api/member/backups/${ids[3]}`)).status, 404);
  assert.equal(
    (
      await d.request(`/api/member/backups/${ids[3]}`, {
        headers: { "X-Account-ID": c.user.id },
      })
    ).status,
    409,
  );
  f.advance(30 * 86400000);
  // Session lifetime is seven days: obtain a new session after advancing.
  assert.equal((await c.bootstrap()).data.user, null);
  await c.login();
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).status,
    200,
  );
  assert.equal(
    (await c.request("/api/member/backups?dataset=open")).status,
    200,
  );
  assert.deepEqual(
    (await c.request(`/api/member/backups/${ids[3]}`)).data.snapshot,
    snapshot(),
  );
  assert.equal(
    (
      await c.request(
        "/api/member/backups?dataset=open",
        post({ snapshot: snapshot() }),
      )
    ).status,
    200,
  );
});

test("disable revokes sessions immediately; restore requires fresh login; last admin protected", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  const id = c.user.id;
  await reauthenticate(a);
  assert.equal(
    (await a.request(member(a.user.id, "status"), post({ disabled: true })))
      .status,
    409,
  );
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: true }))).status,
    200,
  );
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).status,
    401,
  );
  assert.equal((await c.login()).status, 401);
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: false }))).status,
    200,
  );
  assert.equal((await c.bootstrap()).data.user, null);
  assert.equal((await c.login()).status, 200);
  assert.equal(
    (await a.request(member(id, "membership"), post({ days: "cancel" })))
      .status,
    410,
  );
  assert.equal(
    (
      await c.request("/api/member/progress?dataset=open", {
        method: "PUT",
        body: { version: 0, snapshot: snapshot() },
      })
    ).status,
    200,
  );
});

test("reset credentials persisted, hashed, expiring, one-use and revoke every session", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  const id = c.user.id;
  await reauthenticate(a);
  const r = await a.request(member(id, "reset"), post({}));
  assert.equal(r.status, 200);
  assert.ok(
    !JSON.stringify(
      f.accounts.db.prepare("SELECT * FROM reset_tokens").all(),
    ).includes(r.data.token),
  );
  f.restart();
  const anon = f.client();
  await anon.bootstrap();
  assert.equal(
    (
      await anon.request(
        "/api/auth/reset",
        post({ token: r.data.token, password: NEW_PASSWORD }),
      )
    ).status,
    200,
  );
  assert.equal((await c.bootstrap()).data.user, null);
  assert.equal(
    (
      await anon.request(
        "/api/auth/reset",
        post({ token: r.data.token, password: PASSWORD }),
      )
    ).status,
    400,
  );
  assert.equal((await c.login("learner", NEW_PASSWORD)).status, 200);
  const next = await a.request(member(id, "reset"), post({}));
  f.advance(30 * 60000);
  await anon.bootstrap();
  assert.equal(
    (
      await anon.request(
        "/api/auth/reset",
        post({ token: next.data.token, password: PASSWORD }),
      )
    ).status,
    400,
  );
});

test("bounded schema, dataset ownership, dangerous keys and body limit", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  await reauthenticate(a);
  const send = (s) =>
    c.request("/api/member/progress?dataset=open", {
      method: "PUT",
      body: { version: 0, snapshot: s },
    });
  for (const s of [
    {},
    { ...snapshot(), version: 1 },
    snapshot("different"),
    { ...snapshot(), role: "admin" },
    { ...snapshot(), progress: { ...snapshot().progress, session: {} } },
    { ...snapshot(), extras: { __proto__bad: "x" } },
    {
      ...snapshot(),
      progress: { ...snapshot().progress, bookmarks: Array(20001).fill("x") },
    },
  ])
    assert.equal((await send(s)).status, 400);
  assert.equal(
    (await c.request("/api/member/progress?dataset=../other")).status,
    400,
  );
  assert.equal(
    (await c.request("/api/member/progress?dataset=open&dataset=other")).status,
    400,
  );
  const huge = JSON.stringify({
    version: 0,
    snapshot: { ...snapshot(), extras: { huge: "x".repeat(10 * 1024 * 1024) } },
  });
  assert.equal(
    (
      await c.request("/api/member/progress?dataset=open", {
        method: "PUT",
        raw: huge,
      })
    ).status,
    413,
  );
  assert.deepEqual(
    (await c.request("/api/member/progress?dataset=open")).data,
    { version: 0, snapshot: null },
  );
});

test("persisted bounded rate limits survive restart", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.bootstrap();
  let response;
  for (let i = 0; i < 12; i++)
    response = await c.request(
      "/api/auth/login",
      post({ username: "missing", password: PASSWORD }),
    );
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  f.restart();
  assert.equal(
    (
      await c.request(
        "/api/auth/login",
        post({ username: "missing", password: PASSWORD }),
      )
    ).status,
    429,
  );
  assert.ok(
    f.accounts.db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n <=
      10000,
  );
  f.advance(16 * 60000);
  assert.equal(
    (
      await c.request(
        "/api/auth/login",
        post({ username: "missing", password: PASSWORD }),
      )
    ).status,
    401,
  );
});

test("nonTLS fails closed even with forged forwarding headers", async (t) => {
  const f = await fixture(t, {
    allowInsecureLocal: false,
    secureCookies: true,
  });
  const c = f.client();
  const r = await c.bootstrap();
  assert.equal(r.data.enabled, false);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(
    (
      await c.request(
        "/api/auth/register",
        post(
          { username: "unsafe", password: PASSWORD },
          {
            headers: {
              "X-Forwarded-Proto": "https",
              "X-Forwarded-For": "127.0.0.1",
            },
          },
        ),
      )
    ).status,
    426,
  );
});

test("consistent SQLite backup restores sessions, accounts, snapshots and migration version", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  await reauthenticate(a);
  await c.request("/api/member/progress?dataset=open", {
    method: "PUT",
    body: { version: 0, snapshot: snapshot() },
  });
  const target = join(f.dir, "restore.db");
  await backupDatabase(f.accounts.db, target);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const restored = createAccounts({ dbPath: target, origins: [f.url] });
  try {
    assert.equal(
      restored.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      restored.db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      2,
    );
    assert.equal(
      restored.db.prepare("SELECT version FROM progress").get().version,
      1,
    );
    assert.equal(
      restored.db.prepare("PRAGMA user_version").get().user_version,
      2,
    );
  } finally {
    restored.close();
  }
  await assert.rejects(backupDatabase(f.accounts.db, target));
  f.restore(target);
  assert.equal((await c.bootstrap()).data.user.username, "learner");
  assert.deepEqual(
    (await c.request("/api/member/progress?dataset=open")).data,
    { version: 1, snapshot: snapshot() },
  );
  f.accounts.db.exec("PRAGMA user_version=99");
  assert.throws(
    () => createAccounts({ dbPath: target, origins: [f.url] }),
    /version|migration/i,
  );
  f.accounts.db.exec("PRAGMA user_version=2");
  await writeFile(join(f.dir, "corrupt.db"), "not a database");
  assert.throws(() =>
    createAccounts({ dbPath: join(f.dir, "corrupt.db"), origins: [f.url] }),
  );
});

test("async scrypt is salted, bounded to two active jobs, validates encoding", async () => {
  const jobs = Array.from({ length: 5 }, () => hashPassword(PASSWORD));
  assert.ok(passwordWork().active <= 2);
  const hashes = await Promise.all(jobs);
  assert.equal(new Set(hashes).size, 5);
  assert.equal(await verifyPassword(PASSWORD, hashes[0]), true);
  assert.equal(await verifyPassword(NEW_PASSWORD, hashes[0]), false);
  assert.equal(await verifyPassword(PASSWORD, "scrypt$999999999$bad"), false);
});

test("existing browser backup format including exported, percent accuracy and reader position roundtrips", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  await reauthenticate(a);
  const real = snapshot();
  delete real.exportedAt;
  real.exported = new Date().toISOString();
  real.progress.typing = [
    { at: 100, mode: "word", items: 20, wpm: 50, accuracy: 98 },
  ];
  real.settings.dailyNew = 0;
  real.extras = {
    "word-atlas:reader-position:v1": {
      kind: "short",
      id: "sample",
      paragraph: 2,
    },
    "word-atlas:appearance": { theme: "dark" },
  };
  const r = await c.request("/api/member/progress?dataset=open", {
    method: "PUT",
    body: { version: 0, snapshot: real },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (await c.request("/api/member/progress?dataset=open")).data.snapshot,
    real,
  );
});

test("malformed CSRF is denied, including nonASCII header bytes with unequal UTF8 size", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.register();
  const r = await c.request(
    "/api/auth/logout",
    post({}, { headers: { "X-CSRF-Token": "é".repeat(64) } }),
  );
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "csrf");
});

test("in-flight request revoked while streaming body cannot update cloud progress", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  const id = c.user.id;
  await reauthenticate(a);
  let received;
  const response = new Promise((resolve, reject) => {
    received = httpRequest(
      f.url + "/api/member/progress?dataset=open",
      {
        method: "PUT",
        headers: {
          Cookie: c.cookie,
          Origin: f.url,
          "Content-Type": "application/json",
          "X-CSRF-Token": c.csrf,
          "X-Account-ID": id,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, data: JSON.parse(data) }),
        );
      },
    );
    received.on("error", reject);
  });
  received.write('{"version":0,');
  assert.equal(
    (await a.request(member(id, "status"), post({ disabled: true }))).status,
    200,
  );
  received.end(`"snapshot":${JSON.stringify(snapshot())}}`);
  assert.ok([401, 403].includes((await response).status));
  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) AS n FROM progress").get().n,
    0,
  );
});

test("raw chunked bodies enforce 10MiB, prototype keys and missing Origin", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.register();
  async function rawRequest(body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        f.url + "/api/auth/logout",
        {
          method: "POST",
          headers: {
            Cookie: c.cookie,
            Origin: f.url,
            "Content-Type": "application/json",
            "X-CSRF-Token": c.csrf,
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      // Explicit write() makes transfer encoding chunked, without Content-Length.
      req.write(body);
      req.end();
    });
  }
  assert.equal(await rawRequest('{"__proto__":{"polluted":true}}'), 400);
  assert.equal(await rawRequest("{}", { Origin: "" }), 403);
  assert.equal(await rawRequest("x".repeat(10 * 1024 * 1024 + 1)), 413);
});

test("session cookie flags, stale prelogin cookie and static pass-through", async (t) => {
  const f = await fixture(t, { secureCookies: true });
  const c = f.client();
  const boot = await c.bootstrap();
  assert.match(
    boot.headers.get("set-cookie"),
    /HttpOnly; Secure; SameSite=Lax/,
  );
  const old = c.cookie;
  await c.register();
  assert.equal(
    (await c.request("/api/auth/session", { headers: { Cookie: old } })).data
      .user,
    null,
  );
  const req = { url: "/static-file", method: "GET" };
  const res = {
    setHeader() {
      throw new Error("Static response must not be changed");
    },
  };
  assert.equal(await f.accounts.handle(req, res), false);
});

test("password pool rejects overload instead of growing an unbounded queue", async () => {
  const jobs = Array.from({ length: 40 }, () => hashPassword(PASSWORD));
  assert.equal(passwordWork().active, 2);
  assert.equal(passwordWork().queued, 32);
  const results = await Promise.allSettled(jobs);
  assert.equal(
    results.filter((r) => r.status === "rejected" && r.reason.code === "busy")
      .length,
    6,
  );
});

test("cloud extras match browser bounds and support more than 200 illustration preferences", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  await reauthenticate(a);
  const s = snapshot();
  for (let i = 0; i < 250; i++)
    s.extras[`word-atlas:illustration:word${i}`] = { variant: 1 };
  s.extras["word-atlas:extras:v1:open"] = { notes: "x".repeat(600000) };
  assert.equal(
    (
      await c.request("/api/member/progress?dataset=open", {
        method: "PUT",
        body: { version: 0, snapshot: s },
      })
    ).status,
    200,
  );
});

test("legacy membership expiry never gates free accounts or invalidates the current login", async (t) => {
  const f = await fixture(t);
  const a = await f.admin();
  const c = f.client();
  await c.register();
  await reauthenticate(a);
  f.accounts.db
    .prepare("UPDATE users SET permanent=0,expires_at=? WHERE id=?")
    .run(Date.UTC(2026, 9, 28) + 30 * 86400000, c.user.id);
  const saved = await c.request(
    "/api/member/backups?dataset=open",
    post({ snapshot: snapshot() }),
  );
  f.advance(30 * 86400000 - 1000);
  await c.login();
  const cookie = c.cookie;
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).status,
    200,
  );
  f.advance(1000);
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).status,
    200,
  );
  assert.equal((await c.bootstrap()).data.user.membership.active, true);
  assert.equal(c.cookie, cookie);
  assert.equal(
    (await c.request(`/api/member/backups/${saved.data.id}`)).status,
    200,
  );
});

test("auth payloads are small and unknown or unauthorized uploads are rejected before reading", async (t) => {
  const f = await fixture(t),
    c = f.client();
  await c.bootstrap();
  assert.equal(
    (
      await c.request(
        "/api/auth/login",
        post({
          username: "learner",
          password: PASSWORD,
          padding: "x".repeat(17000),
        }),
      )
    ).status,
    413,
  );
  for (const [path, status] of [
    ["/api/not-real", 404],
    ["/api/member/progress?dataset=open", 401],
  ]) {
    let req;
    const answer = new Promise((resolve, reject) => {
      req = httpRequest(
        f.url + path,
        {
          method: "PUT",
          headers: {
            Cookie: c.cookie,
            Origin: f.url,
            "Content-Type": "application/json",
            "X-CSRF-Token": c.csrf,
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", () => {});
      req.write('{"neverFinished":');
      setTimeout(
        () =>
          reject(new Error("Request body was consumed before authorization")),
        700,
      ).unref();
    });
    try {
      assert.equal(await answer, status);
    } finally {
      req.destroy();
    }
  }
});

test("partial uploads have a global admission limit which releases aborted slots", async (t) => {
  const f = await fixture(t),
    c = f.client();
  await c.bootstrap();
  const held = [];
  try {
    for (let i = 0; i < 4; i++) {
      const req = httpRequest(f.url + "/api/auth/login", {
        method: "POST",
        headers: {
          Cookie: c.cookie,
          Origin: f.url,
          "Content-Type": "application/json",
          "X-CSRF-Token": c.csrf,
          "Content-Length": "15000",
        },
      });
      req.on("error", () => {});
      held.push(req);
      await new Promise((r) => req.write('{"username":', r));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      (
        await c.request(
          "/api/auth/login",
          post({ username: "missing", password: PASSWORD }),
        )
      ).status,
      503,
    );
    held.shift().destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      (
        await c.request(
          "/api/auth/login",
          post({ username: "missing", password: PASSWORD }),
        )
      ).status,
      401,
    );
  } finally {
    held.forEach((req) => req.destroy());
  }
});

test("a full session store still permits net-zero rotation of an existing login", async (t) => {
  const f = await fixture(t),
    c = f.client();
  await c.register();
  const db = f.accounts.db,
    expiry = db
      .prepare("SELECT expires_at FROM sessions LIMIT 1")
      .get().expires_at;
  const insert = db.prepare(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,peer_hash) VALUES(?,NULL,?,?,1,?)",
  );
  db.exec("BEGIN");
  for (let i = 1; i < 10000; i++)
    insert.run(
      i.toString(16).padStart(64, "0"),
      "a".repeat(64),
      expiry,
      "fixture",
    );
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 10000);
  assert.equal((await c.login()).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 10000);
});

test("durable cloud quotas count replacements and retained backups without touching other users", async (t) => {
  const size = Buffer.byteLength(JSON.stringify(snapshot()));
  const f = await fixture(t, {
    accountQuotaBytes: size * 2 + 64,
    cloudQuotaBytes: size * 3 + 64,
  });
  const a = await f.admin(),
    c = f.client(),
    d = f.client();
  await c.register();
  await d.register("another");
  await reauthenticate(a);
  await reauthenticate(a);
  assert.equal(
    (
      await c.request("/api/member/progress?dataset=open", {
        method: "PUT",
        body: { version: 0, snapshot: snapshot() },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await c.request(
        "/api/member/backups?dataset=open",
        post({ snapshot: snapshot() }),
      )
    ).status,
    200,
  );
  const full = await c.request(
    "/api/member/backups?dataset=open",
    post({ snapshot: snapshot() }),
  );
  assert.equal(full.status, 413);
  assert.equal(full.data.code, "storage_quota");
  assert.equal(
    (
      await c.request("/api/member/progress?dataset=open", {
        method: "PUT",
        body: { version: 1, snapshot: snapshot() },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await d.request("/api/member/progress?dataset=open", {
        method: "PUT",
        body: { version: 0, snapshot: snapshot() },
      })
    ).status,
    200,
  );
  const global = await d.request(
    "/api/member/backups?dataset=open",
    post({ snapshot: snapshot() }),
  );
  assert.equal(global.status, 413);
  assert.equal(global.data.code, "cloud_capacity");
  assert.equal(
    (await c.request("/api/member/progress?dataset=open")).data.version,
    2,
  );
});
