import http from "node:http";
import { randomBytes } from "node:crypto";
import { normalizeMailConfig } from "./mail-config.mjs";
import { writeMailStore } from "./mail-store.mjs";

const actions = new Set([
  "certificate",
  "events",
  "stage",
  "apply",
  "rollback",
  "automatic",
  "auto-install",
  "mail-save",
]);
const mailKeys = [
  "host",
  "port",
  "security",
  "user",
  "password",
  "from",
  "fromName",
];
const validCodeSecret = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

function mailStatus(config) {
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

export function createHelperServer({
  manager,
  journal,
  mailFile = "/etc/word-atlas/mail.env",
  mailStore = writeMailStore,
}) {
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(value));
      }
    };
    if (req.method !== "POST" || req.url !== "/") {
      send(405, { error: "不支持的操作。" });
      return;
    }
    if (active >= 4) {
      send(503, { error: "操作繁忙，请稍后重试。" });
      return;
    }
    active++;
    let operation = null;
    let committed = false;
    let mailAction = false;
    let result;
    try {
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > 140000) throw { status: 413 };
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 140000) throw { status: 413 };
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw { status: 400 };
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !["action", "payload", "context"].includes(key),
        ) ||
        !actions.has(body.action)
      ) {
        throw { status: 400 };
      }
      const { action, payload = {} } = body;
      mailAction = action === "mail-save";
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw { status: 400 };
      }
      const keys = Object.keys(payload);
      let normalizedMail;
      if (action === "stage") {
        if (
          keys.length !== 2 ||
          keys.some(
            (key) => !["certificatePem", "privateKeyPem"].includes(key),
          ) ||
          typeof payload.certificatePem !== "string" ||
          typeof payload.privateKeyPem !== "string"
        ) {
          throw { status: 400 };
        }
      } else if (action === "apply") {
        if (keys.length !== 1 || !/^[a-f0-9]{32}$/.test(payload.stageId)) {
          throw { status: 400 };
        }
      } else if (action === "mail-save") {
        if (
          keys.length !== mailKeys.length ||
          keys.some((key) => !mailKeys.includes(key))
        ) {
          throw { status: 400 };
        }
        normalizedMail = normalizeMailConfig(payload);
      } else if (keys.length) {
        throw { status: 400 };
      }
      if (
        body.context !== undefined &&
        (!body.context ||
          typeof body.context !== "object" ||
          Array.isArray(body.context) ||
          Object.keys(body.context).length !== 2 ||
          !/^[a-f0-9]{32}$/.test(body.context.operationId) ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(body.context.actorId))
      ) {
        throw { status: 400 };
      }
      if (action === "events") {
        send(200, { events: journal?.list() ?? [] });
        return;
      }
      const method = { certificate: "status", "auto-install": "autoInstall" }[
        action
      ] || action;
      if (action !== "certificate") {
        if (!journal) throw { status: 503 };
        operation = {
          id: body.context?.operationId ?? randomBytes(16).toString("hex"),
          actorId: body.context?.actorId ?? "system",
          action,
        };
        journal.start(operation);
      }
      if (action === "mail-save") {
        const stored = await mailStore(mailFile, normalizedMail);
        committed = true;
        result = {
          ...mailStatus(normalizedMail),
          ...(validCodeSecret(stored?.codeSecret)
            ? { codeSecret: stored.codeSecret }
            : {}),
        };
      } else {
        result = await manager[method](payload);
        committed = true;
      }
      if (operation) {
        journal.finish(
          operation.id,
          "success",
          result.certificate?.fingerprint256,
        );
      }
      send(200, result);
    } catch (error) {
      if (committed && operation?.action === "mail-save" && result) {
        // The atomic mail file is authoritative once committed. A later
        // journal failure must not report the provider change as failed.
        send(200, result);
        return;
      }
      if (operation) {
        try {
          journal.finish(
            operation.id,
            operation.action === "mail-save" ||
              (operation.action === "stage" && !committed)
              ? "failure"
              : "uncertain",
            null,
          );
        } catch {
          // The durable admission remains visible if outcome persistence fails.
        }
      }
      const status = [400, 403, 404, 409, 410, 413, 422, 429, 503].includes(
        error.status,
      )
        ? error.status
        : 400;
      send(status, {
        error:
          status === 413
            ? "上传文件过大。"
            : mailAction
              ? "邮件配置未保存，请检查SMTP字段、TLS连接与文件权限。"
              : "操作未完成，请检查证书域名、有效期、完整证书链与私钥配对，或稍后重试。",
        code: mailAction ? "mail_save_failed" : "operation_rejected",
      });
    } finally {
      active--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  server.keepAliveTimeout = 1000;
  return server;
}
