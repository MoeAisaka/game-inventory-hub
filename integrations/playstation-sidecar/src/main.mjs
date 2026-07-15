import { loadConfig } from "./config.mjs";
import { publicError } from "./errors.mjs";
import { writePrivateJson } from "./files.mjs";
import { installSafeFetch } from "./safe-fetch.mjs";
import { buildSnapshot } from "./snapshot.mjs";
import { submitSnapshot } from "./submit.mjs";

async function main() {
  const config = loadConfig();
  const restoreFetch = installSafeFetch(config.requestTimeoutMs);
  try {
    // psn-api 2.18.0 resolves isomorphic-unfetch while its module is loaded.
    // Import it only after the guarded fetch wrapper is installed, otherwise
    // its requests would bypass our timeout and normalized error boundary.
    const [{ getAuthorization }, { fetchPlaystationData }] = await Promise.all([
      import("./auth.mjs"),
      import("./fetch-playstation.mjs")
    ]);
    const authorization = await getAuthorization(config);
    const data = await fetchPlaystationData(authorization, config);
    const preview = buildSnapshot(data);
    const output = {
      ...preview,
      execution: {
        mode: config.mode,
        authSource: authorization.source,
        submitted: false
      }
    };
    writePrivateJson(config.outputFile, output);
    if (config.mode === "submit") {
      output.execution.submission = await submitSnapshot(config, preview);
      output.execution.submitted = true;
      writePrivateJson(config.outputFile, output);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: config.mode,
      status: preview.summary.status,
      outputFile: config.outputFile,
      counts: {
        played: preview.summary.playedSourceCount,
        purchased: preview.summary.purchasedSourceCount,
        trophies: preview.summary.trophySourceCount,
        merged: preview.summary.mergedItemCount
      },
      submitted: output.execution.submitted
    })}\n`);
    if (preview.summary.status === "PARTIAL") process.exitCode = 2;
  } finally {
    restoreFetch();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: publicError(error) })}\n`);
  process.exitCode = 1;
});
