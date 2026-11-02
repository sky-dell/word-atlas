import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, scryptSync } from "node:crypto";
import { createAccounts } from "./accounts.mjs";
import { hashPassword, verifyPassword, passwordWork } from "./passwords.mjs";
import { backupDatabase } from "./backup.mjs";

const PASSWORD = "Correct horse battery staple 1!";
const NEW_PASSWORD = "Another strong password here 2!";

test('public registration cannot claim the reserved administrator name',async t=>{
  const f=await fixture(t),c=f.client();await c.bootstrap();
  assert.equal((await c.request('/api/auth/register',post({username:'AdMiN',password:PASSWORD}))).status,409);
  const advice=await c.request('/api/auth/username-availability',post({username:'admin'}));assert.equal(advice.data.available,false);assert.equal(advice.data.suggestions.length,3);
});

test('operational routes are admin-only, certificate mutations require reauth and audit never contains key material',async t=>{
  const calls=[],operations={overview:async()=>({project:{uptimeSeconds:10}}),request:async(action,payload)=>{calls.push({action,payload});return action==='stage'?{stageId:'a'.repeat(32),certificate:{fingerprint256:'test-fingerprint'}}:{mode:'automatic'};}};
  const f=await fixture(t,{operations}),c=f.client();await c.register();
  for(const path of ['overview','services','certificate','online','logins'])assert.equal((await c.request('/api/admin/'+path)).status,403);
  const a=await f.admin();assert.equal((await a.request('/api/admin/overview')).data.project.uptimeSeconds,10);
  const body={certificatePem:'fixture-public',privateKeyPem:'fixture-SECRET-private-key'};
  assert.equal((await a.request('/api/admin/certificate/stage',post(body))).status,403);
  await reauthenticate(a);assert.equal((await a.request('/api/admin/certificate/stage',post(body))).status,200);
  assert.equal(calls.at(-1).action,'stage');assert.doesNotMatch(JSON.stringify((await a.request('/api/admin/audit')).data),/fixture-SECRET|fixture-public/);
});
test('disabled service catalog never calls the operational collector even for an administrator',async t=>{
  let calls=0;const f=await fixture(t,{operations:{overview:async()=>({}),request:async()=>{calls++;return {services:[]};}}}),a=await f.admin();
  const r=await a.request('/api/admin/services');assert.equal(r.status,410);assert.equal(r.data.code,'services_disabled');assert.equal(calls,0);
});
test('login history page size is bounded and selectable for compact viewports',async t=>{
  const f=await fixture(t),a=await f.admin();const insert=f.accounts.db.prepare("INSERT INTO login_events(user_id,username,method,result,created_at) VALUES(NULL,'paged','password','failure',?)");for(let i=0;i<12;i++)insert.run(Date.UTC(2026,9,28)+i);
  const r=await a.request('/api/admin/logins?q=paged&limit=3&page=2');assert.equal(r.data.events.length,3);assert.equal(r.data.pages,4);assert.equal(r.data.events[0].createdAt,Date.UTC(2026,9,28)+8);
  assert.equal((await a.request('/api/admin/logins?limit=0')).status,400);assert.equal((await a.request('/api/admin/logins?limit=51')).status,400);
});
test('login history records successful, failed, logout and timeout without credentials; online deduplicates sessions',async t=>{
  const f=await fixture(t),a=await f.admin(),c=f.client();await c.register('tracked');
  await c.request('/api/auth/logout',post({}));await c.login('tracked','Wrong password 1!');await c.login('tracked');
  const second=f.client();await second.login('tracked');
  const online=(await a.request('/api/admin/online')).data;
  const row=online.users.find(u=>u.username==='tracked');assert.equal(row.sessionCount,2);assert.equal(row.active,true);
  assert.doesNotMatch(JSON.stringify(online),/token_hash|peer_hash|csrf/);
  let history=(await a.request('/api/admin/logins?q=tracked')).data;assert.ok(history.events.some(e=>e.result==='failure'));assert.ok(history.events.some(e=>e.result==='success'));assert.ok(history.events.some(e=>e.result==='logout'));
  f.advance(120*60000);await c.bootstrap();await a.login('operator');history=(await a.request('/api/admin/logins?q=tracked')).data;
  assert.equal(history.events.filter(e=>e.result==='timeout').length,2);assert.doesNotMatch(JSON.stringify(history),/Wrong password|battery|token_hash|csrf/);
});
test('failed verified-email logins remain searchable by the canonical account name',async t=>{
  const f=await fixture(t),a=await f.admin(),c=f.client();await c.register('canonical_name');
  f.accounts.db.prepare('UPDATE users SET email=?,email_verified=1 WHERE id=?').run('linked@example.com',c.user.id);
  await c.request('/api/auth/logout',post({}));assert.equal((await c.login('linked@example.com','Wrong password 1!')).status,401);
  const history=(await a.request('/api/admin/logins?q=canonical_name')).data;assert.ok(history.events.some(e=>e.result==='failure'&&e.username==='canonical_name'));
});

test('account idle deadline expires at 120 minutes despite polling and keeps learning data',async t=>{
  const f=await fixture(t),c=f.client();await c.register('idle_owner');
  const id=c.user.id;
  await c.request('/api/account/progress?dataset=open',{method:'PUT',body:{version:0,snapshot:snapshot()}});
  f.advance(119*60000);assert.equal((await c.bootstrap()).data.user.id,id);
  f.advance(60000);assert.equal((await c.request('/api/account/progress?dataset=open')).status,401);
  assert.equal((await c.bootstrap()).data.user,null);
  f.restart();assert.equal((await c.login('idle_owner')).status,200);
  assert.equal((await c.request('/api/account/progress?dataset=open')).data.version,1);
});

test('authorized activity renews account idle deadline, invalid CSRF and expired sessions cannot renew',async t=>{
  const f=await fixture(t),c=f.client();await c.register('active_owner');
  f.advance(119*60000);
  assert.equal((await c.request('/api/auth/activity',post({}))).status,200);
  f.restart();f.advance(119*60000);assert.ok((await c.bootstrap()).data.user);
  assert.equal((await c.request('/api/auth/activity',post({}, {noCsrf:true}))).status,403);
  f.advance(60000);
  assert.ok((await c.request('/api/auth/activity',post({}))).status>=400);
  assert.equal((await c.bootstrap()).data.user,null);
});

test('legacy password login and current-password verification still work after policy upgrade',async t=>{
  const f=await fixture(t),c=f.client();const created=await c.register('legacy_policy');
  const password='correct horse battery staple',salt='0123456789abcdef0123456789abcdef';
  const key=scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:48*1024*1024});
  f.accounts.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(`scrypt$1$32768$8$1$${salt}$${key.toString('hex')}`,created.data.user.id);
  await c.request('/api/auth/logout',post({}));await c.bootstrap();
  assert.equal((await c.request('/api/auth/login',post({username:'legacy_policy',password}))).status,200);
  assert.equal((await c.request('/api/auth/password',post({currentPassword:password,password:'abcdef1!'}))).status,400);
  assert.equal((await c.request('/api/auth/password',post({currentPassword:password,password:'Abcdef1!'}))).status,200);
  await c.bootstrap();assert.equal((await c.request('/api/auth/login',post({username:'legacy_policy',password:'Abcdef1!'}))).status,200);
});

test('username and verified-email registration accept eight-character complex passwords and reject weak passwords',async t=>{
  const sent=[];const f=await fixture(t,{sendEmailCode:async m=>sent.push(m),emailCodeSecret:'s'.repeat(64)}),c=f.client();await c.bootstrap();
  for(const password of ['abcdef1!','ABCDEF1!','Abcdefg!','Abcdef12','Abcde1!']){
    assert.equal((await c.request('/api/auth/register',post({username:'new_policy',password}))).status,400);
  }
  const created=await c.request('/api/auth/register',post({username:'new_policy',password:'Abcdef1!'}));assert.equal(created.status,200);
  await c.request('/api/auth/logout',post({}));await c.bootstrap();
  const login=await c.request('/api/auth/login',post({identifier:'new_policy',password:'Abcdef1!'}));assert.equal(login.status,200);assert.equal(login.data.user.id,created.data.user.id);
  const other=f.client();await other.bootstrap();const email='new-policy@example.com';
  await other.request('/api/auth/email-code',post({email,purpose:'register'}));
  const verified=await other.request('/api/auth/register-verify',post({email,code:sent.at(-1).code}));assert.equal(verified.status,200);
  assert.equal((await other.request('/api/auth/register',post({email,registrationToken:verified.data.registrationToken,password:'abcdef12!'}))).status,400);
  assert.equal((await other.request('/api/auth/register',post({email,registrationToken:verified.data.registrationToken,password:'Zyxwvu2@'}))).status,200);
  await other.request('/api/auth/logout',post({}));await other.bootstrap();
  assert.equal((await other.request('/api/auth/login',post({identifier:email,password:'Zyxwvu2@'}))).status,200);
});

test('two-step registration verifies before password and binds single-use proof to session', async t => {
  const sent=[]; const f=await fixture(t,{sendEmailCode:async m=>sent.push(m),emailCodeSecret:'s'.repeat(64)});
  const c=f.client(), other=f.client(); await c.bootstrap(); await other.bootstrap();
  await c.request('/api/auth/email-code',post({email:'wizard@example.com',purpose:'register'}));
  const bad=await c.request('/api/auth/register-verify',post({email:'wizard@example.com',code:sent[0].code==='000000'?'111111':'000000'}));
  assert.equal(bad.status,400);
  assert.equal(f.accounts.db.prepare('SELECT attempts FROM email_codes').get().attempts,1);
  const verified=await c.request('/api/auth/register-verify',post({email:'wizard@example.com',code:sent[0].code}));
  assert.equal(verified.status,200); assert.equal(typeof verified.data.registrationToken,'string');
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  const body={email:'wizard@example.com',registrationToken:verified.data.registrationToken,password:PASSWORD};
  assert.equal((await other.request('/api/auth/register',post(body))).status,400);
  assert.equal((await c.request('/api/auth/register',post({...body,email:'changed@example.com'}))).status,400);
  assert.equal((await c.request('/api/auth/register',post({...body,registrationToken:body.registrationToken+'x'}))).status,400);
  assert.equal((await c.request('/api/auth/register',post({email:body.email,code:sent[0].code,password:PASSWORD}))).status,400);
  const result=await c.request('/api/auth/register',post(body)); assert.equal(result.status,200); assert.equal(result.data.user.emailVerified,true);
  assert.equal((await c.request('/api/auth/register',post(body))).status,400);
});

test('registration proof keeps original OTP expiry and is invalidated by resend',async t=>{
  const sent=[];const f=await fixture(t,{sendEmailCode:async m=>sent.push(m),emailCodeSecret:'s'.repeat(64)}),c=f.client();await c.bootstrap();
  const email='expiry@example.com',send=()=>c.request('/api/auth/email-code',post({email,purpose:'register'}));
  await send(); f.advance(240000);
  const v=await c.request('/api/auth/register-verify',post({email,code:sent[0].code}));assert.equal(v.status,200);
  f.advance(60000);
  assert.equal((await c.request('/api/auth/register',post({email,password:PASSWORD,registrationToken:v.data.registrationToken}))).status,400);
  await send();const v2=await c.request('/api/auth/register-verify',post({email,code:sent.at(-1).code}));assert.equal(v2.status,200);
  f.advance(60000);await send();
  assert.equal((await c.request('/api/auth/register',post({email,password:PASSWORD,registrationToken:v2.data.registrationToken}))).status,400);
  assert.equal((await c.request('/api/auth/register-verify',{...post({email,code:sent.at(-1).code}),noCsrf:true})).status,403);
});

test('registration proof survives restart and concurrent final requests create exactly one account',async t=>{
  const sent=[];const f=await fixture(t,{sendEmailCode:async m=>sent.push(m),emailCodeSecret:'s'.repeat(64)}),c=f.client();await c.bootstrap();
  const email='race-proof@example.com';await c.request('/api/auth/email-code',post({email,purpose:'register'}));
  const v=await c.request('/api/auth/register-verify',post({email,code:sent[0].code}));assert.equal(v.status,200);f.restart();
  const body={email,password:PASSWORD,registrationToken:v.data.registrationToken};
  const results=await Promise.all([c.request('/api/auth/register',post(body)),c.request('/api/auth/register',post(body))]);
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.ok(results.every(r=>[200,400,403].includes(r.status)));
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM email_codes').get().n,0);
});
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

test('username availability checks case-insensitive names, safe suggestions and CSRF', async t=>{
  const f=await fixture(t), owner=f.client();await owner.register('Existing_Name');
  const a=f.client();await a.bootstrap();
  const ask=name=>a.request('/api/auth/username-availability',{method:'POST',body:{username:name}});
  const r=await ask('existing_name');assert.equal(r.status,200);assert.equal(r.data.available,false);
  assert.equal(r.data.suggestions.length,3);assert.equal(new Set(r.data.suggestions).size,3);
  for(const name of r.data.suggestions){assert.match(name,/^[a-zA-Z0-9_]{3,32}$/);assert.equal((await ask(name)).data.available,true);}
  assert.equal((await ask('x')).status,400);
  assert.equal((await a.request('/api/auth/username-availability',{method:'POST',body:{username:'abc'},noCsrf:true})).status,403);
  assert.equal((await a.request('/api/auth/register',{method:'POST',body:{username:'EXISTING_NAME',password:PASSWORD}})).status,409);
});
test('availability is rate limited and concurrent registration cannot reserve a duplicate name',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await a.bootstrap();await b.bootstrap();
  for(let i=0;i<30;i++)assert.equal((await a.request('/api/auth/username-availability',{method:'POST',body:{username:'unique_name'}})).status,200);
  assert.equal((await a.request('/api/auth/username-availability',{method:'POST',body:{username:'unique_name'}})).status,429);
  const register=c=>c.request('/api/auth/register',{method:'POST',body:{username:'race_name',password:PASSWORD}});
  assert.deepEqual((await Promise.all([register(a),register(b)])).map(r=>r.status).sort(),[200,409]);
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
function mailRuntimeDouble({ configured = true, secret = "existing-provider-secret" } = {}) {
  const runtime = {
    calls: [],
    verifyError: null,
    currentStatus: configured
      ? {
          configured: true,
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          user: "sender@example.com",
          from: "sender@example.com",
          fromName: "Words & Beyond",
          secretConfigured: true,
          password: secret,
        }
      : { configured: false, secretConfigured: false },
    status() {
      return this.currentStatus;
    },
    async verify(input) {
      this.calls.push({ type: "verify", input });
      if (this.verifyError) throw this.verifyError;
      return { ok: true, elapsedMs: 37, tlsProtocol: "TLSv1.3" };
    },
    async apply(input) {
      this.calls.push({ type: "apply", input });
      this.currentStatus = {
        configured: true,
        host: input.host,
        port: input.port,
        security: input.security,
        user: input.user,
        from: input.from,
        fromName: input.fromName,
        secretConfigured: true,
        password: input.password,
      };
    },
    async sendCode() {},
    close() {},
  };
  return runtime;
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

test("mail status is admin-only and never exposes the secret", async (t) => {
  const secret = "status-provider-secret";
  const runtime = mailRuntimeDouble({ configured: false, secret });
  const f = await fixture(t, {
    mailRuntime: runtime,
    mailPassword: secret,
    emailCodeSecret: "s".repeat(64),
  });
  const member = f.client();
  await member.register("mail_member");
  assert.equal((await member.request("/api/admin/mail")).status, 403);

  const admin = await f.admin();
  assert.equal((await admin.bootstrap()).data.emailEnabled, false);
  runtime.currentStatus = {
    configured: true,
    host: "smtp.example.com",
    port: 465,
    security: "tls",
    user: "sender@example.com",
    from: "sender@example.com",
    fromName: "Words & Beyond",
    secretConfigured: true,
    password: secret,
  };
  assert.equal((await admin.bootstrap()).data.emailEnabled, true);

  const response = await admin.request("/api/admin/mail");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    configured: true,
    host: "smtp.example.com",
    port: 465,
    security: "tls",
    user: "sender@example.com",
    from: "sender@example.com",
    fromName: "Words & Beyond",
    secretConfigured: true,
  });
  assert.doesNotMatch(JSON.stringify(response.data), new RegExp(secret));
});

test("mail test and save require CSRF and recent reauthentication", async (t) => {
  const runtime = mailRuntimeDouble();
  const f = await fixture(t, {
    mailRuntime: runtime,
    mailPassword: "existing-provider-secret",
    emailCodeSecret: "s".repeat(64),
  });
  const admin = await f.admin();
  const candidate = {
    host: "mail.example.net",
    port: 465,
    security: "tls",
    user: "candidate@example.net",
    from: "candidate@example.net",
    fromName: "Candidate Sender",
  };

  for (const path of ["/api/admin/mail/test", "/api/admin/mail"]) {
    const response = await admin.request(path, post(candidate));
    assert.equal(response.status, 403);
    assert.equal(response.data.code, "reauth_required");
  }

  await reauthenticate(admin);
  for (const path of ["/api/admin/mail/test", "/api/admin/mail"]) {
    const response = await admin.request(path, post(candidate, { noCsrf: true }));
    assert.equal(response.status, 403);
    assert.equal(response.data.code, "csrf");
  }
  assert.equal(
    (
      await admin.request(
        "/api/admin/mail/test",
        post(candidate, { headers: { Origin: "https://untrusted.example" } }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await admin.request(
        "/api/admin/mail/test",
        post(candidate, { noOwner: true }),
      )
    ).status,
    409,
  );

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await admin.request(
      "/api/admin/mail/test",
      post(candidate),
    );
    assert.equal(response.status, 200);
    if (attempt === 0)
      assert.deepEqual(response.data, {
        ok: true,
        elapsedMs: 37,
        tlsProtocol: "TLSv1.3",
      });
  }
  assert.equal(
    (await admin.request("/api/admin/mail/test", post(candidate))).status,
    429,
  );
});

test("mail save delegates the complete normalized provider to the restricted helper and audits without the password", async (t) => {
  const secret = "existing-provider-secret";
  const runtime = mailRuntimeDouble({ secret });
  const helperCalls = [];
  let rejectSave = false;
  const operations = {
    request: async (action, payload, context) => {
      helperCalls.push({ action, payload, context });
      if (action === "events") return { events: [] };
      if (action !== "mail-save") throw new Error("unexpected action");
      if (rejectSave)
        throw Object.assign(new Error(`helper rejected ${secret}`), {
          status: 503,
          code: "mail_operation_failed",
        });
      return {
        configured: true,
        host: "mail.example.net",
        port: 465,
        security: "tls",
        user: "Candidate@Example.NET",
        from: "Candidate@example.net",
        fromName: "Candidate Sender",
        secretConfigured: true,
      };
    },
  };
  const f = await fixture(t, {
    mailRuntime: runtime,
    mailPassword: secret,
    operations,
    emailCodeSecret: "s".repeat(64),
  });
  const admin = await f.admin();
  await reauthenticate(admin);

  const body = {
    host: " Mail.Example.NET. ",
    port: 465,
    security: "tls",
    user: " Candidate@Example.NET ",
    from: " Candidate@Example.NET ",
    fromName: " Candidate Sender ",
  };
  const response = await admin.request("/api/admin/mail", post(body));
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    configured: true,
    host: "mail.example.net",
    port: 465,
    security: "tls",
    user: "Candidate@Example.NET",
    from: "Candidate@example.net",
    fromName: "Candidate Sender",
    secretConfigured: true,
  });

  const save = helperCalls.find((call) => call.action === "mail-save");
  assert.deepEqual(save.payload, {
    host: "mail.example.net",
    port: 465,
    security: "tls",
    user: "Candidate@Example.NET",
    password: secret,
    from: "Candidate@example.net",
    fromName: "Candidate Sender",
  });
  assert.match(save.context.operationId, /^[a-f0-9]{32}$/);
  assert.equal(save.context.actorId, admin.user.id);
  assert.deepEqual(runtime.calls, [{ type: "apply", input: save.payload }]);
  assert.doesNotMatch(JSON.stringify(response.data), new RegExp(secret));

  const auditResponse = await admin.request("/api/admin/audit");
  const savedAudit = auditResponse.data.audit.find(
    (row) => row.action === "mail_save",
  );
  assert.ok(savedAudit);
  assert.equal(savedAudit.after.operationId, save.context.operationId);
  assert.doesNotMatch(JSON.stringify(savedAudit), new RegExp(secret));
  assert.doesNotMatch(
    JSON.stringify(f.accounts.db.prepare("SELECT * FROM audit").all()),
    new RegExp(secret),
  );

  rejectSave = true;
  const failed = await admin.request(
    "/api/admin/mail",
    post({ ...body, host: "other.example.net" }),
  );
  assert.equal(failed.status, 503);
  assert.equal(runtime.calls.filter((call) => call.type === "apply").length, 1);
  assert.equal(runtime.currentStatus.host, "mail.example.net");
  assert.doesNotMatch(JSON.stringify(failed.data), new RegExp(secret));
  const failedAudit = (
    await admin.request("/api/admin/audit")
  ).data.audit.find((row) => row.action === "mail_save_failed");
  assert.ok(failedAudit);
  assert.doesNotMatch(JSON.stringify(failedAudit), new RegExp(secret));
});

test("mail test failure leaves status unchanged", async (t) => {
  const secret = "candidate-verification-secret";
  const runtime = mailRuntimeDouble({ secret: "active-provider-secret" });
  runtime.verifyError = new Error(`SMTP rejected ${secret}`);
  const f = await fixture(t, {
    mailRuntime: runtime,
    mailPassword: "active-provider-secret",
    emailCodeSecret: "s".repeat(64),
  });
  const admin = await f.admin();
  await reauthenticate(admin);
  const before = (await admin.request("/api/admin/mail")).data;
  const response = await admin.request(
    "/api/admin/mail/test",
    post({
      host: "mail.example.net",
      port: 465,
      security: "tls",
      user: "candidate@example.net",
      password: secret,
      from: "candidate@example.net",
      fromName: "Candidate Sender",
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(response.data.code, "mail_verification_failed");
  assert.doesNotMatch(JSON.stringify(response.data), new RegExp(secret));
  assert.deepEqual(
    (await admin.request("/api/admin/mail")).data,
    before,
  );
  assert.equal(runtime.calls.filter((call) => call.type === "apply").length, 0);
  const audit = (await admin.request("/api/admin/audit")).data.audit.find(
    (row) => row.action === "mail_test_failed",
  );
  assert.ok(audit);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(secret));
});

test("mail-disabled accounts start without a code secret and a later save enables email delivery", async (t) => {
  const codeSecret = "a1".repeat(32);
  const runtime = mailRuntimeDouble({ configured: false });
  runtime.sent = [];
  runtime.sendCode = async (message) => runtime.sent.push(message);
  const helperCalls = [];
  const operations = {
    request: async (action, payload, context) => {
      helperCalls.push({ action, payload, context });
      if (action !== "mail-save") throw new Error("unexpected action");
      return {
        configured: true,
        host: "mail.example.net",
        port: 465,
        security: "tls",
        user: "sender@example.net",
        from: "sender@example.net",
        fromName: "Mail Sender",
        secretConfigured: true,
        codeSecret,
      };
    },
  };
  const f = await fixture(t, { mailRuntime: runtime, operations });
  const anonymous = f.client();
  const initial = await anonymous.bootstrap();
  assert.equal(initial.status, 200);
  assert.equal(initial.data.emailEnabled, false);

  const admin = await f.admin();
  await reauthenticate(admin);
  const saved = await admin.request(
    "/api/admin/mail",
    post({
      host: "mail.example.net",
      port: 465,
      security: "tls",
      user: "sender@example.net",
      password: "first-provider-secret",
      from: "sender@example.net",
      fromName: "Mail Sender",
    }),
  );
  assert.equal(saved.status, 200);
  assert.equal(helperCalls.filter((call) => call.action === "mail-save").length, 1);
  assert.equal((await admin.bootstrap()).data.emailEnabled, true);
  assert.equal((await anonymous.bootstrap()).data.emailEnabled, true);
  assert.doesNotMatch(JSON.stringify(saved.data), new RegExp(codeSecret));
  assert.doesNotMatch(
    JSON.stringify(f.accounts.db.prepare("SELECT * FROM audit").all()),
    new RegExp(codeSecret),
  );

  const signup = f.client();
  await signup.bootstrap();
  const accepted = await signup.request(
    "/api/auth/email-code",
    post({ email: "fresh@example.com", purpose: "register" }),
  );
  assert.equal(accepted.status, 200);
  await waitFor(() => runtime.sent.length === 1);
  assert.match(runtime.sent[0].code, /^\d{6}$/);
  const registered = await signup.request(
    "/api/auth/register",
    post({
      email: "fresh@example.com",
      code: runtime.sent[0].code,
      password: PASSWORD,
    }),
  );
  assert.equal(registered.status, 200);
  assert.doesNotMatch(JSON.stringify(registered.data), new RegExp(codeSecret));
});

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
  assert.equal((await c.bootstrap()).data.user,null);
  const session = await c.login();
  const other = f.client();
  const loggedIn = await other.login();
  f.advance(86400000);
  f.restart();
  assert.equal((await other.bootstrap()).data.user,null);
  const laterSession = await other.login();
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
    "DROP TABLE email_codes; DROP INDEX users_email; ALTER TABLE users DROP COLUMN email; ALTER TABLE users DROP COLUMN email_verified; ALTER TABLE sessions DROP COLUMN idle_expires_at; ALTER TABLE sessions DROP COLUMN last_activity_at; DROP TABLE login_events; PRAGMA user_version=1;",
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
    4,
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
      4,
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
  f.accounts.db.exec("PRAGMA user_version=4");
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
