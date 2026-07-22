import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import {
  updateInventoryProductRatings,
  updateInventoryProductRatingsSchema
} from "@/server/services/inventory-v2";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "货品ID不合法", 400, id);
  const parsed = updateInventoryProductRatingsSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "消耗优先级或商品评级参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  const result = await updateInventoryProductRatings(auth.userId, params.id, parsed.data, id);
  if ("missing" in result) return apiError("NOT_FOUND", "货品不存在", 404, id);
  if ("conflict" in result) return apiError("CONFLICT", "货品已更新，请刷新后重试", 409, id, { currentVersion: result.currentVersion });
  return apiOk(result, 200, id);
}
