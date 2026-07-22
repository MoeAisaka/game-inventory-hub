import { NextRequest } from "next/server";
import { apiOk, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";
import { listRecentInventoryMovements } from "@/server/services/inventory-v2";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "100");
  return apiOk({ movements: await listRecentInventoryMovements(auth.userId, Number.isFinite(limit) ? limit : 100) }, 200, id);
}
