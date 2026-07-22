import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import {
  createInventoryProduct,
  createInventoryProductSchema,
  inventoryV2QuerySchema,
  listInventoryProducts
} from "@/server/services/inventory-v2";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const parsed = inventoryV2QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return apiError("INVALID_REQUEST", "查询参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await listInventoryProducts(auth.userId, parsed.data), 200, id);
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = createInventoryProductSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "货品参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk(await createInventoryProduct(auth.userId, parsed.data, id), 201, id);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return apiError("CONFLICT", "同名货品或颜色已经存在", 409, id);
    }
    return apiError("INTERNAL_ERROR", "创建货品失败", 500, id);
  }
}
