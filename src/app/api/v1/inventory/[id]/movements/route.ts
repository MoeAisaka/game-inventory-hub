import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { addInventoryMovement, inventoryMovementSchema } from "@/server/services/inventory";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "库存ID不合法", 400, id);
  try {
    const parsed = inventoryMovementSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "库存流水参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await addInventoryMovement(auth.userId, params.id, parsed.data, id);
    if (!result) return apiError("NOT_FOUND", "库存不存在", 404, id);
    if ("conflict" in result && result.conflict) return apiError("CONFLICT", "库存已被其他操作更新", 409, id, { current: result.current });
    if ("negative" in result && result.negative) return apiError("PRECONDITION_FAILED", "操作将导致负库存", 412, id, { current: result.current });
    return apiOk(result, 201, id);
  } catch {
    return apiError("INTERNAL_ERROR", "创建库存流水失败", 500, id);
  }
}
