import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writePrivateJson(path, value) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readJsonFiles(directory, prefix) {
  ensurePrivateDirectory(directory);
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      if (!statSync(path).isFile()) return null;
      chmodSync(path, 0o600);
      return JSON.parse(readFileSync(path, "utf8"));
    })
    .filter(Boolean);
}
