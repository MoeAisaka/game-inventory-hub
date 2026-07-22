import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login } from "@/server/auth/login";
import { deriveActivityState, visibleActivityState } from "@/lib/game-insights";
import { splitProductNameAndPurchaseUrl } from "@/lib/purchase-link";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { hashSessionToken, newSessionToken } from "@/server/auth/session";
import { closeDatabase, db } from "@/server/db";
import {
  assets,
  attachments,
  auditLogs,
  authLoginAttempts,
  externalAccounts,
  externalGameMappings,
  fileBlobs,
  gameAcquisitions,
  gameActivitySnapshots,
  gameDualsenseProfiles,
  gameFieldLocks,
  gameMediaItems,
  gameMetadataCandidates,
  gamePlayPlans,
  gamePlaySessions,
  gameRatings,
  gameReleaseEvents,
  gameStatusAssignments,
  games,
  importBatches,
  importImageRefs,
  importReconciliations,
  importRows,
  inventoryItems,
  inventoryMovements,
  inventoryProducts,
  inventoryVariantMovements,
  inventoryVariants,
  platformLibraryItems,
  platformWishlistItems,
  sessions,
  steamLibraryItems,
  syncJobs,
  userPreferences,
  users
} from "@/server/db/schema";
import { commitMigrationBatch } from "@/server/migration/commit";
import { createImportBatch, createImportBatchSchema } from "@/server/services/imports";
import { registerFileBlob, registerFileBlobSchema } from "@/server/services/attachments";
import { rollbackMigrationBatch, runMigrationDryRun } from "@/server/migration/service";
import { addPlaySession, bulkManageGames, createGame, createGameSchema, gameQuerySchema, gameStatusesAfterQuickAction, getGame, listGames, quickUpdateGameStatus, quickUpdateGameWishlist, updateGame } from "@/server/services/games";
import { addInventoryMovement, createInventoryItem, updateInventoryItem } from "@/server/services/inventory";
import {
  addInventoryVariant,
  applyInventoryAction,
  createInventoryProduct,
  listInventoryProducts,
  reverseInventoryMovement,
  updateInventoryProductRatings,
  updateInventoryVariantRepurchase
} from "@/server/services/inventory-v2";
import { getDashboardFilters, getHomeQueuePreferences, saveDashboardFilters, saveHomeQueuePreferences } from "@/server/services/preferences";
import { listReleaseCatalog, releaseCatalogQuerySchema, selectReleaseCatalogEntry } from "@/server/services/releases";
import { acquireWishlistItem, createWishlistItem, listWishlist, removeWishlistItem, updateWishlistPlan } from "@/server/services/wishlist";
import { getHomeData } from "@/server/services/home";
import { applyPlayPlannerAction, getPlayPlannerData, PlayPlannerError } from "@/server/services/play-planning";
import { autoClassifyPlayedGames, previewAutoPlayedGames } from "@/server/services/game-auto-status";
import { saveSteamAccount } from "@/server/integrations/accounts";
import { resolveSteamLibraryItem } from "@/server/integrations/steam-library";
import { fetchSteamOwnedGames, normalizeSteamTitle, syncSteamOwnedGames, uniqueSteamNameCandidate } from "@/server/integrations/steam";
import { ingestSteamFamilySnapshot } from "@/server/integrations/steam-family";
import { fetchSteamStoreMetadata } from "@/server/integrations/steam-store";
import { applyIgdbGenreMapping, canonicalEnglishName, metadataSearchVariants, uniqueExactIgdbCandidate } from "@/server/integrations/igdb";
import { hltbSecondsToMinutes, uniqueExactHltbCandidate } from "@/server/integrations/hltb";
import { ingestPlatformSnapshot } from "@/server/integrations/platform-snapshot";
import type { HowLongToBeatEntry } from "howlongtobeat-ts";

const password = "not-a-real-secret";
let userId = "";
const realSource = resolve(".source-readonly/example-game-inventory.xlsx");

beforeAll(async () => {
  await db.delete(userPreferences);
  await db.delete(steamLibraryItems);
  await db.delete(platformLibraryItems);
  await db.delete(platformWishlistItems);
  await db.delete(syncJobs);
  await db.delete(externalGameMappings);
  await db.delete(externalAccounts);
  await db.delete(gameActivitySnapshots);
  await db.delete(gamePlayPlans);
  await db.delete(gameAcquisitions);
  await db.delete(gameMediaItems);
  await db.delete(gameMetadataCandidates);
  await db.delete(gameRatings);
  await db.delete(gameFieldLocks);
  await db.delete(gameDualsenseProfiles);
  await db.delete(gameReleaseEvents);
  await db.delete(gamePlaySessions);
  await db.delete(gameStatusAssignments);
  await db.delete(inventoryVariantMovements);
  await db.delete(inventoryVariants);
  await db.delete(inventoryProducts);
  await db.delete(inventoryMovements);
  await db.delete(inventoryItems);
  await db.delete(assets);
  await db.delete(games);
  await db.delete(importReconciliations);
  await db.delete(importImageRefs);
  await db.delete(importRows);
  await db.delete(importBatches);
  await db.delete(attachments);
  await db.delete(fileBlobs);
  await db.delete(auditLogs);
  await db.delete(sessions);
  await db.delete(authLoginAttempts);
  await db.delete(users);
  const [user] = await db.insert(users).values({ username: "admin", passwordHash: await hashPassword(password) }).returning();
  userId = user.id;
});

afterAll(async () => {
  await closeDatabase();
});

describe("Phase 1 foundation", () => {
  it("accepts an IGDB Latin title even when the local primary title already uses the same spelling", () => {
    expect(canonicalEnglishName("Noctuary")).toBe("Noctuary");
    expect(canonicalEnglishName("梦灯花")).toBeNull();
    expect(metadataSearchVariants(["ACE COMBAT™ 7", "ACE COMBAT™ 7"])).toEqual(["ACE COMBAT 7", "ACE COMBAT™ 7"]);
  });

  it("maps the 48-hour activity signal to PLAYED without duplicating the official status", () => {
    const now = new Date("2026-07-14T08:00:00Z");
    expect(deriveActivityState({
      statuses: ["PLAYING"],
      totalPlaytimeMinutes: 120,
      lastPlayedAt: new Date("2026-07-14T07:00:00Z"),
      playtimeLastChangedAt: new Date("2026-07-14T07:00:00Z"),
      now
    })).toBe("PLAYING");
    expect(deriveActivityState({
      statuses: ["PLAYING"],
      totalPlaytimeMinutes: 120,
      lastPlayedAt: new Date("2026-07-10T07:00:00Z"),
      playtimeLastChangedAt: new Date("2026-07-10T07:00:00Z"),
      now
    })).toBe("COMPLETION_CANDIDATE");
    expect(deriveActivityState({
      statuses: ["COMPLETED"],
      totalPlaytimeMinutes: 120,
      lastPlayedAt: null,
      playtimeLastChangedAt: null,
      now
    })).toBe("COMPLETED_CONFIRMED");
    expect(visibleActivityState(["COMPLETED"], "COMPLETED_CONFIRMED")).toBeNull();
    expect(visibleActivityState(["PLAYED"], "COMPLETION_CANDIDATE")).toBeNull();
  });

  it("keeps completion fact orthogonal to quick activity transitions", () => {
    expect(gameStatusesAfterQuickAction(["BACKLOG"], "START")).toEqual(["PLAYING"]);
    expect(gameStatusesAfterQuickAction(["PLAYING", "COMPLETED"], "STOP")).toEqual(["PLAYED", "COMPLETED"]);
    expect(gameStatusesAfterQuickAction(["PLAYED", "COMPLETED"], "START")).toEqual(["PLAYING", "COMPLETED"]);
    expect(gameStatusesAfterQuickAction(["PLAYED", "COMPLETED"], "UNCOMPLETE")).toEqual(["PLAYED"]);
    expect(gameStatusesAfterQuickAction(["PLAYING"], "ABANDON")).toEqual(["ABANDONED"]);
    expect(gameStatusesAfterQuickAction(["PLAYED", "COMPLETED"], "ABANDON")).toEqual(["ABANDONED"]);
    expect(gameStatusesAfterQuickAction(["ABANDONED"], "COMPLETE")).toEqual(["PLAYED", "COMPLETED"]);
  });

  it("rejects legacy completion status persistence at the database boundary", async () => {
    await expect(db.insert(games).values({
      ownerUserId: userId,
      nameZh: `旧式通关状态回归-${randomUUID()}`,
      playStatus: "COMPLETED"
    })).rejects.toThrow();
    const completed = await createGame(userId, {
      nameZh: `通关事实约束回归-${randomUUID()}`,
      statuses: ["PLAYED", "COMPLETED"],
      completedAt: "2026-07-01"
    }, randomUUID());
    await expect(db.insert(gameStatusAssignments).values({
      gameId: completed.id,
      status: "COMPLETED"
    })).rejects.toThrow();
    expect(await getGame(userId, completed.id)).toMatchObject({
      isCompleted: true,
      completedAt: "2026-07-01",
      statuses: ["PLAYED", "COMPLETED"]
    });
  });

  it("keeps one active game per owner and IGDB identity while preserving deleted history", async () => {
    const igdbGameId = 1_000_000_000 + Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 7), 16);
    const [first] = await db.insert(games).values({
      ownerUserId: userId,
      nameZh: `IGDB唯一性回归-A-${randomUUID()}`,
      igdbGameId
    }).returning();

    await expect(db.insert(games).values({
      ownerUserId: userId,
      nameZh: `IGDB唯一性回归-B-${randomUUID()}`,
      igdbGameId
    })).rejects.toThrow();

    await db.update(games).set({ deletedAt: new Date() }).where(eq(games.id, first.id));
    const [replacement] = await db.insert(games).values({
      ownerUserId: userId,
      nameZh: `IGDB唯一性回归-C-${randomUUID()}`,
      igdbGameId
    }).returning();
    expect(replacement.igdbGameId).toBe(igdbGameId);
  });

  it("stores PS5, PC USB, and PC Bluetooth DualSense truth atomically and tenant-safely", async () => {
    const profiles = [
      { environment: "PS5_CONSOLE" as const, adaptiveTriggers: "RICH" as const, hapticFeedback: "RICH" as const, controllerSpeaker: "BASIC" as const, touchpad: "BASIC" as const, controllerMic: "NONE" as const, notes: "PS5" },
      { environment: "PC_USB" as const, adaptiveTriggers: "BASIC" as const, hapticFeedback: "BASIC" as const, controllerSpeaker: "UNKNOWN" as const, touchpad: "UNKNOWN" as const, controllerMic: "NONE" as const, notes: "USB" },
      { environment: "PC_BLUETOOTH" as const, adaptiveTriggers: "NONE" as const, hapticFeedback: "NONE" as const, controllerSpeaker: "NONE" as const, touchpad: "BASIC" as const, controllerMic: "NONE" as const, notes: "Bluetooth" }
    ];
    expect(createGameSchema.safeParse({ nameZh: "缺失环境", dualsenseProfiles: profiles.slice(0, 2) }).success).toBe(false);

    const created = await createGame(userId, {
      nameZh: `DualSense分环境回归-${randomUUID()}`,
      dualsenseProfiles: profiles
    }, randomUUID());
    expect(created.dualsenseProfiles).toEqual(profiles);
    expect((await db.select({ value: count() }).from(gameDualsenseProfiles).where(eq(gameDualsenseProfiles.gameId, created.id)))[0].value).toBe(3);

    const nextProfiles = profiles.map((profile) => profile.environment === "PC_BLUETOOTH"
      ? { ...profile, adaptiveTriggers: "BASIC" as const, notes: "Bluetooth patch" }
      : profile);
    const updated = await updateGame(userId, created.id, {
      version: created.version,
      dualsenseProfiles: nextProfiles
    }, randomUUID());
    expect(updated).toMatchObject({ conflict: false });
    if (!updated || updated.conflict) throw new Error("DUALSENSE_UPDATE_FAILED");
    expect(updated.game.dualsenseProfiles).toEqual(nextProfiles);
    // The PS5 row is dual-written to legacy columns only for rollback safety;
    // a PC edit must never overwrite that compatibility projection.
    expect(updated.game.dualsenseAdaptiveTriggers).toBe("RICH");

    const [otherUser] = await db.insert(users).values({
      username: `tenant-${randomUUID()}`,
      passwordHash: await hashPassword(password)
    }).returning();
    await expect(db.insert(gameDualsenseProfiles).values({
      ownerUserId: otherUser.id,
      gameId: created.id,
      environment: "PS5_CONSOLE"
    }).onConflictDoUpdate({
      target: [gameDualsenseProfiles.gameId, gameDualsenseProfiles.environment],
      set: { ownerUserId: otherUser.id }
    })).rejects.toThrow();
  });

  it("atomically classifies stale positive play records as PLAYED and is idempotent", async () => {
    const created = await createGame(userId, {
      nameZh: `自动已游玩回归-${randomUUID()}`,
      statuses: ["COMPLETED"],
      playtimeMinutesManual: 90,
      completedAt: "2026-07-01"
    }, randomUUID());
    await db.update(games).set({ lastPlayedAt: new Date("2026-07-01T00:00:00.000Z") }).where(eq(games.id, created.id));
    const asOf = new Date("2026-07-15T08:00:00.000Z");
    const preview = await previewAutoPlayedGames(userId, { asOf });
    expect(preview.changeCount).toBeGreaterThanOrEqual(1);
    const applied = await autoClassifyPlayedGames(userId, { asOf, expectedCandidateSha256: preview.candidateSha256 });
    expect(applied.updatedCount).toBeGreaterThanOrEqual(1);
    expect(await getGame(userId, created.id)).toMatchObject({
      statuses: ["PLAYED", "COMPLETED"],
      playStatus: null,
      isCompleted: true,
      completedAt: "2026-07-01"
    });
    const second = await autoClassifyPlayedGames(userId, { asOf });
    expect(second.updatedCount).toBe(0);
  });

  it("keeps an explicit PLAYING plan even when the last platform activity is stale", async () => {
    const created = await createGame(userId, {
      nameZh: `手工正在玩保护回归-${randomUUID()}`,
      statuses: ["PLAYING"],
      playtimeMinutesManual: 90
    }, randomUUID());
    await db.update(games).set({ lastPlayedAt: new Date("2026-07-01T00:00:00.000Z") }).where(eq(games.id, created.id));
    const asOf = new Date("2026-07-15T08:00:00.000Z");
    const preview = await previewAutoPlayedGames(userId, { asOf });
    expect(preview.sampleIds).not.toContain(created.id);
    const applied = await autoClassifyPlayedGames(userId, { asOf, expectedCandidateSha256: preview.candidateSha256 });
    expect(applied.removedPlaying).toBe(0);
    expect(await getGame(userId, created.id)).toMatchObject({
      statuses: ["PLAYING"],
      playStatus: "PLAYING"
    });
  });

  it("accepts only a unique exact HowLongToBeat title with a compatible release year", () => {
    const entry = (id: number, name: string, releaseYear: number) => ({
      id, name, alias: "", type: "Game", reviewScore: 90, platforms: [], similarity: 1,
      releaseYear, raw: {}, mainTime: 3600, mainExtraTime: 7200, completionistTime: 10800
    }) as unknown as HowLongToBeatEntry;
    expect(uniqueExactHltbCandidate(["Elden Ring"], "2022-02-25", [entry(1, "Elden Ring", 2022)])?.id).toBe(1);
    expect(uniqueExactHltbCandidate(["Elden Ring"], "2022-02-25", [entry(1, "Elden Ring", 2015)])).toBeNull();
    expect(uniqueExactHltbCandidate(["Elden Ring"], "2022-02-25", [entry(1, "Elden Ring", 2022), entry(2, "Elden Ring", 2022)])).toBeNull();
    expect(hltbSecondsToMinutes(3660)).toBe(61);
  });

  it("persists dashboard filters by user and namespace", async () => {
    await saveDashboardFilters(userId, {
      platform: "STEAM",
      statuses: ["PLAYING", "TO_BUY"],
      scope: "STEAM_LINKED",
      completionWindow: "5Y"
    }, randomUUID());
    expect(await getDashboardFilters(userId)).toEqual({
      platform: "STEAM",
      statuses: ["PLAYING", "TO_BUY"],
      scope: "STEAM_LINKED",
      completionWindow: "5Y"
    });
  });

  it("uses Argon2id password hashes and stable session token hashing", async () => {
    const hash = await hashPassword(password);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a revocable session and audits successful login", async () => {
    const result = await login("ADMIN", password, randomUUID());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [sessionCount] = await db.select({ value: count() }).from(sessions).where(eq(sessions.userId, userId));
    const [auditCount] = await db.select({ value: count() }).from(auditLogs).where(eq(auditLogs.action, "auth.login"));
    expect(sessionCount.value).toBe(1);
    expect(auditCount.value).toBe(1);
  });

  it("records failed login without storing the raw username", async () => {
    const result = await login("admin", "wrong-password", randomUUID());
    expect(result).toMatchObject({ ok: false, reason: "INVALID_CREDENTIALS" });
    const [attempt] = await db.select().from(authLoginAttempts);
    expect(attempt.failedCount).toBe(1);
    expect(attempt.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rate-limits the fifth consecutive failure for one normalized login key", async () => {
    let result: Awaited<ReturnType<typeof login>> | undefined;
    for (let index = 0; index < 5; index += 1) {
      result = await login("ghost-user", "wrong-password", randomUUID());
    }
    expect(result).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    const blocked = await login("GHOST-USER", "wrong-password", randomUUID());
    expect(blocked).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
  });

  it("creates import batches idempotently by source checksum", async () => {
    const input = createImportBatchSchema.parse({
      sourceName: "source.xlsx",
      sourceChecksum: "a".repeat(64),
      sourceByteSize: 1234,
      totalRows: 0
    });
    const first = await createImportBatch(input, userId, randomUUID());
    const second = await createImportBatch(input, userId, randomUUID());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.batch.id).toBe(first.batch.id);
  });

  it("registers file metadata idempotently and rejects invalid checksums", async () => {
    const input = registerFileBlobSchema.parse({
      checksumSha256: "b".repeat(64),
      originalName: "asset.png",
      mimeType: "image/png",
      byteSize: 2048
    });
    const first = await registerFileBlob(input, userId, randomUUID());
    const second = await registerFileBlob(input, userId, randomUUID());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(() => registerFileBlobSchema.parse({ ...input, checksumSha256: "broken" })).toThrow();
  });

  it("enforces batch counter invariants in PostgreSQL", async () => {
    await expect(db.insert(importBatches).values({
      sourceName: "invalid.xlsx",
      sourceChecksum: "c".repeat(64),
      sourceByteSize: 10,
      totalRows: 1,
      successRows: 2,
      createdByUserId: userId
    })).rejects.toThrow();
  });

  it.runIf(existsSync(realSource))("runs the corrected real workbook idempotently and rolls staging data back", async () => {
    const first = await runMigrationDryRun({ sourcePath: realSource, actorUserId: userId, requestId: randomUUID() });
    const second = await runMigrationDryRun({ sourcePath: realSource, actorUserId: userId, requestId: randomUUID() });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.analysis.summary).toMatchObject({
      imageReferenceCount: 282,
      mediaFileCount: 252,
      duplicateGameNameGroups: 4,
      allHardGatesPassed: true,
      readyForCommit: true,
      acceptedByType: { GAME: 380, ASSET: 334, INVENTORY: 50 }
    });
    expect(first.analysis.summary.rowCounts.ERROR).toBe(0);
    const [rowCount] = await db.select({ value: count() }).from(importRows).where(eq(importRows.batchId, first.batch.id));
    const [imageCount] = await db.select({ value: count() }).from(importImageRefs).where(eq(importImageRefs.batchId, first.batch.id));
    expect(rowCount.value).toBe(986);
    expect(imageCount.value).toBe(282);
    const rolledBack = await rollbackMigrationBatch(first.batch.id, userId, randomUUID());
    expect(rolledBack.status).toBe("ROLLED_BACK");
    const [remainingRows] = await db.select({ value: count() }).from(importRows).where(eq(importRows.batchId, first.batch.id));
    expect(remainingRows.value).toBe(0);
  });

  it.runIf(existsSync(realSource))("commits the corrected batch exactly once into formal business tables", async () => {
    const staged = await runMigrationDryRun({ sourcePath: realSource, actorUserId: userId, requestId: randomUUID() });
    const first = await commitMigrationBatch(staged.batch.id, userId, randomUUID());
    const second = await commitMigrationBatch(staged.batch.id, userId, randomUUID());
    expect(first).toMatchObject({ reused: false, games: 380, assets: 334, inventoryItems: 50 });
    expect(second).toMatchObject({ reused: true, games: 380, assets: 334, inventoryItems: 50 });
    const [gameCount, assetCount, inventoryCount] = await Promise.all([
      db.select({ value: count() }).from(games).where(eq(games.sourceBatchId, staged.batch.id)),
      db.select({ value: count() }).from(assets).where(eq(assets.sourceBatchId, staged.batch.id)),
      db.select({ value: count() }).from(inventoryItems).where(eq(inventoryItems.sourceBatchId, staged.batch.id))
    ]);
    expect([gameCount[0].value, assetCount[0].value, inventoryCount[0].value]).toEqual([380, 334, 50]);
  });

  it("supports audited game creation and optimistic concurrency", async () => {
    const game = await createGame(userId, {
      nameZh: "线上服务回归测试",
      platform: "STEAM",
      playStatus: "PLAYING",
      startedAt: "2026-01-01",
      completedAt: null
    }, randomUUID());
    const updated = await updateGame(userId, game.id, { version: game.version, progressPercent: 25 }, randomUUID());
    expect(updated && "conflict" in updated && updated.conflict).toBe(false);
    if (!updated || updated.conflict) throw new Error("游戏更新回归未返回最新记录");
    const conflict = await updateGame(userId, game.id, { version: game.version, progressPercent: 50 }, randomUUID());
    expect(conflict && "conflict" in conflict && conflict.conflict).toBe(true);
    await expect(updateGame(userId, game.id, {
      version: updated.game.version,
      completedAt: "2025-12-31"
    }, randomUUID())).rejects.toThrow("GAME_DATE_ORDER");
  });

  it("uses one explicit backlog order and preserves rating provenance", async () => {
    const queued = await createGame(userId, {
      nameZh: "待玩队列回归测试",
      playStatus: "BACKLOG",
      queueOrder: 2,
      communityRating: 88.5,
      criticRating: 91,
      ratingSource: "IGN"
    }, randomUUID());
    expect(queued).toMatchObject({ queueOrder: 2, communityRating: 88.5, criticRating: 91, ratingSource: "IGN" });
    const playing = await updateGame(userId, queued.id, {
      version: queued.version,
      playStatus: "PLAYING"
    }, randomUUID());
    if (!playing || playing.conflict) throw new Error("待玩队列状态更新失败");
    expect(playing.game.queueOrder).toBeNull();
  });

  it("supports multiple statuses including unreleased and to-buy", async () => {
    const game = await createGame(userId, {
      nameZh: "多状态回归测试",
      statuses: ["UNRELEASED", "TO_BUY"]
    }, randomUUID());
    expect(game.statuses).toEqual(["UNRELEASED", "TO_BUY"]);
    expect(game.playStatus).toBeNull();
    const queued = await updateGame(userId, game.id, {
      version: game.version,
      statuses: ["BACKLOG"],
      queueOrder: 10
    }, randomUUID());
    if (!queued || queued.conflict) throw new Error("多状态更新失败");
    expect(queued.game).toMatchObject({ statuses: ["BACKLOG"], queueOrder: 10, playStatus: "BACKLOG" });
    const removedFromQueue = await updateGame(userId, game.id, {
      version: queued.game.version,
      statuses: ["TO_BUY"]
    }, randomUUID());
    if (!removedFromQueue || removedFromQueue.conflict) throw new Error("多状态清理队列失败");
    expect(removedFromQueue.game).toMatchObject({ statuses: ["TO_BUY"], queueOrder: null, playStatus: null });
  });

  it("adds eligible games to the wishlist and automatically moves owned games to backlog", async () => {
    const game = await createGame(userId, {
      nameZh: `愿望单持有转移回归-${randomUUID()}`,
      platform: "PLAYSTATION",
      releaseDate: "2027-02-01",
      statuses: ["UNRELEASED"]
    }, randomUUID());
    expect(game.wishlistEligible).toBe(true);
    const wished = await quickUpdateGameWishlist(userId, game.id, { active: true, version: game.version }, randomUUID());
    if (!wished || wished.conflict) throw new Error("愿望单新增失败");
    expect(wished.game.statuses).toEqual(["UNRELEASED", "TO_BUY"]);

    const acquired = await updateGame(userId, game.id, {
      version: wished.game.version,
      manualOwned: true
    }, randomUUID());
    if (!acquired || acquired.conflict) throw new Error("愿望单持有转移失败");
    expect(acquired.game).toMatchObject({ statuses: ["BACKLOG"], playStatus: "BACKLOG", wishlistEligible: false });
    const [transitionAudit] = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.entityId, game.id), eq(auditLogs.action, "game.wishlist.auto_transition")));
    expect(transitionAudit.metadata).toMatchObject({ from: "TO_BUY", to: "BACKLOG", trigger: "OWNERSHIP" });
  });

  it("automatically moves a wishlisted game with a play record to playing", async () => {
    const game = await createGame(userId, {
      nameZh: `愿望单游玩转移回归-${randomUUID()}`,
      platform: "STEAM",
      statuses: ["WISHLIST"]
    }, randomUUID());
    expect(game.statuses).toEqual(["TO_BUY"]);
    const result = await addPlaySession(userId, game.id, {
      minutes: 30,
      startedAt: new Date("2026-07-16T12:00:00.000Z")
    }, randomUUID());
    expect(result?.game).toMatchObject({ statuses: ["PLAYING"], playStatus: "PLAYING", wishlistEligible: false });
  });

  it("rejects adding an already-owned game to the wishlist", async () => {
    const game = await createGame(userId, {
      nameZh: `愿望单资格回归-${randomUUID()}`,
      platform: "NINTENDO_SWITCH",
      manualOwned: true
    }, randomUUID());
    expect(game.wishlistEligible).toBe(false);
    await expect(quickUpdateGameWishlist(userId, game.id, {
      active: true,
      version: game.version
    }, randomUUID())).rejects.toThrow("GAME_WISHLIST_NOT_ELIGIBLE");
  });

  it("keeps external wishlist items outside the game catalog and archives them when ownership appears", async () => {
    const name = `独立愿望单持有转移-${randomUUID()}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: "2027-03-18",
      releaseDatePrecision: "DAY",
      planOrder: 70
    }, randomUUID());
    expect((await listWishlist(userId, { q: name })).items).toHaveLength(1);
    expect((await listGames(userId, gameQuerySchema.parse({ q: name }))).total).toBe(0);

    const game = await createGame(userId, { nameZh: name, platform: "STEAM", manualOwned: true }, randomUUID());
    expect(game).toMatchObject({ statuses: ["BACKLOG"], playStatus: "BACKLOG", queueOrder: 70 });
    expect((await listWishlist(userId, { q: name })).items).toHaveLength(0);
    const [archived] = await db.select().from(platformWishlistItems).where(eq(platformWishlistItems.id, wished.id));
    expect(archived).toMatchObject({ isActive: false, matchedGameId: game.id });
  });

  it("searches standalone wishlist items by the localized display name", async () => {
    const marker = randomUUID();
    const wished = await createWishlistItem(userId, {
      name: `Anno 117: Pax Romana ${marker}`,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    await db.update(platformWishlistItems).set({
      rawMetadata: { source: "MANUAL", nameZh: `纪元117罗马和平${marker}` }
    }).where(eq(platformWishlistItems.id, wished.id));
    const result = await listWishlist(userId, { q: `纪元117罗马和平${marker}` });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: wished.id, displayName: `纪元117罗马和平${marker}` });
  });

  it("archives a standalone wishlist item into playing when the first play record appears", async () => {
    const name = `独立愿望单游玩转移-${randomUUID()}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "PLAYSTATION",
      externalGameId: null,
      platform: "PS5",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    const game = await createGame(userId, { nameZh: name, platform: "PS5" }, randomUUID());
    await addPlaySession(userId, game.id, { minutes: 15, startedAt: new Date("2026-07-16T13:00:00.000Z") }, randomUUID());
    const updated = await getGame(userId, game.id);
    expect(updated).toMatchObject({ statuses: ["PLAYING"], playStatus: "PLAYING" });
    const [archived] = await db.select().from(platformWishlistItems).where(eq(platformWishlistItems.id, wished.id));
    expect(archived).toMatchObject({ isActive: false, matchedGameId: game.id });
  });

  it("supports manually removing a standalone wishlist item", async () => {
    const name = `独立愿望单移除-${randomUUID()}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "NINTENDO",
      externalGameId: null,
      platform: "NINTENDO_SWITCH_2",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    expect(await removeWishlistItem(userId, wished.id, randomUUID())).toMatchObject({ isActive: false });
    expect((await listWishlist(userId, { q: name })).items).toHaveLength(0);
  });

  it("adds and removes a standalone wishlist item from the unified next-play plan", async () => {
    const name = `愿望单游玩计划-${randomUUID()}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    expect(wished.planOrder).toBeNull();
    expect(await updateWishlistPlan(userId, wished.id, { planned: true, planOrder: 90 }, randomUUID()))
      .toMatchObject({ planOrder: 90, isActive: true });
    expect((await listWishlist(userId, { q: name })).items[0]).toMatchObject({ planOrder: 90 });
    expect(await updateWishlistPlan(userId, wished.id, { planned: false }, randomUUID()))
      .toMatchObject({ planOrder: null, isActive: true });
  });

  it("converts a wishlist item straight into the next-play queue with one selected acquisition channel", async () => {
    const marker = randomUUID();
    const name = `愿望单快捷购入-${marker}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "NINTENDO",
      externalGameId: `nintendo-${marker}`,
      platform: "NINTENDO_SWITCH_2",
      storeUrl: null,
      coverUrl: "https://cdn.example.test/quick-acquire-cover.jpg",
      releaseDate: "2027-08-08",
      releaseDatePrecision: "DAY",
      planOrder: 120
    }, randomUUID());

    const acquired = await acquireWishlistItem(userId, wished.id, { channel: "PHYSICAL" }, randomUUID());
    expect(acquired).toMatchObject({ reused: false, channel: "PHYSICAL", platform: "NINTENDO_SWITCH_2" });
    if (!acquired) throw new Error("愿望单快捷购入失败");
    const [archived] = await db.select().from(platformWishlistItems).where(eq(platformWishlistItems.id, wished.id));
    expect(archived).toMatchObject({ isActive: false, matchedGameId: acquired.gameId });
    expect(archived.rawMetadata).toMatchObject({
      quickAcquisition: { gameId: acquired.gameId, acquisitionId: acquired.acquisitionId, channel: "PHYSICAL" }
    });
    const game = await getGame(userId, acquired.gameId);
    expect(game).toMatchObject({
      nameZh: name,
      platform: "NINTENDO_SWITCH_2",
      statuses: ["BACKLOG"],
      playStatus: "BACKLOG",
      queueOrder: 120,
      coverUrl: "https://cdn.example.test/quick-acquire-cover.jpg"
    });
    const [channel] = await db.select().from(gameAcquisitions).where(eq(gameAcquisitions.id, acquired.acquisitionId));
    expect(channel).toMatchObject({
      source: "MANUAL",
      channel: "PHYSICAL",
      availability: "AVAILABLE",
      offlineCapable: true,
      isOwned: true
    });
    const [plan] = await db.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, userId),
      eq(gamePlayPlans.gameId, acquired.gameId)
    ));
    expect(plan).toMatchObject({
      scenario: "COMMUTE",
      state: "QUEUED",
      acquisitionId: acquired.acquisitionId,
      completionGoal: "EXTRA"
    });
    expect(plan.queueOrder).not.toBeNull();
    expect(acquired).toMatchObject({ scenario: "COMMUTE", queueOrder: plan.queueOrder });
    const planner = await getPlayPlannerData(userId);
    expect(planner.scenarios.COMMUTE.queue.some((entry) => entry.gameId === acquired.gameId)).toBe(true);
    expect(planner.candidates.some((candidate) => candidate.id === acquired.gameId)).toBe(false);
    const home = await getHomeData(userId);
    expect(home.candidatePool.some((candidate) => candidate.id === acquired.gameId)).toBe(false);
    expect((await listWishlist(userId, { q: name })).items).toHaveLength(0);

    const repeated = await acquireWishlistItem(userId, wished.id, { channel: "PHYSICAL" }, randomUUID());
    expect(repeated).toMatchObject({ reused: true, gameId: acquired.gameId, acquisitionId: acquired.acquisitionId, channel: "PHYSICAL" });
    expect(await db.select().from(gameAcquisitions).where(and(
      eq(gameAcquisitions.ownerUserId, userId),
      eq(gameAcquisitions.externalAcquisitionId, `wishlist:${wished.id}`)
    ))).toHaveLength(1);
  });

  it("reuses an exact matched game when converting a wishlist item", async () => {
    const marker = randomUUID();
    const name = `愿望单复用正式游戏-${marker}`;
    const existing = await createGame(userId, { nameZh: name, platform: "STEAM" }, randomUUID());
    const wished = await createWishlistItem(userId, {
      name,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    expect(wished.matchedGameId).toBe(existing.id);
    const acquired = await acquireWishlistItem(userId, wished.id, { channel: "SELF_PURCHASED" }, randomUUID());
    expect(acquired).toMatchObject({ gameId: existing.id, channel: "SELF_PURCHASED", scenario: "FIXED" });
    expect((await listGames(userId, gameQuerySchema.parse({ q: name }))).total).toBe(1);
    expect(await getGame(userId, existing.id)).toMatchObject({ statuses: ["BACKLOG"], playStatus: "BACKLOG" });
    const [plan] = await db.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, userId),
      eq(gamePlayPlans.gameId, existing.id)
    ));
    expect(plan).toMatchObject({ scenario: "FIXED", state: "QUEUED" });
  });

  it("appends wishlist acquisitions to the tail of the inferred next-play queue", async () => {
    const marker = randomUUID();
    const firstWish = await createWishlistItem(userId, {
      name: `队尾追加A-${marker}`,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    const secondWish = await createWishlistItem(userId, {
      name: `队尾追加B-${marker}`,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    const first = await acquireWishlistItem(userId, firstWish.id, { channel: "SELF_PURCHASED" }, randomUUID());
    const second = await acquireWishlistItem(userId, secondWish.id, { channel: "SUBSCRIPTION" }, randomUUID());
    if (!first || !second) throw new Error("队尾追加入手失败");
    expect(first.scenario).toBe("FIXED");
    expect(second.scenario).toBe("FIXED");
    expect(first.queueOrder).not.toBeNull();
    expect(second.queueOrder).not.toBeNull();
    expect(second.queueOrder!).toBeGreaterThan(first.queueOrder!);
  });

  it("leaves pre-existing candidate pool games with channels out of the next-play queue", async () => {
    const legacy = await createGame(userId, {
      nameZh: `存量候玩池不搬移-${randomUUID()}`,
      platform: "STEAM",
      statuses: ["BACKLOG"]
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION",
      gameId: legacy.id,
      channel: "SELF_PURCHASED",
      platform: "STEAM",
      availability: "AVAILABLE",
      offlineCapable: true
    }, randomUUID());
    expect(await db.select().from(gamePlayPlans).where(eq(gamePlayPlans.gameId, legacy.id))).toHaveLength(0);
  });

  it("shows only unplanned, uncompleted games with an available acquisition channel in the candidate pool", async () => {
    const marker = randomUUID();
    const eligible = await createGame(userId, {
      nameZh: `候玩池合格-${marker}`,
      platform: "STEAM",
      statuses: ["BACKLOG"]
    }, randomUUID());
    const missingChannel = await createGame(userId, {
      nameZh: `候玩池无渠道-${marker}`,
      platform: "STEAM",
      statuses: ["BACKLOG"]
    }, randomUUID());
    const completed = await createGame(userId, {
      nameZh: `候玩池已通关-${marker}`,
      platform: "STEAM",
      statuses: ["PLAYED", "COMPLETED"],
      completedAt: "2026-07-22"
    }, randomUUID());
    const abandoned = await createGame(userId, {
      nameZh: `候玩池已弃坑-${marker}`,
      platform: "STEAM",
      statuses: ["ABANDONED"]
    }, randomUUID());
    const planned = await createGame(userId, {
      nameZh: `候玩池已排队-${marker}`,
      platform: "STEAM",
      statuses: ["BACKLOG"]
    }, randomUUID());
    for (const game of [eligible, completed, abandoned, planned]) {
      await applyPlayPlannerAction(userId, {
        action: "SET_ACQUISITION",
        gameId: game.id,
        channel: "SELF_PURCHASED",
        platform: "STEAM",
        availability: "AVAILABLE",
        offlineCapable: true
      }, randomUUID());
    }
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: planned.id,
      scenario: "FIXED",
      state: "QUEUED",
      completionGoal: "EXTRA",
      queueOrder: 10,
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID());

    const planner = await getPlayPlannerData(userId);
    const candidateIds = new Set(planner.candidates.map((game) => game.id));
    expect(candidateIds.has(eligible.id)).toBe(true);
    expect(candidateIds.has(missingChannel.id)).toBe(false);
    expect(candidateIds.has(completed.id)).toBe(false);
    expect(candidateIds.has(abandoned.id)).toBe(false);
    expect(candidateIds.has(planned.id)).toBe(false);
    expect(planner.counts.missingChannel).toBeGreaterThanOrEqual(1);

    const home = await getHomeData(userId);
    const homeCandidateIds = new Set(home.candidatePool.map((game) => game.id));
    expect(homeCandidateIds.has(eligible.id)).toBe(true);
    expect(homeCandidateIds.has(missingChannel.id)).toBe(false);
    expect(homeCandidateIds.has(completed.id)).toBe(false);
    expect(homeCandidateIds.has(abandoned.id)).toBe(false);
    expect(homeCandidateIds.has(planned.id)).toBe(false);
  });

  it("marks a currently playing game completed and archives every plan atomically", async () => {
    const game = await createGame(userId, {
      nameZh: `正在玩快捷通关-${randomUUID()}`,
      platform: "STEAM",
      statuses: ["PLAYING"]
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION",
      gameId: game.id,
      channel: "SELF_PURCHASED",
      platform: "STEAM",
      availability: "AVAILABLE",
      offlineCapable: true
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "FIXED",
      state: "PLAYING",
      completionGoal: "EXTRA",
      acquisitionId: null,
      preferredDevice: "BEDROOM_5080",
      replaceCurrent: false
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "COMMUTE",
      state: "QUEUED",
      completionGoal: "EXTRA",
      queueOrder: 10,
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID());
    expect(await db.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, userId),
      eq(gamePlayPlans.gameId, game.id)
    ))).toHaveLength(2);

    const current = await getGame(userId, game.id);
    if (!current) throw new Error("正在玩游戏未找到");
    const completed = await quickUpdateGameStatus(userId, game.id, {
      action: "COMPLETE",
      version: current.version,
      completedAt: "2026-07-22"
    }, randomUUID());
    expect(completed).toMatchObject({
      conflict: false,
      game: { statuses: ["PLAYED", "COMPLETED"], isCompleted: true, completedAt: "2026-07-22" }
    });
    expect(await db.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, userId),
      eq(gamePlayPlans.gameId, game.id)
    ))).toHaveLength(0);

    const planner = await getPlayPlannerData(userId);
    expect(planner.scenarios.FIXED.current?.gameId).not.toBe(game.id);
    expect(planner.scenarios.FIXED.queue.some((plan) => plan.gameId === game.id)).toBe(false);
    expect(planner.candidates.some((candidate) => candidate.id === game.id)).toBe(false);
    expect((await getHomeData(userId)).candidatePool.some((candidate) => candidate.id === game.id)).toBe(false);

    await expect(applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "FIXED",
      state: "QUEUED",
      completionGoal: "EXTRA",
      queueOrder: 10,
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID())).rejects.toMatchObject({ code: "GAME_COMPLETED" } satisfies Partial<PlayPlannerError>);
  });

  it("marks a queued game abandoned, removes every plan atomically, and blocks re-planning", async () => {
    const game = await createGame(userId, {
      nameZh: `队列快捷弃坑-${randomUUID()}`,
      platform: "STEAM",
      statuses: ["BACKLOG"]
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION",
      gameId: game.id,
      channel: "SELF_PURCHASED",
      platform: "STEAM",
      availability: "AVAILABLE",
      offlineCapable: true
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "FIXED",
      state: "QUEUED",
      completionGoal: "EXTRA",
      queueOrder: 10,
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "COMMUTE",
      state: "PLAYING",
      completionGoal: "EXTRA",
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID());

    const current = await getGame(userId, game.id);
    if (!current) throw new Error("待弃坑游戏未找到");
    const abandoned = await quickUpdateGameStatus(userId, game.id, {
      action: "ABANDON",
      version: current.version
    }, randomUUID());
    expect(abandoned).toMatchObject({
      conflict: false,
      game: { statuses: ["ABANDONED"], isCompleted: false, completedAt: null }
    });
    expect(await db.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, userId),
      eq(gamePlayPlans.gameId, game.id)
    ))).toHaveLength(0);
    const planner = await getPlayPlannerData(userId);
    expect(planner.candidates.some((candidate) => candidate.id === game.id)).toBe(false);
    expect((["COMMUTE", "FIXED"] as const).some((scenario) => planner.scenarios[scenario].current?.gameId === game.id
      || planner.scenarios[scenario].queue.some((plan) => plan.gameId === game.id))).toBe(false);

    await expect(applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: game.id,
      scenario: "FIXED",
      state: "QUEUED",
      completionGoal: "EXTRA",
      queueOrder: 10,
      acquisitionId: null,
      preferredDevice: null,
      replaceCurrent: false
    }, randomUUID())).rejects.toMatchObject({ code: "GAME_ABANDONED" } satisfies Partial<PlayPlannerError>);
  });

  it("persists the today-page candidate pool visibility preference", async () => {
    expect(await getHomeQueuePreferences(userId)).toEqual({ showCandidatePool: false });
    await saveHomeQueuePreferences(userId, { showCandidatePool: true }, randomUUID());
    expect(await getHomeQueuePreferences(userId)).toEqual({ showCandidatePool: true });
    await saveHomeQueuePreferences(userId, { showCandidatePool: false }, randomUUID());
    expect(await getHomeQueuePreferences(userId)).toEqual({ showCandidatePool: false });
  });

  it("stores game genres, filters by them, and keeps manual edits locked against IGDB backfill", async () => {
    const marker = randomUUID();
    const game = await createGame(userId, {
      nameZh: `类型标签-${marker}`,
      platform: "STEAM",
      primaryGenre: "ARPG",
      subGenres: ["ROGUELIKE", "HORROR"]
    }, randomUUID());
    expect(game).toMatchObject({ primaryGenre: "ARPG", subGenres: ["ROGUELIKE", "HORROR"], genreSource: "MANUAL" });
    const lockFields = (await db.select().from(gameFieldLocks).where(eq(gameFieldLocks.gameId, game.id)))
      .map((lock) => lock.field);
    expect(lockFields).toContain("PRIMARY_GENRE");
    expect(lockFields).toContain("SUB_GENRES");

    const byPrimary = await listGames(userId, gameQuerySchema.parse({ q: `类型标签-${marker}`, genre: ["ARPG"] }));
    expect(byPrimary.games.map((entry) => entry.id)).toEqual([game.id]);
    const bySub = await listGames(userId, gameQuerySchema.parse({ q: `类型标签-${marker}`, genre: "HORROR" }));
    expect(bySub.games.map((entry) => entry.id)).toEqual([game.id]);
    expect((await listGames(userId, gameQuerySchema.parse({ q: `类型标签-${marker}`, genre: ["RHYTHM"] }))).total).toBe(0);

    const lockedResult = await applyIgdbGenreMapping(userId, [{ gameId: game.id, genreNames: ["Fighting", "Racing"] }]);
    expect(lockedResult).toEqual({ updated: 0, lockedSkipped: 1, unmapped: 0 });
    expect(await getGame(userId, game.id)).toMatchObject({ primaryGenre: "ARPG", subGenres: ["ROGUELIKE", "HORROR"] });

    const fresh = await createGame(userId, { nameZh: `类型回填-${marker}`, platform: "STEAM" }, randomUUID());
    const applied = await applyIgdbGenreMapping(userId, [
      { gameId: fresh.id, genreNames: ["Platform", "Adventure", "Indie", "Puzzle"] }
    ]);
    expect(applied).toEqual({ updated: 1, lockedSkipped: 0, unmapped: 0 });
    expect(await getGame(userId, fresh.id)).toMatchObject({
      primaryGenre: "PLATFORMER",
      subGenres: ["PUZZLE"],
      genreSource: "IGDB"
    });

    const blank = await createGame(userId, { nameZh: `类型未映射-${marker}` }, randomUUID());
    const unmapped = await applyIgdbGenreMapping(userId, [
      { gameId: blank.id, genreNames: ["Shooter", "Role-playing (RPG)", "Adventure"] }
    ]);
    expect(unmapped).toEqual({ updated: 0, lockedSkipped: 0, unmapped: 1 });
    expect(await getGame(userId, blank.id)).toMatchObject({ primaryGenre: null, subGenres: [], genreSource: null });
  });

  it("maps wishlist metadata genres for badges and genre filtering", async () => {
    const marker = randomUUID();
    const name = `心愿类型筛选-${marker}`;
    const wished = await createWishlistItem(userId, {
      name,
      provider: "STEAM",
      externalGameId: null,
      platform: "STEAM",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY"
    }, randomUUID());
    await db.update(platformWishlistItems).set({
      rawMetadata: { source: "MANUAL", genresZh: ["动作", "冒险"], genresEn: ["Hack and slash/Beat 'em up", "Puzzle"] }
    }).where(eq(platformWishlistItems.id, wished.id));
    const all = await listWishlist(userId, { q: name });
    expect(all.items[0]?.genres).toEqual(["PUZZLE", "ACT"]);
    const filtered = await listWishlist(userId, { q: name, genre: "ACT" });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.total).toBe(1);
    expect((await listWishlist(userId, { q: name, genre: "RHYTHM" })).items).toHaveLength(0);
  });

  it("selects one complete release catalog record idempotently into the unified purchase list", async () => {
    const externalGameId = String(Date.now());
    const [event] = await db.insert(gameReleaseEvents).values({
      ownerUserId: userId,
      source: "IGDB",
      dedupeKey: `catalog:igdb:release:${externalGameId}`,
      externalGameId,
      nameZh: `完整发售目录-${externalGameId}`,
      nameEn: `Complete Release Catalog ${externalGameId}`,
      platform: "STEAM",
      releaseDate: "2027-09-18",
      datePrecision: "DAY",
      region: "GLOBAL",
      storeUrl: `https://store.steampowered.com/app/${externalGameId}/`,
      coverUrl: "https://cdn.example.test/release-cover.jpg",
      storeProvider: "STEAM",
      storeExternalGameId: externalGameId,
      summaryZh: "一段完整的中文游戏简介。",
      summaryEn: "A complete English game summary.",
      developers: ["Example Developer"],
      publishers: ["Example Publisher"],
      genresZh: ["角色扮演"],
      genresEn: ["Role-Playing"],
      metadataFetchedAt: new Date()
    }).returning();

    const wishlisted = await selectReleaseCatalogEntry(userId, event.id, { target: "WISHLIST" }, randomUUID());
    expect(wishlisted).toMatchObject({ target: "WISHLIST", reused: false, item: { planOrder: null, isActive: true } });
    if (!("item" in wishlisted) || !wishlisted.item) throw new Error("完整发售目录未写入愿望单");
    expect(wishlisted.item.rawMetadata).toMatchObject({
      source: "RELEASE_CATALOG",
      catalogEventId: event.id,
      nameZh: event.nameZh,
      nameEn: event.nameEn,
      summaryZh: event.summaryZh,
      summaryEn: event.summaryEn,
      developers: ["Example Developer"],
      publishers: ["Example Publisher"],
      genresZh: ["角色扮演"],
      genresEn: ["Role-Playing"]
    });

    const planned = await selectReleaseCatalogEntry(userId, event.id, { target: "PLANNED" }, randomUUID());
    expect(planned).toMatchObject({ target: "PLANNED", reused: true, item: { isActive: true } });
    if (!("item" in planned) || !planned.item) throw new Error("完整发售目录未加入接下来玩");
    expect(planned.item.id).toBe(wishlisted.item.id);
    expect(planned.item.planOrder).toBeNull();
    expect(await db.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, userId),
      eq(platformWishlistItems.provider, "STEAM"),
      eq(platformWishlistItems.externalGameId, externalGameId)
    ))).toHaveLength(1);
  });

  it("groups multi-platform releases into one work and converts the selected platform into backlog atomically", async () => {
    const marker = String(Date.now());
    const nameZh = `多平台心愿聚合-${marker}`;
    const [steamEvent, playstationEvent] = await db.insert(gameReleaseEvents).values([
      {
        ownerUserId: userId,
        source: "IGDB",
        dedupeKey: `catalog:igdb:release:multi:${marker}:steam`,
        externalGameId: marker,
        nameZh,
        nameEn: `Multi-platform wish ${marker}`,
        platform: "STEAM",
        releaseDate: "2027-06-18",
        datePrecision: "DAY",
        region: "GLOBAL",
        storeUrl: `https://store.steampowered.com/app/${marker}/`,
        storeProvider: "STEAM",
        storeExternalGameId: `steam-${marker}`
      },
      {
        ownerUserId: userId,
        source: "IGDB",
        dedupeKey: `catalog:igdb:release:multi:${marker}:ps5`,
        externalGameId: marker,
        nameZh,
        nameEn: `Multi-platform wish ${marker}`,
        platform: "PS5",
        releaseDate: "2027-06-18",
        datePrecision: "DAY",
        region: "GLOBAL",
        storeUrl: `https://store.playstation.com/concept/${marker}/`,
        storeProvider: "PLAYSTATION",
        storeExternalGameId: `ps5-${marker}`
      }
    ]).returning();

    const catalog = await listReleaseCatalog(userId, releaseCatalogQuerySchema.parse({
      q: nameZh,
      window: "24M",
      pageSize: 24
    }));
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toMatchObject({ platforms: expect.arrayContaining(["PS5", "STEAM"]) });
    expect(catalog.items[0].variants).toHaveLength(2);

    const firstSelection = await selectReleaseCatalogEntry(userId, steamEvent.id, { target: "WISHLIST" }, randomUUID());
    if (!("item" in firstSelection) || !firstSelection.item) throw new Error("多平台作品未加入心愿单");
    const secondSelection = await selectReleaseCatalogEntry(userId, playstationEvent.id, { target: "WISHLIST" }, randomUUID());
    expect(secondSelection).toMatchObject({ reused: true, item: { id: firstSelection.item.id } });
    expect(await db.select({ id: platformWishlistItems.id }).from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, userId),
      eq(platformWishlistItems.isActive, true),
      sql`${platformWishlistItems.rawMetadata} ->> 'igdbGameId' = ${marker}`
    ))).toHaveLength(1);

    const acquired = await acquireWishlistItem(userId, firstSelection.item.id, {
      channel: "SUBSCRIPTION",
      selection: {
        provider: "PLAYSTATION",
        platform: "PS5",
        externalGameId: `ps5-${marker}`,
        storeUrl: playstationEvent.storeUrl,
        catalogEventId: playstationEvent.id
      }
    }, randomUUID());
    expect(acquired).toMatchObject({ reused: false, channel: "SUBSCRIPTION", platform: "PS5" });
    if (!acquired) throw new Error("多平台心愿购入未完成");
    expect(await getGame(userId, acquired.gameId)).toMatchObject({
      platform: "PS5",
      statuses: ["BACKLOG"],
      playStatus: "BACKLOG"
    });
    const [acquisition] = await db.select().from(gameAcquisitions).where(eq(gameAcquisitions.id, acquired.acquisitionId));
    expect(acquisition).toMatchObject({
      source: "MANUAL",
      channel: "SUBSCRIPTION",
      platform: "PS5",
      offlineCapable: false,
      details: expect.objectContaining({ provider: "PLAYSTATION" })
    });
    expect(await db.select({ id: platformWishlistItems.id }).from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, userId),
      eq(platformWishlistItems.isActive, true),
      sql`${platformWishlistItems.rawMetadata} ->> 'igdbGameId' = ${marker}`
    ))).toHaveLength(0);
    expect((await getPlayPlannerData(userId)).candidates.some((candidate) => candidate.id === acquired.gameId)).toBe(false);
  });

  it("allows a store-identified release into the wishlist while optional metadata is still filling", async () => {
    const marker = randomUUID();
    const [event] = await db.insert(gameReleaseEvents).values({
      ownerUserId: userId,
      source: "PLAYSTATION",
      dedupeKey: `catalog:playstation:release:selectable-${marker}`,
      externalGameId: `selectable-${marker}`,
      nameZh: `资料补全中目录-${marker}`,
      nameEn: `Selectable Catalog ${marker}`,
      platform: "PLAYSTATION",
      releaseDate: "2027-09-21",
      datePrecision: "DAY",
      region: "GLOBAL",
      storeUrl: `https://store.playstation.com/product/selectable-${marker}`,
      storeProvider: "PLAYSTATION",
      storeExternalGameId: `selectable-${marker}`
    }).returning();

    const selected = await selectReleaseCatalogEntry(userId, event.id, { target: "WISHLIST" }, randomUUID());
    expect(selected).toMatchObject({ target: "WISHLIST", reused: false, item: { name: event.nameEn, isActive: true } });
  });

  it("fails closed for store-unidentified or already-owned release catalog records", async () => {
    const marker = randomUUID();
    const [incomplete] = await db.insert(gameReleaseEvents).values({
      ownerUserId: userId,
      source: "IGDB",
      dedupeKey: `catalog:igdb:release:incomplete-${marker}`,
      externalGameId: `incomplete-${marker}`,
      nameZh: `未补全目录-${marker}`,
      nameEn: `Incomplete Catalog ${marker}`,
      platform: "STEAM",
      releaseDate: "2027-10-01",
      datePrecision: "DAY",
      region: "GLOBAL"
    }).returning();
    const rejected = await selectReleaseCatalogEntry(userId, incomplete.id, { target: "WISHLIST" }, randomUUID());
    expect(rejected).toMatchObject({ incomplete: true });

    const ownedGame = await createGame(userId, {
      nameZh: `已持有发售目录-${marker}`,
      nameEn: `Owned Release Catalog ${marker}`,
      platform: "STEAM",
      manualOwned: true
    }, randomUUID());
    const [ownedEvent] = await db.insert(gameReleaseEvents).values({
      ownerUserId: userId,
      gameId: ownedGame.id,
      source: "IGDB",
      dedupeKey: `catalog:igdb:release:owned-${marker}`,
      externalGameId: `owned-${marker}`,
      nameZh: ownedGame.nameZh,
      nameEn: ownedGame.nameEn,
      platform: "STEAM",
      releaseDate: "2027-11-01",
      datePrecision: "DAY",
      region: "GLOBAL",
      storeUrl: `https://store.steampowered.com/app/owned-${marker}/`,
      coverUrl: "https://cdn.example.test/owned-release-cover.jpg",
      storeProvider: "STEAM",
      storeExternalGameId: `owned-${marker}`,
      summaryZh: "已持有游戏的中文简介。",
      summaryEn: "The English summary of an owned game.",
      developers: ["Owned Developer"],
      publishers: ["Owned Publisher"],
      genresZh: ["冒险"],
      genresEn: ["Adventure"],
      metadataFetchedAt: new Date()
    }).returning();
    expect(await selectReleaseCatalogEntry(userId, ownedEvent.id, { target: "PLANNED" }, randomUUID()))
      .toMatchObject({ inLibrary: true, gameId: ownedGame.id });
  });

  it("keeps purchase planning separate from the playable scenario queue", async () => {
    const catalogName = `首页正式计划-${randomUUID()}`;
    const wishlistName = `首页愿望计划-${randomUUID()}`;
    const catalog = await createGame(userId, {
      nameZh: catalogName,
      platform: "STEAM",
      statuses: ["BACKLOG"],
      queueOrder: 1
    }, randomUUID());
    const wished = await createWishlistItem(userId, {
      name: wishlistName,
      provider: "NINTENDO",
      externalGameId: null,
      platform: "NINTENDO_SWITCH_2",
      storeUrl: null,
      coverUrl: null,
      releaseDate: null,
      releaseDatePrecision: "DAY",
      planOrder: 2
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION",
      gameId: catalog.id,
      acquisitionId: null,
      channel: "SELF_PURCHASED",
      platform: "STEAM",
      availability: "AVAILABLE",
      offlineCapable: true
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN",
      gameId: catalog.id,
      scenario: "FIXED",
      state: "QUEUED",
      acquisitionId: null,
      preferredDevice: "STUDY_PS5",
      completionGoal: "EXTRA",
      queueOrder: 1,
      replaceCurrent: false
    }, randomUUID());
    const home = await getHomeData(userId, new Date("2026-07-17T06:00:00.000Z"));
    expect(home.nextQueue.find((item) => item.gameId === catalog.id)).toMatchObject({ channel: "SELF_PURCHASED", queueOrder: 1 });
    expect(home.purchaseQueue.find((item) => item.id === wished.id)).toMatchObject({ kind: "WISHLIST" });
    expect(home.playScenarios.FIXED.queue.find((item) => item.gameId === catalog.id)).toMatchObject({
      channel: "SELF_PURCHASED",
      queueOrder: 1
    });
    expect(home.metrics.plannedCount).toBeGreaterThanOrEqual(1);
    expect(home.playScenarios.FIXED.queue.some((item) => item.gameId === wished.id)).toBe(false);
  });

  it("derives purchase state from acquisition records and keeps the primary release calendar synchronized", async () => {
    const game = await createGame(userId, {
      nameZh: "数据中心回归测试",
      platform: "STEAM",
      releaseDate: "2026-08-08",
      statuses: ["TO_BUY"]
    }, randomUUID());
    expect(await db.select().from(gameReleaseEvents).where(eq(gameReleaseEvents.gameId, game.id))).toHaveLength(1);
    await db.insert(gameAcquisitions).values({
      ownerUserId: userId,
      gameId: game.id,
      source: "STEAM",
      externalAcquisitionId: `test-${randomUUID()}`
    });
    const listed = await listGames(userId, gameQuerySchema.parse({ q: "数据中心回归测试" }));
    expect(listed.games[0]).toMatchObject({ purchaseState: "OWNED", acquisitionSources: ["STEAM"] });
    const updated = await updateGame(userId, game.id, { version: game.version, releaseDate: "2026-09-09" }, randomUUID());
    if (!updated || updated.conflict) throw new Error("发售日更新失败");
    const [event] = await db.select().from(gameReleaseEvents).where(eq(gameReleaseEvents.gameId, game.id));
    expect(event.releaseDate).toBe("2026-09-09");
  });

  it("creates a manual acquisition and locks user-maintained metadata", async () => {
    const game = await createGame(userId, {
      nameZh: "手工入库与字段锁回归测试",
      nameEn: "Manual Acquisition Regression",
      platform: "PC_OTHER",
      releaseDate: "2026-10-10",
      communityRating: 86,
      manualOwned: true
    }, randomUUID());
    const [listed, locks, acquisitions] = await Promise.all([
      listGames(userId, gameQuerySchema.parse({ q: "手工入库与字段锁回归测试" })),
      db.select().from(gameFieldLocks).where(eq(gameFieldLocks.gameId, game.id)),
      db.select().from(gameAcquisitions).where(eq(gameAcquisitions.gameId, game.id))
    ]);
    expect(listed.games[0]).toMatchObject({ purchaseState: "OWNED", acquisitionSources: ["MANUAL"] });
    expect(new Set(locks.map((lock) => lock.field))).toEqual(new Set([
      "NAME_ZH",
      "NAME_EN",
      "RELEASE_DATE",
      "COMMUNITY_RATING"
    ]));
    expect(acquisitions).toHaveLength(1);
    expect(acquisitions[0]).toMatchObject({ source: "MANUAL", isOwned: true });
  });

  it("combines multi-select status and platform filters with stable query parsing", async () => {
    const marker = `多条件筛选回归-${randomUUID()}`;
    const steam = await createGame(userId, { nameZh: `${marker}-Steam`, platform: "STEAM", statuses: ["BACKLOG"] }, randomUUID());
    const playstation = await createGame(userId, { nameZh: `${marker}-PS`, platform: "PLAYSTATION", statuses: ["PLAYING"] }, randomUUID());
    await createGame(userId, { nameZh: `${marker}-iOS`, platform: "IOS", statuses: ["COMPLETED"] }, randomUUID());

    const query = gameQuerySchema.parse({
      q: marker,
      status: ["BACKLOG", "PLAYING"],
      platform: ["STEAM", "PLAYSTATION", "STEAM"],
      pageSize: 30
    });
    expect(query.platform).toEqual(["STEAM", "PLAYSTATION"]);
    const result = await listGames(userId, query);
    expect(result.games.map((game) => game.id).sort()).toEqual([steam.id, playstation.id].sort());
    expect(gameQuerySchema.parse({ platform: "STEAM" }).platform).toEqual(["STEAM"]);
    expect(gameQuerySchema.parse({ platform: "STEAM,PLAYSTATION" }).platform).toEqual(["STEAM", "PLAYSTATION"]);
    const completedOnly = await listGames(userId, gameQuerySchema.parse({ q: marker, status: ["COMPLETED"], pageSize: 30 }));
    expect(completedOnly.games).toHaveLength(1);
    expect(completedOnly.games[0].nameZh).toBe(`${marker}-iOS`);
  });

  it("fuzzy-searches multilingual names and matched platform aliases without broad short-query matches", async () => {
    const marker = randomUUID().slice(0, 8);
    const aliasMarker = randomUUID().replaceAll("-", "");
    const target = await createGame(userId, {
      nameZh: `塞尔达传说：旷野之息 ${marker}`,
      nameEn: `The Legend of Zelda: Breath of the Wild ${marker}`,
      searchAliases: [`异度之刃X 终极版 ${aliasMarker}`],
      platform: "NINTENDO_SWITCH",
      statuses: ["BACKLOG"]
    }, randomUUID());
    await createGame(userId, {
      nameZh: `塞尔达无关回归 ${marker}`,
      nameEn: `Unrelated Zelda Regression ${marker}`,
      platform: "NINTENDO_SWITCH",
      statuses: ["COMPLETED"]
    }, randomUUID());
    await db.insert(platformLibraryItems).values({
      ownerUserId: userId,
      provider: "NINTENDO",
      externalGameId: `fuzzy-alias-${marker}`,
      name: `Zelda BOTW Ultimate ${aliasMarker}`,
      platform: "Nintendo Switch",
      matchStatus: "MATCHED",
      matchedGameId: target.id,
      matchConfidence: 100,
      matchMethod: "TEST_ALIAS"
    });

    const punctuationInsensitive = await listGames(userId, gameQuerySchema.parse({
      q: `塞尔达传说旷野之息${marker}`,
      status: ["BACKLOG"]
    }));
    expect(punctuationInsensitive.games.map((game) => game.id)).toEqual([target.id]);

    const typoTolerant = await listGames(userId, gameQuerySchema.parse({
      q: `Breth of the Wld ${marker}`
    }));
    expect(typoTolerant.games[0]?.id).toBe(target.id);

    const alias = await listGames(userId, gameQuerySchema.parse({ q: `BOTW Ultimate ${aliasMarker}` }));
    expect(alias.games.map((game) => game.id)).toEqual([target.id]);

    const traditional = await listGames(userId, gameQuerySchema.parse({ q: `薩爾達傳說曠野之息 ${marker}` }));
    expect(traditional.games[0]?.id).toBe(target.id);

    const curatedAlias = await listGames(userId, gameQuerySchema.parse({ q: `異度之刃X 終極版 ${aliasMarker}` }));
    expect(curatedAlias.games.map((game) => game.id)).toEqual([target.id]);

    const shortQuery = await listGames(userId, gameQuerySchema.parse({ q: "zz" }));
    expect(shortQuery.games.some((game) => game.id === target.id)).toBe(false);
  });

  it("bulk-manages explicit and filtered game selections atomically", async () => {
    const marker = `批量管理回归-${randomUUID()}`;
    const first = await createGame(userId, { nameZh: `${marker}-A`, platform: "STEAM", statuses: ["UNPLANNED"] }, randomUUID());
    const second = await createGame(userId, { nameZh: `${marker}-B`, platform: "PLAYSTATION", statuses: ["UNPLANNED"] }, randomUUID());
    const third = await createGame(userId, { nameZh: `${marker}-C`, platform: "NINTENDO_SWITCH", statuses: ["UNPLANNED"] }, randomUUID());

    expect(await bulkManageGames(userId, {
      selection: { mode: "IDS", ids: [first.id, second.id] },
      action: { type: "STATUSES", mode: "ADD", statuses: ["TO_BUY"] }
    }, randomUUID())).toEqual({ updatedCount: 2 });
    expect((await getGame(userId, first.id))?.statuses).toEqual(["TO_BUY"]);
    expect((await getGame(userId, third.id))?.statuses).toEqual(["UNPLANNED"]);

    const query = gameQuerySchema.parse({ q: marker, sort: "name_asc" });
    expect(await bulkManageGames(userId, {
      selection: {
        mode: "FILTER",
        query: { q: query.q, status: query.status, platform: query.platform, genre: query.genre, sort: query.sort },
        excludedIds: [],
        expectedTotal: 3
      },
      action: { type: "QUEUE", start: 10, step: 2 }
    }, randomUUID())).toEqual({ updatedCount: 3 });
    const queued = await listGames(userId, gameQuerySchema.parse({ q: marker, sort: "name_asc" }));
    expect(queued.games.map((game) => game.queueOrder)).toEqual([10, 12, 14]);
    expect(queued.games.every((game) => game.statuses.includes("BACKLOG"))).toBe(true);

    await expect(bulkManageGames(userId, {
      selection: {
        mode: "FILTER",
        query: { q: query.q, status: query.status, platform: query.platform, genre: query.genre, sort: query.sort },
        excludedIds: [],
        expectedTotal: 2
      },
      action: { type: "PLATFORM", platform: "PC_OTHER" }
    }, randomUUID())).rejects.toThrow("BULK_SELECTION_STALE");
    expect((await getGame(userId, first.id))?.platform).toBe("STEAM");

    expect(await bulkManageGames(userId, {
      selection: { mode: "IDS", ids: [third.id] },
      action: { type: "DELETE" }
    }, randomUUID())).toEqual({ updatedCount: 1 });
    expect(await getGame(userId, third.id)).toBeNull();
    expect(await getGame(userId, third.id, true)).not.toBeNull();
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "game.bulk.delete"));
    expect(audits.at(-1)?.metadata).toMatchObject({ count: 1, selectionMode: "IDS" });
  });

  it("preserves inventory conservation and blocks negative stock", async () => {
    const item = await createInventoryItem(userId, {
      productName: "库存回归测试",
      color: "黑色",
      unopenedQuantity: 2,
      openedQuantity: 0
    }, randomUUID());
    const opened = await addInventoryMovement(userId, item.id, {
      movementType: "OPENED",
      unopenedDelta: -1,
      openedDelta: 1,
      reason: "自动化回归拆封",
      version: item.version
    }, randomUUID());
    if (!opened || !("movement" in opened) || !opened.item) throw new Error("库存拆封回归未返回更新记录");
    expect([opened.item.unopenedQuantity, opened.item.openedQuantity]).toEqual([1, 1]);
    const negative = await addInventoryMovement(userId, item.id, {
      movementType: "CONSUMED",
      unopenedDelta: 0,
      openedDelta: -2,
      reason: "验证负库存拦截",
      version: opened.item.version
    }, randomUUID());
    expect(negative && "negative" in negative && negative.negative).toBe(true);
  });

  it("extracts a trailing purchase URL and supports audited inventory edits", async () => {
    expect(splitProductNameAndPurchaseUrl("测试商品 https://detail.1688.com/offer/123.html")).toEqual({
      productName: "测试商品",
      purchaseUrl: "https://detail.1688.com/offer/123.html",
      extracted: true
    });
    expect(splitProductNameAndPurchaseUrl("https://example.com/only-url").extracted).toBe(false);
    const item = await createInventoryItem(userId, {
      productName: "购买链接回归 https://detail.1688.com/offer/456.html",
      color: "灰色",
      unopenedQuantity: 0,
      openedQuantity: 0
    }, randomUUID());
    expect(item).toMatchObject({ productName: "购买链接回归", purchaseUrl: "https://detail.1688.com/offer/456.html" });
    const updated = await updateInventoryItem(userId, item.id, {
      productName: item.productName,
      purchaseUrl: "https://example.com/product/456",
      color: item.color,
      brand: null,
      style: null,
      material: null,
      unitPrice: null,
      currentLocation: null,
      notes: null,
      version: item.version
    }, randomUUID());
    if (!updated || !("item" in updated) || !updated.item) throw new Error("库存编辑回归未返回更新记录");
    expect(updated.item.purchaseUrl).toBe("https://example.com/product/456");
  });

  it("keeps product, color variant and semantic movements atomic, idempotent and reversible", async () => {
    const createKey = `inventory-v2-create-${randomUUID()}`;
    const created = await createInventoryProduct(userId, {
      productName: `新库存模型回归-${randomUUID()}`,
      brand: "测试品牌",
      color: "黑色",
      initialUnopened: 2,
      currentLocation: "左柜",
      repurchaseDecision: "UNDECIDED",
      idempotencyKey: createKey
    }, randomUUID());
    expect(created).toMatchObject({
      reused: false,
      product: { variants: [{ color: "黑色", unopenedQuantity: 2, inUseQuantity: 0 }] },
      movement: { movementType: "STOCK_IN", unopenedDelta: 2 }
    });
    if (!created.product) throw new Error("新库存模型创建回归未返回货品");

    const createReused = await createInventoryProduct(userId, {
      productName: `幂等请求不应创建第二个货品-${randomUUID()}`,
      color: "白色",
      initialUnopened: 99,
      idempotencyKey: createKey
    }, randomUUID());
    expect(createReused).toMatchObject({ reused: true, product: { id: created.product.id } });

    const variantKey = `inventory-v2-variant-${randomUUID()}`;
    const added = await addInventoryVariant(userId, created.product.id, {
      color: "肤色",
      initialUnopened: 1,
      productVersion: created.product.version,
      idempotencyKey: variantKey
    }, randomUUID());
    if (!("product" in added) || !added.product) throw new Error("新增颜色回归未返回货品");
    expect(added.product.variants).toHaveLength(2);
    const lowerPriority = await createInventoryProduct(userId, {
      productName: `${created.product.productName}-次级`,
      color: "灰色",
      initialUnopened: 1,
      consumptionPriority: 2,
      productRating: 5,
      idempotencyKey: `inventory-v2-priority-low-${randomUUID()}`
    }, randomUUID());
    expect(lowerPriority.product).toMatchObject({ consumptionPriority: 2, productRating: 5 });
    const lowerPriorityVariant = lowerPriority.product?.variants[0];
    if (!lowerPriorityVariant) throw new Error("次级货品颜色款缺失");
    const retiredProductsBefore = (await listInventoryProducts(userId, { q: "", filter: "all" })).overview.retiredProducts;
    const retired = await updateInventoryVariantRepurchase(userId, lowerPriorityVariant.id, {
      repurchaseDecision: "DO_NOT_REPURCHASE",
      version: lowerPriorityVariant.version
    }, randomUUID());
    if (!("variant" in retired)) throw new Error("淘汰状态回归未返回颜色款");
    expect(retired.variant).toMatchObject({ repurchaseDecision: "DO_NOT_REPURCHASE", version: lowerPriorityVariant.version + 1 });
    const [legacyRetired] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, lowerPriorityVariant.legacyItemId!));
    expect(legacyRetired.repurchaseDecision).toBe("DO_NOT_REPURCHASE");
    const staleRetirement = await updateInventoryVariantRepurchase(userId, lowerPriorityVariant.id, {
      repurchaseDecision: "REPURCHASE",
      version: lowerPriorityVariant.version
    }, randomUUID());
    expect(staleRetirement).toMatchObject({ conflict: true, current: { version: lowerPriorityVariant.version + 1 } });
    const ratingsRequestId = randomUUID();
    const ratingsUpdated = await updateInventoryProductRatings(userId, created.product.id, {
      consumptionPriority: 5,
      productRating: 3,
      version: added.product.version
    }, ratingsRequestId);
    if (!("product" in ratingsUpdated) || !ratingsUpdated.product) throw new Error("评级回归未返回货品");
    expect(ratingsUpdated.product).toMatchObject({ consumptionPriority: 5, productRating: 3, version: added.product.version + 1 });
    const productRatingRequestId = randomUUID();
    const productRatingOnlyUpdated = await updateInventoryProductRatings(userId, created.product.id, {
      productRating: 4,
      version: added.product.version + 1
    }, productRatingRequestId);
    if (!("product" in productRatingOnlyUpdated) || !productRatingOnlyUpdated.product) throw new Error("商品评级单字段回归未返回货品");
    expect(productRatingOnlyUpdated.product).toMatchObject({ consumptionPriority: 5, productRating: 4, version: added.product.version + 2 });
    const staleRatingsUpdate = await updateInventoryProductRatings(userId, created.product.id, {
      consumptionPriority: 4,
      version: added.product.version
    }, randomUUID());
    expect(staleRatingsUpdate).toMatchObject({ conflict: true, currentVersion: added.product.version + 2 });
    const consumptionOrdered = await listInventoryProducts(userId, { q: created.product.productName, filter: "all" });
    expect(consumptionOrdered.products.map((product) => [product.consumptionPriority, product.productRating])).toEqual([[5, 4], [2, 5]]);
    expect(consumptionOrdered.overview.retiredProducts).toBe(retiredProductsBefore + 1);
    const [ratingsAudit] = await db.select().from(auditLogs).where(eq(auditLogs.requestId, ratingsRequestId)).limit(1);
    const [productRatingAudit] = await db.select().from(auditLogs).where(eq(auditLogs.requestId, productRatingRequestId)).limit(1);
    expect(ratingsAudit?.metadata).toEqual({ consumptionPriority: 5, productRating: 3 });
    expect(productRatingAudit?.metadata).toEqual({ productRating: 4 });
    const repurchaseAudits = await db.select().from(auditLogs).where(eq(auditLogs.action, "inventory_v2.variant.repurchase.update"));
    expect(repurchaseAudits.at(-1)?.metadata).toMatchObject({ repurchaseDecision: "DO_NOT_REPURCHASE" });
    const black = added.product.variants.find((variant) => variant.color === "黑色");
    if (!black) throw new Error("黑色颜色款缺失");

    const openKey = `inventory-v2-open-${randomUUID()}`;
    const opened = await applyInventoryAction(userId, black.id, {
      action: "OPEN_FOR_USE",
      quantity: 1,
      version: black.version,
      idempotencyKey: openKey
    }, randomUUID());
    if (!("variant" in opened) || !opened.variant) throw new Error("拆封回归未返回颜色款");
    expect(opened).toMatchObject({
      reused: false,
      variant: { unopenedQuantity: 1, inUseQuantity: 1 },
      movement: { unopenedDelta: -1, inUseDelta: 1, scrappedDelta: 0 }
    });

    const openedAgain = await applyInventoryAction(userId, black.id, {
      action: "OPEN_FOR_USE",
      quantity: 1,
      version: black.version,
      idempotencyKey: openKey
    }, randomUUID());
    expect(openedAgain).toMatchObject({ reused: true, variant: { unopenedQuantity: 1, inUseQuantity: 1 } });

    const scrapKey = `inventory-v2-scrap-${randomUUID()}`;
    const scrapped = await applyInventoryAction(userId, black.id, {
      action: "SCRAP_IN_USE",
      quantity: 1,
      version: opened.variant.version,
      idempotencyKey: scrapKey
    }, randomUUID());
    if (!("variant" in scrapped) || !scrapped.variant || !("movement" in scrapped) || !scrapped.movement) throw new Error("报废回归未返回颜色款");
    expect(scrapped).toMatchObject({
      variant: { unopenedQuantity: 1, inUseQuantity: 0 },
      movement: { scrappedDelta: 1 }
    });
    const scrappedOverview = await listInventoryProducts(userId, { q: created.product.productName, filter: "all" });
    expect(scrappedOverview.products[0].variants.find((variant) => variant.color === "黑色")?.scrappedQuantity).toBe(1);

    const impossible = await applyInventoryAction(userId, black.id, {
      action: "SCRAP_IN_USE",
      quantity: 1,
      version: scrapped.variant.version,
      idempotencyKey: `inventory-v2-negative-${randomUUID()}`
    }, randomUUID());
    expect(impossible).toMatchObject({ negative: true });

    const reversed = await reverseInventoryMovement(userId, scrapped.movement.id, {
      version: scrapped.variant.version,
      reason: "自动化回归撤销报废",
      idempotencyKey: `inventory-v2-reverse-${randomUUID()}`
    }, randomUUID());
    expect(reversed).toMatchObject({
      reused: false,
      variant: { unopenedQuantity: 1, inUseQuantity: 1 },
      movement: { movementType: "REVERSE", scrappedDelta: -1 }
    });

    const overview = await listInventoryProducts(userId, { q: created.product.productName, filter: "all" });
    const targetProduct = overview.products.find((product) => product.id === created.product?.id);
    expect(targetProduct?.variants).toHaveLength(2);
    expect(targetProduct?.variants.find((variant) => variant.color === "黑色")?.scrappedQuantity).toBe(0);
    const [legacyMirror] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, black.id));
    expect(legacyMirror).toMatchObject({ unopenedQuantity: 1, openedQuantity: 1 });
    const [legacyMovementCount, v2MovementCount] = await Promise.all([
      db.select({ value: count() }).from(inventoryMovements).where(eq(inventoryMovements.itemId, black.id)),
      db.select({ value: count() }).from(inventoryVariantMovements).where(eq(inventoryVariantMovements.variantId, black.id))
    ]);
    expect(legacyMovementCount[0].value).toBe(v2MovementCount[0].value);
  });

  it("ingests PlayStation and Nintendo snapshots into an isolated read-only staging model", async () => {
    const local = await createGame(userId, { nameZh: "平台快照精确匹配", nameEn: "Platform Snapshot Match" }, randomUUID());
    const nintendoLocal = await createGame(userId, { nameZh: "任天堂平台精确匹配", platform: "NINTENDO_SWITCH_2" }, randomUUID());
    const playstation = await ingestPlatformSnapshot(userId, {
      provider: "PLAYSTATION",
      externalUserId: "psn-regression-user",
      displayName: "Regression",
      items: [{ externalGameId: "PPSA-REGRESSION", name: "Platform Snapshot Match", platform: "PS5", playtimeMinutes: 120, isOwned: true, rawMetadata: { trophies: 3 } }]
    }, `psn-snapshot-${randomUUID()}`, randomUUID());
    expect(playstation).toMatchObject({ reused: false, matched: 1, unresolved: 0 });
    expect((await db.select().from(platformLibraryItems).where(eq(platformLibraryItems.externalGameId, "PPSA-REGRESSION")))[0]).toMatchObject({ provider: "PLAYSTATION", matchStatus: "MATCHED", matchedGameId: local.id, playtimeMinutes: 120 });
    const playstationAcquisition = (await db.select().from(gameAcquisitions).where(eq(gameAcquisitions.externalAcquisitionId, "PPSA-REGRESSION")))[0];
    expect(playstationAcquisition).toMatchObject({ source: "PLAYSTATION", channel: "SUBSCRIPTION", isOwned: false, offlineCapable: false });
    expect((await getGame(userId, local.id))?.playtimeMinutesSynced).toBe(120);
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION",
      gameId: local.id,
      acquisitionId: playstationAcquisition.id,
      version: playstationAcquisition.version,
      channel: "PHYSICAL",
      platform: "PS5",
      availability: "AVAILABLE",
      offlineCapable: true
    }, randomUUID());
    await ingestPlatformSnapshot(userId, {
      provider: "PLAYSTATION",
      externalUserId: "psn-regression-user",
      displayName: "Regression",
      items: [{ externalGameId: "PPSA-REGRESSION", name: "Platform Snapshot Match", platform: "PS5", playtimeMinutes: 180, isOwned: true, rawMetadata: { trophies: 4 } }]
    }, `psn-snapshot-refresh-${randomUUID()}`, randomUUID());
    expect((await db.select().from(gameAcquisitions).where(eq(gameAcquisitions.id, playstationAcquisition.id)))[0]).toMatchObject({
      channel: "PHYSICAL",
      offlineCapable: true,
      isOwned: true,
      details: expect.objectContaining({ classificationMode: "MANUAL", manuallyClassified: true })
    });
    const nintendo = await ingestPlatformSnapshot(userId, {
      provider: "NINTENDO",
      externalUserId: "nintendo-regression-user",
      items: [
        { externalGameId: "NSUID-REGRESSION", name: "未匹配任天堂游戏", platform: "Nintendo Switch 2", playtimeMinutes: 0, isOwned: true, rawMetadata: {} },
        { externalGameId: "NSUID-MATCHED", name: nintendoLocal.nameZh, platform: "NINTENDO_SWITCH_2", playtimeMinutes: 0, isOwned: false, rawMetadata: {} }
      ]
    }, `nintendo-snapshot-${randomUUID()}`, randomUUID());
    expect(nintendo).toMatchObject({ reused: false, matched: 1, unresolved: 1 });
    expect((await db.select().from(gameAcquisitions).where(eq(gameAcquisitions.externalAcquisitionId, "NSUID-MATCHED")))[0]).toMatchObject({ source: "NINTENDO", channel: "PHYSICAL", isOwned: true, offlineCapable: true });
  });

  it("parses the official Steam owned-games response without exposing credentials", async () => {
    let requestedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        response: { game_count: 1, games: [{ appid: 620, name: "Portal 2", playtime_forever: 321 }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const records = await fetchSteamOwnedGames("76561198000000000", "not-a-real-secret", fakeFetch);
    expect(records).toEqual([expect.objectContaining({ appid: 620, playtime_forever: 321 })]);
    expect(new URL(requestedUrl).searchParams.get("skip_unvetted_apps")).toBe("false");
  });

  it("normalizes Steam localized store metadata and review scores", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/appreviews/")) {
        return new Response(JSON.stringify({
          success: 1,
          query_summary: { total_positive: 90, total_negative: 10, total_reviews: 100, review_score_desc: "Very Positive" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const chinese = url.searchParams.get("l") === "schinese";
      return new Response(JSON.stringify({
        "620": {
          success: true,
          data: {
            name: chinese ? "传送门 2" : "Portal 2",
            header_image: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/620/header.jpg",
            release_date: { coming_soon: false, date: "18 Apr, 2011" },
            metacritic: { score: 95, url: "https://www.metacritic.com/game/portal-2/" }
          }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect(await fetchSteamStoreMetadata(620, fakeFetch)).toMatchObject({
      nameZh: "传送门 2",
      nameEn: "Portal 2",
      releaseDate: "2011-04-18",
      communityRating: 90,
      communityRatingCount: 100,
      criticRating: 95
    });
  });

  it("does not choose an arbitrary Steam mapping when imported titles are duplicated", () => {
    expect(uniqueSteamNameCandidate([{ id: "one" }])).toEqual({ id: "one" });
    expect(uniqueSteamNameCandidate([{ id: "one" }, { id: "two" }])).toBeUndefined();
    expect(normalizeSteamTitle("Portal® 2: Game of the Year")).toBe("portal2gameoftheyear");
  });

  it("accepts one exact IGDB alias but rejects ambiguous metadata matches", () => {
    const candidates = [
      { id: 1, name: "Sakuna: Of Rice and Ruin", alternative_names: [{ name: "天穗之咲稻姬" }] },
      { id: 2, name: "Another Game", alternative_names: [{ name: "另一个游戏" }] }
    ];
    expect(uniqueExactIgdbCandidate("天穗之咲稻姬", candidates)?.id).toBe(1);
    expect(uniqueExactIgdbCandidate("重复名", [
      { id: 1, name: "First", alternative_names: [{ name: "重复名" }] },
      { id: 2, name: "Second", alternative_names: [{ name: "重复名" }] }
    ])).toBeNull();
  });

  it("stages unmatched Steam records instead of creating duplicate games", async () => {
    const exactName = "Steam Match Regression 20260713";
    const unmatchedName = "Steam Unmatched Regression 20260713";
    const exactAppId = 987654321;
    const unmatchedAppId = 987654322;
    const relatedAppId = 987654323;
    await saveSteamAccount(userId, { steamId: "76561198000000000", displayName: "regression" }, randomUUID());
    const local = await createGame(userId, { nameZh: exactName, platform: null }, randomUUID());
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      response: {
        game_count: 3,
        games: [
          { appid: exactAppId, name: exactName, playtime_forever: 321, rtime_last_played: 1_700_000_000 },
          { appid: unmatchedAppId, name: unmatchedName, playtime_forever: 45 },
          { appid: relatedAppId, name: `${exactName} VR`, playtime_forever: 79 }
        ]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
    const synced = await syncSteamOwnedGames(userId, `steam-regression-${randomUUID()}`, {
      apiKey: "not-a-real-secret",
      fetcher: fakeFetch
    });
    expect(synced).toMatchObject({ processed: 3, matched: 1, unmatched: 2, created: 0 });
    const [matchedItem, unmatchedItem, relatedItem] = await Promise.all([
      db.select().from(steamLibraryItems).where(eq(steamLibraryItems.steamAppId, exactAppId)).limit(1),
      db.select().from(steamLibraryItems).where(eq(steamLibraryItems.steamAppId, unmatchedAppId)).limit(1),
      db.select().from(steamLibraryItems).where(eq(steamLibraryItems.steamAppId, relatedAppId)).limit(1)
    ]);
    expect(matchedItem[0]).toMatchObject({ matchStatus: "MATCHED", matchedGameId: local.id, matchMethod: "UNIQUE_EXACT_TITLE" });
    expect(unmatchedItem[0]).toMatchObject({ matchStatus: "UNMATCHED", matchedGameId: null, matchMethod: "NO_MATCH" });
    expect(relatedItem[0]).toMatchObject({ matchStatus: "UNMATCHED", matchedGameId: null, matchMethod: "NO_MATCH" });
    expect(await db.select().from(games).where(eq(games.steamAppId, unmatchedAppId))).toHaveLength(0);

    const related = await resolveSteamLibraryItem(userId, relatedAppId, { action: "MATCH", gameId: local.id }, randomUUID());
    expect(related.game).toMatchObject({
      id: local.id,
      steamAppId: exactAppId,
      playtimeMinutesSynced: 400
    });
    const mappings = await db.select().from(externalGameMappings).where(eq(externalGameMappings.gameId, local.id));
    expect(mappings.map((mapping) => mapping.externalGameId).sort()).toEqual([String(exactAppId), String(relatedAppId)].sort());

    const resynced = await syncSteamOwnedGames(userId, `steam-regression-${randomUUID()}`, {
      apiKey: "not-a-real-secret",
      fetcher: fakeFetch
    });
    expect(resynced).toMatchObject({ processed: 3, matched: 2, unmatched: 1, created: 0 });
    expect((await db.select().from(games).where(eq(games.id, local.id)).limit(1))[0]).toMatchObject({
      steamAppId: exactAppId,
      playtimeMinutesSynced: 400
    });

    const created = await resolveSteamLibraryItem(userId, unmatchedAppId, { action: "CREATE" }, randomUUID());
    expect(created).toMatchObject({ action: "CREATE", item: { matchStatus: "MATCHED", matchMethod: "MANUAL_CREATE" } });
    expect(created.game).toMatchObject({ nameZh: unmatchedName, steamAppId: unmatchedAppId, playtimeMinutesSynced: 45 });
  });

  it("ingests Steam Family access without treating it as a purchase", async () => {
    const marker = randomUUID().slice(0, 8);
    const appId = 987_655_000;
    const unmatchedAppId = 987_655_001;
    const local = await createGame(userId, {
      nameZh: `家庭共享回归 ${marker}`,
      nameEn: `Family Sharing Regression ${marker}`,
      platform: "STEAM",
      statuses: ["WISHLIST"]
    }, randomUUID());
    await saveSteamAccount(userId, { steamId: "76561198000000000", displayName: "regression" }, randomUUID());
    const result = await ingestSteamFamilySnapshot(userId, {
      steamId: "76561198000000000",
      familyGroupId: "123456789",
      items: [
        {
          appId,
          name: `Family Sharing Regression ${marker}`,
          ownerSteamIds: ["76561198000000001"],
          excludeReason: 0,
          playtimeMinutes: 0,
          lastPlayedAt: null,
          iconUrl: null,
          rawMetadata: {}
        },
        {
          appId: unmatchedAppId,
          name: `Family Sharing Unmatched ${marker}`,
          ownerSteamIds: ["76561198000000002"],
          excludeReason: 0,
          playtimeMinutes: 120,
          lastPlayedAt: "2026-07-18T12:00:00.000Z",
          iconUrl: null,
          rawMetadata: {}
        }
      ]
    }, `steam-family-regression-${randomUUID()}`, randomUUID());
    expect(result).toMatchObject({ matched: 1, unmatched: 1, unavailable: 0 });
    expect((await db.select().from(steamLibraryItems).where(eq(steamLibraryItems.steamAppId, appId)).limit(1))[0]).toMatchObject({
      licenseType: "FAMILY_SHARED",
      licenseOwnerSteamIds: ["76561198000000001"],
      familyGroupId: "123456789",
      isOwned: true,
      matchedGameId: local.id
    });
    const refreshed = await getGame(userId, local.id);
    expect(refreshed).toMatchObject({ ownershipStatus: "FAMILY_SHARED", purchaseState: "FAMILY_SHARED" });
    expect(refreshed?.statuses).toEqual(["BACKLOG"]);
    const acquisition = (await db.select().from(gameAcquisitions).where(and(
      eq(gameAcquisitions.gameId, local.id),
      eq(gameAcquisitions.externalAcquisitionId, String(appId))
    )).limit(1))[0];
    expect(acquisition).toMatchObject({ source: "STEAM", isOwned: false, channel: "FAMILY_SHARED", availability: "AVAILABLE", offlineCapable: false, details: expect.objectContaining({ accessType: "FAMILY_SHARED" }) });

    const createdFamily = await resolveSteamLibraryItem(userId, unmatchedAppId, { action: "CREATE" }, randomUUID());
    expect(createdFamily).toMatchObject({ action: "CREATE", item: { matchStatus: "MATCHED", matchMethod: "MANUAL_CREATE" } });
    if (!createdFamily.game) throw new Error("Expected a game to be created from the family-sharing item");
    expect(createdFamily.game).toMatchObject({
      nameZh: `Family Sharing Unmatched ${marker}`,
      steamAppId: unmatchedAppId,
      ownershipStatus: "FAMILY_SHARED",
      playStatus: "UNPLANNED",
      playtimeMinutesSynced: 120
    });
    expect((await getGame(userId, createdFamily.game.id))?.statuses).toContain("UNPLANNED");
  });

  it("keeps acquisition channels separate and sorts each play queue by access urgency", async () => {
    const subscription = await createGame(userId, { nameZh: `会免队列-${randomUUID()}`, statuses: ["BACKLOG"] }, randomUUID());
    const family = await createGame(userId, { nameZh: `家庭队列-${randomUUID()}`, statuses: ["BACKLOG"] }, randomUUID());
    const selfPurchased = await createGame(userId, { nameZh: `自购队列-${randomUUID()}`, statuses: ["BACKLOG"] }, randomUUID());
    for (const [game, channel, order] of [
      [subscription, "SUBSCRIPTION", 90],
      [family, "FAMILY_SHARED", 10],
      [selfPurchased, "SELF_PURCHASED", 1]
    ] as const) {
      await applyPlayPlannerAction(userId, {
        action: "SET_ACQUISITION", gameId: game.id, channel, platform: "STEAM",
        availability: "AVAILABLE", offlineCapable: true, acquisitionId: null
      }, randomUUID());
      await applyPlayPlannerAction(userId, {
        action: "SET_PLAN", gameId: game.id, scenario: "FIXED", state: "QUEUED",
        completionGoal: "EXTRA", queueOrder: order, acquisitionId: null, preferredDevice: "BEDROOM_5080", replaceCurrent: false
      }, randomUUID());
    }
    const planner = await getPlayPlannerData(userId);
    const ids = planner.scenarios.FIXED.queue.filter((plan) => [subscription.id, family.id, selfPurchased.id].includes(plan.gameId));
    expect(ids.map((plan) => plan.channel)).toEqual(["SUBSCRIPTION", "FAMILY_SHARED", "SELF_PURCHASED"]);
    expect(ids.map((plan) => plan.queueOrder)).toEqual([90, 10, 1]);
  });

  it("requires offline-native access for commute and enforces one active slot per scenario", async () => {
    const first = await createGame(userId, { nameZh: `通勤槽位A-${randomUUID()}`, statuses: ["BACKLOG"] }, randomUUID());
    const second = await createGame(userId, { nameZh: `通勤槽位B-${randomUUID()}`, statuses: ["BACKLOG"] }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION", gameId: first.id, channel: "SELF_PURCHASED", platform: "STEAM",
      availability: "AVAILABLE", offlineCapable: false, acquisitionId: null
    }, randomUUID());
    await expect(applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: first.id, scenario: "COMMUTE", state: "PLAYING",
      completionGoal: "MAIN", acquisitionId: null, preferredDevice: "COMMUTE_GPD", replaceCurrent: false
    }, randomUUID())).rejects.toMatchObject({ code: "OFFLINE_REQUIRED" } satisfies Partial<PlayPlannerError>);
    const firstAcquisition = (await db.select().from(gameAcquisitions).where(and(
      eq(gameAcquisitions.ownerUserId, userId), eq(gameAcquisitions.gameId, first.id)
    )).limit(1))[0];
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION", gameId: first.id, acquisitionId: firstAcquisition.id,
      version: firstAcquisition.version, channel: "SELF_PURCHASED", platform: "STEAM",
      availability: "AVAILABLE", offlineCapable: true
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_ACQUISITION", gameId: second.id, channel: "PHYSICAL", platform: "NINTENDO_SWITCH_2",
      availability: "AVAILABLE", offlineCapable: true, acquisitionId: null
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: first.id, scenario: "COMMUTE", state: "PLAYING",
      completionGoal: "MAIN", acquisitionId: null, preferredDevice: "COMMUTE_GPD", replaceCurrent: false
    }, randomUUID());
    await expect(applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: second.id, scenario: "COMMUTE", state: "PLAYING",
      completionGoal: "EXTRA", acquisitionId: null, preferredDevice: "COMMUTE_NS2", replaceCurrent: false
    }, randomUUID())).rejects.toMatchObject({ code: "SCENARIO_OCCUPIED" } satisfies Partial<PlayPlannerError>);
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: second.id, scenario: "COMMUTE", state: "PLAYING",
      completionGoal: "EXTRA", acquisitionId: null, preferredDevice: "COMMUTE_NS2", replaceCurrent: true
    }, randomUUID());
    const planner = await getPlayPlannerData(userId);
    expect(planner.scenarios.COMMUTE.current?.gameId).toBe(second.id);
    expect(planner.scenarios.COMMUTE.queue.some((plan) => plan.gameId === first.id)).toBe(true);
  });

  it("applies platform scenario defaults and moves a plan across scenarios atomically", async () => {
    const steam = await createGame(userId, { nameZh: `Steam双场景-${randomUUID()}`, platform: "STEAM", statuses: ["BACKLOG"] }, randomUUID());
    const switchGame = await createGame(userId, { nameZh: `Switch通勤-${randomUUID()}`, platform: "NINTENDO_SWITCH_2", statuses: ["BACKLOG"] }, randomUUID());
    const playStation = await createGame(userId, { nameZh: `PS固定-${randomUUID()}`, platform: "PLAYSTATION", statuses: ["BACKLOG"] }, randomUUID());
    const [steamAcquisition] = await db.insert(gameAcquisitions).values({
      ownerUserId: userId, gameId: steam.id, source: "STEAM", externalAcquisitionId: `steam:${randomUUID()}`,
      channel: "FAMILY_SHARED", platform: "STEAM", availability: "AVAILABLE", offlineCapable: false,
      details: { classificationMode: "PLATFORM_FALLBACK" }
    }).returning();
    const [switchAcquisition] = await db.insert(gameAcquisitions).values({
      ownerUserId: userId, gameId: switchGame.id, source: "NINTENDO", externalAcquisitionId: `switch:${randomUUID()}`,
      channel: "PHYSICAL", platform: "NINTENDO_SWITCH_2", availability: "AVAILABLE", offlineCapable: false,
      details: { classificationMode: "PLATFORM_FALLBACK" }
    }).returning();
    await db.insert(gameAcquisitions).values({
      ownerUserId: userId, gameId: playStation.id, source: "PLAYSTATION", externalAcquisitionId: `ps:${randomUUID()}`,
      channel: "SUBSCRIPTION", platform: "PLAYSTATION", availability: "AVAILABLE", offlineCapable: true,
      details: { classificationMode: "PLATFORM_FALLBACK" }
    });
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: steam.id, scenario: "FIXED", state: "QUEUED",
      acquisitionId: steamAcquisition.id, preferredDevice: "BEDROOM_5080", completionGoal: "EXTRA", replaceCurrent: false
    }, randomUUID());
    await applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: switchGame.id, scenario: "COMMUTE", state: "QUEUED",
      acquisitionId: switchAcquisition.id, preferredDevice: "COMMUTE_NS2", completionGoal: "EXTRA", replaceCurrent: false
    }, randomUUID());
    await expect(applyPlayPlannerAction(userId, {
      action: "SET_PLAN", gameId: playStation.id, scenario: "COMMUTE", state: "QUEUED",
      acquisitionId: null, preferredDevice: "COMMUTE_GPD", completionGoal: "EXTRA", replaceCurrent: false
    }, randomUUID())).rejects.toMatchObject({ code: "OFFLINE_REQUIRED" } satisfies Partial<PlayPlannerError>);
    const beforeMove = await getPlayPlannerData(userId);
    const steamFixed = beforeMove.scenarios.FIXED.queue.find((plan) => plan.gameId === steam.id);
    expect(steamFixed).toBeDefined();
    await applyPlayPlannerAction(userId, {
      action: "MOVE_PLAN", gameId: steam.id,
      sourceScenario: "FIXED", targetScenario: "COMMUTE", targetState: "QUEUED",
      sourceVersion: steamFixed!.version, acquisitionId: null, preferredDevice: null,
      completionGoal: "EXTRA", queueOrder: null, replaceCurrent: false
    }, randomUUID());
    const afterMove = await getPlayPlannerData(userId);
    expect(afterMove.scenarios.FIXED.queue.some((plan) => plan.gameId === steam.id)).toBe(false);
    expect(afterMove.scenarios.COMMUTE.queue.some((plan) => plan.gameId === steam.id)).toBe(true);
    expect(afterMove.scenarios.COMMUTE.queue.some((plan) => plan.gameId === switchGame.id)).toBe(true);
    expect(afterMove.scenarios.COMMUTE.queue.find((plan) => plan.gameId === steam.id)?.game.acquisitions[0]).toMatchObject({ commuteEligible: true, fixedEligible: true });
    expect(afterMove.scenarios.COMMUTE.queue.find((plan) => plan.gameId === switchGame.id)?.game.acquisitions[0]).toMatchObject({ commuteEligible: true });
  });
});
