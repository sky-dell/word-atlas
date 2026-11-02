import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

const INVALID_CONFIG = "Invalid mail configuration";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const HOST_MAX = 253;
const PORT_MIN = 1;
const PORT_MAX = 65535;
const USER_MAX = 320;
const PASSWORD_MAX = 1024;
const FROM_MAX = 254;
const FROM_NAME_MAX = 128;
const ENV_VALUE_PREFIX = "__atlas_base64__:";
const CONFIG_KEYS = ["host", "port", "security", "user", "password", "from", "fromName"];
const TRANSPORT_TIMEOUT_MS = 15000;

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

const PUBLIC_IPV6 = new BlockList();
PUBLIC_IPV6.addSubnet("2000::", 3, "ipv6");
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

function invalid() {
  throw Object.assign(new Error(INVALID_CONFIG), { code: "invalid_mail_config" });
}

function unsafeEndpoint() {
  throw Object.assign(new Error("SMTP endpoint must be public"), {
    code: "unsafe_smtp_endpoint",
  });
}

function recordObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainObject(value) {
  if (!recordObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowed) {
  if (!plainObject(value) || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.entries(descriptors).every(
    ([key, descriptor]) =>
      allowed.includes(key) &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, "value"),
  );
}

function stringValue(value, max, { trim = true, allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalid();
  }
  const normalized = trim ? value.trim() : value;
  if (!allowEmpty && normalized.length === 0) invalid();
  return normalized;
}

function normalizeHost(value) {
  let host = stringValue(value, HOST_MAX).replace(/\.$/u, "");
  if (
    !host ||
    isIP(host) ||
    host.toLowerCase() === "localhost" ||
    host.toLowerCase().endsWith(".localhost")
  ) {
    invalid();
  }
  const ascii = domainToASCII(host);
  if (
    !ascii ||
    ascii.length > HOST_MAX ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      ascii,
    ) ||
    ascii.split(".").some((label) => label.length > 63)
  ) {
    invalid();
  }
  return ascii.toLowerCase();
}

function normalizePort(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < PORT_MIN ||
    value > PORT_MAX
  ) {
    invalid();
  }
  return value;
}

function normalizeSecurity(value) {
  if (value !== "tls" && value !== "starttls") invalid();
  return value;
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, "ipv4");
  if (family !== 6) return false;
  return (
    PUBLIC_IPV6.check(address, "ipv6") &&
    !NON_PUBLIC_IPV6.check(address, "ipv6")
  );
}

function normalizeFrom(value) {
  const address = stringValue(value, FROM_MAX);
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const rawDomain = address.slice(at + 1);
  if (
    at <= 0 ||
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    invalid();
  }
  const normalized = `${local.toLowerCase()}@${normalizeHost(rawDomain)}`;
  if (normalized.length > FROM_MAX) invalid();
  return normalized;
}

function normalizePassword(value, currentPassword) {
  const supplied =
    value === undefined || value === "" ? "" : stringValue(value, PASSWORD_MAX, { trim: false });
  const preserved = supplied || currentPassword;
  if (!preserved) invalid();
  return preserved;
}

export function normalizeMailConfig(input, options = {}) {
  if (
    !exactObject(options, ["currentPassword"]) ||
    !exactObject(input, CONFIG_KEYS)
  ) {
    invalid();
  }
  const currentPassword =
    options.currentPassword === undefined || options.currentPassword === ""
      ? ""
      : stringValue(options.currentPassword, PASSWORD_MAX, { trim: false });
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    security: normalizeSecurity(input.security),
    user: stringValue(input.user, USER_MAX),
    password: normalizePassword(input.password, currentPassword),
    from: normalizeFrom(input.from),
    fromName: stringValue(input.fromName, FROM_NAME_MAX, { allowEmpty: true }),
  };
}

function envValue(value) {
  if (value === "") return "";
  if (/^[^\s#'"\\]+$/u.test(value)) return value;
  return `${ENV_VALUE_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function decodeEnvValue(value) {
  if (typeof value !== "string") invalid();
  if (!value.startsWith(ENV_VALUE_PREFIX)) return value;
  const encoded = value.slice(ENV_VALUE_PREFIX.length);
  if (!encoded || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) invalid();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) invalid();
  return decoded;
}

export function mailConfigFromEnv(env) {
  if (!recordObject(env)) return null;
  try {
    const value = (key) =>
      Object.hasOwn(env, key) && typeof env[key] === "string"
        ? env[key]
        : undefined;
    const security =
      value("SMTP_SECURE") === "1" || value("SMTP_SECURE") === "true"
        ? "tls"
        : value("SMTP_SECURE") === "0" || value("SMTP_SECURE") === "false"
          ? "starttls"
          : undefined;
    const port = value("SMTP_PORT");
    if (
      port === undefined ||
      !/^[1-9]\d{0,4}$/u.test(port)
    ) {
      return null;
    }
    return normalizeMailConfig({
      host: decodeEnvValue(value("SMTP_HOST")),
      port: Number(port),
      security,
      user: decodeEnvValue(value("SMTP_USER")),
      password: decodeEnvValue(value("SMTP_PASS")),
      from: decodeEnvValue(value("SMTP_FROM")),
      fromName:
        value("SMTP_FROM_NAME") === undefined
          ? ""
          : decodeEnvValue(value("SMTP_FROM_NAME")),
    });
  } catch {
    return null;
  }
}

export function mailEnvFile(config, codeSecret) {
  const normalized = normalizeMailConfig(config);
  const secret = stringValue(codeSecret, 64, { trim: false });
  if (!/^[a-f0-9]{64}$/i.test(secret)) invalid();
  return [
    `SMTP_HOST=${envValue(normalized.host)}`,
    `SMTP_PORT=${normalized.port}`,
    `SMTP_SECURE=${normalized.security === "tls" ? "1" : "0"}`,
    `SMTP_USER=${envValue(normalized.user)}`,
    `SMTP_PASS=${envValue(normalized.password)}`,
    `SMTP_FROM=${envValue(normalized.from)}`,
    `SMTP_FROM_NAME=${envValue(normalized.fromName)}`,
    `MAIL_CODE_SECRET=${secret}`,
    "",
  ].join("\n");
}

function endpointHost(value) {
  try {
    const host = normalizeHost(value);
    if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
      unsafeEndpoint();
    }
    return host;
  } catch {
    unsafeEndpoint();
  }
}

function lookupEntries(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.address !== "string") {
      unsafeEndpoint();
    }
    const family = isIP(entry.address);
    if (
      (family !== 4 && family !== 6) ||
      (entry.family !== undefined && entry.family !== family) ||
      !isPublicAddress(entry.address)
    ) {
      unsafeEndpoint();
    }
    return { address: entry.address, family };
  });
}

export async function resolvePublicSmtpTarget(
  host,
  { resolve = dns.promises.lookup } = {},
) {
  const servername = endpointHost(host);
  const settled = await Promise.allSettled(
    [4, 6].map((family) =>
      resolve(servername, { family, all: true, verbatim: true }),
    ),
  );
  const addresses = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      addresses.push(...lookupEntries(result.value));
    }
  }
  const selected =
    addresses.find(({ family }) => family === 4) ??
    addresses.find(({ family }) => family === 6);
  if (!selected) unsafeEndpoint();
  return { ...selected, servername };
}

export function mailerOptions(config, target) {
  const normalized = normalizeMailConfig(config);
  const family = target && isIP(target.address);
  if (
    !target ||
    typeof target !== "object" ||
    typeof target.address !== "string" ||
    typeof target.servername !== "string" ||
    target.family !== family ||
    target.servername !== normalized.host ||
    (family !== 4 && family !== 6) ||
    !isPublicAddress(target.address)
  ) {
    unsafeEndpoint();
  }
  return {
    host: target.address,
    port: normalized.port,
    secure: normalized.security === "tls",
    requireTLS: normalized.security === "starttls",
    auth: { user: normalized.user, pass: normalized.password },
    tls: {
      servername: target.servername,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    connectionTimeout: TRANSPORT_TIMEOUT_MS,
    greetingTimeout: TRANSPORT_TIMEOUT_MS,
    socketTimeout: TRANSPORT_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}
