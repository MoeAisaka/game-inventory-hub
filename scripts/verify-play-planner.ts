import { sql } from "drizzle-orm";
import { closeDatabase, db } from "@/server/db";

type Summary = {
  plans: number;
  queued: number;
  playing: number;
  active_distinct: number;
  commute_playing: number;
  fixed_playing: number;
  missing_channel: number;
  missing_hltb: number;
  invalid_owner: number;
  invalid_acquisition: number;
  invalid_commute: number;
  invalid_playing_order: number;
  duplicate_slots: number;
};

function expected(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`INVALID_${name}`);
  return value;
}

async function main() {
  const result = await db.execute<Summary>(sql`
    with planner_games as (
      select distinct p.game_id
      from game_play_plans p
    ), duplicate_slots as (
      select owner_user_id, scenario
      from game_play_plans
      where state = 'PLAYING'
      group by owner_user_id, scenario
      having count(*) > 1
    )
    select
      count(*)::int as plans,
      count(*) filter (where p.state = 'QUEUED')::int as queued,
      count(*) filter (where p.state = 'PLAYING')::int as playing,
      count(distinct p.game_id) filter (where p.state = 'PLAYING')::int as active_distinct,
      count(*) filter (where p.scenario = 'COMMUTE' and p.state = 'PLAYING')::int as commute_playing,
      count(*) filter (where p.scenario = 'FIXED' and p.state = 'PLAYING')::int as fixed_playing,
      count(*) filter (where p.state = 'QUEUED' and a.channel is null)::int as missing_channel,
      count(*) filter (where p.state = 'QUEUED' and g.estimated_normally_minutes is null)::int as missing_hltb,
      count(*) filter (where p.owner_user_id <> g.owner_user_id)::int as invalid_owner,
      count(*) filter (where p.acquisition_id is not null and (
        a.id is null or a.owner_user_id <> p.owner_user_id or a.game_id <> p.game_id or a.availability <> 'AVAILABLE'
      ))::int as invalid_acquisition,
      count(*) filter (where p.scenario = 'COMMUTE' and p.acquisition_id is not null and case
        when upper(coalesce(a.source::text, '')) like '%STEAM%' then
          coalesce(a.details->>'manuallyClassified', 'false') = 'true' and coalesce(a.offline_capable, false) = false
        when upper(coalesce(a.source::text, '')) like '%PLAYSTATION%' then true
        when upper(coalesce(a.source::text, '')) like '%NINTENDO%' then
          coalesce(a.details->>'manuallyClassified', 'false') = 'true' and coalesce(a.offline_capable, false) = false
        when upper(coalesce(a.platform::text, '')) like '%PLAYSTATION%'
          or upper(coalesce(a.platform::text, '')) like '%PS4%'
          or upper(coalesce(a.platform::text, '')) like '%PS5%' then true
        when coalesce(a.details->>'manuallyClassified', 'false') = 'true' then coalesce(a.offline_capable, false) = false
        when upper(coalesce(a.platform::text, '')) like '%NINTENDO%'
          or upper(coalesce(a.platform::text, '')) like '%SWITCH%'
          or upper(coalesce(a.platform::text, '')) like '%STEAM%' then false
        else coalesce(a.offline_capable, false) = false
      end)::int as invalid_commute,
      count(*) filter (where p.state = 'PLAYING' and p.queue_order is not null)::int as invalid_playing_order,
      (select count(*)::int from duplicate_slots) as duplicate_slots
    from game_play_plans p
    join games g on g.id = p.game_id and g.deleted_at is null
    left join game_acquisitions a on a.id = p.acquisition_id
  `);
  const actual = result.rows[0];
  if (!actual) throw new Error("PLAY_PLANNER_SUMMARY_MISSING");
  const failures: string[] = [];
  for (const key of ["invalid_owner", "invalid_acquisition", "invalid_commute", "invalid_playing_order", "duplicate_slots"] as const) {
    if (Number(actual[key]) !== 0) failures.push(`${key}:${actual[key]}`);
  }
  if (Number(actual.active_distinct) > 2) failures.push(`active_distinct:${actual.active_distinct}>2`);
  const expectedChecks = {
    plans: expected("EXPECTED_PLAY_PLAN_TOTAL"),
    queued: expected("EXPECTED_PLAY_PLAN_QUEUED"),
    playing: expected("EXPECTED_PLAY_PLAN_PLAYING"),
    commute_playing: expected("EXPECTED_PLAY_PLAN_COMMUTE_PLAYING"),
    fixed_playing: expected("EXPECTED_PLAY_PLAN_FIXED_PLAYING")
  };
  for (const [key, value] of Object.entries(expectedChecks)) {
    if (value !== null && Number(actual[key as keyof Summary]) !== value) {
      failures.push(`${key}:${actual[key as keyof Summary]}!=${value}`);
    }
  }
  const report = { ok: failures.length === 0, checkedAt: new Date().toISOString(), actual, expected: expectedChecks, failures };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeDatabase);
