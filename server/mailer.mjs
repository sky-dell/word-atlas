import nodemailer from "nodemailer";
import { normalizeEmail } from "./accounts.mjs";

const SENDER = "sz_allen@126.com";
export function createMailerFromEnv(env = process.env) {
  const enabled =
    env.SMTP_HOST === "smtp.126.com" &&
    env.SMTP_PORT === "465" &&
    ["1", "true"].includes(env.SMTP_SECURE) &&
    env.SMTP_USER === SENDER &&
    env.SMTP_FROM === SENDER &&
    typeof env.SMTP_PASS === "string" &&
    env.SMTP_PASS.length > 0 &&
    typeof env.MAIL_CODE_SECRET === "string" &&
    /^[a-f0-9]{64}$/i.test(env.MAIL_CODE_SECRET);
  const transport = enabled
    ? nodemailer.createTransport({
        host: "smtp.126.com",
        port: 465,
        secure: true,
        auth: { user: SENDER, pass: env.SMTP_PASS },
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      })
    : null;
  let closed = false,
    active = 0;
  async function deliver(message) {
    if (!enabled || closed) throw new Error("Email delivery is unavailable");
    if (active >= 4) throw new Error("Email delivery is busy");
    active++;
    try {
      await transport.sendMail({
        from: SENDER,
        ...message,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch {
      throw new Error("Email delivery failed");
    } finally {
      active--;
    }
  }
  return {
    enabled: !!enabled,
    async sendCode({ email, purpose, code }) {
      if (!enabled || closed) throw new Error("Email delivery is unavailable");
      const to = normalizeEmail(email);
      if (
        !["register", "login"].includes(purpose) ||
        typeof code !== "string" ||
        !/^\d{6}$/.test(code)
      )
        throw new Error("Invalid email challenge");
      const description = `您${purpose === "register" ? "注册" : "登录"}验证码是 ${code}，5 分钟内有效。请勿向他人透露。如非本人操作，请忽略此邮件。`;
      await deliver({
        to,
        subject:
          purpose === "register"
            ? "词与远方 · 邮箱注册验证码"
            : "词与远方 · 登录验证码",
        text: `词与远方 · Words & Beyond\n\n${description}`,
        html: `<div lang="zh-CN" style="font-family:Arial,'Microsoft YaHei','PingFang SC',sans-serif;color:#1b2034;line-height:1.8;font-size:20px;"><p style="margin:0 0 20px;font-size:22px;line-height:1.8;">词与远方 · Words &amp; Beyond</p><p style="margin:0;font-size:20px;line-height:1.8;">${description}</p></div>`,
      });
    },
    // Trusted local configuration probe only; deliberately not an auth code.
    async sendTest() {
      await deliver({
        to: SENDER,
        subject: "词与远方邮件服务接入测试",
        text: "这是一封词与远方邮件服务接入测试邮件，用于确认邮件服务配置与投递。此邮件不是登录或注册验证码，不可用于账户验证。",
      });
    },
    close() {
      if (!closed) {
        closed = true;
        transport?.close();
      }
    },
  };
}
