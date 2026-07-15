import { execFileSync } from "node:child_process";
import { NintendoSidecarError } from "./errors.mjs";

const SAFE_ENV = {
  NXAPI_DEBUG_FILE: "0",
  NXAPI_SKIP_UPDATE_CHECK: "1",
  NXAPI_USER_AGENT: "game-inventory-hub-nintendo-sidecar/0.2.0"
};

function run(config, args, options = {}) {
  try {
    return execFileSync(config.nxapiBin, ["--data-path", config.dataPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...SAFE_ENV },
      maxBuffer: 20 * 1024 * 1024,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const authRequired = /authenticate|session token|SelectedUser|NintendoAccountToken|login/i.test(stderr);
    throw new NintendoSidecarError(
      authRequired ? "NINTENDO_AUTH_REQUIRED" : "NXAPI_COMMAND_FAILED",
      authRequired ? "Nintendo Account 授权尚未完成，请先运行 node src/auth-start.mjs" : "Nintendo 只读数据获取失败"
    );
  }
}

export function fetchNxapiData(config) {
  if (config.mode === "nso") {
    const playLog = JSON.parse(run(config, ["nso", "play-activity", "--json"]));
    return { mode: "nso", playLog };
  }
  if (config.mode !== "pctl") {
    throw new NintendoSidecarError("NINTENDO_MODE_INVALID", "Nintendo 同步模式必须为 nso 或 pctl");
  }
  const devices = JSON.parse(run(config, ["pctl", "devices", "--json"]));
  run(config, ["pctl", "dump-summaries", config.summaryPath]);
  return { mode: "pctl", devices };
}
