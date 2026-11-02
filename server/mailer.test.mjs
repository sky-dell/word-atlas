import { test, mock } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createMailerFromEnv } from "./mailer.mjs";

const env = {
  SMTP_HOST: "smtp.126.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "1",
  SMTP_USER: "sz_allen@126.com",
  SMTP_FROM: "sz_allen@126.com",
  SMTP_PASS: "fake-local-only",
  MAIL_CODE_SECRET: "a".repeat(64),
};
test("mailer disables incomplete configuration without sending", async () => {
  const m = createMailerFromEnv({});
  assert.equal(m.enabled, false);
  await assert.rejects(
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
  );
  m.close();
});
test("mailer enforces TLS, fixed sender, safe recipient and bounded transport without protocol logs", async (t) => {
  let options,
    delivery,
    closed = 0;
  const transport = {
    sendMail: async (m) => {
      delivery = m;
    },
    close: () => {
      closed++;
    },
  };
  mock.method(nodemailer, "createTransport", (o) => {
    options = o;
    return transport;
  });
  t.after(() => mock.restoreAll());
  const m = createMailerFromEnv(env);
  assert.equal(m.enabled, true);
  assert.equal(options.host, "smtp.126.com");
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.ok(options.connectionTimeout <= 15000);
  assert.ok(options.socketTimeout <= 15000);
  await m.sendCode({
    email: "Recipient@example.com",
    purpose: "register",
    code: "000001",
  });
  assert.equal(delivery.from, "sz_allen@126.com");
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
  assert.equal(closed, 1);
  await assert.rejects(
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
  );
  assert.equal(
    createMailerFromEnv({ ...env, SMTP_FROM: "other@example.com" }).enabled,
    false,
  );
});

test("trusted CLI mail test has a fixed self recipient and no authentication code; shares capacity and safe failures", async (t) => {
  const pending = [];
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: (message) =>
      new Promise((resolve, reject) => {
        pending.push({ message, resolve, reject });
      }),
    close() {},
  }));
  t.after(() => mock.restoreAll());
  const m = createMailerFromEnv(env);
  assert.equal(typeof m.sendTest, "function");
  const requests = [
    m.sendTest(),
    m.sendTest(),
    m.sendCode({ email: "a@example.com", purpose: "login", code: "000001" }),
    m.sendTest(),
  ];
  await assert.rejects(m.sendTest(), /busy/);
  const first = pending[0].message;
  assert.equal(first.from, "sz_allen@126.com");
  assert.equal(first.to, "sz_allen@126.com");
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
