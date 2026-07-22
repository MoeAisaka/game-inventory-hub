import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";
import { inventoryQuerySchema, listInventory } from "@/server/services/inventory";

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
  return apiError("INVENTORY_V2_REQUIRED", "旧版库存写入已停用，请使用货品卡片页", 410, id);
}
