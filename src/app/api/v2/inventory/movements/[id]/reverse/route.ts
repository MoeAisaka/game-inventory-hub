import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { reverseInventoryMovement, reverseInventoryMovementSchema } from "@/server/services/inventory-v2";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "流水ID不合法", 400, id);
  const parsed = reverseInventoryMovementSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "撤销参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  const result = await reverseInventoryMovement(auth.userId, params.id, parsed.data, id);
  if ("missing" in result) return apiError("NOT_FOUND", "流水不存在", 404, id);
  if ("notReversible" in result) return apiError("PRECONDITION_FAILED", "历史流水或撤销流水不能再次撤销", 412, id);
  if ("conflict" in result) return apiError("CONFLICT", "库存已更新，请刷新后重试", 409, id, { current: result.current });
  if ("negative" in result) return apiError("PRECONDITION_FAILED", "撤销将导致库存状态不合法", 412, id, { current: result.current });
  return apiOk(result, 201, id);
}
