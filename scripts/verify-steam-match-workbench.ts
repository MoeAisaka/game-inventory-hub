import { asc } from "drizzle-orm";
import { closeDatabase, db } from "../src/server/db";
import { users } from "../src/server/db/schema";
import { steamLibraryOverview } from "../src/server/integrations/steam-library";

const expected = {
  total: Number(process.env.EXPECTED_STEAM_ACTIVE ?? 1_435),
  matched: Number(process.env.EXPECTED_STEAM_MATCHED ?? 363),
  unmatched: Number(process.env.EXPECTED_STEAM_UNMATCHED ?? 1_072),
  unavailableFamily: Number(process.env.EXPECTED_STEAM_UNAVAILABLE_FAMILY ?? 9),
  ownedMissing: Number(process.env.EXPECTED_STEAM_OWNED_MISSING ?? 9),
  review: Number(process.env.EXPECTED_STEAM_REVIEW ?? 52),
  nonGame: Number(process.env.EXPECTED_STEAM_NON_GAME ?? 5),
  catalog: Number(process.env.EXPECTED_STEAM_CATALOG ?? 1_006),
  actionable: Number(process.env.EXPECTED_STEAM_ACTIONABLE ?? 66)
};

async function main() {
  const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
  if (!owner) throw new Error("No owner user exists");

  const overview = await steamLibraryOverview(owner.id);
  const actual = {
    total: overview.summary.total,
    matched: overview.summary.matched,
    unmatched: overview.summary.unmatched,
    unavailableFamily: overview.summary.unavailableFamily,
    ownedMissing: overview.workbench.counts.OWNED_MISSING,
    review: overview.workbench.counts.REVIEW,
    nonGame: overview.workbench.counts.NON_GAME,
    catalog: overview.workbench.counts.CATALOG,
    actionable: overview.workbench.counts.actionable
  };
  const failures = Object.entries(expected)
    .filter(([key, value]) => actual[key as keyof typeof actual] !== value)
    .map(([key, value]) => `${key}:${actual[key as keyof typeof actual]}!=${value}`);
  const report = { ok: failures.length === 0, checkedAt: new Date().toISOString(), expected, actual, failures };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeDatabase);
