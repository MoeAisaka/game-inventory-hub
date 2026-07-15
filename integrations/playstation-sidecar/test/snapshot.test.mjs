import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, normalizeTitle } from "../src/snapshot.mjs";

const baseData = {
  account: { externalUserId: "account-1", displayName: "Yukina" },
  played: [{
    titleId: "PPSA00001_00",
    name: "Example Game™",
    localizedName: "Example Game™",
    category: "ps5_native_game",
    service: "none_purchased",
    playCount: 3,
    playDuration: "PT2H30M",
    firstPlayedDateTime: "2026-01-01T00:00:00Z",
    lastPlayedDateTime: "2026-01-02T00:00:00Z",
    localizedImageUrl: "https://example.com/cover.jpg",
    concept: { id: 42, titleIds: ["PPSA00001_00"], name: "Example Game", media: { images: [] } }
  }],
  purchased: [{
    conceptId: "42",
    titleId: "PPSA00001_00",
    productId: "PRODUCT-1",
    entitlementId: "ENTITLEMENT-1",
    name: "Example Game",
    platform: "PS5",
    image: { url: "https://example.com/purchased.jpg" },
    membership: "NONE",
    isPreOrder: false
  }],
  trophies: [{ trophyTitleName: "Example Game", progress: 55 }],
  warnings: []
};

test("merges played, purchased and trophy sources without duplicates", () => {
  const result = buildSnapshot(baseData, new Date("2026-07-14T00:00:00Z"));
  assert.equal(result.snapshot.items.length, 1);
  assert.deepEqual(result.snapshot.items[0], {
    externalGameId: "concept:42",
    name: "Example Game™",
    platform: "PS5",
    coverUrl: "https://example.com/cover.jpg",
    playtimeMinutes: 150,
    firstPlayedAt: "2026-01-01T00:00:00.000Z",
    lastPlayedAt: "2026-01-02T00:00:00.000Z",
    progressPercent: 55,
    isOwned: true,
    rawMetadata: {
      conceptId: 42,
      titleId: "PPSA00001_00",
      titleIds: ["PPSA00001_00"],
      category: "ps5_native_game",
      service: "none_purchased",
      playCount: 3,
      sources: ["played_games", "purchased_games"],
      trophyMatch: "UNIQUE_NORMALIZED_NAME",
      productId: "PRODUCT-1",
      entitlementId: "ENTITLEMENT-1",
      membership: "NONE",
      isPreOrder: false
    }
  });
  assert.match(result.idempotencyKey, /^playstation-[a-f0-9]{40}$/);
  assert.equal(result.summary.status, "COMPLETE");
});

test("content idempotency key is stable across capture times", () => {
  const first = buildSnapshot(baseData, new Date("2026-07-14T00:00:00Z"));
  const second = buildSnapshot(baseData, new Date("2026-07-15T00:00:00Z"));
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.summary.contentSha256, second.summary.contentSha256);
});

test("does not apply ambiguous trophy progress", () => {
  const data = { ...baseData, trophies: [{ trophyTitleName: "Example Game", progress: 20 }, { trophyTitleName: "Example Game", progress: 100 }] };
  const result = buildSnapshot(data);
  assert.equal(result.snapshot.items[0].progressPercent, null);
  assert.equal(result.snapshot.items[0].rawMetadata.trophyMatch, "AMBIGUOUS");
});

test("normalizes localized punctuation and trademarks", () => {
  assert.equal(normalizeTitle("  Example：Game™  "), "examplegame");
});
