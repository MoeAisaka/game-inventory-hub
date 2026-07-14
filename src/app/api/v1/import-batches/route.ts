import { desc } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";
import { db } from "@/server/db";
import { importBatches } from "@/server/db/schema";
import { createImportBatch, createImportBatchSchema } from "@/server/services/imports";
import { sameOrigin } from "@/server/http/auth";

async function authorize(request: NextRequest, id: string) {
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return session ?? apiError("AUTH_REQUIRED", "需要登录", 401, id);
}

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await authorize(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const batches = await db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(50);
  return apiOk({ batches }, 200, id);
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await authorize(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = createImportBatchSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "导入批次参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await createImportBatch(parsed.data, auth.userId, id);
    return apiOk(result, result.created ? 201 : 200, id);
  } catch {
    return apiError("INTERNAL_ERROR", "创建导入批次失败", 500, id);
  }
}
