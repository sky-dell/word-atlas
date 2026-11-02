import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// One process-wide pool, including CLI/library callers. At most ~64 MiB of
// scrypt memory is active; queue length is bounded before expensive work starts.
let active = 0;
const queue = [];
const parameters = { N: 32768, r: 8, p: 1, maxmem: 48 * 1024 * 1024 };
export const validPassword = (value) =>
  typeof value === "string" &&
  [...value].length >= 12 &&
  [...value].length <= 128;
export const passwordWork = () => ({ active, queued: queue.length });

function derive(password, salt) {
  if (active >= 2 && queue.length >= 32)
    return Promise.reject(
      Object.assign(new Error("Password service busy"), {
        status: 503,
        code: "busy",
      }),
    );
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      scrypt(password, salt, 64, parameters, (error, key) => {
        active--;
        queue.shift()?.();
        if (error) reject(error);
        else resolve(key);
      });
    };
    if (active < 2) run();
    else queue.push(run);
  });
}

export async function hashPassword(password) {
  if (!validPassword(password))
    throw Object.assign(new Error("Password must contain 12–128 characters"), {
      status: 400,
      code: "invalid_password",
    });
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$1$32768$8$1$${salt}$${key.toString("hex")}`;
}

// A missing account still pays the same work factor and uses constant-time
// comparison. Parameters are never taken from an untrusted encoded string.
const dummy = `scrypt$1$32768$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;
export async function verifyPassword(password, encoded = dummy) {
  if (!validPassword(password)) return false;
  if (!/^scrypt\$1\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(encoded))
    return false;
  const parts = encoded.split("$");
  const key = await derive(password, parts[5]);
  return timingSafeEqual(key, Buffer.from(parts[6], "hex"));
}
