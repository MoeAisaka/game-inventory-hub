import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { selectReleaseCatalogEntry, selectReleaseCatalogEntrySchema } from "@/server/services/releases";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "发售目录记录ID不合法", 400, id);
  const parsed = selectReleaseCatalogEntrySchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "加入清单参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  try {
    const result = await selectReleaseCatalogEntry(auth.userId, params.id, parsed.data, id);
    if ("missing" in result) return apiError("NOT_FOUND", "发售目录记录不存在", 404, id);
    if ("incomplete" in result) return apiError("PRECONDITION_FAILED", "平台商店身份尚未确认，暂不能加入清单", 412, id, { missingFields: result.missingFields, missingLabels: result.missingLabels });
    if ("inLibrary" in result) return apiError("PRECONDITION_FAILED", "该游戏已有持有或游玩记录，无需加入待购清单", 412, id, { gameId: result.gameId });
    return apiOk(result, result.reused ? 200 : 201, id);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return apiError("CONFLICT", "该平台游戏已存在于愿望单，请刷新后重试", 409, id);
    }
    return apiError("INTERNAL_ERROR", "加入清单失败", 500, id);
  }
}
