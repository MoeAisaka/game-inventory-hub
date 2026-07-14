import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import {
  auditLogs,
  importBatches,
  importImageRefs,
  importReconciliations,
  importRows
} from "@/server/db/schema";
import { analyzeMigrationWorkbook, type MigrationAnalysis } from "./normalize";
import { parseOpenXmlWorkbook } from "./openxml";

export const MIGRATION_PARSER_VERSION = "phase2-openxml-v1";

export type DryRunInput = {
  sourcePath: string;
  actorUserId?: string | null;
  requestId?: string;
};

export async function runMigrationDryRun(input: DryRunInput) {
  if (extname(input.sourcePath).toLowerCase() !== ".xlsx") throw new Error("只允许读取.xlsx源文件");
  const fileStat = await stat(input.sourcePath);
  if (!fileStat.isFile()) throw new Error("源路径不是文件");
  if (fileStat.size <= 0 || fileStat.size > 2_000_000_000) throw new Error("源文件大小超出允许范围");
  const sourceBytes = await readFile(input.sourcePath);
  const sourceChecksum = createHash("sha256").update(sourceBytes).digest("hex");
  const workbook = await parseOpenXmlWorkbook(input.sourcePath);
  const analysis = analyzeMigrationWorkbook(workbook);
  const requestId = input.requestId ?? `migration-${randomUUID()}`;
  const sourceName = basename(input.sourcePath);

  return db.transaction(async (tx) => {
    const existing = (await tx.select().from(importBatches)
      .where(eq(importBatches.sourceChecksum, sourceChecksum)).limit(1))[0];

    if (existing?.status === "COMMITTED") throw new Error("已提交批次不可重新执行试迁移");
    if (existing?.status === "VALIDATED" && existing.summary?.parserVersion === MIGRATION_PARSER_VERSION) {
      return { batch: existing, analysis, reused: true };
    }

    const batch = existing ?? (await tx.insert(importBatches).values({
      sourceName,
      sourceChecksum,
      sourceByteSize: fileStat.size,
      status: "PENDING",
      createdByUserId: input.actorUserId ?? null
    }).returning())[0];

    if (existing) {
      await tx.delete(importRows).where(eq(importRows.batchId, batch.id));
      await tx.delete(importImageRefs).where(eq(importImageRefs.batchId, batch.id));
      await tx.delete(importReconciliations).where(eq(importReconciliations.batchId, batch.id));
      await tx.update(importBatches).set({
        sourceName,
        sourceByteSize: fileStat.size,
        status: "PENDING",
        totalRows: 0,
        successRows: 0,
        warningRows: 0,
        errorRows: 0,
        excludedRows: 0,
        imageRefCount: 0,
        uniqueMediaCount: 0,
        summary: {},
        completedAt: null,
        updatedAt: new Date()
      }).where(eq(importBatches.id, batch.id));
    }

    await tx.insert(importRows).values(analysis.rows.map((row) => ({
      batchId: batch.id,
      sheetName: row.sheetName,
      sourceRow: row.sourceRow,
      recordType: row.recordType,
      rowChecksum: row.rowChecksum,
      status: row.status,
      rawPayload: row.rawPayload,
      normalizedPayload: row.normalizedPayload,
      issues: row.issues
    })));

    await tx.insert(importImageRefs).values(analysis.images.map((image) => ({
      batchId: batch.id,
      sheetName: image.sheetName,
      sourceRow: image.sourceRow,
      sourceColumn: image.sourceColumn,
      anchorIndex: image.anchorIndex,
      mediaPath: image.mediaPath,
      checksumSha256: image.checksumSha256,
      byteSize: image.byteSize,
      extension: image.extension,
      status: image.status,
      issues: image.issues
    })));

    await tx.insert(importReconciliations).values(analysis.reconciliations.map((item) => ({
      batchId: batch.id,
      metric: item.metric,
      expectedCount: item.expectedCount,
      actualCount: item.actualCount,
      passed: item.passed,
      details: item.details
    })));

    const summary = {
      ...analysis.summary,
      parserVersion: MIGRATION_PARSER_VERSION,
      sourceChecksum,
      sourceByteSize: fileStat.size
    };
    const [updatedBatch] = await tx.update(importBatches).set({
      status: "VALIDATED",
      totalRows: analysis.rows.length,
      successRows: analysis.summary.rowCounts.SUCCESS,
      warningRows: analysis.summary.rowCounts.WARNING,
      errorRows: analysis.summary.rowCounts.ERROR,
      excludedRows: analysis.summary.rowCounts.EXCLUDED,
      imageRefCount: analysis.images.length,
      uniqueMediaCount: analysis.summary.uniqueImageChecksums,
      summary,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(importBatches.id, batch.id)).returning();

    await tx.insert(auditLogs).values({
      actorUserId: input.actorUserId ?? null,
      action: "import.batch.dry_run",
      entityType: "import_batch",
      entityId: batch.id,
      outcome: "SUCCESS",
      requestId,
      metadata: {
        sourceChecksum,
        parserVersion: MIGRATION_PARSER_VERSION,
        hardGatesPassed: analysis.summary.allHardGatesPassed,
        readyForCommit: analysis.summary.readyForCommit
      }
    });

    return { batch: updatedBatch, analysis, reused: false };
  });
}

export async function rollbackMigrationBatch(batchId: string, actorUserId?: string | null, requestId = `rollback-${randomUUID()}`) {
  return db.transaction(async (tx) => {
    const batch = (await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1))[0];
    if (!batch) throw new Error("导入批次不存在");
    if (batch.status === "COMMITTED") throw new Error("已提交批次需要业务数据补偿流程，不能用暂存回滚");
    await tx.delete(importRows).where(eq(importRows.batchId, batchId));
    await tx.delete(importImageRefs).where(eq(importImageRefs.batchId, batchId));
    await tx.delete(importReconciliations).where(eq(importReconciliations.batchId, batchId));
    const [rolledBack] = await tx.update(importBatches).set({
      status: "ROLLED_BACK",
      totalRows: 0,
      successRows: 0,
      warningRows: 0,
      errorRows: 0,
      excludedRows: 0,
      imageRefCount: 0,
      uniqueMediaCount: 0,
      summary: { rolledBackAt: new Date().toISOString(), parserVersion: MIGRATION_PARSER_VERSION },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(importBatches.id, batchId)).returning();
    await tx.insert(auditLogs).values({
      actorUserId: actorUserId ?? null,
      action: "import.batch.rollback",
      entityType: "import_batch",
      entityId: batchId,
      outcome: "SUCCESS",
      requestId,
      metadata: { previousStatus: batch.status }
    });
    return rolledBack;
  });
}

export function publicMigrationReport(result: { batch: typeof importBatches.$inferSelect; analysis: MigrationAnalysis; reused: boolean }) {
  const blockingErrors = result.analysis.rows
    .filter((row) => row.status === "ERROR")
    .map((row) => ({ sheetName: row.sheetName, sourceRow: row.sourceRow, issues: row.issues }));
  return {
    generatedAt: new Date().toISOString(),
    parserVersion: MIGRATION_PARSER_VERSION,
    batch: {
      id: result.batch.id,
      sourceName: result.batch.sourceName,
      sourceChecksum: result.batch.sourceChecksum,
      sourceByteSize: result.batch.sourceByteSize,
      status: result.batch.status,
      reused: result.reused
    },
    summary: result.analysis.summary,
    reconciliations: result.analysis.reconciliations,
    blockingErrors,
    topIssues: Object.entries(result.analysis.summary.issueCounts).slice(0, 20).map(([code, count]) => ({ code, count }))
  };
}
