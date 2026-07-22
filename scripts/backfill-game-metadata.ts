import { asc } from "drizzle-orm";
import { closeDatabase, db } from "@/server/db";
import { users } from "@/server/db/schema";
import { writeAudit } from "@/server/audit";
import { syncHltbMetadata } from "@/server/integrations/hltb";
import { syncIgdbMetadata } from "@/server/integrations/igdb";
import { syncPlayStationStoreMetadata } from "@/server/integrations/playstation-store";
import { syncSteamStoreMetadata } from "@/server/integrations/steam-store";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const forceMissing = process.argv.includes("--force-missing");
const retryBefore = forceMissing ? new Date() : undefined;
const providersArgument = process.argv.find((value) => value.startsWith("--providers="))?.slice("--providers=".length);
const providers = new Set((providersArgument ?? "STEAM,PLAYSTATION,IGDB,HLTB").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
const supportedProviders = new Set(["STEAM", "PLAYSTATION", "IGDB", "HLTB"]);
for (const provider of providers) if (!supportedProviders.has(provider)) throw new Error(`UNSUPPORTED_PROVIDER:${provider}`);

async function drain(
  provider: string,
  maxBatches: number,
  run: (key: string) => Promise<{ processed?: number; updated?: number; skipped?: number; failed?: number; hasMore?: boolean }>
) {
  const summary = { provider, batches: 0, processed: 0, updated: 0, skipped: 0, failed: 0, complete: false };
  for (let index = 0; index < maxBatches; index += 1) {
    const result = await run(`backfill-${provider.toLowerCase()}-${Date.now()}-${index}`);
    summary.batches += 1;
    summary.processed += result.processed ?? 0;
    summary.updated += result.updated ?? 0;
    summary.skipped += result.skipped ?? 0;
    summary.failed += result.failed ?? 0;
    console.log(JSON.stringify({ event: "batch", ...summary, result }));
    if (!result.hasMore || !result.processed) { summary.complete = true; break; }
    await sleep(provider === "HLTB" ? 1_200 : 350);
  }
  return summary;
}

const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
if (!owner) throw new Error("NO_OWNER");

try {
  const result: Record<string, unknown> = {};
  if (providers.has("STEAM")) result.steam = await drain("STEAM", 50, (key) => syncSteamStoreMetadata(owner.id, key, fetch, { retryBefore, missingOnly: forceMissing }));
  if (providers.has("PLAYSTATION")) result.playStation = await drain("PLAYSTATION", 100, (key) => syncPlayStationStoreMetadata(owner.id, key, fetch, { retryBefore }));
  if (providers.has("IGDB")) result.igdb = await drain("IGDB", 50, (key) => syncIgdbMetadata(owner.id, key, fetch, { retryBefore, missingOnly: forceMissing }));
  if (providers.has("HLTB")) result.hltb = await drain("HLTB", 120, (key) => syncHltbMetadata(owner.id, key, undefined, { retryBefore }));
  const requestId = `metadata-backfill-${Date.now()}`;
  await writeAudit({
    actorUserId: owner.id,
    action: "game.metadata.backfill",
    entityType: "game_catalog",
    entityId: owner.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { providers: [...providers], forceMissing, result }
  });
  console.log(JSON.stringify({ event: "complete", providers: [...providers], forceMissing, ...result }));
} finally {
  await closeDatabase();
}
