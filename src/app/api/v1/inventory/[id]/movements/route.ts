import { NextRequest } from "next/server";
import { apiError, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  void context;
  return apiError("INVENTORY_V2_REQUIRED", "旧版库存写入已停用，请使用货品卡片页", 410, id);
}
