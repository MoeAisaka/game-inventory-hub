import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const outputArg = process.argv.findIndex((value) => value === "--output");
if (outputArg < 0 || !process.argv[outputArg + 1]) throw new Error("--output is required");
const output = resolve(process.argv[outputArg + 1]);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const owners = await client.query<{ id: string }>("select id from users order by created_at");
  if (owners.rowCount !== 1) throw new Error(`OWNER_COUNT_INVALID:${owners.rowCount}`);
  const ownerUserId = owners.rows[0].id;
  const steamResult = await client.query(`
      select steam_app_id, name, playtime_minutes, recent_playtime_minutes,
             last_played_at, icon_url, is_owned
      from steam_library_items
      where owner_user_id = $1 and is_owned = true
      order by steam_app_id
    `, [ownerUserId]);
  const igdbResult = await client.query(`
      select m.external_game_id, g.id as old_game_id, g.name_zh, g.name_en,
             g.cover_url, g.release_date, g.community_rating, g.community_rating_count,
             g.critic_rating, g.critic_rating_count, g.estimated_hastily_minutes,
             g.estimated_normally_minutes, g.estimated_completely_minutes
      from external_game_mappings m
      join games g on g.id = m.game_id
      where g.owner_user_id = $1 and g.deleted_at is null and m.provider = 'IGDB'
      order by m.external_game_id::bigint
    `, [ownerUserId]);
  const mappingResult = await client.query(`
      select m.game_id as old_game_id, m.provider, m.external_game_id
      from external_game_mappings m
      join games g on g.id = m.game_id
      where g.owner_user_id = $1 and g.deleted_at is null
        and m.provider in ('STEAM','PLAYSTATION','NINTENDO','IGDB')
      order by m.game_id, m.provider, m.external_game_id
    `, [ownerUserId]);
  if (!steamResult.rowCount) throw new Error("STEAM_SOURCE_EMPTY");
  if (!igdbResult.rowCount) throw new Error("IGDB_SOURCE_EMPTY");
  const capturedAt = new Date().toISOString();
  const payload = {
    schemaVersion: "catalog-production-sources.v1",
    capturedAt,
    ownerUserId,
    steam: steamResult.rows.map((row) => ({
      provider: "STEAM",
      externalGameId: String(row.steam_app_id),
      name: row.name,
      platform: "STEAM",
      coverUrl: row.icon_url,
      playtimeMinutes: row.playtime_minutes,
      recentPlaytimeMinutes: row.recent_playtime_minutes,
      firstPlayedAt: null,
      lastPlayedAt: row.last_played_at ? new Date(row.last_played_at).toISOString() : null,
      progressPercent: null,
      isOwned: row.is_owned,
      rawMetadata: { steamAppId: row.steam_app_id, source: "steam_owned_games" }
    })),
    igdb: igdbResult.rows.map((row) => ({
      externalGameId: String(row.external_game_id),
      oldGameId: String(row.old_game_id),
      nameZh: row.name_zh,
      nameEn: row.name_en,
      coverUrl: row.cover_url,
      releaseDate: row.release_date,
      communityRating: row.community_rating === null ? null : Number(row.community_rating),
      communityRatingCount: row.community_rating_count,
      criticRating: row.critic_rating === null ? null : Number(row.critic_rating),
      criticRatingCount: row.critic_rating_count,
      estimatedHastilyMinutes: row.estimated_hastily_minutes,
      estimatedNormallyMinutes: row.estimated_normally_minutes,
      estimatedCompletelyMinutes: row.estimated_completely_minutes
    })),
    existingMappings: mappingResult.rows.map((row) => ({
      oldGameId: String(row.old_game_id),
      provider: row.provider,
      externalGameId: String(row.external_game_id)
    }))
  };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`${JSON.stringify({ ok: true, output, counts: { steam: steamResult.rowCount, igdb: igdbResult.rowCount, mappings: mappingResult.rowCount } })}\n`);
} finally {
  await client.end();
}
