import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import {
  acquireWishlistItem,
  acquireWishlistItemSchema,
  WishlistAcquireError
} from "@/server/services/wishlist";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const auth = await requireApiSession(request, requestIdentifier);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, requestIdentifier);
  const parsed = acquireWishlistItemSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "购入渠道参数不合法", 400, requestIdentifier, z.flattenError(parsed.error).fieldErrors);
  }
  const { id } = await context.params;
  try {
    const result = await acquireWishlistItem(auth.userId, id, parsed.data, requestIdentifier);
    if (!result) return apiError("NOT_FOUND", "愿望单记录不存在", 404, requestIdentifier);
    return apiOk(result, 200, requestIdentifier);
  } catch (error) {
    if (error instanceof WishlistAcquireError) {
      const status = error.code === "WISHLIST_INACTIVE" ? 409 : 422;
      return apiError(error.code === "WISHLIST_INACTIVE" ? "CONFLICT" : "PRECONDITION_FAILED", error.message, status, requestIdentifier);
    }
    return apiError("INTERNAL_ERROR", "愿望单转入候玩池失败", 500, requestIdentifier);
  }
}
