import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildCatalogRebuildPlan, type RebuildSources, type SourceItem } from "../src/server/catalog-rebuild/plan";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(process.argv[index + 1]);
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function withIdentityOverride(item: SourceItem): SourceItem {
  return item;
}

function platformSource(provider: "PLAYSTATION" | "NINTENDO", item: Record<string, unknown>): SourceItem {
  return withIdentityOverride({
    provider,
    externalGameId: String(item.externalGameId),
    name: String(item.name),
    platform: typeof item.platform === "string" ? item.platform : null,
    coverUrl: typeof item.coverUrl === "string" ? item.coverUrl : null,
    playtimeMinutes: Number(item.playtimeMinutes ?? 0),
    recentPlaytimeMinutes: null,
    firstPlayedAt: typeof item.firstPlayedAt === "string" ? item.firstPlayedAt : null,
    lastPlayedAt: typeof item.lastPlayedAt === "string" ? item.lastPlayedAt : null,
    progressPercent: typeof item.progressPercent === "number" ? item.progressPercent : null,
    isOwned: Boolean(item.isOwned),
    rawMetadata: typeof item.rawMetadata === "object" && item.rawMetadata ? item.rawMetadata as Record<string, unknown> : {},
    identityTitleOverride: typeof item.identityTitleOverride === "string" ? item.identityTitleOverride : null
  });
}

const productionPath = arg("--production");
const playstationPath = arg("--playstation");
const nintendoPath = arg("--nintendo");
const sourcesOutput = arg("--sources-output");
const planOutput = arg("--plan-output");
const [production, playstation, nintendo] = await Promise.all([json(productionPath), json(playstationPath), json(nintendoPath)]);
if (production.schemaVersion !== "catalog-production-sources.v1") throw new Error("PRODUCTION_SOURCE_SCHEMA_INVALID");
if (playstation.schemaVersion !== "playstation-preview.v1") throw new Error("PLAYSTATION_PREVIEW_SCHEMA_INVALID");
if (nintendo.schemaVersion !== "nintendo-nso-preview.v1") throw new Error("NINTENDO_PREVIEW_SCHEMA_INVALID");

const sources: RebuildSources = {
  ownerUserId: production.ownerUserId,
  capturedAt: new Date().toISOString(),
  steam: production.steam.map((item: SourceItem) => withIdentityOverride(item)),
  playstation: {
    status: playstation.summary.status,
    contentSha256: playstation.summary.contentSha256,
    externalUserId: playstation.snapshot.externalUserId,
    displayName: playstation.snapshot.displayName ?? null,
    items: playstation.snapshot.items.map((item: Record<string, unknown>) => platformSource("PLAYSTATION", item))
  },
  nintendo: {
    status: nintendo.summary.status,
    contentSha256: nintendo.summary.contentSha256,
    externalUserId: nintendo.snapshot.externalUserId,
    displayName: nintendo.snapshot.displayName ?? null,
    items: nintendo.snapshot.items.map((item: Record<string, unknown>) => platformSource("NINTENDO", item))
  },
  igdb: production.igdb,
  existingMappings: production.existingMappings
};
const plan = buildCatalogRebuildPlan(sources);
for (const path of [sourcesOutput, planOutput]) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await writeFile(sourcesOutput, `${JSON.stringify(sources, null, 2)}\n`, { mode: 0o600 });
await writeFile(planOutput, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
await Promise.all([chmod(sourcesOutput, 0o600), chmod(planOutput, 0o600)]);
process.stdout.write(`${JSON.stringify({ ok: true, sourcesOutput, planOutput, planSha256: plan.planSha256, summary: plan.summary, ambiguities: plan.ambiguities.length })}\n`);
