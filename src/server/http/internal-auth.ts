import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export function authorizedInternalRequest(request: Request) {
  const configured = env().SYNC_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!configured || configured.length < 32 || !supplied) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
