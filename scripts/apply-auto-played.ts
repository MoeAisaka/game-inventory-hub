import { asc } from "drizzle-orm";
import { closeDatabase, db } from "@/server/db";
import { users } from "@/server/db/schema";
import { autoClassifyPlayedGames, previewAutoPlayedGames } from "@/server/services/game-auto-status";

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const asOfText = valueAfter("--as-of");
const asOf = asOfText ? new Date(asOfText) : new Date();
const expected = valueAfter("--confirm-candidate-sha256");
const expectedCount = valueAfter("--expected-count");
const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
if (!owner) throw new Error("NO_OWNER");

try {
  const preview = await previewAutoPlayedGames(owner.id, { asOf, inactivityHours: 48 });
  console.log(JSON.stringify({ event: "preview", ...preview }));
  if (!apply) process.exitCode = 0;
  else {
    if (process.env.ALLOW_GAME_STATUS_AUTOMATION !== "true") throw new Error("ALLOW_GAME_STATUS_AUTOMATION=true is required");
    if (!expected) throw new Error("--confirm-candidate-sha256 is required");
    if (expectedCount !== undefined && Number(expectedCount) !== preview.changeCount) throw new Error("AUTO_PLAYED_COUNT_CHANGED");
    const result = await autoClassifyPlayedGames(owner.id, {
      asOf,
      inactivityHours: 48,
      expectedCandidateSha256: expected
    });
    console.log(JSON.stringify({ event: "applied", ...result }));
  }
} finally {
  await closeDatabase();
}
