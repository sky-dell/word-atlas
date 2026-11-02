import {
  createHash,
  createHmac,
  randomInt,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { openDatabase, transaction } from "./database.mjs";
import { hashPassword, verifyPassword, validPassword, validPasswordInput, PASSWORD_ERROR } from "./passwords.mjs";
import { MAX_BODY, safeTree, validDataset, validSnapshot } from "./schema.mjs";
import { normalizeMailConfig } from "./mail-config.mjs";

const DAY = 86400000;
const ACCOUNT_IDLE_MS=120*60000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = (ip) =>
  ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
const fail = (status, code, message = code, extra = {}) => {
  throw Object.assign(new Error(message), { status, code, extra });
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function publicMailStatus(value) {
  if (!value || value.configured !== true)
    return {
      configured: false,
      secretConfigured: value?.secretConfigured === true,
    };
  return {
    configured: true,
    host: value.host,
    port: value.port,
    security: value.security,
    user: value.user,
    from: value.from,
    fromName: value.fromName,
    secretConfigured: true,
  };
}
// Bound aggregate upload memory, including authenticated users and slow bodies.
let activeBodies = 0;
const MAX_ACTIVE_BODIES = 4;
const AUTH_BODY_LIMIT = 16 * 1024;
let activeMailSends = 0;
const MAX_MAIL_SENDS = 4;

export function normalizeEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
      value,
    )
  )
    fail(400, "invalid_email");
  const [local, domain] = value.split("@");
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.split(".").some((x) => x.length > 63)
  )
    fail(400, "invalid_email");
  return value.toLowerCase();
}

function fields(body, allowed, required = []) {
  if (
    !object(body) ||
    !Object.keys(body).every((k) => allowed.includes(k)) ||
    !required.every((k) => Object.hasOwn(body, k))
  )
    fail(400, "invalid_body", "Invalid request fields");
}
function credentials(body, nickname = false) {
  fields(
    body,
    nickname ? ["username", "password", "nickname"] : ["username", "password"],
    ["username", "password"],
  );
  if(typeof body.username==='string'&&body.username.toLowerCase()==='admin')fail(409,'username_taken','该名称为系统管理员保留，请选择其他用户名。');
  if (
    typeof body.username !== "string" ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(body.username)
  )
    fail(
      400,
      "invalid_username",
      "Username must contain 3–32 ASCII letters, digits or underscores",
    );
  if (!validPassword(body.password))
    fail(400, "invalid_password", PASSWORD_ERROR);
  if (
    nickname &&
    body.nickname !== undefined &&
    (typeof body.nickname !== "string" ||
      [...body.nickname].length > 80 ||
      /[\x00-\x1f\x7f]/.test(body.nickname))
  )
    fail(400, "invalid_nickname");
}

async function readBody(req, limit = AUTH_BODY_LIMIT) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] || "",
    )
  )
    fail(415, "content_type", "Expected application/json");
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  )
    fail(415, "content_encoding");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    req.resume();
    fail(413, "body_too_large");
  }
  if (activeBodies >= MAX_ACTIVE_BODIES) {
    req.resume();
    fail(503, "upload_capacity", "Too many concurrent uploads");
  }
  activeBodies++;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0,
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      activeBodies--;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const error = (status, code) =>
      Object.assign(new Error(code), { status, code });
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) finish(error(413, "body_too_large"));
      else chunks.push(chunk);
    };
    const onError = () => finish(error(400, "invalid_body"));
    const onAbort = () => finish(error(400, "invalid_body"));
    const onEnd = () => {
      try {
        // Fatal UTF-8 decoding rejects malformed encodings instead of replacement.
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        if (!object(value) || !safeTree(value))
          return finish(error(400, "invalid_body"));
        finish(null, value);
      } catch {
        finish(error(400, "invalid_json"));
      }
    };
    const timer = setTimeout(() => finish(error(408, "body_timeout")), 15000);
    timer.unref();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAbort);
  });
}
export { readBody as readJsonBody };

export function createAccounts({
  dbPath,
  origins,
  secureCookies = true,
  allowInsecureLocal = false,
  initializeDatabase = true,
  accountQuotaBytes = 40 * 1024 * 1024,
  cloudQuotaBytes = 512 * 1024 * 1024,
  now = Date.now,
  sendEmailCode,
  mailRuntime,
  mailPassword,
  emailCodeSecret: initialEmailCodeSecret,
  operations,
  listGuests=()=>[],
} = {}) {
  if (
    mailRuntime !== undefined &&
    (!mailRuntime ||
      typeof mailRuntime !== "object" ||
      typeof mailRuntime.status !== "function" ||
      typeof mailRuntime.verify !== "function" ||
      typeof mailRuntime.apply !== "function" ||
      typeof mailRuntime.sendCode !== "function")
  )
    throw new Error("Invalid mail runtime");
  const mailSender = sendEmailCode ?? mailRuntime?.sendCode;
  if (mailSender !== undefined && typeof mailSender !== "function")
    throw new Error("Email code sender must be a function");
  let emailCodeSecret = initialEmailCodeSecret;
  const validEmailCodeSecret = (value) =>
    typeof value === "string" && Buffer.byteLength(value) >= 32;
  const mailConfigured = () => {
    if (!mailRuntime) return typeof mailSender === "function";
    try {
      return mailRuntime.status().configured === true;
    } catch {
      return false;
    }
  };
  if (mailConfigured() && !validEmailCodeSecret(emailCodeSecret))
    throw new Error(
      "Email code sender requires a persistent secret of at least 32 bytes",
    );
  let currentMailPassword = mailPassword;
  let mailSaveQueue = Promise.resolve();
  function serializeMailSave(task) {
    const job = mailSaveQueue.then(task, task);
    mailSaveQueue = job.catch(() => {});
    return job;
  }
  const emailEnabled = mailConfigured;
  if (
    ![accountQuotaBytes, cloudQuotaBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new Error("Cloud storage quotas must be positive byte counts");
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 20)
    throw new Error("Configure trusted origins explicitly");
  const trusted = new Set(
    origins.map((value) => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== value ||
        url.username ||
        url.password
      )
        throw new Error("Invalid canonical origin");
      return url.origin;
    }),
  );
  const db = openDatabase(dbPath, { initialize: initializeDatabase });
  const statements = new Map();
  const sql = (query) => {
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    return statements.get(query);
  };
  let closed = false;
  const mailJobs = new Set();

  function publicUser(row) {
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      role: row.role,
      disabled: !!row.disabled,
      email: row.email ?? null,
      emailVerified: !!row.email_verified,
      createdAt: row.created_at,
      membership: {
        active: !row.disabled,
        permanent: true,
        expiresAt: null,
      },
    };
  }
  const userById = (id) => sql("SELECT * FROM users WHERE id=?").get(id);
  function session(req) {
    const cookies = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith("wa_session="));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice("wa_session=".length);
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = sql(
      "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
    ).get(digest(token), now());
    if (!row) return null;
    if (row.user_id) {
      if(!Number.isSafeInteger(row.idle_expires_at)||row.idle_expires_at<=now())return null;
      const user = userById(row.user_id);
      if (!user || user.disabled) return null;
      row.user = user;
    }
    return row;
  }
  function requireSession(req) {
    const s = session(req);
    if (!s?.user) fail(401, "unauthorized", "Sign in required");
    return s;
  }
  function owner(req, s, required = false) {
    const expected = req.headers["x-account-id"];
    if (
      (required && !expected) ||
      (expected !== undefined && expected !== s?.user_id)
    )
      fail(409, "account_changed", "The current account has changed");
  }
  function csrf(req) {
    const s = session(req);
    if (!s || !equal(req.headers["x-csrf-token"], s.csrf))
      fail(403, "csrf", "Refresh the session and try again");
    owner(req, s);
    return s;
  }
  function admin(req, mutation = false) {
    const s = requireSession(req);
    if (s.user.role !== "admin") fail(403, "forbidden");
    if (
      mutation &&
      (s.reauth_at === null ||
        now() - s.reauth_at >= 300000 ||
        s.reauth_at > now())
    )
      fail(403, "reauth_required", "Verify your password again");
    return s;
  }
  function member(req) {
    const s = requireSession(req);
    owner(req, s, true);
    return s;
  }
  function cleanup() {
    sql(`INSERT INTO login_events(user_id,username,method,result,created_at) SELECT s.user_id,u.username,'session','timeout',MIN(s.expires_at,s.idle_expires_at) FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at<=? OR s.idle_expires_at<=?`).run(now(),now());
    sql('DELETE FROM sessions WHERE user_id IS NOT NULL AND idle_expires_at<=?').run(now());
    sql("DELETE FROM sessions WHERE expires_at<=?").run(now());
    sql('DELETE FROM login_events WHERE created_at<?').run(now()-90*DAY);
    sql('DELETE FROM login_events WHERE id IN (SELECT id FROM login_events ORDER BY id DESC LIMIT -1 OFFSET 10000)').run();
    sql("DELETE FROM reset_tokens WHERE expires_at<=?").run(now());
    sql("DELETE FROM rate_limits WHERE expires_at<=?").run(now());
    sql("DELETE FROM email_codes WHERE expires_at<=?").run(now());
  }
  function logLogin(userId,username,method,result){
    sql('INSERT INTO login_events(user_id,username,method,result,created_at) VALUES(?,?,?,?,?)').run(userId,username.slice(0,254),method,result,now());
  }
  function rate(
    req,
    kind,
    max,
    window = 15 * 60000,
    identity = "",
    scope = "ip",
  ) {
    // No forwarded header affects rate limiting or transport decisions.
    const key = digest(
      `${kind}:${scope === "ip" ? req.socket.remoteAddress || "unknown" : scope}:${identity}`,
    );
    const row = sql("SELECT * FROM rate_limits WHERE key=?").get(key);
    if (row && row.expires_at > now()) {
      if (row.count >= max)
        fail(429, "rate_limited", "Too many attempts", {
          retryAfter: Math.ceil((row.expires_at - now()) / 1000),
        });
      sql("UPDATE rate_limits SET count=count+1 WHERE key=?").run(key);
    } else {
      if (sql("SELECT COUNT(*) AS n FROM rate_limits").get().n >= 10000)
        fail(429, "rate_limited", "Rate limit storage full", {
          retryAfter: 900,
        });
      sql(
        "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at",
      ).run(key, now() + window);
    }
  }
  function newSession(req, res, userId = null) {
    const old = session(req),
      token = randomToken(),
      csrfToken = randomToken();
    const duration = userId ? 7 * DAY : 3600000;
    const rotate = () => {
      if (old)
        sql("DELETE FROM sessions WHERE token_hash=?").run(old.token_hash);
      if (userId)
        sql(
          "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, token_hash DESC LIMIT -1 OFFSET 9)",
        ).run(userId);
      if (sql("SELECT COUNT(*) AS n FROM sessions").get().n >= 10000)
        fail(503, "busy", "Session capacity reached");
      sql(
        "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,peer_hash,idle_expires_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        digest(token),
        userId,
        csrfToken,
        now() + duration,
        now(),
        digest(req.socket.remoteAddress || "unknown"),
        userId?now()+ACCOUNT_IDLE_MS:null,
        now(),
      );
      if(userId)logLogin(userId,userById(userId).username,req.url?.startsWith('/api/auth/login-code')?'email-code':req.url?.startsWith('/api/auth/register')?'register':'password','success');
    };
    // Registration already owns a transaction; login/bootstrap need their own.
    if (db.isTransaction) rotate();
    else transaction(db, rotate);
    res.setHeader(
      "Set-Cookie",
      `wa_session=${token}; Path=/; Max-Age=${Math.floor(duration / 1000)}; HttpOnly; ${secureCookies ? "Secure; " : ""}SameSite=Lax`,
    );
    return csrfToken;
  }
  function clearCookie(res) {
    res.setHeader(
      "Set-Cookie",
      `wa_session=; Path=/; Max-Age=0; HttpOnly; ${secureCookies ? "Secure; " : ""}SameSite=Lax`,
    );
  }
  function audit(actor, target, action, before, after) {
    sql(
      "INSERT INTO audit(actor_id,target_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      actor,
      target,
      action,
      JSON.stringify(before),
      JSON.stringify(after),
      now(),
    );
  }
  function dataset(url) {
    const values = url.searchParams.getAll("dataset");
    if (
      values.length !== 1 ||
      !validDataset(values[0]) ||
      [...url.searchParams.keys()].some((k) => k !== "dataset")
    )
      fail(400, "invalid_dataset");
    return values[0];
  }
  function datasetCapacity(userId, name) {
    const count = sql(
      "SELECT COUNT(*) AS n FROM (SELECT dataset FROM progress WHERE user_id=? UNION SELECT dataset FROM backups WHERE user_id=?)",
    ).get(userId, userId).n;
    const exists = sql(
      "SELECT 1 FROM progress WHERE user_id=? AND dataset=? UNION SELECT 1 FROM backups WHERE user_id=? AND dataset=? LIMIT 1",
    ).get(userId, name, userId, name);
    if (!exists && count >= 20)
      fail(413, "dataset_limit", "At most 20 cloud datasets per account");
  }
  function storageCapacity(userId, delta) {
    const usage = sql(
      "SELECT COALESCE(SUM(bytes),0) AS bytes FROM (SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM progress WHERE user_id=? UNION ALL SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM backups WHERE user_id=?)",
    ).get(userId, userId).bytes;
    if (usage + delta > accountQuotaBytes)
      fail(
        413,
        "storage_quota",
        "Cloud storage quota reached; download your backup and contact the administrator",
      );
    const total = sql(
      "SELECT COALESCE(SUM(bytes),0) AS bytes FROM (SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM progress UNION ALL SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM backups)",
    ).get().bytes;
    if (total + delta > cloudQuotaBytes)
      fail(
        413,
        "cloud_capacity",
        "Cloud storage capacity reached; existing data remains available",
      );
  }
  function checkCurrentPassword(req, initial) {
    const s = requireSession(req);
    if (
      s.token_hash !== initial.token_hash ||
      s.user.password_hash !== initial.user.password_hash
    )
      fail(401, "unauthorized");
    csrf(req);
    return s;
  }

  const emailUser = (email) =>
    sql("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
  const codeHash = (email, purpose, nonce, code) =>
    createHmac("sha256", emailCodeSecret)
      .update(JSON.stringify([email, purpose, nonce, code]))
      .digest("hex");
  function checkCode(email, purpose, code, expectedNonce) {
    const row = sql(
      "SELECT * FROM email_codes WHERE email=? AND purpose=?",
    ).get(email, purpose);
    if (
      !row ||
      !row.ready ||
      row.expires_at <= now() ||
      row.created_at > now() ||
      row.attempts >= 5 ||
      (expectedNonce && row.nonce !== expectedNonce)
    )
      fail(400, "invalid_code", "Invalid or expired email code");
    if (!equal(row.code_hash, codeHash(email, purpose, row.nonce, code))) {
      sql(
        "UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND purpose=? AND attempts<5",
      ).run(email, purpose);
      fail(400, "invalid_code", "Invalid or expired email code");
    }
    const user = emailUser(email);
    if (
      (purpose === "register" && user) ||
      (purpose === "login" &&
        (!user ||
          user.disabled ||
          !user.email_verified ||
          user.id !== row.user_id))
    )
      fail(400, "invalid_code", "Invalid or expired email code");
    return row;
  }
  function codeFields(body, registration = false) {
    fields(
      body,
      registration
        ? ["email", "code", "password", "nickname"]
        : ["email", "code"],
      registration ? ["email", "code", "password"] : ["email", "code"],
    );
    const email = normalizeEmail(body.email);
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code))
      fail(400, "invalid_code", "Invalid or expired email code");
    if (registration)
      credentials(
        {
          username: "email_account",
          password: body.password,
          ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        },
        true,
      );
    return email;
  }
  // The proof stays in page memory and is useful only with the same CSRF-bound
  // session and live challenge. Resending invalidates it; no schema migration.
  const proofSignature = (s, payload) => createHmac('sha256', emailCodeSecret)
    .update(JSON.stringify(['registration-proof-v1', s.token_hash, payload])).digest('hex');
  function registrationProof(req, email, token) {
    if (typeof token !== 'string' || token.length > 2048) fail(400, 'invalid_code');
    const parts = token.split('.');
    if (parts.length !== 2 || !equal(parts[1], proofSignature(csrf(req), parts[0]))) fail(400, 'invalid_code');
    let value;
    try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { fail(400, 'invalid_code'); }
    const row = sql("SELECT * FROM email_codes WHERE email=? AND purpose='register'").get(email);
    if (!value || value.email !== email || !row || !row.ready || row.attempts !== 5 ||
        row.nonce !== value.nonce || row.expires_at !== value.expiresAt || row.expires_at <= now() ||
        row.created_at > now() || emailUser(email)) fail(400, 'invalid_code');
    return row;
  }
  function revokeCodes(userId) {
    const email = userById(userId)?.email;
    for (const job of mailJobs) if (job.email === email) job.expired = true;
    sql(
      "DELETE FROM email_codes WHERE user_id=? OR email=(SELECT email FROM users WHERE id=?)",
    ).run(userId, userId);
  }

  function sendCode(req, body) {
    if (!emailEnabled())
      fail(503, "email_unavailable", "Email delivery is not configured");
    fields(body, ["email", "purpose"], ["email", "purpose"]);
    const email = normalizeEmail(body.email),
      purpose = body.purpose;
    if (!["register", "login"].includes(purpose)) fail(400, "invalid_purpose");
    const response = { ok: true, retryAfter: 60, expiresIn: 300 };
    transaction(db, () => {
      rate(req, "email_cooldown", 1, 60000, email, "email");
      rate(req, "email_hour", 5, 3600000, email, "email");
      rate(req, "email_ip", 20, 3600000);
      rate(req, "email_global", 200, 3600000, "", "global");
      // Every accepted resend invalidates the previous challenge, even if the
      // bounded background worker cannot admit this request.
      sql("DELETE FROM email_codes WHERE email=? AND purpose=?").run(
        email,
        purpose,
      );
    });
    for (const previous of mailJobs)
      if (previous.email === email && previous.purpose === purpose)
        previous.expired = true;
    // Neither admission nor HTTP latency depends on account eligibility or on
    // SMTP results. The response means "if eligible, attempt delivery", not sent.
    if (activeMailSends >= MAX_MAIL_SENDS) return response;
    const job = {
      email,
      purpose,
      nonce: randomToken(),
      timer: null,
      expired: false,
    };
    mailJobs.add(job);
    activeMailSends++;
    // setImmediate runs eligibility/SMTP only after handle has sent acceptance.
    setImmediate(async () => {
      const remove = () => {
        if (!closed)
          sql(
            "DELETE FROM email_codes WHERE email=? AND purpose=? AND nonce=?",
          ).run(email, purpose, job.nonce);
      };
      try {
        if (closed || job.expired) return;
        const user = emailUser(email);
        if (
          purpose === "register"
            ? !!user
            : !user || user.disabled || !user.email_verified
        )
          return;
        const code = String(randomInt(1000000)).padStart(6, "0"),
          created = now();
        sql(`INSERT INTO email_codes(email,purpose,nonce,code_hash,user_id,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(email,purpose) DO UPDATE SET nonce=excluded.nonce,
          code_hash=excluded.code_hash,user_id=excluded.user_id,attempts=0,ready=0,created_at=excluded.created_at,expires_at=excluded.expires_at`).run(
          email,
          purpose,
          job.nonce,
          codeHash(email, purpose, job.nonce, code),
          user?.id ?? null,
          created,
          created + 300000,
        );
        job.timer = setTimeout(() => {
          job.expired = true;
          // Cleanup failure still leaves ready=0; never expose errors or codes.
          try {
            remove();
          } catch {}
        }, 15000);
        job.timer.unref();
        await mailSender({ email, purpose, code });
        if (closed || job.expired) return;
        const current = emailUser(email);
        if (
          (purpose === "register" && current) ||
          (purpose === "login" &&
            (!current ||
              current.disabled ||
              !current.email_verified ||
              current.id !== user.id ||
              current.password_hash !== user.password_hash))
        ) {
          remove();
          return;
        }
        // Revocation/resend can remove this nonce during asynchronous delivery.
        sql(
          "UPDATE email_codes SET ready=1 WHERE email=? AND purpose=? AND nonce=? AND expires_at>?",
        ).run(email, purpose, job.nonce, now());
      } catch {
        try {
          remove();
        } catch {}
      } finally {
        clearTimeout(job.timer);
        mailJobs.delete(job);
        // Timed-out/non-cooperative senders hold a slot until they settle.
        activeMailSends--;
      }
    });
    return response;
  }

  function mailCandidate(body) {
    try {
      return normalizeMailConfig(body, {
        currentPassword: currentMailPassword || undefined,
      });
    } catch {
      fail(400, "invalid_mail_config", "邮件服务配置无效");
    }
  }

  function publicVerification(value) {
    if (
      !value ||
      value.ok !== true ||
      !Number.isFinite(value.elapsedMs) ||
      value.elapsedMs < 0
    )
      fail(422, "mail_verification_failed", "Email provider verification failed");
    return {
      ok: true,
      elapsedMs: Math.round(value.elapsedMs),
      ...(typeof value.tlsProtocol === "string" && value.tlsProtocol
        ? { tlsProtocol: value.tlsProtocol }
        : {}),
    };
  }

  async function route(req, res, url) {
    const path = url.pathname.replace(/^\/api\/account\//, "/api/member/"),
      method = req.method;
    if (method === "GET" && path === "/api/auth/session") {
      let s = session(req);
      if (!s) {
        rate(req, "anonymous", 100, 3600000);
        const csrfToken = newSession(req, res);
        return { user: null, csrfToken, enabled: true, emailEnabled: emailEnabled() };
      }
      return {
        user: s.user ? publicUser(s.user) : null,
        csrfToken: s.csrf,
        enabled: true,
        emailEnabled: emailEnabled(),
        idleExpiresAt:s.user?s.idle_expires_at:null,
        serverNow:now(),
      };
    }
    const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (write) {
      if (!trusted.has(req.headers.origin))
        fail(403, "origin", "Untrusted request origin");
      csrf(req);
      const auth =
        method === "POST" &&
        [
          "/api/auth/email-code",
          "/api/auth/register-verify",
          "/api/auth/username-availability",
          "/api/auth/login-code",
          "/api/auth/register",
          "/api/auth/login",
          "/api/auth/logout",
          "/api/auth/password",
          "/api/auth/reauth",
          "/api/auth/activity",
          "/api/auth/reset",
        ].includes(path);
      const certificateWrite=method==='POST'&&/^\/api\/admin\/certificate\/(stage|apply|rollback|automatic)$/.test(path);
      const mailWrite =
        method === "POST" &&
        (path === "/api/admin/mail" || path === "/api/admin/mail/test");
      const adminWrite =certificateWrite||mailWrite||
        method === "POST" &&
        /^\/api\/admin\/users\/[a-f0-9-]{36}\/(membership|status|reset)$/.test(
          path,
        );
      const cloudWrite =
        (method === "PUT" && path === "/api/member/progress") ||
        (method === "POST" && path === "/api/member/backups");
      if (!auth && !adminWrite && !cloudWrite)
        fail(404, "not_found", "Unknown API endpoint");
      if (adminWrite) admin(req, true);
      if (cloudWrite) {
        const s = member(req);
        dataset(url);
        rate(req, "upload_admission", 60, 60000, s.user_id);
      }
      if (auth && ["/api/auth/password", "/api/auth/reauth"].includes(path))
        requireSession(req);
    }
    const largeUpload =
      (method === "PUT" && path === "/api/member/progress") ||
      (method === "POST" && path === "/api/member/backups");
    const body = write
      ? await readBody(req, largeUpload ? MAX_BODY : path==='/api/admin/certificate/stage'?131072:AUTH_BODY_LIMIT)
      : null;
    // A request may have spent time streaming its body while another client
    // revoked this session. Recheck after every asynchronous boundary.
    if (write) csrf(req);

    if(method==='POST'&&path==='/api/auth/activity'){
      fields(body,[]);const s=requireSession(req);owner(req,s,true);
      const idleExpiresAt=Math.min(s.expires_at,now()+ACCOUNT_IDLE_MS);
      sql('UPDATE sessions SET idle_expires_at=?,last_activity_at=? WHERE token_hash=?').run(idleExpiresAt,now(),s.token_hash);
      return {idleExpiresAt,serverNow:now()};
    }

    if (method === 'POST' && path === '/api/auth/username-availability') {
      fields(body,['username'],['username']);
      if(typeof body.username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(body.username)) fail(400,'invalid_username','用户名须为3–32位英文字母、数字或下划线');
      rate(req,'username_availability',30,60000);
      const exists=name=>name.toLowerCase()==='admin'||!!sql('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name);
      const available=!exists(body.username), suggestions=[];
      if(!available) for(let attempt=0;attempt<30&&suggestions.length<3;attempt++){
        const name=body.username.slice(0,25)+'_'+randomInt(10000,100000);
        if(!suggestions.includes(name)&&!exists(name)) suggestions.push(name);
      }
      return {available,suggestions};
    }

    if (method === "POST" && path === "/api/auth/email-code")
      return sendCode(req, body);
    if (method === 'POST' && path === '/api/auth/register-verify') {
      if (!emailEnabled()) fail(503, 'email_unavailable');
      const email = codeFields(body);
      rate(req, 'email_verify', 30, 15 * 60000);
      // Keep failed-attempt updates outside the success transaction.
      const row = checkCode(email, 'register', body.code);
      const payload = Buffer.from(JSON.stringify({email, nonce:row.nonce, expiresAt:row.expires_at})).toString('base64url');
      const registrationToken = `${payload}.${proofSignature(csrf(req), payload)}`;
      sql("UPDATE email_codes SET attempts=5 WHERE email=? AND purpose='register' AND nonce=?").run(email, row.nonce);
      return {email, registrationToken, expiresAt:row.expires_at};
    }
    if (method === 'POST' && path === '/api/auth/register' && Object.hasOwn(body, 'registrationToken')) {
      if (!emailEnabled()) fail(503, 'email_unavailable');
      fields(body, ['email','registrationToken','password'], ['email','registrationToken','password']);
      const email = normalizeEmail(body.email);
      credentials({username:'email_account',password:body.password}, true);
      rate(req, 'email_verify', 30, 15 * 60000);
      registrationProof(req, email, body.registrationToken);
      const encoded = await hashPassword(body.password);
      csrf(req);
      return transaction(db, () => {
        registrationProof(req, email, body.registrationToken);
        const id = randomUUID();
        sql('INSERT INTO users(id,username,email,email_verified,nickname,password_hash,created_at) VALUES(?,?,?,1,?,?,?)')
          .run(id,email,email,'',encoded,now());
        sql("DELETE FROM email_codes WHERE email=? AND purpose='register'").run(email);
        return {user:publicUser(userById(id)),csrfToken:newSession(req,res,id)};
      });
    }
    if (
      method === "POST" &&
      (path === "/api/auth/login-code" ||
        (path === "/api/auth/register" && Object.hasOwn(body, "email")))
    ) {
      if (!emailEnabled())
        fail(503, "email_unavailable", "Email delivery is not configured");
      const register = path.endsWith("/register"),
        email = codeFields(body, register),
        purpose = register ? "register" : "login";
      rate(req, "email_verify", 30, 15 * 60000);
      let challenge;try{challenge=checkCode(email,purpose,body.code);}catch(error){if(!register)logLogin(emailUser(email)?.id??null,email,'email-code','failure');throw error;}
      const encoded = register ? await hashPassword(body.password) : null;
      csrf(req);
      return transaction(db, () => {
        checkCode(email, purpose, body.code, challenge.nonce);
        let user = emailUser(email);
        if (register) {
          const id = randomUUID();
          sql(
            "INSERT INTO users(id,username,email,email_verified,nickname,password_hash,created_at) VALUES(?,?,?,1,?,?,?)",
          ).run(id, email, email, body.nickname || "", encoded, now());
          user = userById(id);
        }
        sql(
          "DELETE FROM email_codes WHERE email=? AND purpose=? AND nonce=?",
        ).run(email, purpose, challenge.nonce);
        return {
          user: publicUser(user),
          csrfToken: newSession(req, res, user.id),
        };
      });
    }

    if (
      method === "POST" &&
      ["/api/auth/register", "/api/auth/login"].includes(path)
    ) {
      const register = path.endsWith("/register");
      let identifier;
      if (register) {
        credentials(body, true);
        identifier = body.username;
      } else {
        fields(body, ["username", "identifier", "password"], ["password"]);
        if (
          Object.hasOwn(body, "username") === Object.hasOwn(body, "identifier")
        )
          fail(400, "invalid_body");
        identifier = body.identifier ?? body.username;
        if (typeof identifier !== "string") fail(400, "invalid_body");
        if (identifier.includes("@")) identifier = normalizeEmail(identifier);
        else if (!/^[a-zA-Z0-9_]{3,32}$/.test(identifier))
          fail(400, "invalid_username");
        if (!validPasswordInput(body.password)) fail(400, "invalid_password");
      }
      rate(
        req,
        register ? "register" : "login",
        register ? 10 : 10,
        register ? 3600000 : 15 * 60000,
      );
      rate(req, "credential", 10, 15 * 60000, identifier.toLowerCase());
      if (register) {
        const encoded = await hashPassword(body.password);
        csrf(req);
        return transaction(db, () => {
          const id = randomUUID();
          try {
            sql(
              "INSERT INTO users(id,username,nickname,password_hash,created_at) VALUES(?,?,?,?,?)",
            ).run(id, body.username, body.nickname || "", encoded, now());
          } catch (error) {
            if (
              error.code?.startsWith("ERR_SQLITE") &&
              /UNIQUE/.test(error.message)
            )
              fail(409, "username_taken", "用户名已存在，请选择其他用户名");
            throw error;
          }
          return {
            user: publicUser(userById(id)),
            csrfToken: newSession(req, res, id),
          };
        });
      }
      const user = identifier.includes("@")
        ? sql(
            "SELECT * FROM users WHERE email=? COLLATE NOCASE AND email_verified=1",
          ).get(identifier)
        : sql("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(
            identifier,
          );
      const verified = await verifyPassword(body.password, user?.password_hash);
      csrf(req);
      const current = user && userById(user.id);
      if (
        !verified ||
        !current ||
        current.disabled ||
        current.password_hash !== user.password_hash
      ){
        logLogin(current?.id??null,current?.username??identifier,'password','failure');
        fail(401, "invalid_credentials", "Invalid username or password");
      }
      return {
        user: publicUser(current),
        csrfToken: newSession(req, res, current.id),
      };
    }
    if (method === "POST" && path === "/api/auth/logout") {
      fields(body, []);
      const s = csrf(req);
      if(s.user)logLogin(s.user_id,s.user.username,'session','logout');
      sql("DELETE FROM sessions WHERE token_hash=?").run(s.token_hash);
      clearCookie(res);
      return { ok: true };
    }
    if (
      method === "POST" &&
      ["/api/auth/password", "/api/auth/reauth"].includes(path)
    ) {
      const change = path.endsWith("/password");
      fields(
        body,
        change ? ["currentPassword", "password"] : ["password"],
        change ? ["currentPassword", "password"] : ["password"],
      );
      if (change && !validPassword(body.password))
        fail(400, "invalid_password", PASSWORD_ERROR);
      const s = requireSession(req);
      rate(req, change ? "password" : "reauth", 10, 15 * 60000, s.user_id);
      const verified = await verifyPassword(
        change ? body.currentPassword : body.password,
        s.user.password_hash,
      );
      checkCurrentPassword(req, s);
      if (!verified)
        fail(401, "invalid_credentials", "Invalid username or password");
      if (!change) {
        sql("UPDATE sessions SET reauth_at=? WHERE token_hash=?").run(
          now(),
          s.token_hash,
        );
        return { ok: true };
      }
      const encoded = await hashPassword(body.password);
      checkCurrentPassword(req, s);
      transaction(db, () => {
        sql("UPDATE users SET password_hash=? WHERE id=?").run(
          encoded,
          s.user_id,
        );
        sql("DELETE FROM sessions WHERE user_id=?").run(s.user_id);
        sql("DELETE FROM reset_tokens WHERE user_id=?").run(s.user_id);
        revokeCodes(s.user_id);
      });
      clearCookie(res);
      return { ok: true };
    }
    if (method === "POST" && path === "/api/auth/reset") {
      fields(body, ["token", "password"], ["token", "password"]);
      if (!validPassword(body.password)) fail(400, "invalid_password", PASSWORD_ERROR);
      if (
        typeof body.token !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.token)
      )
        fail(400, "invalid_reset", "Invalid or expired reset credential");
      rate(req, "reset", 10);
      const tokenHash = digest(body.token);
      const reset = sql(
        "SELECT * FROM reset_tokens WHERE token_hash=? AND expires_at>?",
      ).get(tokenHash, now());
      if (!reset || userById(reset.user_id)?.disabled)
        fail(400, "invalid_reset", "Invalid or expired reset credential");
      const encoded = await hashPassword(body.password);
      csrf(req);
      transaction(db, () => {
        const current = sql(
          "SELECT * FROM reset_tokens WHERE token_hash=? AND expires_at>?",
        ).get(tokenHash, now());
        if (!current || userById(current.user_id)?.disabled)
          fail(400, "invalid_reset", "Invalid or expired reset credential");
        sql("UPDATE users SET password_hash=? WHERE id=?").run(
          encoded,
          current.user_id,
        );
        sql("DELETE FROM sessions WHERE user_id=?").run(current.user_id);
        sql("DELETE FROM reset_tokens WHERE user_id=?").run(current.user_id);
        revokeCodes(current.user_id);
      });
      // Preserve the anonymous CSRF session so repeated invalid use is rejected
      // by the reset endpoint, without requiring another bootstrap first.
      if (session(req)?.user_id === reset.user_id) clearCookie(res);
      return { ok: true };
    }
    if (path.startsWith("/api/admin/")) {
      const s = admin(req, write);
      if (method === "GET" && path === "/api/admin/mail") {
        if (!mailRuntime)
          fail(503, "mail_unavailable", "邮件服务组件尚未就绪。");
        return publicMailStatus(mailRuntime.status());
      }
      if (
        method === "POST" &&
        (path === "/api/admin/mail/test" || path === "/api/admin/mail")
      ) {
        if (!mailRuntime)
          fail(503, "mail_unavailable", "邮件服务组件尚未就绪。");
        owner(req, s, true);
        const testing = path.endsWith("/test");
        rate(req, testing ? "mail_test" : "mail_save", 10, 60000, s.user_id);
        if (testing) {
          const candidate = mailCandidate(body);
          const before = publicMailStatus(mailRuntime.status());
          let result;
          try {
            result = publicVerification(await mailRuntime.verify(candidate));
          } catch {
            audit(s.user_id, s.user_id, "mail_test_failed", {}, {
              code: "mail_verification_failed",
            });
            fail(
              422,
              "mail_verification_failed",
              "Email provider verification failed",
            );
          }
          audit(s.user_id, s.user_id, "mail_test", before, {
            ...publicMailStatus(mailRuntime.status()),
            ...result,
          });
          return result;
        }

        if (!operations)
          fail(503, "mail_operation_failed", "邮件配置服务暂不可用，请稍后重试。");
        return serializeMailSave(async () => {
          const candidate = mailCandidate(body);
          const before = publicMailStatus(mailRuntime.status());
          const operationId = randomBytes(16).toString("hex");
          let prepared = null;
          const canPrepare =
            typeof mailRuntime.prepare === "function" &&
            typeof mailRuntime.activate === "function";
          if (canPrepare) {
            try {
              prepared = await mailRuntime.prepare(candidate);
            } catch {
              audit(s.user_id, s.user_id, "mail_save_prepare_failed", before, {
                code: "mail_prepare_failed",
              });
              fail(
                503,
                "mail_prepare_failed",
                "邮件服务配置未保存，运行时准备失败。",
              );
            }
          }
          const discardPrepared = () => {
            if (!prepared || typeof mailRuntime.discard !== "function") return;
            try {
              mailRuntime.discard(prepared);
            } catch {}
          };
          let stored;
          try {
            stored = await operations.request("mail-save", candidate, {
              operationId,
              actorId: s.user_id,
            });
          } catch {
            discardPrepared();
            audit(s.user_id, s.user_id, "mail_save_failed", before, {
              code: "mail_operation_failed",
            });
            fail(
              503,
              "mail_operation_failed",
              "邮件配置服务暂不可用，请稍后重试。",
            );
          }
          currentMailPassword = candidate.password;
          const persistedInactive = (code) => {
            discardPrepared();
            audit(
              s.user_id,
              s.user_id,
              "mail_save_activation_failed",
              before,
              {
                code,
                operationId,
                persisted: true,
                active: false,
              },
            );
            fail(
              503,
              "mail_activation_failed",
              "邮件服务配置已保存，但当前运行时尚未启用，请重试或重启服务。",
              { persisted: true, active: false },
            );
          };
          if (stored?.codeSecret !== undefined) {
            if (
              typeof stored.codeSecret !== "string" ||
              !/^[a-f0-9]{64}$/i.test(stored.codeSecret)
            ) {
              persistedInactive("mail_code_secret_invalid");
            }
            emailCodeSecret = stored.codeSecret;
          } else if (!validEmailCodeSecret(emailCodeSecret)) {
            persistedInactive("mail_code_secret_unavailable");
          }
          try {
            if (prepared) await mailRuntime.activate(prepared);
            else await mailRuntime.apply(candidate);
          } catch {
            persistedInactive("mail_activation_failed");
          }
          const after = publicMailStatus(mailRuntime.status());
          audit(s.user_id, s.user_id, "mail_save", before, {
            ...after,
            operationId,
          });
          return after;
        });
      }
      if(method==='GET'&&path==='/api/admin/logins'){
        const q=url.searchParams.get('q')||'',page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')??50);
        if(q.length>80||!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(limit)||limit<1||limit>50)fail(400,'invalid_query');
        const total=sql('SELECT COUNT(*) n FROM login_events WHERE instr(lower(username),lower(?))>0').get(q).n;
        return {events:sql('SELECT id,username,method,result,created_at AS createdAt FROM login_events WHERE instr(lower(username),lower(?))>0 ORDER BY id DESC LIMIT ? OFFSET ?').all(q,limit,(page-1)*limit),page,limit,pages:Math.max(1,Math.ceil(total/limit)),total};
      }
      if(method==='GET'&&path==='/api/admin/online'){
        const rows=sql(`SELECT u.id,u.username,u.nickname,u.role,COUNT(*) AS sessionCount,MAX(s.created_at) AS loggedInAt,MAX(s.last_activity_at) AS lastActivityAt,MAX(MIN(s.expires_at,s.idle_expires_at)) AS idleExpiresAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.disabled=0 AND s.expires_at>? AND s.idle_expires_at>? GROUP BY u.id ORDER BY lastActivityAt DESC LIMIT 1000`).all(now(),now());
        return {users:[...rows.map(row=>({...row,kind:'account',active:row.lastActivityAt>=now()-300000})),...listGuests().map(row=>({...row,active:row.lastActivityAt>=now()-300000}))],sampledAt:now(),activeWindowSeconds:300};
      }
      if(method==='GET'&&path==='/api/admin/overview'){
        if(!operations)fail(503,'operations_unavailable','运行监控组件尚未就绪。');return operations.overview();
      }
      if(method==='GET'&&path==='/api/admin/services')fail(410,'services_disabled','系统服务状态采集已停用。');
      if(method==='GET'&&path==='/api/admin/certificate'){
        if(!operations)fail(503,'operations_unavailable','运行监控组件尚未就绪。');return operations.request('certificate');
      }
      const certificateAction=method==='POST'&&path.match(/^\/api\/admin\/certificate\/(stage|apply|rollback|automatic)$/);
      if(certificateAction){
        if(!operations)fail(503,'operations_unavailable','证书组件尚未就绪。');
        const action=certificateAction[1];
        if(action==='stage'){fields(body,['certificatePem','privateKeyPem'],['certificatePem','privateKeyPem']);if(typeof body.certificatePem!=='string'||typeof body.privateKeyPem!=='string')fail(400,'invalid_certificate');}
        else if(action==='apply'){fields(body,['stageId'],['stageId']);if(!/^[a-f0-9]{32}$/.test(body.stageId))fail(400,'invalid_stage');}
        else fields(body,[]);
        rate(req,'certificate',10,60000,s.user_id);owner(req,s,true);
        const operationId=randomBytes(16).toString('hex');
        audit(s.user_id,s.user_id,'certificate_'+action+'_requested',{}, {operationId});
        const result=await operations.request(action,body,{operationId,actorId:s.user_id});
        audit(s.user_id,s.user_id,'certificate_'+action,{}, {fingerprint:result.certificate?.fingerprint256??null});
        return result;
      }
      if (method === "GET" && path === "/api/admin/users") {
        const q = url.searchParams.get("q") || "";
        if (q.length > 80) fail(400, "invalid_query");
        return {
          users: sql(
            "SELECT * FROM users WHERE instr(lower(username),lower(?))>0 OR instr(lower(nickname),lower(?))>0 ORDER BY created_at DESC,id LIMIT 200",
          )
            .all(q, q)
            .map(publicUser),
        };
      }
      if (method === "GET" && path === "/api/admin/audit"){
        let independent=[],operationWarning='';
        if(operations)try{const rows=await operations.request('events');independent=(rows.events??[]).map(row=>({id:'tls:'+row.id,actorId:row.actorId,targetId:row.actorId,action:'certificate_'+row.action+'_'+row.state,before:{},after:{operationId:row.id,fingerprint:row.fingerprint,state:row.state},createdAt:row.updatedAt}));}catch{operationWarning='证书独立审计暂不可用；requested 仅表示操作已提交，请检查当前证书确认结果。';}
        return {operationWarning,
          audit: [...sql("SELECT * FROM audit ORDER BY id DESC LIMIT 200")
            .all()
            .map((r) => ({
              id: r.id,
              actorId: r.actor_id,
              targetId: r.target_id,
              action: r.action,
              before: JSON.parse(r.before_json),
              after: JSON.parse(r.after_json),
              createdAt: r.created_at,
            })),...independent].sort((a,b)=>b.createdAt-a.createdAt).slice(0,200),
        };
      }
      const match = path.match(
        /^\/api\/admin\/users\/([a-f0-9-]{36})\/(membership|status|reset)$/,
      );
      if (method === "POST" && match) {
        rate(req, "admin", 100, 60000, s.user_id);
        const [, id, action] = match;
        return transaction(db, () => {
          const target = userById(id);
          if (!target) fail(404, "not_found");
          const before = publicUser(target);
          if (action === "membership") {
            fail(410, "membership_removed", "All enabled accounts are free");
          } else if (action === "status") {
            fields(body, ["disabled"], ["disabled"]);
            if (typeof body.disabled !== "boolean") fail(400, "invalid_status");
            if (
              body.disabled &&
              target.role === "admin" &&
              !target.disabled &&
              sql(
                "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0",
              ).get().n <= 1
            )
              fail(
                409,
                "last_admin",
                "Cannot disable the last active administrator",
              );
            sql("UPDATE users SET disabled=? WHERE id=?").run(
              body.disabled ? 1 : 0,
              id,
            );
            if (body.disabled) {
              sql("DELETE FROM sessions WHERE user_id=?").run(id);
              sql("DELETE FROM reset_tokens WHERE user_id=?").run(id);
              revokeCodes(id);
            }
          } else {
            fields(body, []);
            if (target.disabled) fail(409, "account_disabled");
            // Web administrators cannot reset another administrator and thereby
            // acquire that administrator identity; admin recovery is local CLI.
            if (target.role === "admin")
              fail(403, "local_admin_reset", "Use the local reset-admin CLI");
            revokeCodes(id);
            const token = randomToken(),
              expiresAt = now() + 30 * 60000;
            sql(
              "INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at",
            ).run(digest(token), id, expiresAt);
            audit(s.user_id, id, "reset", {}, { expiresAt });
            return { token, expiresAt };
          }
          const after = publicUser(userById(id));
          audit(s.user_id, id, action, before, after);
          return { user: after };
        });
      }
    }
    if (path.startsWith("/api/member/")) {
      const backupDownload = path.match(
        /^\/api\/member\/backups\/([a-f0-9-]{36})$/,
      );
      const s = member(req);
      if (method === "GET" && backupDownload) {
        const row = sql(
          "SELECT snapshot,version FROM backups WHERE id=? AND user_id=?",
        ).get(backupDownload[1], s.user_id);
        if (!row) fail(404, "not_found");
        return { snapshot: JSON.parse(row.snapshot), version: row.version };
      }
      if (["/api/member/progress", "/api/member/backups"].includes(path)) {
        const name = dataset(url);
        const current = () =>
          sql(
            "SELECT version,snapshot FROM progress WHERE user_id=? AND dataset=?",
          ).get(s.user_id, name);
        if (method === "GET" && path.endsWith("/progress")) {
          const row = current();
          return {
            version: row?.version || 0,
            snapshot: row ? JSON.parse(row.snapshot) : null,
          };
        }
        if (method === "PUT" && path.endsWith("/progress")) {
          fields(body, ["version", "snapshot"], ["version", "snapshot"]);
          if (
            !Number.isSafeInteger(body.version) ||
            body.version < 0 ||
            !validSnapshot(body.snapshot, name)
          )
            fail(400, "invalid_snapshot");
          rate(req, "cloud", 120, 60000, s.user_id);
          return transaction(db, () => {
            const row = current(),
              version = row?.version || 0;
            if (body.version !== version)
              fail(409, "conflict", "Cloud version changed", { version });
            datasetCapacity(s.user_id, name);
            const serialized = JSON.stringify(body.snapshot);
            storageCapacity(
              s.user_id,
              Buffer.byteLength(serialized) -
                (row ? Buffer.byteLength(row.snapshot) : 0),
            );
            sql(
              "INSERT INTO progress(user_id,dataset,version,snapshot,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,dataset) DO UPDATE SET version=excluded.version,snapshot=excluded.snapshot,updated_at=excluded.updated_at",
            ).run(s.user_id, name, version + 1, serialized, now());
            return { version: version + 1 };
          });
        }
        if (method === "GET" && path.endsWith("/backups"))
          return {
            backups: sql(
              "SELECT id,created_at AS createdAt,version FROM backups WHERE user_id=? AND dataset=? ORDER BY created_at DESC,rowid DESC LIMIT 3",
            ).all(s.user_id, name),
          };
        if (method === "POST" && path.endsWith("/backups")) {
          fields(body, ["snapshot"], ["snapshot"]);
          if (!validSnapshot(body.snapshot, name))
            fail(400, "invalid_snapshot");
          rate(req, "backup", 30, 3600000, s.user_id);
          return transaction(db, () => {
            datasetCapacity(s.user_id, name);
            const serialized = JSON.stringify(body.snapshot);
            const evicted = sql(
              "SELECT COALESCE(SUM(bytes),0) AS bytes FROM (SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM backups WHERE user_id=? AND dataset=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 2)",
            ).get(s.user_id, name).bytes;
            storageCapacity(s.user_id, Buffer.byteLength(serialized) - evicted);
            const id = randomUUID(),
              createdAt = now(),
              version = current()?.version || 0;
            sql(
              "INSERT INTO backups(id,user_id,dataset,version,snapshot,created_at) VALUES(?,?,?,?,?,?)",
            ).run(id, s.user_id, name, version, serialized, createdAt);
            sql(
              "DELETE FROM backups WHERE user_id=? AND dataset=? AND id NOT IN (SELECT id FROM backups WHERE user_id=? AND dataset=? ORDER BY created_at DESC,rowid DESC LIMIT 3)",
            ).run(s.user_id, name, s.user_id, name);
            return { id, createdAt, version };
          });
        }
      }
    }
    fail(404, "not_found", "Unknown API endpoint");
  }

  async function handle(req, res) {
    // Do not touch headers or consume bodies for the parent's static routes.
    if (typeof req.url !== "string" || !req.url.startsWith("/api/"))
      return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Cookie, Origin");
    const send = (status, data) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status);
        res.end(JSON.stringify(data));
      }
    };
    try {
      if (closed) fail(503, "unavailable");
      const host = req.headers.host;
      const encrypted = req.socket.encrypted === true;
      if (!host || !trusted.has(`${encrypted ? "https" : "http"}://${host}`))
        fail(403, "host", "Untrusted request host");
      const local =
        allowInsecureLocal &&
        loopback(req.socket.remoteAddress) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(`http://${host}`).hostname,
        );
      if (!encrypted && !local) {
        if (req.method === "GET" && req.url === "/api/auth/session") {
          send(200, {
            user: null,
            csrfToken: null,
            enabled: false,
            emailEnabled: false,
          });
          return true;
        }
        fail(426, "https_required", "HTTPS is required for accounts");
      }
      if (!secureCookies && !local) fail(503, "secure_cookies_required");
      if (req.headers.origin !== undefined && !trusted.has(req.headers.origin))
        fail(403, "origin");
      cleanup();
      send(
        200,
        await route(
          req,
          res,
          new URL(req.url, `${encrypted ? "https" : "http"}://${host}`),
        ),
      );
    } catch (error) {
      const status = error.status || 500;
      if (status === 429)
        res.setHeader("Retry-After", String(error.extra?.retryAfter || 900));
      const extra = { ...error.extra };
      delete extra.retryAfter;
      // Never include SQL, paths, request bodies, credentials or internal errors.
      send(status, {
        error: status === 500 ? "Account service error" : error.message,
        code: error.code && status !== 500 ? error.code : "internal_error",
        ...extra,
      });
    }
    return true;
  }
  return {
    handle,
    close() {
      if (!closed) {
        closed = true;
        for (const job of mailJobs) {
          clearTimeout(job.timer);
          sql(
            "DELETE FROM email_codes WHERE email=? AND purpose=? AND nonce=?",
          ).run(job.email, job.purpose, job.nonce);
        }
        db.close();
      }
    },
    db,
  };
}
