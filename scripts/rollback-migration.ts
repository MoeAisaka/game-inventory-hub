import { closeDatabase } from "../src/server/db/index";
import { rollbackMigrationBatch } from "../src/server/migration/service";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const batchId = option("--batch");
if (!batchId) throw new Error("用法：npm run migration:rollback -- --batch <批次ID>");

try {
  const batch = await rollbackMigrationBatch(batchId);
  console.log(JSON.stringify({ batchId: batch.id, status: batch.status }, null, 2));
} finally {
  await closeDatabase();
}
