#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { createMailerFromEnv } from "../server/mailer.mjs";

export const TEST_MAIL_FAILURE_MESSAGE =
  "邮件接入测试失败；未输出授权码或SMTP协议内容。请检查配置、TLS连接和发信限制。";

export function testMailSuccessMessage(sender) {
  return `SMTP已接受发往 ${sender} 的接入测试邮件（不含登录验证码）。请检查收件箱或垃圾邮件；SMTP接受不等同于已送达收件箱。`;
}

export async function runTestMail({
  file = "/etc/word-atlas/mail.env",
  inspect = lstat,
  read = readFile,
  createMailer = createMailerFromEnv,
  log = (message) => console.log(message),
  error = (message) => console.error(message),
} = {}) {
  let mailer;
  try {
    const info = await inspect(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Private mail configuration permissions are invalid.");
    const env = parseEnv(await read(file, "utf8"));
    mailer = createMailer(env);
    if (!mailer.enabled) throw new Error("Mail configuration is incomplete.");
    const sender = mailer.status()?.from;
    if (typeof sender !== "string" || !sender)
      throw new Error("Sender missing.");
    await mailer.sendTest();
    log(testMailSuccessMessage(sender));
    return true;
  } catch {
    error(TEST_MAIL_FAILURE_MESSAGE);
    return false;
  } finally {
    try {
      mailer?.close();
    } catch {}
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.getuid?.() !== 0)
    throw new Error("Please run as root on the host.");
  if (!(await runTestMail())) process.exitCode = 1;
}
