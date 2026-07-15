import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { verifyCatalogRebuildPlan, type CatalogRebuildPlan, type PlannedGame, type SourceItem } from "../src/server/catalog-rebuild/plan";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

if (process.env.ALLOW_CATALOG_REBUILD !== "true") throw new Error("ALLOW_CATALOG_REBUILD=true is required");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const planPath = resolve(arg("--plan"));
const backupPath = resolve(arg("--backup"));
const resultPath = resolve(arg("--result"));
const confirmedPlanSha = arg("--confirm-plan-sha256");
const backupSha256 = arg("--backup-sha256");
if (!/^[a-f0-9]{64}$/.test(backupSha256)) throw new Error("BACKUP_SHA256_INVALID");

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

if (await sha256File(backupPath) !== backupSha256) throw new Error("BACKUP_SHA256_MISMATCH");
const plan = JSON.parse(await readFile(planPath, "utf8")) as CatalogRebuildPlan;
verifyCatalogRebuildPlan(plan);
if (plan.planSha256 !== confirmedPlanSha) throw new Error("CATALOG_PLAN_CONFIRMATION_MISMATCH");

function sourceKey(provider: string, externalGameId: string) {
  return `${provider}:${externalGameId}`;
}

function nameSource(game: PlannedGame) {
  if (!game.nameEn) return "IMPORT";
  if (game.igdbGameId) return "IGDB";
  if (game.sources.some((item) => item.provider === "STEAM")) return "STEAM";
  if (game.sources.some((item) => item.provider === "PLAYSTATION")) return "PLAYSTATION";
  return "NINTENDO";
}

function platformItemGameMap() {
  const result = new Map<string, PlannedGame>();
  for (const game of plan.games) {
    for (const source of game.sources) {
      const key = sourceKey(source.provider, source.externalGameId);
      if (result.has(key)) throw new Error(`PLAN_SOURCE_MAPPED_TWICE:${key}`);
      result.set(key, game);
    }
  }
  for (const item of plan.sourceItems) {
    const key = sourceKey(item.provider, item.externalGameId);
    if (!result.has(key)) throw new Error(`PLAN_SOURCE_UNMAPPED:${key}`);
  }
  return result;
}

async function insertGame(client: pg.Client, game: PlannedGame) {
  await client.query(`
    insert into games (
      id, owner_user_id, name_zh, name_en, name_en_source, platform, platform_source,
      media_type, ownership_status, play_status, started_at, completed_at, last_played_at,
      progress_percent, playtime_minutes_synced, cover_url, cover_url_source,
      release_date, release_date_source, community_rating, community_rating_count,
      critic_rating, critic_rating_count, rating_source, rating_updated_at,
      estimated_hastily_minutes, estimated_normally_minutes, estimated_completely_minutes,
      first_observed_played_at, playtime_last_changed_at, steam_app_id, igdb_game_id,
      acquisition_notes, version
    ) values (
      $1,$2,$3,$4,$5,$6,'CATALOG_REBUILD_V13','DIGITAL',$7,$8,$9,$10,$11,$12,$13,$14,$15,
      $16,case when $16::date is null then 'IMPORT'::data_source else 'IGDB'::data_source end,
      $17,$18,$19,$20,case when $17::numeric is null and $19::numeric is null then null else 'IGDB'::game_rating_source end,
      case when $17::numeric is null and $19::numeric is null then null else $21::timestamptz end,
      $22,$23,$24,$25,$26,$27,$28,$29,1
    )
  `, [
    game.id, plan.ownerUserId, game.nameZh.slice(0, 200), game.nameEn?.slice(0, 200) ?? null, nameSource(game), game.platform,
    game.ownershipStatus, game.playStatus, game.startedAt, game.completedAt, game.lastPlayedAt,
    game.progressPercent, game.playtimeMinutesSynced, game.coverUrl, game.coverUrlSource,
    game.releaseDate, game.communityRating, game.communityRatingCount, game.criticRating, game.criticRatingCount,
    plan.generatedAt, game.estimatedHastilyMinutes, game.estimatedNormallyMinutes, game.estimatedCompletelyMinutes,
    game.startedAt ? `${game.startedAt}T00:00:00.000Z` : null,
    game.playtimeMinutesSynced > 0 ? plan.generatedAt : null,
    game.steamAppId, game.igdbGameId,
    `Catalog V2 rebuilt from ${game.sources.map((source) => source.provider).filter((value, index, array) => array.indexOf(value) === index).join(", ")}`
  ]);
  await client.query("insert into game_status_assignments (game_id,status) values ($1,$2)", [game.id, game.playStatus]);
}

async function insertMappings(client: pg.Client, game: PlannedGame) {
  for (const source of game.sources) {
    await client.query(`
      insert into external_game_mappings (game_id,provider,external_game_id,match_confidence,manually_confirmed)
      values ($1,$2,$3,$4,false)
    `, [game.id, source.provider, source.externalGameId, source.matchMethod === "EXISTING_EXTERNAL_MAPPING" ? 100 : 92]);
  }
}

async function insertAcquisitionAndActivity(client: pg.Client, item: SourceItem, game: PlannedGame) {
  if (item.isOwned && item.provider !== "NINTENDO") {
    await client.query(`
      insert into game_acquisitions (
        owner_user_id,game_id,source,external_acquisition_id,is_owned,details,last_confirmed_at
      ) values ($1,$2,$3,$4,true,$5::jsonb,$6)
    `, [plan.ownerUserId, game.id, item.provider, item.externalGameId, JSON.stringify({
      name: item.name,
      platform: item.platform ?? null,
      source: "catalog_rebuild_v13",
      rawMetadata: item.rawMetadata ?? {}
    }), plan.generatedAt]);
  }
  await client.query(`
    insert into game_activity_snapshots (
      owner_user_id,game_id,provider,external_game_id,total_playtime_minutes,recent_playtime_minutes,last_played_at,observed_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [plan.ownerUserId, game.id, item.provider, item.externalGameId, item.playtimeMinutes ?? 0, item.recentPlaytimeMinutes ?? null, item.lastPlayedAt ?? null, plan.generatedAt]);
}

async function upsertPlatformItem(client: pg.Client, item: SourceItem, game: PlannedGame) {
  await client.query(`
    insert into platform_library_items (
      owner_user_id,provider,external_game_id,name,platform,cover_url,playtime_minutes,
      first_played_at,last_played_at,progress_percent,is_owned,match_status,matched_game_id,
      match_confidence,match_method,raw_metadata,last_seen_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MATCHED',$12,100,'CATALOG_REBUILD_V13',$13::jsonb,$14)
    on conflict (owner_user_id,provider,external_game_id) do update set
      name=excluded.name, platform=excluded.platform, cover_url=excluded.cover_url,
      playtime_minutes=excluded.playtime_minutes, first_played_at=excluded.first_played_at,
      last_played_at=excluded.last_played_at, progress_percent=excluded.progress_percent,
      is_owned=excluded.is_owned, match_status='MATCHED', matched_game_id=excluded.matched_game_id,
      match_confidence=100, match_method='CATALOG_REBUILD_V13', raw_metadata=excluded.raw_metadata,
      last_seen_at=excluded.last_seen_at, updated_at=now()
  `, [
    plan.ownerUserId, item.provider, item.externalGameId, item.name.slice(0, 300), item.platform ?? null,
    item.coverUrl ?? null, item.playtimeMinutes ?? 0, item.firstPlayedAt ?? null, item.lastPlayedAt ?? null,
    item.progressPercent ?? null, item.isOwned, game.id, JSON.stringify(item.rawMetadata ?? {}), plan.generatedAt
  ]);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const requestId = `catalog-v13-${randomUUID()}`;
let before: Record<string, number> | null = null;
let after: Record<string, number> | null = null;
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('game-inventory-catalog-rebuild-v13'))");
  const owner = await client.query("select id from users where id=$1", [plan.ownerUserId]);
  if (owner.rowCount !== 1) throw new Error("CATALOG_OWNER_NOT_FOUND");
  const current = await client.query(`
    select
      (select count(*)::int from games where owner_user_id=$1) as games,
      (select count(*)::int from steam_library_items where owner_user_id=$1 and is_owned=true) as steam,
      (select count(*)::int from assets where owner_user_id=$1) as assets,
      (select count(*)::int from inventory_items where owner_user_id=$1) as inventory,
      (select count(*)::int from inventory_movements m join inventory_items i on i.id=m.item_id where i.owner_user_id=$1) as movements
  `, [plan.ownerUserId]);
  before = current.rows[0];
  if (before!.steam !== plan.summary.steamCount) throw new Error(`LIVE_STEAM_COUNT_CHANGED:${before!.steam}:${plan.summary.steamCount}`);

  await client.query("update steam_library_items set match_status='UNMATCHED', matched_game_id=null, match_confidence=0, match_method='CATALOG_REBUILD_PENDING', updated_at=now() where owner_user_id=$1", [plan.ownerUserId]);
  await client.query("update platform_library_items set match_status='UNMATCHED', matched_game_id=null, match_confidence=0, match_method='CATALOG_REBUILD_PENDING', updated_at=now() where owner_user_id=$1", [plan.ownerUserId]);
  await client.query("delete from games where owner_user_id=$1", [plan.ownerUserId]);

  for (const game of plan.games) await insertGame(client, game);
  for (const game of plan.games) await insertMappings(client, game);
  const gameBySource = platformItemGameMap();
  for (const item of plan.sourceItems) {
    const game = gameBySource.get(sourceKey(item.provider, item.externalGameId))!;
    await insertAcquisitionAndActivity(client, item, game);
    if (item.provider === "STEAM") {
      const updated = await client.query(`
        update steam_library_items set match_status='MATCHED', matched_game_id=$1,
          match_confidence=100, match_method='CATALOG_REBUILD_V13', updated_at=now()
        where owner_user_id=$2 and steam_app_id=$3
      `, [game.id, plan.ownerUserId, Number(item.externalGameId)]);
      if (updated.rowCount !== 1) throw new Error(`STEAM_ITEM_UPDATE_FAILED:${item.externalGameId}`);
    } else {
      await upsertPlatformItem(client, item, game);
    }
  }

  for (const account of plan.accounts) {
    await client.query(`
      insert into external_accounts (owner_user_id,provider,external_user_id,display_name,status,last_synced_at)
      values ($1,$2,$3,$4,'ACTIVE',$5)
      on conflict (owner_user_id,provider) do update set external_user_id=excluded.external_user_id,
        display_name=excluded.display_name,status='ACTIVE',last_synced_at=excluded.last_synced_at,
        last_error_code=null,updated_at=now()
    `, [plan.ownerUserId, account.provider, account.externalUserId, account.displayName, plan.generatedAt]);
  }

  for (const game of plan.games) {
    if (game.communityRating !== null) {
      await client.query(`insert into game_ratings (owner_user_id,game_id,source,kind,score,rating_count,fetched_at) values ($1,$2,'IGDB','COMMUNITY',$3,$4,$5)`,
        [plan.ownerUserId, game.id, game.communityRating, game.communityRatingCount, plan.generatedAt]);
    }
    if (game.criticRating !== null) {
      await client.query(`insert into game_ratings (owner_user_id,game_id,source,kind,score,rating_count,fetched_at) values ($1,$2,'IGDB','CRITIC',$3,$4,$5)`,
        [plan.ownerUserId, game.id, game.criticRating, game.criticRatingCount, plan.generatedAt]);
    }
    if (game.releaseDate) {
      for (const platform of [...new Set(game.platform.split(" / "))]) {
        const dedupeKey = `catalog-v13:${game.id}:${platform}`;
        await client.query(`
          insert into game_release_events (
            owner_user_id,game_id,source,dedupe_key,external_game_id,name_zh,name_en,platform,release_date,
            region,is_announced,cover_url,fetched_at
          ) values ($1,$2,'IGDB',$3,$4,$5,$6,$7,$8,'GLOBAL',true,$9,$10)
        `, [plan.ownerUserId, game.id, dedupeKey, game.igdbGameId ? String(game.igdbGameId) : null, game.nameZh, game.nameEn, platform, game.releaseDate, game.coverUrl, plan.generatedAt]);
      }
    }
  }

  const verified = await client.query(`
    select
      (select count(*)::int from games where owner_user_id=$1 and deleted_at is null) as games,
      (select count(*)::int from steam_library_items where owner_user_id=$1 and is_owned=true and match_status='MATCHED') as steam_matched,
      (select count(*)::int from platform_library_items where owner_user_id=$1 and provider='PLAYSTATION' and match_status='MATCHED') as playstation_matched,
      (select count(*)::int from platform_library_items where owner_user_id=$1 and provider='NINTENDO' and match_status='MATCHED') as nintendo_matched,
      (select count(*)::int from external_game_mappings m join games g on g.id=m.game_id where g.owner_user_id=$1) as mappings,
      (select count(*)::int from assets where owner_user_id=$1) as assets,
      (select count(*)::int from inventory_items where owner_user_id=$1) as inventory,
      (select count(*)::int from inventory_movements m join inventory_items i on i.id=m.item_id where i.owner_user_id=$1) as movements
  `, [plan.ownerUserId]);
  after = verified.rows[0];
  if (after!.games !== plan.games.length) throw new Error(`GAME_RECONCILIATION_FAILED:${after!.games}:${plan.games.length}`);
  if (after!.steam_matched !== plan.summary.steamCount) throw new Error(`STEAM_RECONCILIATION_FAILED:${after!.steam_matched}:${plan.summary.steamCount}`);
  if (after!.playstation_matched !== plan.summary.playstationCount) throw new Error(`PLAYSTATION_RECONCILIATION_FAILED:${after!.playstation_matched}:${plan.summary.playstationCount}`);
  if (after!.nintendo_matched !== plan.summary.nintendoCount) throw new Error(`NINTENDO_RECONCILIATION_FAILED:${after!.nintendo_matched}:${plan.summary.nintendoCount}`);
  if (after!.assets !== before!.assets || after!.inventory !== before!.inventory || after!.movements !== before!.movements) {
    throw new Error("NON_GAME_DATA_CHANGED");
  }
  await client.query(`
    insert into audit_logs (actor_user_id,action,entity_type,entity_id,outcome,request_id,metadata)
    values ($1,'catalog.rebuild.v13','game_catalog',$2,'SUCCESS',$3,$4::jsonb)
  `, [plan.ownerUserId, plan.planSha256, requestId, JSON.stringify({
    planSha256: plan.planSha256,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    backupSha256,
    before,
    after,
    summary: plan.summary
  })]);
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}

const result = {
  status: "PASS",
  appliedAt: new Date().toISOString(),
  planSha256: plan.planSha256,
  sourceSnapshotSha256: plan.sourceSnapshotSha256,
  backupSha256,
  before,
  after,
  summary: plan.summary
};
await mkdir(dirname(resultPath), { recursive: true, mode: 0o700 });
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
await chmod(resultPath, 0o600);
process.stdout.write(`${JSON.stringify(result)}\n`);
