import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";
import { listReleaseCalendar, releaseCalendarQuerySchema } from "@/server/services/releases";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const session = await requireApiSession(request, id);
  if (session instanceof Response) return session;
  const parsed = releaseCalendarQuerySchema.safeParse({
    month: request.nextUrl.searchParams.get("month"),
    platform: request.nextUrl.searchParams.getAll("platform")
  });
  if (!parsed.success) return apiError("INVALID_REQUEST", "发售日历筛选参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await listReleaseCalendar(session.userId, parsed.data), 200, id);
}
