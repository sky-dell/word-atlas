import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailerFromEnv, createMailRuntime } from "./mailer.mjs";
import { normalizeMailConfig } from "./mail-config.mjs";

const env = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "0",
  SMTP_USER: "sender@example.com",
  SMTP_FROM: "Sender@example.com",
  SMTP_FROM_NAME: "Words & Beyond",
  SMTP_PASS: "fake-local-only",
  MAIL_CODE_SECRET: "a".repeat(64),
};

const activeConfig = normalizeMailConfig({
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "sender@example.com",
  password: "active-provider-secret",
  from: "Sender@example.com",
  fromName: "Words & Beyond",
});

const candidateConfig = normalizeMailConfig({
  host: "mail.example.net",
  port: 465,
  security: "tls",
  user: "candidate@example.net",
  password: "candidate-provider-secret",
  from: "Candidate@example.net",
  fromName: "Candidate Sender",
});

function runtimeDoubles({ verifyError, applyError } = {}) {
  const transports = [];
  const messages = [];
  return {
    transports,
    messages,
    options: {
      resolve: async (host) => ({
        address: host === candidateConfig.host ? "93.184.216.35" : "93.184.216.34",
        family: 4,
        servername: host,
      }),
      createTransport: (transportOptions) => {
        if (applyError && transportOptions.auth.user === candidateConfig.user) {
          throw applyError;
        }
        const transport = {
          transportOptions,
          closed: 0,
          async verify() {
            if (verifyError) throw verifyError;
          },
          async sendMail(message) {
            messages.push(message);
          },
          close() {
            this.closed++;
          },
        };
        transports.push(transport);
        return transport;
      },
    },
  };
}

test("verifies a candidate provider without replacing the active provider", async () => {
  const doubles = runtimeDoubles();
  const runtime = createMailRuntime(activeConfig, doubles.options);
  const before = runtime.status();

  await runtime.verify(candidateConfig);

  assert.deepEqual(runtime.status(), before);
  assert.equal(doubles.transports.length, 1);
  assert.equal(doubles.transports[0].transportOptions.host, "93.184.216.35");
  assert.equal(doubles.transports[0].transportOptions.requireTLS, false);
  assert.equal(doubles.transports[0].closed, 1);
  runtime.close();
});

test("applies a verified provider and changes enabled status immediately", async () => {
  const doubles = runtimeDoubles();
  const runtime = createMailRuntime(activeConfig, doubles.options);
  const stableSendCode = runtime.sendCode;

  await runtime.verify(candidateConfig);
  await runtime.apply(candidateConfig);
  const status = runtime.status();

  assert.equal(status.configured, true);
  assert.equal(status.host, candidateConfig.host);
  assert.equal(status.port, candidateConfig.port);
  assert.equal(status.security, candidateConfig.security);
  assert.equal(status.user, candidateConfig.user);
  assert.equal(status.from, candidateConfig.from);
  assert.equal(status.fromName, candidateConfig.fromName);
  assert.equal(status.secretConfigured, true);
  assert.ok(!("password" in status));

  await stableSendCode({
    email: "recipient@example.com",
    purpose: "login",
    code: "123456",
  });
  assert.equal(doubles.messages.length, 1);
  assert.equal(doubles.messages[0].from.address, candidateConfig.from);
  assert.equal(doubles.messages[0].from.name, candidateConfig.fromName);
  assert.equal(doubles.messages[0].to, "recipient@example.com");
  runtime.close();
});

test("keeps the active provider when verification or apply fails", async () => {
  const doubles = runtimeDoubles({
    applyError: new Error(`transport rejected ${candidateConfig.password}`),
  });
  const runtime = createMailRuntime(activeConfig, doubles.options);
  const before = runtime.status();

  await runtime.sendCode({
    email: "first@example.com",
    purpose: "login",
    code: "111111",
  });
  const activeTransport = doubles.transports[0];
  doubles.options.resolve = async () => {
    throw new Error("candidate lookup failed");
  };
  await assert.rejects(runtime.verify(candidateConfig));
  assert.deepEqual(runtime.status(), before);
  assert.equal(activeTransport.closed, 0);

  doubles.options.resolve = runtimeDoubles().options.resolve;
  await assert.rejects(runtime.verify(candidateConfig));
  await assert.rejects(
    runtime.apply(candidateConfig),
    (error) =>
      error instanceof Error &&
      !error.message.includes(candidateConfig.password),
  );
  assert.deepEqual(runtime.status(), before);
  assert.equal(activeTransport.closed, 0);

  await runtime.sendCode({
    email: "second@example.com",
    purpose: "login",
    code: "222222",
  });
  assert.equal(doubles.messages.at(-1).to, "second@example.com");
  assert.equal(doubles.messages.at(-1).from.address, activeConfig.from);
  runtime.close();
});

test("does not let an in-flight initial transport replace a newly applied provider", async () => {
  let releaseInitial;
  const initialGate = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  const doubles = runtimeDoubles();
  const resolve = doubles.options.resolve;
  doubles.options.resolve = async (host) => {
    if (host === activeConfig.host) await initialGate;
    return resolve(host);
  };
  const runtime = createMailRuntime(activeConfig, doubles.options);

  const initialSend = runtime.sendCode({
    email: "first@example.com",
    purpose: "login",
    code: "111111",
  });
  await runtime.verify(candidateConfig);
  await runtime.apply(candidateConfig);
  releaseInitial();
  await assert.rejects(initialSend, /unavailable/);
  const current = runtime.status();
  assert.equal(current.host, candidateConfig.host);
  assert.equal(current.user, candidateConfig.user);

  await runtime.sendCode({
    email: "second@example.com",
    purpose: "login",
    code: "222222",
  });
  assert.equal(doubles.messages.at(-1).from.address, candidateConfig.from);
  runtime.close();
});

test("does not report failure after a provider switch because the old close failed", async () => {
  const doubles = runtimeDoubles();
  const createTransport = doubles.options.createTransport;
  doubles.options.createTransport = (transportOptions) => {
    const transport = createTransport(transportOptions);
    if (transportOptions.auth.user === activeConfig.user) {
      transport.close = () => {
        throw new Error(`close leaked ${activeConfig.password}`);
      };
    }
    return transport;
  };
  const runtime = createMailRuntime(activeConfig, doubles.options);
  await runtime.sendCode({
    email: "first@example.com",
    purpose: "login",
    code: "111111",
  });

  await runtime.verify(candidateConfig);
  await runtime.apply(candidateConfig);
  assert.equal(runtime.status().host, candidateConfig.host);
  await runtime.sendCode({
    email: "second@example.com",
    purpose: "login",
    code: "222222",
  });
  assert.equal(doubles.messages.at(-1).from.address, candidateConfig.from);
  runtime.close();
});

test('verification emails contain only the brand and purpose-specific code with large HTML text', async () => {
  const doubles = runtimeDoubles();
  const mailer = createMailerFromEnv(env, doubles.options);
  try {
    for (const [purpose, label, code] of [['register', '注册', '294659'], ['login', '登录', '000007']]) {
      await mailer.sendCode({email:'recipient@example.com',purpose,code});
      const message = doubles.messages.at(-1);
      const sentence = `您${label}验证码是 ${code}，5 分钟内有效。请勿向他人透露。如非本人操作，请忽略此邮件。`;
      assert.equal(message.text, `词与远方 · Words & Beyond\n\n${sentence}`);
      assert.equal(typeof message.html, 'string');
      assert.match(message.html, /font-size:\s*20px/);
      assert.match(message.html, /font-size:\s*22px/);
      assert.match(message.html, /词与远方 · Words &amp; Beyond/);
      assert.ok(message.html.includes(sentence));
      assert.equal((message.html.match(/<p\b/g)||[]).length, 2);
      assert.doesNotMatch(message.text + message.html, /多懂一个词|多看一点世界/);
    }
  } finally { mailer.close(); }
});
test("mailer disables incomplete configuration without sending", async () => {
  const m = createMailerFromEnv({});
  assert.equal(m.enabled, false);
  await assert.rejects(
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
  );
  m.close();
});
test("mailer enforces TLS, fixed sender, safe recipient and bounded transport without protocol logs", async () => {
  const doubles = runtimeDoubles();
  const m = createMailerFromEnv(env, doubles.options);
  assert.equal(m.enabled, true);
  await m.sendCode({
    email: "Recipient@example.com",
    purpose: "register",
    code: "000001",
  });
  const options = doubles.transports[0].transportOptions;
  const delivery = doubles.messages[0];
  assert.equal(options.host, "93.184.216.34");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.servername, "smtp.example.com");
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.tls.minVersion, "TLSv1.2");
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.ok(options.connectionTimeout <= 15000);
  assert.ok(options.socketTimeout <= 15000);
  assert.deepEqual(delivery.from, {
    name: "Words & Beyond",
    address: "Sender@example.com",
  });
  assert.equal(delivery.to, "recipient@example.com");
  assert.ok(delivery.text.includes("000001"));
  assert.ok(delivery.text.includes("5"));
  assert.match(delivery.subject, /词与远方/);
  assert.match(delivery.text, /Words & Beyond/);
  await assert.rejects(
    m.sendCode({
      email: "evil@example.com\r\nBcc:other@example.com",
      purpose: "login",
      code: "000001",
    }),
  );
  await assert.rejects(
    m.sendCode({ email: "a@example.com", purpose: "reset", code: "000001" }),
  );
  m.close();
  m.close();
  assert.equal(doubles.transports[0].closed, 1);
  await assert.rejects(
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
  );
  assert.equal(
    createMailerFromEnv({ ...env, SMTP_FROM: "other@example.com" }).enabled,
    true,
  );
});

test("trusted CLI mail test has a fixed self recipient and no authentication code; shares capacity and safe failures", async (t) => {
  const pending = [];
  const options = {
    resolve: async (host) => ({
      address: "93.184.216.34",
      family: 4,
      servername: host,
    }),
    createTransport: () => ({
      sendMail: (message) =>
        new Promise((resolve, reject) => {
          pending.push({ message, resolve, reject });
        }),
      close() {},
    }),
  };
  const m = createMailerFromEnv(env, options);
  assert.equal(typeof m.sendTest, "function");
  const requests = [
    m.sendTest(),
    m.sendTest(),
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
    m.sendTest(),
  ];
  await assert.rejects(m.sendTest(), /busy/);
  const first = pending[0].message;
  assert.deepEqual(first.from, {
    name: "Words & Beyond",
    address: "Sender@example.com",
  });
  assert.equal(first.to, "Sender@example.com");
  assert.equal(first.subject, "词与远方邮件服务接入测试");
  assert.ok(!/\d{6}/.test(first.text));
  assert.ok(first.text.includes("不是登录或注册验证码"));
  assert.deepEqual(pending[1].message, first);
  assert.deepEqual(pending[3].message, first);
  pending[0].reject(new Error("sensitive smtp credential diagnostic"));
  for (const item of pending.slice(1)) item.resolve();
  const results = await Promise.allSettled(requests);
  assert.equal(results[0].reason.message, "Email delivery failed");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  m.close();
  await assert.rejects(m.sendTest(), /unavailable/);
  await assert.rejects(createMailerFromEnv({}).sendTest(), /unavailable/);
});
