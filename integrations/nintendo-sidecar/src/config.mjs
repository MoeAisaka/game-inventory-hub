import { resolve } from "node:path";

export function loadConfig() {
  const root = resolve(process.env.NINTENDO_ROOT_DIR?.trim() || ".");
  return {
    mode: (process.env.NINTENDO_SYNC_MODE?.trim() || "nso").toLowerCase(),
    dataPath: resolve(process.env.NINTENDO_NXAPI_DATA_PATH?.trim() || `${root}/.runtime/nintendo/nxapi`),
    summaryPath: resolve(process.env.NINTENDO_SUMMARY_PATH?.trim() || `${root}/.runtime/nintendo/summaries`),
    outputFile: resolve(process.env.NINTENDO_PREVIEW_OUTPUT_FILE?.trim() || `${root}/output/nintendo/preview-latest.json`),
    historyFile: resolve(process.env.NINTENDO_HISTORY_FILE?.trim() || `${root}/.runtime/nintendo/nso-last-success.json`),
    playerId: process.env.NINTENDO_PLAYER_ID?.trim() || null,
    nxapiBin: resolve(process.env.NINTENDO_NXAPI_BIN?.trim() || "integrations/nintendo-sidecar/node_modules/.bin/nxapi")
  };
}
