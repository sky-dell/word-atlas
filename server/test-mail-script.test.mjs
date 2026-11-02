import { test } from "node:test";
import assert from "node:assert/strict";
import { runTestMail } from "../scripts/test-mail.mjs";

test("fallback mail test reports the configured sender without exposing the credential", async () => {
  const output = [];
  const errors = [];
  let sent = false;
  let receivedEnv = null;
  await runTestMail({
    file: "/fixture/mail.env",
    inspect: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o100600,
    }),
    read: async () =>
      [
        "SMTP_HOST=smtp.example.com",
        "SMTP_PORT=465",
        "SMTP_SECURE=1",
        "SMTP_USER=sender@example.com",
        "SMTP_PASS=fallback-mail-secret",
        "SMTP_FROM=sender@example.com",
        "SMTP_FROM_NAME=Example Sender",
        "",
      ].join("\n"),
    createMailer: (env) => {
      receivedEnv = env;
      return {
        enabled: true,
        status: () => ({
          configured: true,
          from: env.SMTP_FROM,
          secretConfigured: true,
        }),
        async sendTest() {
          sent = true;
        },
        close() {},
      };
    },
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(sent, true);
  assert.equal(receivedEnv.SMTP_FROM, "sender@example.com");
  assert.match(output.join("\n"), /sender@example\.com/);
  assert.doesNotMatch(output.join("\n"), /126|fallback-mail-secret/);
  assert.deepEqual(errors, []);
});

test("fallback mail test failure stays provider-neutral and hides transport text", async () => {
  const output = [];
  const errors = [];
  await runTestMail({
    file: "/fixture/mail.env",
    inspect: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o100600,
    }),
    read: async () => "SMTP_PASS=failure-mail-secret\n",
    createMailer: () => ({
      enabled: true,
      status: () => ({ configured: true, from: "sender@example.com" }),
      async sendTest() {
        throw new Error("sensitive SMTP diagnostic failure-mail-secret");
      },
      close() {},
    }),
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
  });

  assert.deepEqual(output, []);
  assert.match(errors.join("\n"), /邮件接入测试失败/);
  assert.doesNotMatch(
    errors.join("\n"),
    /126|failure-mail-secret|SMTP diagnostic/,
  );
});
