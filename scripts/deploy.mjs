import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = spawnSync("npm", ["run", "build"], {
  cwd: root,
  env: { ...process.env, ATLAS_BASE: "./" },
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status || 1);
const target = "/data/AI-History-CSS/dist/words";
if (
  fs.existsSync(target) &&
  !fs.existsSync(path.join(target, "word-atlas-deployment.json"))
)
  throw Error(
    "Existing directory is not marked as a Words & Beyond deployment; refusing to replace it.",
  );
const next = fs.mkdtempSync("/data/AI-History-CSS/dist/word-atlas-release-");
// mkdtemp creates mode 0700; the static service uses a separate read-only user.
fs.chmodSync(next, 0o755);
fs.cpSync(path.join(root, "dist"), next, {
  recursive: true,
  mode: fs.constants.COPYFILE_FICLONE,
});
fs.copyFileSync(path.join(next, "index.html"), path.join(next, "app.htm"));
fs.writeFileSync(
  path.join(next, "word-atlas-deployment.json"),
  JSON.stringify({
    project: "word-atlas",
    source: root,
    at: new Date().toISOString(),
  }),
);
if (fs.existsSync(target)) {
  const archive = path.join(root, ".local", "releases");
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(target, path.join(archive, "words-" + Date.now()));
}
fs.renameSync(next, target);
console.log("Published http://43.133.166.184/#/atlas");
