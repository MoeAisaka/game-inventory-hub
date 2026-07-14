import { NextRequest } from "next/server";
import { z } from "zod";
import { dashboardFiltersSchema } from "@/lib/dashboard";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";
import { getDashboardData } from "@/server/services/dashboard";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const query: Record<string, string | string[]> = Object.fromEntries(request.nextUrl.searchParams);
  query.statuses = request.nextUrl.searchParams.getAll("statuses");
  const parsed = dashboardFiltersSchema.safeParse(query);
  if (!parsed.success) return apiError("INVALID_REQUEST", "看板筛选参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await getDashboardData(auth.userId, parsed.data), 200, id);
}
