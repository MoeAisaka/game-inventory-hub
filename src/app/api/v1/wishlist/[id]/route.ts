import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId } from "@/lib/api";
import { safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { removeWishlistItem, updateWishlistPlan, updateWishlistPlanSchema } from "@/server/services/wishlist";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const auth = await requireApiSession(request, requestIdentifier);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, requestIdentifier);
  const parsed = updateWishlistPlanSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "游玩计划参数不合法", 400, requestIdentifier, z.flattenError(parsed.error).fieldErrors);
  const { id } = await context.params;
  const item = await updateWishlistPlan(auth.userId, id, parsed.data, requestIdentifier);
  if (!item) return apiError("NOT_FOUND", "愿望单记录不存在", 404, requestIdentifier);
  return apiOk({ item }, 200, requestIdentifier);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const auth = await requireApiSession(request, requestIdentifier);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, requestIdentifier);
  const { id } = await context.params;
  const item = await removeWishlistItem(auth.userId, id, requestIdentifier);
  if (!item) return apiError("NOT_FOUND", "愿望单记录不存在", 404, requestIdentifier);
  return apiOk({ item }, 200, requestIdentifier);
}
