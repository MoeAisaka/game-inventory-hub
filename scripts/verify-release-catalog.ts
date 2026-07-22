import { sql } from "drizzle-orm";
import { closeDatabase, db } from "@/server/db";
import { gameReleaseEvents } from "@/server/db/schema";
import { releaseCatalogMatchesQuery, releaseCatalogMissingFields } from "@/server/services/releases";

const requiredColumns = [
  "store_provider",
  "store_external_game_id",
  "summary_zh",
  "summary_en",
  "developers",
  "publishers",
  "genres_zh",
  "genres_en",
  "metadata_fetched_at"
] as const;

async function main() {
  const columnRows = await db.execute<{ column_name: string }>(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_release_events'
  `);
  const columns = new Set(columnRows.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter((column) => !columns.has(column));
  if (missingColumns.length) throw new Error(`RELEASE_CATALOG_SCHEMA_MISSING:${missingColumns.join(",")}`);

  const events = await db.select().from(gameReleaseEvents).where(sql`
    ${gameReleaseEvents.source} = 'IGDB'
    and ${gameReleaseEvents.dedupeKey} like 'catalog:igdb:release:%'
  `);
  const duplicateRows = await db.execute<{ duplicate_count: string }>(sql`
    select count(*)::text as duplicate_count
    from (
      select owner_user_id, dedupe_key
      from game_release_events
      where source = 'IGDB' and dedupe_key like 'catalog:igdb:release:%'
      group by owner_user_id, dedupe_key
      having count(*) > 1
    ) duplicate_groups
  `);
  const duplicateCount = Number(duplicateRows.rows[0]?.duplicate_count ?? 0);
  if (duplicateCount) throw new Error(`RELEASE_CATALOG_DUPLICATE_KEYS:${duplicateCount}`);

  const complete = events.filter((event) => releaseCatalogMissingFields(event).length === 0);
  const partial = events.length - complete.length;
  const invalidComplete = complete.filter((event) => !event.storeUrl || !event.storeProvider || !event.storeExternalGameId);
  if (invalidComplete.length) throw new Error(`RELEASE_CATALOG_INVALID_COMPLETE:${invalidComplete.length}`);

  const aincradEvents = events.filter((event) => releaseCatalogMatchesQuery(event, "Aincrad"));
  if (!aincradEvents.length) throw new Error("RELEASE_CATALOG_AINCRAD_FIXTURE_MISSING");
  const aincradShortQueryMatches = events.filter((event) => releaseCatalogMatchesQuery(event, "艾恩"));
  if (!aincradShortQueryMatches.some((event) => aincradEvents.some((candidate) => candidate.id === event.id))) {
    throw new Error("RELEASE_CATALOG_AINCRAD_SHORT_QUERY_MISSING");
  }

  console.log(JSON.stringify({
    status: "RELEASE_CATALOG_VERIFIED",
    events: events.length,
    complete: complete.length,
    partial,
    duplicateCount,
    requiredColumns: requiredColumns.length,
    aincradShortQueryMatches: aincradShortQueryMatches.length
  }));
}

main().finally(closeDatabase);
