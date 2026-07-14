import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { createInventoryItem, createInventoryItemSchema, inventoryQuerySchema, listInventory } from "@/server/services/inventory";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const parsed = inventoryQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return apiError("INVALID_REQUEST", "查询参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await listInventory(auth.userId, parsed.data), 200, id);
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = createInventoryItemSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "库存参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk({ item: await createInventoryItem(auth.userId, parsed.data, id) }, 201, id);
  } catch {
    return apiError("INTERNAL_ERROR", "创建库存失败", 500, id);
  }
}
