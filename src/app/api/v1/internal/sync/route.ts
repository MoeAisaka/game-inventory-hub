import { asc } from "drizzle-orm";
import { apiError, apiOk, requestId } from "@/lib/api";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { authorizedInternalRequest } from "@/server/http/internal-auth";
import { IgdbConnectorError, syncIgdbMetadata, syncIgdbReleaseCatalog } from "@/server/integrations/igdb";
import { SteamConnectorError, syncSteamOwnedGames } from "@/server/integrations/steam";
import { syncSteamWishlist } from "@/server/integrations/steam-wishlist";
import { SteamStoreConnectorError, syncSteamStoreMetadata } from "@/server/integrations/steam-store";
import { PlayStationStoreConnectorError, syncPlayStationStoreMetadata } from "@/server/integrations/playstation-store";
import { syncHltbMetadata } from "@/server/integrations/hltb";
import { autoClassifyPlayedGames } from "@/server/services/game-auto-status";

export async function POST(request: Request) {
  const id = requestId(request);
  if (!authorizedInternalRequest(request)) return apiError("FORBIDDEN", "内部同步凭证无效", 403, id);
  const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
  if (!owner) return apiError("PRECONDITION_FAILED", "尚未创建系统账号", 412, id);
  const bucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
  const dayBucket = new Date().toISOString().slice(0, 10);
  const result: Record<string, unknown> = {};
  try { result.steam = await syncSteamOwnedGames(owner.id, `cron-steam-${bucket}`); }
  catch (error) { result.steam = { skipped: true, code: error instanceof SteamConnectorError ? error.code : "FAILED" }; }
  try { result.steamWishlist = await syncSteamWishlist(owner.id, `cron-steam-wishlist-${dayBucket}`); }
  catch (error) { result.steamWishlist = { skipped: true, code: error instanceof SteamConnectorError ? error.code : "FAILED" }; }
  try { result.steamMetadata = await syncSteamStoreMetadata(owner.id, `cron-steam-metadata-${bucket}`); }
  catch (error) { result.steamMetadata = { skipped: true, code: error instanceof SteamStoreConnectorError ? error.code : "FAILED" }; }
  try { result.playStationMetadata = await syncPlayStationStoreMetadata(owner.id, `cron-playstation-metadata-${bucket}`); }
  catch (error) { result.playStationMetadata = { skipped: true, code: error instanceof PlayStationStoreConnectorError ? error.code : "FAILED" }; }
  try { result.igdb = await syncIgdbMetadata(owner.id, `cron-igdb-${bucket}`); }
  catch (error) { result.igdb = { skipped: true, code: error instanceof IgdbConnectorError ? error.code : "FAILED" }; }
  try { result.releaseCatalog = await syncIgdbReleaseCatalog(owner.id, `cron-release-catalog-${bucket}`); }
  catch (error) { result.releaseCatalog = { skipped: true, code: error instanceof IgdbConnectorError ? error.code : "FAILED" }; }
  try { result.hltb = await syncHltbMetadata(owner.id, `cron-hltb-${bucket}`); }
  catch { result.hltb = { skipped: true, code: "FAILED" }; }
  try { result.autoPlayed = await autoClassifyPlayedGames(owner.id); }
  catch { result.autoPlayed = { skipped: true, code: "FAILED" }; }
  return apiOk(result, 200, id);
}
