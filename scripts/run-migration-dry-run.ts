import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { closeDatabase } from "../src/server/db/index";
import { publicMigrationReport, runMigrationDryRun } from "../src/server/migration/service";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const source = option("--source");
const output = resolve(option("--output") ?? "output/migration-report.json");
if (!source) throw new Error("用法：npm run migration:dry-run -- --source <xlsx路径> [--output <报告路径>]");

try {
  const result = await runMigrationDryRun({ sourcePath: resolve(source) });
  const report = publicMigrationReport(result);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    batchId: report.batch.id,
    reused: report.batch.reused,
    hardGatesPassed: report.summary.allHardGatesPassed,
    readyForCommit: report.summary.readyForCommit,
    rows: report.summary.rowCounts,
    acceptedByType: report.summary.acceptedByType,
    images: report.summary.imageReferenceCount,
    output
  }, null, 2));
} finally {
  await closeDatabase();
}
