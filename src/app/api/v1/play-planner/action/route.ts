import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { applyPlayPlannerAction, PlayPlannerError, playPlannerActionSchema } from "@/server/services/play-planning";

const errorContracts: Record<PlayPlannerError["code"], { status: number; apiCode: "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" }> = {
  GAME_NOT_FOUND: { status: 404, apiCode: "NOT_FOUND" },
  GAME_COMPLETED: { status: 412, apiCode: "PRECONDITION_FAILED" },
  GAME_ABANDONED: { status: 412, apiCode: "PRECONDITION_FAILED" },
  ACQUISITION_NOT_FOUND: { status: 404, apiCode: "NOT_FOUND" },
  ACQUISITION_REQUIRED: { status: 412, apiCode: "PRECONDITION_FAILED" },
  OFFLINE_REQUIRED: { status: 412, apiCode: "PRECONDITION_FAILED" },
  SCENARIO_OCCUPIED: { status: 409, apiCode: "CONFLICT" },
  CONFLICT: { status: 409, apiCode: "CONFLICT" }
};

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = playPlannerActionSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "游玩规划参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await applyPlayPlannerAction(auth.userId, parsed.data, id);
    return apiOk(result, 200, id);
  } catch (error) {
    if (error instanceof PlayPlannerError) {
      const contract = errorContracts[error.code];
      return apiError(contract.apiCode, error.message, contract.status, id, { plannerCode: error.code });
    }
    return apiError("INTERNAL_ERROR", "游玩规划更新失败", 500, id);
  }
}
