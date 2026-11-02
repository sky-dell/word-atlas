import nodemailer from "nodemailer";
import { normalizeEmail } from "./accounts.mjs";
import {
  mailConfigFromEnv,
  mailerOptions,
  normalizeMailConfig,
  resolvePublicSmtpTarget,
} from "./mail-config.mjs";

const MAX_ACTIVE_DELIVERIES = 4;

function statusOf(config) {
  if (!config) return { configured: false, secretConfigured: false };
  return {
    configured: true,
    host: config.host,
    port: config.port,
    security: config.security,
    user: config.user,
    from: config.from,
    fromName: config.fromName,
    secretConfigured: true,
  };
}

function publicMailError(code, message) {
  return Object.assign(new Error(message), { code });
}

function senderOf(config) {
  return config.fromName
    ? { name: config.fromName, address: config.from }
    : config.from;
}

export function createMailRuntime(
  initialConfig,
  {
    resolve = resolvePublicSmtpTarget,
    createTransport = nodemailer.createTransport,
  } = {},
) {
  let config = initialConfig ? normalizeMailConfig(initialConfig) : null;
  let active = null;
  let activePromise = null;
  let activeDeliveries = 0;
  let generation = 0;
  let closed = false;

  async function transportState(candidate) {
    const target = await resolve(candidate.host);
    const transport = createTransport(mailerOptions(candidate, target));
    return {
      config: candidate,
      transport,
      pending: 0,
      closing: false,
    };
  }

  function retire(state) {
    if (!state?.transport || state.closing) return;
    state.closing = true;
    if (state.pending === 0) closeTransport(state);
  }

  function closeTransport(state) {
    try {
      state.transport.close();
    } catch {
      // A retired transport must not change the outcome of a completed switch.
    }
  }

  async function ensureActive() {
    if (closed || !config) {
      throw publicMailError(
        "mail_unavailable",
        "Email delivery is unavailable",
      );
    }
    if (active?.transport && !active.closing) return active;
    if (!activePromise) {
      const requestedGeneration = generation;
      activePromise = transportState(config)
        .then((state) => {
          if (closed || requestedGeneration !== generation) {
            retire(state);
            throw publicMailError(
              "mail_unavailable",
              "Email delivery is unavailable",
            );
          }
          active = state;
          return state;
        })
        .catch(() => {
          if (requestedGeneration === generation) activePromise = null;
          throw publicMailError(
            "mail_unavailable",
            "Email delivery is unavailable",
          );
        });
    }
    return activePromise;
  }

  async function probe(candidate) {
    const state = await transportState(candidate);
    try {
      if (typeof state.transport.verify !== "function") {
        throw new Error("Transport verification is unavailable");
      }
      const verified = await state.transport.verify();
      if (verified === false) throw new Error("Transport verification failed");
      const tlsProtocol =
        typeof state.transport.getTlsProtocol === "function"
          ? state.transport.getTlsProtocol()
          : state.transport.tlsProtocol;
      return {
        ok: true,
        ...(typeof tlsProtocol === "string" && tlsProtocol
          ? { tlsProtocol }
          : {}),
      };
    } finally {
      state.transport.close();
    }
  }

  async function deliver(makeMessage) {
    const state = await ensureActive();
    if (closed || state.closing) {
      throw publicMailError(
        "mail_unavailable",
        "Email delivery is unavailable",
      );
    }
    if (activeDeliveries >= MAX_ACTIVE_DELIVERIES) {
      throw publicMailError("mail_busy", "Email delivery is busy");
    }
    activeDeliveries++;
    state.pending++;
    try {
      await state.transport.sendMail({
        from: senderOf(state.config),
        ...makeMessage(state.config),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch {
      throw new Error("Email delivery failed");
    } finally {
      activeDeliveries--;
      state.pending--;
      if (state.closing && state.pending === 0) closeTransport(state);
    }
  }

  return {
    status() {
      return statusOf(config);
    },
    async verify(input) {
      try {
        const candidate = normalizeMailConfig(input, {
          currentPassword: config?.password,
        });
        const startedAt = performance.now();
        const result = await probe(candidate);
        return {
          ...result,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } catch {
        throw publicMailError(
          "mail_verification_failed",
          "Email provider verification failed",
        );
      }
    },
    async apply(input) {
      if (closed) {
        throw publicMailError(
          "mail_unavailable",
          "Email provider update failed",
        );
      }
      let next;
      try {
        const candidate = normalizeMailConfig(input, {
          currentPassword: config?.password,
        });
        next = await transportState(candidate);
      } catch {
        throw publicMailError(
          "mail_apply_failed",
          "Email provider update failed",
        );
      }

      const previous = active;
      generation++;
      config = next.config;
      active = next;
      activePromise = Promise.resolve(next);
      retire(previous);
    },
    async sendCode({ email, purpose, code }) {
      if (!config || closed) {
        throw new Error("Email delivery is unavailable");
      }
      const to = normalizeEmail(email);
      if (
        !["register", "login"].includes(purpose) ||
        typeof code !== "string" ||
        !/^\d{6}$/.test(code)
      ) {
        throw new Error("Invalid email challenge");
      }
      const description = `您${purpose === "register" ? "注册" : "登录"}验证码是 ${code}，5 分钟内有效。请勿向他人透露。如非本人操作，请忽略此邮件。`;
      await deliver(() => ({
        to,
        subject:
          purpose === "register"
            ? "词与远方 · 邮箱注册验证码"
            : "词与远方 · 登录验证码",
        text: `词与远方 · Words & Beyond\n\n${description}`,
        html: `<div lang="zh-CN" style="font-family:Arial,'Microsoft YaHei','PingFang SC',sans-serif;color:#1b2034;line-height:1.8;font-size:20px;"><p style="margin:0 0 20px;font-size:22px;line-height:1.8;">词与远方 · Words &amp; Beyond</p><p style="margin:0;font-size:20px;line-height:1.8;">${description}</p></div>`,
      }));
    },
    async sendTest() {
      if (!config || closed) {
        throw new Error("Email delivery is unavailable");
      }
      await deliver((current) => ({
        to: current.from,
        subject: "词与远方邮件服务接入测试",
        text: "这是一封词与远方邮件服务接入测试邮件，用于确认邮件服务配置与投递。此邮件不是登录或注册验证码，不可用于账户验证。",
      }));
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      retire(active);
    },
  };
}

export function createMailerFromEnv(env = process.env, options) {
  const runtime = createMailRuntime(mailConfigFromEnv(env), options);
  return {
    get enabled() {
      return runtime.status().configured;
    },
    status: runtime.status,
    sendCode: runtime.sendCode,
    sendTest: runtime.sendTest,
    close: runtime.close,
  };
}
