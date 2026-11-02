#!/usr/bin/env node
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readMailStore, writeMailStore } from "../server/mail-store.mjs";
import { promptPassword } from "./admin.mjs";

function publicStatus(config) {
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

async function secureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error("配置目录必须由root所有且不能由其他用户写入。");
  }
}

export async function saveMailConfiguration({
  directory = "/etc/word-atlas",
  config,
  replace = false,
}) {
  const dir = resolve(directory);
  await secureDirectory(dir);
  const file = join(dir, "mail.env");
  const current = await readMailStore(file);
  if (current && !replace) {
    throw new Error("已有邮件配置；如需替换请明确使用 --replace。");
  }
  await writeMailStore(file, config);
  return { file, status: publicStatus(await readMailStore(file)) };
}

function interactiveTerminal() {
  const input = process.stdin;
  const output = process.stderr;
  if (
    !input.isTTY ||
    !output.isTTY ||
    typeof input.setRawMode !== "function"
  ) {
    throw new Error("邮件配置仅支持主机上的交互终端。");
  }
}

async function promptText(label) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    return (await terminal.question(label)).trim();
  } finally {
    terminal.close();
  }
}

async function promptMailConfig() {
  const host = await promptText("SMTP 主机：");
  const port = Number(await promptText("SMTP 端口："));
  const security = (await promptText("安全模式（tls/starttls）：")).toLowerCase();
  const user = await promptText("SMTP 登录账号：");
  let password = await promptPassword("SMTP 授权码（不回显）：");
  try {
    const from = await promptText("发件邮箱：");
    const fromName = await promptText("发件人名称（可留空）：");
    return { host, port, security, user, password, from, fromName };
  } finally {
    password = "";
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length && !(args.length === 1 && args[0] === "--replace")) {
    throw new Error("仅支持可选的 --replace；SMTP授权码不能通过参数或管道传入。");
  }
  if (process.getuid?.() !== 0) {
    throw new Error("请以root身份在主机交互终端运行。");
  }
  interactiveTerminal();
  let config;
  try {
    config = await promptMailConfig();
    const result = await saveMailConfiguration({
      config,
      replace: args.includes("--replace"),
    });
    console.log(
      `已为 ${result.status.user} 保存root私有邮件配置（未输出授权码）。请告知录入完成；待功能部署后生效。`,
    );
  } finally {
    if (config) config.password = "";
    config = null;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
