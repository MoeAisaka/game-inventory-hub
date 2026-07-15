import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { deleteInventoryItem, updateInventoryItem, updateInventoryItemSchema } from "@/server/services/inventory";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "库存ID不合法", 400, id);
  const parsed = updateInventoryItemSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "库存参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  const result = await updateInventoryItem(auth.userId, params.id, parsed.data, id);
  if (!result) return apiError("NOT_FOUND", "库存不存在", 404, id);
  if (result.conflict) return apiError("CONFLICT", "库存已被其他操作更新，请刷新后重试", 409, id, { currentVersion: result.current.version });
  return apiOk({ item: result.item }, 200, id);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "库存ID不合法", 400, id);
  const item = await deleteInventoryItem(auth.userId, params.id, id);
  return item ? apiOk({ item }, 200, id) : apiError("NOT_FOUND", "库存不存在", 404, id);
}
