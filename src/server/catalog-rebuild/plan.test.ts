import { describe, expect, test } from "vitest";
import { assertUniquePlannedIgdbIds, buildCatalogRebuildPlan, identityTitle, verifyCatalogRebuildPlan, type RebuildSources, type SourceItem } from "./plan";

function source(provider: SourceItem["provider"], externalGameId: string, name: string, extra: Partial<SourceItem> = {}): SourceItem {
  return { provider, externalGameId, name, isOwned: true, ...extra };
}

function fixture(): RebuildSources {
  return {
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    capturedAt: "2026-07-14T00:00:00.000Z",
    steam: Array.from({ length: 302 }, (_, index) => source("STEAM", String(1000 + index), index === 0 ? "Example Game" : `Steam Game ${index}`)),
    playstation: {
      status: "COMPLETE",
      contentSha256: "a".repeat(64),
      externalUserId: "ps-user",
      displayName: "PS User",
      items: Array.from({ length: 605 }, (_, index) => source("PLAYSTATION", `concept:${index}`, index === 0 ? "Example Game Enhanced Edition" : `PlayStation Game ${index}`, { platform: index % 2 ? "PS4" : "PS5" }))
    },
    nintendo: {
      status: "COMPLETE",
      contentSha256: "b".repeat(64),
      externalUserId: "nso-self",
      displayName: "Nintendo Account",
      items: [source("NINTENDO", "title:0100000000000001", "Example Game", { isOwned: false, playtimeMinutes: 120 })]
    },
    igdb: Array.from({ length: 325 }, (_, index) => ({
      externalGameId: String(5000 + index), oldGameId: `old-${index}`, nameZh: index === 0 ? "示例游戏" : `IGDB Game ${index}`, nameEn: index === 0 ? "Example Game" : null,
      coverUrl: index === 0 ? "https://example.com/cover.jpg" : null, releaseDate: index === 0 ? "2026-01-01" : null,
      communityRating: null, communityRatingCount: null, criticRating: null, criticRatingCount: null,
      estimatedHastilyMinutes: null, estimatedNormallyMinutes: null, estimatedCompletelyMinutes: null
    })),
    existingMappings: [
      { oldGameId: "old-0", provider: "STEAM", externalGameId: "1000" },
      { oldGameId: "old-0", provider: "IGDB", externalGameId: "5000" }
    ]
  };
}

describe("catalog rebuild identity", () => {
  test("merges standard/enhanced and cross-platform records without removing remaster identity", () => {
    expect(identityTitle("Example Game Enhanced Edition")).toBe(identityTitle("Example Game"));
    expect(identityTitle("Example Game Remastered")).not.toBe(identityTitle("Example Game"));
  });

  test("uses audited identity overrides to separate reboots and merge platform-labelled variants", () => {
    const sources = fixture();
    sources.playstation.items[0] = source("PLAYSTATION", "title:new", "Example Game", {
      platform: "PS5",
      identityTitleOverride: "Example Game 2026"
    });
    sources.nintendo.items[0] = source("NINTENDO", "title:switch", "Example Game: Nintendo Switch Edition", {
      identityTitleOverride: "Example Game"
    });
    const plan = buildCatalogRebuildPlan(sources, new Date("2026-07-14T08:00:00.000Z"));
    const base = plan.games.find((game) => game.sources.some((item) => item.externalGameId === "1000"));
    const reboot = plan.games.find((game) => game.sources.some((item) => item.externalGameId === "title:new"));
    expect(base?.sources.some((item) => item.externalGameId === "title:switch")).toBe(true);
    expect(reboot?.id).not.toBe(base?.id);
  });

  test("builds a deterministic plan and keeps all external mappings", () => {
    const first = buildCatalogRebuildPlan(fixture(), new Date("2026-07-14T08:00:00.000Z"));
    const second = buildCatalogRebuildPlan(fixture(), new Date("2026-07-14T08:00:00.000Z"));
    expect(first).toEqual(second);
    verifyCatalogRebuildPlan(first);
    const example = first.games.find((game) => game.igdbGameId === 5000);
    expect(example?.nameZh).toBe("示例游戏");
    expect(example?.sources.map((item) => item.provider).sort()).toEqual(["IGDB", "NINTENDO", "PLAYSTATION", "STEAM"]);
    expect(example?.playtimeMinutesSynced).toBe(120);
  });

  test("refuses incomplete source sets", () => {
    const sources = fixture();
    sources.playstation.items.pop();
    expect(() => buildCatalogRebuildPlan(sources)).toThrow("PLAYSTATION_COUNT_MISMATCH");
  });

  test("rejects plans that contain duplicate IGDB identities", () => {
    const plan = buildCatalogRebuildPlan(fixture(), new Date("2026-07-14T08:00:00.000Z"));
    const identified = plan.games.find((game) => game.igdbGameId === 5000)!;
    const other = plan.games.find((game) => game.igdbGameId === null)!;
    other.igdbGameId = identified.igdbGameId;
    expect(() => assertUniquePlannedIgdbIds(plan.games)).toThrow("CATALOG_PLAN_DUPLICATE_IGDB_ID");
  });

  test("merges base and enhanced IGDB editions while selecting base metadata", () => {
    const sources = fixture();
    sources.igdb[1] = {
      ...sources.igdb[1],
      externalGameId: "5001",
      oldGameId: "old-enhanced",
      nameZh: "示例游戏增强版",
      nameEn: "Example Game Enhanced Edition",
      releaseDate: "2026-07-01"
    };
    sources.existingMappings.push(
      { oldGameId: "old-enhanced", provider: "IGDB", externalGameId: "5001" },
      { oldGameId: "old-enhanced", provider: "STEAM", externalGameId: "1001" }
    );
    sources.steam[1].name = "Example Game Enhanced Edition";
    const plan = buildCatalogRebuildPlan(sources, new Date("2026-07-14T08:00:00.000Z"));
    const example = plan.games.find((game) => game.sources.some((source) => source.externalGameId === "5000"));
    expect(example?.igdbGameId).toBe(5000);
    expect(example?.sources.filter((source) => source.provider === "IGDB")).toHaveLength(2);
  });
});
