import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { hardwareSeedSchema, type HardwareSeedEntry } from "@/lib/hardware-seed";
import { defaultHardwareProfile } from "@/lib/purchase-advisor";
import { normalizeGameSearchText } from "@/lib/game-search";
import { writeAudit } from "@/server/audit";
import { closeDatabase, db } from "@/server/db";
import { gameDualsenseProfiles, gameFieldLocks, games, userPreferences, users } from "@/server/db/schema";
import { HARDWARE_PROFILE_NAMESPACE } from "@/server/services/preferences";

/**
 * V0.33.0：导入按 PS5 主机 / PC USB 有线 / PC 蓝牙分开的 DualSense 档案 + 光追档案种子。
 * - 按游戏名（中文名/英文名/搜索别名 vs 种子名/别名，归一化后精确比对）匹配库内游戏；匹配不到的输出清单并跳过。
 * - 尊重 gameFieldLocks：DUALSENSE_PROFILE / RAY_TRACING_PROFILE 已被人工锁定的部分不覆盖。
 * - 同时以 onConflictDoNothing 写入默认用户硬件档案（PS5 + RTX 5090D 高端 PC + Switch），不覆盖既有配置。
 */

const seedPath = join(process.cwd(), "data/hardware-profiles-v0320.json");
const seed = hardwareSeedSchema.parse(JSON.parse(readFileSync(seedPath, "utf8")));

const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
if (!owner) throw new Error("NO_OWNER");

function candidateNames(entry: HardwareSeedEntry) {
  return [entry.nameZh, ...entry.aliases].map(normalizeGameSearchText).filter(Boolean);
}

function legacyPcWiredRequirement(entry: HardwareSeedEntry) {
  const usb = entry.dualsense.profiles.find((profile) => profile.environment === "PC_USB")!;
  const bluetooth = entry.dualsense.profiles.find((profile) => profile.environment === "PC_BLUETOOTH")!;
  const dimensions = ["adaptiveTriggers", "hapticFeedback", "controllerSpeaker", "touchpad", "controllerMic"] as const;
  if (dimensions.some((dimension) => bluetooth[dimension] === "BASIC" || bluetooth[dimension] === "RICH")) return "FALSE" as const;
  if (dimensions.some((dimension) => usb[dimension] !== "UNKNOWN")
    && dimensions.every((dimension) => bluetooth[dimension] === "NONE")) return "TRUE" as const;
  return "UNKNOWN" as const;
}

try {
  const rows = await db.select({
    id: games.id,
    nameZh: games.nameZh,
    nameEn: games.nameEn,
    searchAliases: games.searchAliases
  }).from(games).where(and(eq(games.ownerUserId, owner.id), isNull(games.deletedAt)));

  const byNormalizedName = new Map<string, Set<string>>();
  for (const row of rows) {
    const names = [row.nameZh, row.nameEn ?? "", ...row.searchAliases].map(normalizeGameSearchText).filter(Boolean);
    for (const name of names) {
      const ids = byNormalizedName.get(name) ?? new Set<string>();
      ids.add(row.id);
      byNormalizedName.set(name, ids);
    }
  }

  const summary = { entries: seed.length, updated: 0, dualsenseLockedSkipped: 0, rayTracingLockedSkipped: 0, fullyLockedSkipped: 0 };
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const now = new Date();

  for (const entry of seed) {
    const matchedIds = new Set<string>();
    for (const name of candidateNames(entry)) {
      for (const id of byNormalizedName.get(name) ?? []) matchedIds.add(id);
    }
    if (!matchedIds.size) {
      unmatched.push(entry.nameZh);
      continue;
    }
    if (matchedIds.size > 1) {
      ambiguous.push(`${entry.nameZh}（命中 ${matchedIds.size} 条库内记录）`);
      continue;
    }
    const [gameId] = matchedIds;
    const locks = new Set((await db.select({ field: gameFieldLocks.field })
      .from(gameFieldLocks)
      .where(and(
        eq(gameFieldLocks.gameId, gameId),
        inArray(gameFieldLocks.field, ["DUALSENSE_PROFILE", "RAY_TRACING_PROFILE"])
      ))).map((lock) => lock.field));
    const dualsenseLocked = locks.has("DUALSENSE_PROFILE");
    const rayTracingLocked = locks.has("RAY_TRACING_PROFILE");
    if (dualsenseLocked) summary.dualsenseLockedSkipped += 1;
    if (rayTracingLocked) summary.rayTracingLockedSkipped += 1;
    if (dualsenseLocked && rayTracingLocked) {
      summary.fullyLockedSkipped += 1;
      console.log(JSON.stringify({ event: "locked", nameZh: entry.nameZh, gameId }));
      continue;
    }
    await db.transaction(async (transaction) => {
      const ps5 = entry.dualsense.profiles.find((profile) => profile.environment === "PS5_CONSOLE")!;
      if (!dualsenseLocked) {
        for (const profile of entry.dualsense.profiles) {
          await transaction.insert(gameDualsenseProfiles).values({
            ownerUserId: owner.id,
            gameId,
            ...profile,
            source: "IMPORT"
          }).onConflictDoUpdate({
            target: [gameDualsenseProfiles.gameId, gameDualsenseProfiles.environment],
            set: {
              adaptiveTriggers: profile.adaptiveTriggers,
              hapticFeedback: profile.hapticFeedback,
              controllerSpeaker: profile.controllerSpeaker,
              touchpad: profile.touchpad,
              controllerMic: profile.controllerMic,
              notes: profile.notes,
              source: "IMPORT",
              version: sql`${gameDualsenseProfiles.version} + 1`,
              updatedAt: now
            }
          });
        }
      }
      await transaction.update(games).set({
        ...(dualsenseLocked ? {} : {
          // Dual-write the PS5 row into the legacy columns until the rollback
          // compatibility window closes.
          dualsenseAdaptiveTriggers: ps5.adaptiveTriggers,
          dualsenseHapticFeedback: ps5.hapticFeedback,
          dualsenseControllerSpeaker: ps5.controllerSpeaker,
          dualsenseTouchpad: ps5.touchpad,
          dualsenseControllerMic: ps5.controllerMic,
          dualsenseNotes: ps5.notes,
          pcWiredRequired: legacyPcWiredRequirement(entry)
        }),
        ...(rayTracingLocked ? {} : {
          rayTracing: entry.rayTracing.level,
          rayTracingNotes: entry.rayTracing.notes
        }),
        hardwareProfileSource: "IMPORT",
        updatedAt: now
      }).where(eq(games.id, gameId));
    });
    summary.updated += 1;
    console.log(JSON.stringify({ event: "updated", nameZh: entry.nameZh, gameId, dualsenseLocked, rayTracingLocked }));
  }

  await db.insert(userPreferences).values({
    ownerUserId: owner.id,
    namespace: HARDWARE_PROFILE_NAMESPACE,
    value: defaultHardwareProfile
  }).onConflictDoNothing();

  await writeAudit({
    actorUserId: owner.id,
    action: "game.hardware_profiles.import",
    entityType: "game_catalog",
    entityId: owner.id,
    outcome: "SUCCESS",
    requestId: `hardware-import-${Date.now()}`,
    metadata: { ...summary, unmatched, ambiguous }
  });
  console.log(JSON.stringify({ event: "complete", ...summary, unmatched, ambiguous }));
  if (unmatched.length) console.log(`未匹配到库内游戏（已跳过）：${unmatched.join("、")}`);
  if (ambiguous.length) console.log(`名称命中多条记录（已跳过，请人工处理）：${ambiguous.join("、")}`);
} finally {
  await closeDatabase();
}
