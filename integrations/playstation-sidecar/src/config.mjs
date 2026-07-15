import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SidecarError } from "./errors.mjs";

function readSecret(name) {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new SidecarError("SECRET_FILE_UNREADABLE", `无法读取 ${name} 的 Secret 文件`);
    }
  }
  return process.env[name]?.trim() || null;
}

function numberFromEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SidecarError("INVALID_CONFIGURATION", `${name} 配置不合法`);
  }
  return value;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const preview = argv.includes("--preview");
  const submit = argv.includes("--submit");
  if (preview === submit) {
    throw new SidecarError("INVALID_MODE", "必须且只能指定 --preview 或 --submit");
  }
  const outputFile = resolve(process.env.PSN_PREVIEW_OUTPUT_FILE?.trim() || "output/playstation/preview-latest.json");
  const authStateFile = resolve(process.env.PSN_AUTH_STATE_FILE?.trim() || ".runtime/playstation/auth.json");
  const mainApiUrl = process.env.MAIN_API_URL?.trim() || "http://127.0.0.1:3000";
  let parsedApiUrl;
  try {
    parsedApiUrl = new URL(mainApiUrl);
  } catch {
    throw new SidecarError("INVALID_CONFIGURATION", "MAIN_API_URL 不是合法 URL");
  }
  if (!/^https?:$/.test(parsedApiUrl.protocol)) {
    throw new SidecarError("INVALID_CONFIGURATION", "MAIN_API_URL 仅允许 HTTP 或 HTTPS");
  }
  return {
    mode: preview ? "preview" : "submit",
    outputFile,
    authStateFile,
    npsso: readSecret("PSN_NPSSO"),
    syncSecret: readSecret("SYNC_CRON_SECRET"),
    mainApiUrl: parsedApiUrl.toString().replace(/\/$/, ""),
    requestTimeoutMs: numberFromEnv("PSN_REQUEST_TIMEOUT_MS", 20_000, 3_000, 120_000),
    maxAttempts: numberFromEnv("PSN_MAX_ATTEMPTS", 3, 1, 5),
    pageSize: numberFromEnv("PSN_PAGE_SIZE", 200, 20, 800),
    maxItems: numberFromEnv("PSN_MAX_ITEMS", 5000, 1, 5000)
  };
}
