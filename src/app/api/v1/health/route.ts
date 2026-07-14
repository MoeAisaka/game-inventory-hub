import { performance } from "node:perf_hooks";
import { apiError, apiOk, requestId } from "@/lib/api";
import { env } from "@/lib/env";
import { pool } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  const started = performance.now();
  try {
    await pool.query("SELECT 1");
    return apiOk({
      status: "ok",
      version: env().APP_VERSION,
      checks: { database: { status: "ok", latencyMs: Math.round((performance.now() - started) * 100) / 100 } }
    }, 200, id);
  } catch {
    return apiError("DATABASE_UNAVAILABLE", "数据库暂时不可用", 503, id);
  }
}
