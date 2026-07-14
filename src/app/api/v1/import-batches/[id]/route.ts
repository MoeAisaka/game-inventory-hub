import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";
import { db } from "@/server/db";
import { importBatches, importReconciliations, importRows } from "@/server/db/schema";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return apiError("AUTH_REQUIRED", "需要登录", 401, id);
  const params = await context.params;
  const batch = (await db.select().from(importBatches).where(eq(importBatches.id, params.id)).limit(1))[0];
  if (!batch) return apiError("NOT_FOUND", "导入批次不存在", 404, id);
  const reconciliations = await db.select().from(importReconciliations)
    .where(eq(importReconciliations.batchId, batch.id));
  const exceptions = (await db.select().from(importRows).where(eq(importRows.batchId, batch.id)))
    .filter((row) => row.status === "ERROR" || row.status === "WARNING")
    .slice(0, 200)
    .map((row) => ({
      id: row.id,
      sheetName: row.sheetName,
      sourceRow: row.sourceRow,
      recordType: row.recordType,
      status: row.status,
      issues: row.issues
    }));
  return apiOk({ batch, reconciliations, exceptions }, 200, id);
}
