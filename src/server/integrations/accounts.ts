import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { externalAccounts } from "@/server/db/schema";

export const steamAccountSchema = z.object({
  steamId: z.string().regex(/^\d{17}$/, "SteamID64 必须是17位数字"),
  displayName: z.string().trim().min(1).max(100).nullable().optional()
});

export async function saveSteamAccount(
  ownerUserId: string,
  input: z.infer<typeof steamAccountSchema>,
  requestId: string = randomUUID()
) {
  const [account] = await db.insert(externalAccounts).values({
    ownerUserId,
    provider: "STEAM",
    externalUserId: input.steamId,
    displayName: input.displayName ?? null,
    status: "ACTIVE",
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: [externalAccounts.ownerUserId, externalAccounts.provider],
    set: {
      externalUserId: input.steamId,
      displayName: input.displayName ?? null,
      status: "ACTIVE",
      lastErrorCode: null,
      updatedAt: new Date()
    }
  }).returning();
  await writeAudit({ actorUserId: ownerUserId, action: "external_account.steam.save", entityType: "external_account", entityId: account.id, outcome: "SUCCESS", requestId });
  return account;
}

export async function getExternalAccount(ownerUserId: string, provider: "STEAM" | "IGDB" | "PLAYSTATION" | "NINTENDO") {
  return (await db.select().from(externalAccounts).where(and(
    eq(externalAccounts.ownerUserId, ownerUserId),
    eq(externalAccounts.provider, provider)
  )).limit(1))[0] ?? null;
}
