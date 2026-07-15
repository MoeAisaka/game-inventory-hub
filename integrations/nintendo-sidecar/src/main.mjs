import { loadConfig } from "./config.mjs";
import { publicError } from "./errors.mjs";
import { ensurePrivateDirectory, readJsonFiles, writePrivateJson } from "./files.mjs";
import { fetchNxapiData } from "./nxapi.mjs";
import { buildNintendoNsoPreview, buildNintendoPreview } from "./snapshot.mjs";
import { readFileSync } from "node:fs";

function readPrevious(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const config = loadConfig();
  ensurePrivateDirectory(config.dataPath);
  ensurePrivateDirectory(config.summaryPath);
  const fetched = fetchNxapiData(config);
  const preview = fetched.mode === "nso"
    ? buildNintendoNsoPreview({ playLog: fetched.playLog, previous: readPrevious(config.historyFile) })
    : buildNintendoPreview({
        devices: fetched.devices,
        daily: readJsonFiles(config.summaryPath, "pctl-daily-"),
        monthly: readJsonFiles(config.summaryPath, "pctl-monthly-"),
        playerId: config.playerId
      });
  writePrivateJson(config.outputFile, { ...preview, execution: { mode: "preview", submitted: false } });
  if (fetched.mode === "nso") writePrivateJson(config.historyFile, preview);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "preview",
    outputFile: config.outputFile,
    counts: {
      devices: preview.summary.deviceCount,
      players: preview.summary.playerCount,
      games: preview.summary.gameCount,
      playtimeMinutes: preview.summary.totalPlaytimeMinutes
    },
    submitted: false
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: publicError(error) })}\n`);
  process.exitCode = 1;
});
