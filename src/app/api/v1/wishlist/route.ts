import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import {
  createWishlistItem,
  createWishlistItemSchema,
  listWishlist,
  wishlistQuerySchema
} from "@/server/services/wishlist";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const parsed = wishlistQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return apiError("INVALID_REQUEST", "愿望单查询参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await listWishlist(auth.userId, parsed.data), 200, id);
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = createWishlistItemSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "愿望单参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk({ item: await createWishlistItem(auth.userId, parsed.data, id) }, 201, id);
  } catch (error) {
    if (error instanceof Error && error.message === "WISHLIST_ALREADY_IN_LIBRARY") {
      return apiError("INVALID_REQUEST", "该游戏已有持有或游玩记录，无需加入愿望单", 400, id);
    }
    return apiError("INTERNAL_ERROR", "创建愿望单失败", 500, id);
  }
}
