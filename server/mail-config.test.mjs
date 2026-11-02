import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import {
  mailConfigFromEnv,
  mailEnvFile,
  mailerOptions,
  normalizeMailConfig,
  resolvePublicSmtpTarget,
} from "./mail-config.mjs";

const secret = "provider-authorization-code";
const base = {
  host: "SMTP.Example.COM",
  port: 465,
  security: "tls",
  user: "smtp-login@example.com",
  password: secret,
  from: "Sender@Example.COM",
  fromName: "Example Mail",
};

test("normalizes any TLS SMTP provider without exposing the password", () => {
  const config = normalizeMailConfig({
    ...base,
    host: "  SMTP.例子.测试  ",
    user: "  smtp-login@example.com  ",
    from: "  Sender@例子.测试  ",
    fromName: "  邮件发送者  ",
  });

  assert.deepEqual(config, {
    host: "smtp.xn--fsqu00a.xn--0zwm56d",
    port: 465,
    security: "tls",
    user: "smtp-login@example.com",
    password: secret,
    from: "Sender@xn--fsqu00a.xn--0zwm56d",
    fromName: "邮件发送者",
  });
  assert.deepEqual(Object.keys(config), [
    "host",
    "port",
    "security",
    "user",
    "password",
    "from",
    "fromName",
  ]);

  const submitted = "do-not-echo-this-secret";
  assert.throws(
    () => normalizeMailConfig({ ...base, password: submitted, from: "bad\r\nBcc:x@example.com" }),
    (error) => {
      assert.equal(error.code, "invalid_mail_config");
      assert.doesNotMatch(error.message, new RegExp(submitted));
      return true;
    },
  );
});

test("preserves sender local-part case while normalizing only the hostname", () => {
  const config = normalizeMailConfig({
    ...base,
    from: "Sender.Name+tag@例子.测试",
  });

  assert.equal(config.from, "Sender.Name+tag@xn--fsqu00a.xn--0zwm56d");
});

test("rejects malformed provider fields and CRLF injection", () => {
  const invalid = [
    { host: "smtp.example.com\r\nX-Injected: yes" },
    { host: "localhost" },
    { host: "smtp..example.com" },
    { host: "x".repeat(254) },
    { port: 0 },
    { port: 65536 },
    { port: 465.5 },
    { port: "465" },
    { security: "ssl" },
    { user: "smtp-user\nAUTH PLAIN injected" },
    { user: "x".repeat(321) },
    { from: "not-an-email" },
    { from: "sender@example.com\r\nBcc:victim@example.com" },
    {
      from: `${"a".repeat(64)}@${Array.from({ length: 6 }, () => "例".repeat(30)).join(".")}`,
    },
    { fromName: "Mail\r\nBcc:victim@example.com" },
    { fromName: "x".repeat(129) },
    { password: "secret\nAUTH PLAIN injected" },
    { password: "x".repeat(1025) },
  ];

  for (const patch of invalid) {
    assert.throws(
      () => normalizeMailConfig({ ...base, ...patch }),
      { code: "invalid_mail_config" },
      `must reject ${Object.keys(patch)[0]}`,
    );
  }
});

test("requires a password for first configuration but preserves an existing password", () => {
  assert.throws(
    () => normalizeMailConfig({ ...base, password: "" }),
    { code: "invalid_mail_config" },
  );
  assert.throws(
    () => normalizeMailConfig({ ...base, password: undefined }),
    { code: "invalid_mail_config" },
  );

  const preserved = normalizeMailConfig(
    { ...base, password: "" },
    { currentPassword: "existing-secret" },
  );
  assert.equal(preserved.password, "existing-secret");

  const replacement = normalizeMailConfig(base, {
    currentPassword: "existing-secret",
  });
  assert.equal(replacement.password, secret);
});

test("rejects non-TLS modes and insecure field shapes", () => {
  for (const input of [
    null,
    [],
    "smtp.example.com",
    new Date(),
    new Map(Object.entries(base)),
    { ...base, __proto__: { admin: true } },
    { ...base, extra: "not allowed" },
    { ...base, security: "plain" },
    { ...base, security: undefined },
    { ...base, user: { value: "smtp-login@example.com" } },
  ]) {
    assert.throws(
      () => normalizeMailConfig(input),
      { code: "invalid_mail_config" },
    );
  }

  assert.throws(
    () => normalizeMailConfig(base, { currentPassword: 7 }),
    { code: "invalid_mail_config" },
  );
  assert.throws(
    () => normalizeMailConfig(base, { extra: true }),
    { code: "invalid_mail_config" },
  );
});

test("serializes and re-parses generic SMTP environment configuration", () => {
  const starttls = normalizeMailConfig({
    ...base,
    host: "smtp.example.net",
    port: 587,
    security: "starttls",
    fromName: "Example Mail",
  });
  const codeSecret = "b".repeat(64);
  const source = mailEnvFile(starttls, codeSecret);
  const env = parseEnv(source);

  assert.deepEqual(Object.keys(env).sort(), [
    "MAIL_CODE_SECRET",
    "SMTP_FROM",
    "SMTP_FROM_NAME",
    "SMTP_HOST",
    "SMTP_PASS",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
  ]);
  assert.equal(env.SMTP_HOST, "smtp.example.net");
  assert.equal(env.SMTP_PORT, "587");
  assert.equal(env.SMTP_SECURE, "0");
  assert.equal(env.SMTP_PASS, secret);
  assert.equal(env.MAIL_CODE_SECRET, codeSecret);
  assert.deepEqual(mailConfigFromEnv(env), starttls);

  const implicitTls = parseEnv(mailEnvFile(normalizeMailConfig(base), codeSecret));
  assert.equal(implicitTls.SMTP_SECURE, "1");
  assert.deepEqual(
    mailConfigFromEnv({ ...implicitTls, SMTP_SECURE: "true" }),
    normalizeMailConfig(base),
  );
  const environmentLike = Object.create({});
  Object.assign(environmentLike, implicitTls);
  assert.deepEqual(mailConfigFromEnv(environmentLike), normalizeMailConfig(base));

  const withoutName = normalizeMailConfig({ ...base, fromName: "" });
  assert.deepEqual(
    mailConfigFromEnv(parseEnv(mailEnvFile(withoutName, codeSecret))),
    withoutName,
  );
  const special = normalizeMailConfig({
    ...base,
    password: 'authorization code # "quoted" \\ path',
    fromName: "O'Brien Mail",
  });
  assert.deepEqual(
    mailConfigFromEnv(parseEnv(mailEnvFile(special, codeSecret))),
    special,
  );
  assert.equal(mailConfigFromEnv({}), null);
  assert.equal(
    mailConfigFromEnv({ ...implicitTls, SMTP_PORT: "not-a-port" }),
    null,
  );
  assert.throws(
    () => mailEnvFile(starttls, "not-a-secret"),
    { code: "invalid_mail_config" },
  );
});

test("round-trips marker-prefixed environment values", () => {
  const marker = "__atlas_base64__:c2VjcmV0";
  const config = normalizeMailConfig({
    ...base,
    user: marker,
    password: marker,
    fromName: marker,
  });
  const env = parseEnv(mailEnvFile(config, "c".repeat(64)));

  assert.deepEqual(mailConfigFromEnv(env), config);
});

test("pins one validated public SMTP address", async () => {
  const calls = [];
  const target = await resolvePublicSmtpTarget("SMTP.Example.COM.", {
    resolve: async (host, options) => {
      calls.push({ host, ...options });
      return options.family === 4
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }];
    },
  });

  assert.deepEqual(target, {
    address: "93.184.216.34",
    family: 4,
    servername: "smtp.example.com",
  });
  assert.deepEqual(
    calls.map(({ host, family, all }) => ({ host, family, all })),
    [
      { host: "smtp.example.com", family: 4, all: true },
      { host: "smtp.example.com", family: 6, all: true },
    ],
  );

  const ipv6 = await resolvePublicSmtpTarget("smtp.example.com", {
    resolve: async (_host, options) =>
      options.family === 6
        ? [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]
        : [],
  });
  assert.deepEqual(ipv6, {
    address: "2606:2800:220:1:248:1893:25c8:1946",
    family: 6,
    servername: "smtp.example.com",
  });
});

test("rejects loopback private link-local multicast and unspecified addresses", async () => {
  const unsafe = [
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.16.0.1", 4],
    ["192.168.0.1", 4],
    ["169.254.169.254", 4],
    ["224.0.0.1", 4],
    ["0.0.0.0", 4],
    ["192.0.2.1", 4],
    ["::1", 6],
    ["fc00::1", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["::", 6],
    ["2001:db8::1", 6],
  ];

  for (const [address, family] of unsafe) {
    await assert.rejects(
      resolvePublicSmtpTarget("smtp.example.com", {
        resolve: async (_host, options) =>
          options.family === family ? [{ address, family }] : [],
      }),
      { code: "unsafe_smtp_endpoint" },
      `must reject ${address}`,
    );
  }

  await assert.rejects(
    resolvePublicSmtpTarget("smtp.example.com", {
      resolve: async (_host, options) =>
        options.family === 4
          ? [
              { address: "93.184.216.34", family: 4 },
              { address: "10.0.0.8", family: 4 },
            ]
          : [],
    }),
    { code: "unsafe_smtp_endpoint" },
    "one non-public result must reject the complete endpoint",
  );

  let resolved = false;
  await assert.rejects(
    resolvePublicSmtpTarget("localhost", {
      resolve: async () => {
        resolved = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }),
    { code: "unsafe_smtp_endpoint" },
  );
  assert.equal(resolved, false);
});

test("uses the provider hostname as TLS server name", () => {
  const target = {
    address: "93.184.216.34",
    family: 4,
    servername: "smtp.example.com",
  };
  const starttls = normalizeMailConfig({
    ...base,
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    fromName: "Example Mail",
  });
  const options = mailerOptions(starttls, target);

  assert.equal(options.host, "93.184.216.34");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.deepEqual(options.auth, {
    user: "smtp-login@example.com",
    pass: secret,
  });
  assert.equal(options.tls.servername, "smtp.example.com");
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.tls.minVersion, "TLSv1.2");
  assert.ok(options.connectionTimeout > 0);
  assert.ok(options.connectionTimeout <= 15000);
  assert.ok(options.greetingTimeout > 0);
  assert.ok(options.greetingTimeout <= 15000);
  assert.ok(options.socketTimeout > 0);
  assert.ok(options.socketTimeout <= 15000);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);

  const implicitTls = mailerOptions(
    normalizeMailConfig({ ...base, host: "smtp.example.com" }),
    target,
  );
  assert.equal(implicitTls.secure, true);
  assert.equal(implicitTls.requireTLS, false);
  assert.throws(
    () => mailerOptions(starttls, { ...target, family: 6 }),
    { code: "unsafe_smtp_endpoint" },
  );
  assert.throws(
    () => mailerOptions(starttls, { ...target, address: "10.0.0.1" }),
    { code: "unsafe_smtp_endpoint" },
  );
});
