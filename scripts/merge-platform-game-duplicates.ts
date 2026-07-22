import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

type GameRow = {
  id: string;
  owner_user_id: string;
  igdb_game_id: number;
  name_zh: string;
  name_en: string | null;
  platform: string | null;
  is_completed: boolean;
  completed_at: string | null;
  started_at: string | null;
  last_played_at: string | null;
  progress_percent: number | null;
  playtime_minutes_manual: number | null;
  playtime_minutes_synced: number;
  steam_app_id: number | null;
  hltb_game_id: number | null;
  notes: string | null;
  acquisition_notes: string | null;
  updated_at: string;
  platform_record_count: number;
  positive_platform_record_count: number;
  relation_count: number;
};

type MergePair = {
  igdbGameId: number;
  survivor: GameRow;
  redundant: GameRow;
};

const EXPECTED_INITIAL_GROUPS = 12;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const apply = process.argv.includes("--apply");
const confirmIndex = process.argv.indexOf("--confirm-candidate-sha256");
const confirmedCandidateSha256 = confirmIndex >= 0 ? process.argv[confirmIndex + 1] : undefined;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

function asIso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function dateOnly(value: Date | string | null) {
  if (!value) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function earlierDate(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function laterInstant(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function mergeText(left: string | null, right: string | null) {
  const values = [left, right].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return [...new Set(values)].join("\n\n") || null;
}

function mergePlatforms(left: string | null, right: string | null) {
  const rank = new Map([
    ["PS4", 10], ["PS5", 20], ["STEAM", 30], ["PC", 40],
    ["NINTENDO_SWITCH", 50], ["NINTENDO SWITCH", 50], ["SWITCH", 50], ["SWITCH 2", 60]
  ]);
  const values = [left, right]
    .flatMap((value) => value?.split(" / ") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999) || a.localeCompare(b)).join(" / ") || null;
}

async function loadDuplicateRows(client: pg.Client) {
  const result = await client.query<GameRow>(`
    with duplicate_ids as (
      select owner_user_id, igdb_game_id
      from games
      where deleted_at is null and igdb_game_id is not null
      group by owner_user_id, igdb_game_id
      having count(*) > 1
    )
    select
      g.id::text,
      g.owner_user_id::text,
      g.igdb_game_id,
      g.name_zh,
      g.name_en,
      g.platform,
      g.is_completed,
      g.completed_at::text,
      g.started_at::text,
      g.last_played_at::text,
      g.progress_percent,
      g.playtime_minutes_manual,
      g.playtime_minutes_synced,
      g.steam_app_id,
      g.hltb_game_id,
      g.notes,
      g.acquisition_notes,
      g.updated_at::text,
      (
        (select count(*) from platform_library_items item where item.matched_game_id = g.id)
        + (select count(*) from steam_library_items item where item.matched_game_id = g.id)
      )::int as platform_record_count,
      (
        (select count(*) from platform_library_items item where item.matched_game_id = g.id and item.playtime_minutes > 0)
        + (select count(*) from steam_library_items item where item.matched_game_id = g.id and item.playtime_minutes > 0)
      )::int as positive_platform_record_count,
      (
        (select count(*) from external_game_mappings item where item.game_id = g.id)
        + (select count(*) from game_acquisitions item where item.game_id = g.id)
        + (select count(*) from game_activity_snapshots item where item.game_id = g.id)
        + (select count(*) from game_play_sessions item where item.game_id = g.id)
        + (select count(*) from game_field_locks item where item.game_id = g.id)
        + (select count(*) from game_metadata_candidates item where item.game_id = g.id)
        + (select count(*) from game_ratings item where item.game_id = g.id)
        + (select count(*) from game_release_events item where item.game_id = g.id)
        + (select count(*) from game_status_assignments item where item.game_id = g.id)
      )::int as relation_count
    from games g
    join duplicate_ids d using (owner_user_id, igdb_game_id)
    order by g.owner_user_id, g.igdb_game_id, g.id
  `);
  return result.rows.map((row) => ({
    ...row,
    completed_at: dateOnly(row.completed_at),
    started_at: dateOnly(row.started_at),
    last_played_at: asIso(row.last_played_at),
    updated_at: asIso(row.updated_at)!
  }));
}

function buildPairs(rows: GameRow[]) {
  const grouped = new Map<string, GameRow[]>();
  for (const row of rows) {
    const key = `${row.owner_user_id}:${row.igdb_game_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  if (grouped.size !== 0 && grouped.size !== EXPECTED_INITIAL_GROUPS) {
    throw new Error(`PLATFORM_DEDUP_GROUP_COUNT_UNEXPECTED:${grouped.size}:${EXPECTED_INITIAL_GROUPS}`);
  }
  const pairs: MergePair[] = [];
  for (const group of grouped.values()) {
    if (group.length !== 2) throw new Error(`PLATFORM_DEDUP_GROUP_SIZE_INVALID:${group[0]?.igdb_game_id}:${group.length}`);
    if (group.some((row) => row.platform_record_count < 1)) {
      throw new Error(`PLATFORM_DEDUP_NON_PLATFORM_RECORD:${group[0].igdb_game_id}`);
    }
    const completed = group.filter((row) => row.is_completed);
    if (completed.length !== 1) throw new Error(`PLATFORM_DEDUP_SURVIVOR_AMBIGUOUS:${group[0].igdb_game_id}:${completed.length}`);
    const survivor = completed[0];
    const redundant = group.find((row) => row.id !== survivor.id)!;
    if (survivor.owner_user_id !== redundant.owner_user_id) throw new Error("PLATFORM_DEDUP_OWNER_MISMATCH");
    if (survivor.hltb_game_id && redundant.hltb_game_id && survivor.hltb_game_id !== redundant.hltb_game_id) {
      throw new Error(`PLATFORM_DEDUP_HLTB_CONFLICT:${survivor.igdb_game_id}`);
    }
    pairs.push({ igdbGameId: survivor.igdb_game_id, survivor, redundant });
  }
  return pairs.sort((left, right) => left.igdbGameId - right.igdbGameId);
}

function candidateSha256(pairs: MergePair[]) {
  const value = pairs.map(({ igdbGameId, survivor, redundant }) => [
    igdbGameId,
    survivor.id,
    redundant.id,
    survivor.updated_at,
    redundant.updated_at,
    survivor.platform_record_count,
    redundant.platform_record_count,
    survivor.relation_count,
    redundant.relation_count
  ].join("\t")).join("\n");
  return createHash("sha256").update(value).digest("hex");
}

async function counts(client: pg.Client) {
  const result = await client.query<{
    games: number;
    completed: number;
    duplicate_groups: number;
    assets: number;
    inventory: number;
    movements: number;
  }>(`
    select
      (select count(*)::int from games where deleted_at is null) games,
      (select count(*)::int from games where deleted_at is null and is_completed) completed,
      (select count(*)::int from (
        select owner_user_id, igdb_game_id from games
        where deleted_at is null and igdb_game_id is not null
        group by owner_user_id, igdb_game_id having count(*) > 1
      ) duplicate_igdb) duplicate_groups,
      (select count(*)::int from assets where deleted_at is null) assets,
      (select count(*)::int from inventory_items where deleted_at is null) inventory,
      (select count(*)::int from inventory_movements) movements
  `);
  return result.rows[0];
}

async function moveRelations(client: pg.Client, survivorId: string, redundantId: string) {
  await client.query("update steam_library_items set matched_game_id=$1, updated_at=now() where matched_game_id=$2", [survivorId, redundantId]);
  await client.query("update platform_library_items set matched_game_id=$1, updated_at=now() where matched_game_id=$2", [survivorId, redundantId]);
  await client.query("update platform_wishlist_items set matched_game_id=$1, updated_at=now() where matched_game_id=$2", [survivorId, redundantId]);
  await client.query("update external_game_mappings set game_id=$1, updated_at=now() where game_id=$2", [survivorId, redundantId]);
  await client.query("update game_acquisitions set game_id=$1, updated_at=now() where game_id=$2", [survivorId, redundantId]);
  await client.query("update game_activity_snapshots set game_id=$1 where game_id=$2", [survivorId, redundantId]);
  await client.query("update game_play_sessions set game_id=$1 where game_id=$2", [survivorId, redundantId]);

  await client.query(`
    insert into game_field_locks (game_id, field, locked_by_user_id, created_at)
    select $1, field, locked_by_user_id, created_at from game_field_locks where game_id=$2
    on conflict (game_id, field) do nothing
  `, [survivorId, redundantId]);
  await client.query("delete from game_field_locks where game_id=$1", [redundantId]);

  await client.query(`
    delete from game_metadata_candidates source
    using game_metadata_candidates target
    where source.game_id=$2 and target.game_id=$1
      and source.provider=target.provider
      and source.external_game_id=target.external_game_id
      and source.field=target.field
  `, [survivorId, redundantId]);
  await client.query("update game_metadata_candidates set game_id=$1, updated_at=now() where game_id=$2", [survivorId, redundantId]);

  await client.query(`
    delete from game_ratings target
    using game_ratings source
    where target.game_id=$1 and source.game_id=$2
      and target.source=source.source and target.kind=source.kind
      and (source.fetched_at > target.fetched_at
        or (source.fetched_at = target.fetched_at and coalesce(source.rating_count,0) > coalesce(target.rating_count,0)))
  `, [survivorId, redundantId]);
  await client.query(`
    delete from game_ratings source
    using game_ratings target
    where source.game_id=$2 and target.game_id=$1
      and source.source=target.source and source.kind=target.kind
  `, [survivorId, redundantId]);
  await client.query("update game_ratings set game_id=$1, updated_at=now() where game_id=$2", [survivorId, redundantId]);

  await client.query("update game_release_events set game_id=$1, updated_at=now() where game_id=$2", [survivorId, redundantId]);
  await client.query(`
    delete from game_release_events duplicate
    using game_release_events keeper
    where duplicate.owner_user_id=keeper.owner_user_id
      and duplicate.game_id=$1 and keeper.game_id=$1
      and duplicate.id > keeper.id
      and duplicate.source=keeper.source
      and coalesce(duplicate.external_game_id,'')=coalesce(keeper.external_game_id,'')
      and duplicate.platform=keeper.platform
      and duplicate.release_date=keeper.release_date
      and duplicate.date_precision=keeper.date_precision
      and duplicate.region=keeper.region
  `, [survivorId]);

  await client.query(`
    insert into game_status_assignments (game_id, status, created_at)
    select $1, status, created_at
    from game_status_assignments
    where game_id=$2 and status <> 'BACKLOG'
    on conflict (game_id, status) do nothing
  `, [survivorId, redundantId]);
  await client.query("delete from game_status_assignments where game_id=$1", [redundantId]);
}

async function recomputePlatformActivity(client: pg.Client, gameId: string) {
  const result = await client.query<{
    total_minutes: number;
    first_played_at: string | null;
    last_played_at: string | null;
  }>(`
    with steam as (
      select coalesce(sum(playtime_minutes),0)::int total,
             min(created_at)::text first_played_at,
             max(last_played_at)::text last_played_at
      from steam_library_items
      where matched_game_id=$1 and match_status='MATCHED' and is_owned=true
    ), platform as (
      select
        coalesce(max(playtime_minutes) filter (where provider='PLAYSTATION'),0)::int ps,
        coalesce(max(playtime_minutes) filter (where provider='NINTENDO'),0)::int nintendo,
        min(coalesce(first_played_at,created_at)) filter (where playtime_minutes > 0)::text first_played_at,
        max(last_played_at)::text last_played_at
      from platform_library_items
      where matched_game_id=$1 and match_status='MATCHED'
    )
    select
      (steam.total + platform.ps + platform.nintendo)::int total_minutes,
      least(steam.first_played_at,platform.first_played_at) first_played_at,
      greatest(steam.last_played_at,platform.last_played_at) last_played_at
    from steam cross join platform
  `, [gameId]);
  return result.rows[0];
}

async function applyPair(client: pg.Client, pair: MergePair) {
  const { survivor, redundant } = pair;
  await client.query(`
    update games set steam_app_id=null, igdb_game_id=null, hltb_game_id=null, updated_at=now()
    where id=$1 and deleted_at is null
  `, [redundant.id]);
  await moveRelations(client, survivor.id, redundant.id);

  const platform = mergePlatforms(survivor.platform, redundant.platform);
  await client.query(`
    update games
    set
      platform=$2,
      platform_source='PLATFORM_CANONICAL_V0191',
      ownership_status=case when exists(select 1 from game_acquisitions a where a.game_id=$1 and a.is_owned) then 'OWNED' else ownership_status end,
      is_completed=(is_completed or $3),
      completed_at=coalesce(completed_at,$4::date),
      started_at=coalesce(least(started_at,$5::date),started_at,$5::date),
      last_played_at=coalesce(greatest(last_played_at,$6::timestamptz),last_played_at,$6::timestamptz),
      progress_percent=coalesce(greatest(progress_percent,$7::int),progress_percent,$7::int),
      playtime_minutes_manual=coalesce(greatest(playtime_minutes_manual,$8::int),playtime_minutes_manual,$8::int),
      steam_app_id=coalesce(steam_app_id,$9::int),
      igdb_game_id=$10::int,
      hltb_game_id=coalesce(hltb_game_id,$11::int),
      notes=$12,
      acquisition_notes=$13,
      updated_at=now(),
      version=version+1
    where id=$1 and owner_user_id=$14 and deleted_at is null
  `, [
    survivor.id,
    platform,
    redundant.is_completed,
    earlierDate(survivor.completed_at, redundant.completed_at),
    earlierDate(survivor.started_at, redundant.started_at),
    laterInstant(survivor.last_played_at, redundant.last_played_at),
    redundant.progress_percent,
    redundant.playtime_minutes_manual,
    survivor.steam_app_id ?? redundant.steam_app_id,
    pair.igdbGameId,
    survivor.hltb_game_id ?? redundant.hltb_game_id,
    mergeText(survivor.notes, redundant.notes),
    mergeText(survivor.acquisition_notes, redundant.acquisition_notes),
    survivor.owner_user_id
  ]);

  const activity = await recomputePlatformActivity(client, survivor.id);
  await client.query(`
    update games
    set playtime_minutes_synced=$2,
        first_observed_played_at=coalesce(least(first_observed_played_at,$3::timestamptz),first_observed_played_at,$3::timestamptz),
        last_played_at=coalesce(greatest(last_played_at,$4::timestamptz),last_played_at,$4::timestamptz),
        playtime_last_changed_at=case when playtime_minutes_synced <> $2 then now() else playtime_last_changed_at end,
        updated_at=now(), version=version+1
    where id=$1 and deleted_at is null
  `, [survivor.id, activity.total_minutes, activity.first_played_at, activity.last_played_at]);

  await client.query(`
    delete from game_status_assignments
    where game_id=$1 and status='BACKLOG'
      and exists(select 1 from games g where g.id=$1 and (g.is_completed or g.playtime_minutes_synced > 0))
  `, [survivor.id]);
  await client.query(`
    update games
    set deleted_at=now(), updated_at=now(), version=version+1
    where id=$1 and owner_user_id=$2 and deleted_at is null
  `, [redundant.id, survivor.owner_user_id]);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const before = await counts(client);
  const initialPairs = buildPairs(await loadDuplicateRows(client));
  const initialSha256 = candidateSha256(initialPairs);
  const preview = {
    event: "platform-game-dedup-preview",
    strategy: "keep-completed-platform-record-and-merge-platform-relations",
    before,
    groupCount: initialPairs.length,
    redundantCount: initialPairs.length,
    candidateSha256: initialSha256,
    pairs: initialPairs.map(({ igdbGameId, survivor, redundant }) => ({
      igdbGameId,
      survivor: { id: survivor.id, nameZh: survivor.name_zh, platform: survivor.platform, platformRecords: survivor.platform_record_count },
      redundant: { id: redundant.id, nameZh: redundant.name_zh, platform: redundant.platform, platformRecords: redundant.platform_record_count }
    }))
  };
  console.log(JSON.stringify(preview));
  if (!apply) process.exitCode = 0;
  else {
    if (process.env.ALLOW_PLATFORM_GAME_DEDUP !== "true") throw new Error("ALLOW_PLATFORM_GAME_DEDUP=true is required");
    if (!confirmedCandidateSha256) throw new Error("--confirm-candidate-sha256 is required");
    if (confirmedCandidateSha256 !== initialSha256) throw new Error("PLATFORM_DEDUP_CANDIDATE_CHANGED");
    if (initialPairs.length === 0) {
      console.log(JSON.stringify({ event: "platform-game-dedup-applied", updatedCount: 0, candidateSha256: EMPTY_SHA256, before, after: before }));
    } else {
      await client.query("begin");
      try {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", ["game-inventory-platform-dedup-v0191"]);
        const freshPairs = buildPairs(await loadDuplicateRows(client));
        const freshSha256 = candidateSha256(freshPairs);
        if (freshSha256 !== initialSha256) throw new Error("PLATFORM_DEDUP_CANDIDATE_CHANGED_AFTER_LOCK");
        for (const pair of freshPairs) await applyPair(client, pair);
        const after = await counts(client);
        if (after.games !== before.games - freshPairs.length) throw new Error(`PLATFORM_DEDUP_GAME_COUNT_INVALID:${after.games}`);
        if (after.completed !== before.completed) throw new Error(`PLATFORM_DEDUP_COMPLETION_COUNT_CHANGED:${after.completed}:${before.completed}`);
        if (after.duplicate_groups !== 0) throw new Error(`PLATFORM_DEDUP_REMAINS:${after.duplicate_groups}`);
        if (after.assets !== before.assets || after.inventory !== before.inventory || after.movements !== before.movements) {
          throw new Error("PLATFORM_DEDUP_NON_GAME_DATA_CHANGED");
        }
        await client.query(`
          insert into audit_logs (actor_user_id,action,entity_type,entity_id,outcome,request_id,metadata)
          values ($1,'game.dedup.platform_canonical','game_bulk',null,'SUCCESS',$2,$3::jsonb)
        `, [freshPairs[0].survivor.owner_user_id, randomUUID(), JSON.stringify({
          strategy: preview.strategy,
          candidateSha256: freshSha256,
          before,
          after,
          pairs: preview.pairs
        })]);
        await client.query("commit");
        console.log(JSON.stringify({ event: "platform-game-dedup-applied", updatedCount: freshPairs.length, candidateSha256: freshSha256, before, after }));
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  }
} finally {
  await client.end();
}
