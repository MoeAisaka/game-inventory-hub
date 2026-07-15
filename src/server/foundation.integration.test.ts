import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login } from "@/server/auth/login";
import { deriveActivityState } from "@/lib/game-insights";
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
  gameFieldLocks,
  gameMetadataCandidates,
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
  platformLibraryItems,
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
import { createGame, gameQuerySchema, listGames, updateGame } from "@/server/services/games";
import { addInventoryMovement, createInventoryItem, updateInventoryItem } from "@/server/services/inventory";
import { getDashboardFilters, saveDashboardFilters } from "@/server/services/preferences";
import { saveSteamAccount } from "@/server/integrations/accounts";
import { resolveSteamLibraryItem } from "@/server/integrations/steam-library";
import { fetchSteamOwnedGames, normalizeSteamTitle, syncSteamOwnedGames, uniqueSteamNameCandidate } from "@/server/integrations/steam";
import { fetchSteamStoreMetadata } from "@/server/integrations/steam-store";
import { canonicalEnglishName, uniqueExactIgdbCandidate } from "@/server/integrations/igdb";
import { ingestPlatformSnapshot } from "@/server/integrations/platform-snapshot";

const password = "test-password-that-is-long"; // secret-scan: allow
let userId = "";
const realSource = resolve(".source-readonly/游戏清单+折腾清单_已修正.xlsx");

beforeAll(async () => {
  await db.delete(userPreferences);
  await db.delete(steamLibraryItems);
  await db.delete(platformLibraryItems);
  await db.delete(syncJobs);
  await db.delete(externalGameMappings);
  await db.delete(externalAccounts);
  await db.delete(gameActivitySnapshots);
  await db.delete(gameAcquisitions);
  await db.delete(gameMetadataCandidates);
  await db.delete(gameRatings);
  await db.delete(gameFieldLocks);
  await db.delete(gameReleaseEvents);
  await db.delete(gamePlaySessions);
  await db.delete(gameStatusAssignments);
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
  });

  it("keeps the 48-hour rule as an inferred completion candidate instead of overwriting confirmed status", () => {
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
      statuses: ["BACKLOG", "TO_BUY"],
      queueOrder: 10
    }, randomUUID());
    if (!queued || queued.conflict) throw new Error("多状态更新失败");
    expect(queued.game).toMatchObject({ statuses: ["BACKLOG", "TO_BUY"], queueOrder: 10, playStatus: "BACKLOG" });
    const removedFromQueue = await updateGame(userId, game.id, {
      version: queued.game.version,
      statuses: ["TO_BUY"]
    }, randomUUID());
    if (!removedFromQueue || removedFromQueue.conflict) throw new Error("多状态清理队列失败");
    expect(removedFromQueue.game).toMatchObject({ statuses: ["TO_BUY"], queueOrder: null, playStatus: null });
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

  it("ingests PlayStation and Nintendo snapshots into an isolated read-only staging model", async () => {
    const local = await createGame(userId, { nameZh: "平台快照精确匹配", nameEn: "Platform Snapshot Match" }, randomUUID());
    const playstation = await ingestPlatformSnapshot(userId, {
      provider: "PLAYSTATION",
      externalUserId: "psn-regression-user",
      displayName: "Regression",
      items: [{ externalGameId: "PPSA-REGRESSION", name: "Platform Snapshot Match", platform: "PS5", playtimeMinutes: 120, isOwned: true, rawMetadata: { trophies: 3 } }]
    }, `psn-snapshot-${randomUUID()}`, randomUUID());
    expect(playstation).toMatchObject({ reused: false, matched: 1, unresolved: 0 });
    expect((await db.select().from(platformLibraryItems).where(eq(platformLibraryItems.externalGameId, "PPSA-REGRESSION")))[0]).toMatchObject({ provider: "PLAYSTATION", matchStatus: "MATCHED", matchedGameId: local.id, playtimeMinutes: 120 });
    const nintendo = await ingestPlatformSnapshot(userId, {
      provider: "NINTENDO",
      externalUserId: "nintendo-regression-user",
      items: [{ externalGameId: "NSUID-REGRESSION", name: "未匹配任天堂游戏", platform: "Nintendo Switch 2", playtimeMinutes: 0, isOwned: true, rawMetadata: {} }]
    }, `nintendo-snapshot-${randomUUID()}`, randomUUID());
    expect(nintendo).toMatchObject({ reused: false, matched: 0, unresolved: 1 });
  });

  it("parses the official Steam owned-games response without exposing credentials", async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      response: { game_count: 1, games: [{ appid: 620, name: "Portal 2", playtime_forever: 321 }] }
    }), { status: 200, headers: { "content-type": "application/json" } });
    const records = await fetchSteamOwnedGames("76561198000000000", "server-only-test-key", fakeFetch);
    expect(records).toEqual([expect.objectContaining({ appid: 620, playtime_forever: 321 })]);
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
      apiKey: "server-only-test-key", // secret-scan: allow
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
      apiKey: "server-only-test-key", // secret-scan: allow
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
});
