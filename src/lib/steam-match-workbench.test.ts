import { describe, expect, it } from "vitest";
import { buildSteamMatchWorkbench, type SteamReviewLocalGame, type SteamReviewSourceItem } from "./steam-match-workbench";

const game = (overrides: Partial<SteamReviewLocalGame> = {}): SteamReviewLocalGame => ({
  id: crypto.randomUUID(),
  nameZh: "The Last of Us Part I",
  nameEn: "The Last of Us Part I",
  platform: "STEAM",
  steamAppId: null,
  searchAliases: [],
  ...overrides
});

const item = (overrides: Partial<SteamReviewSourceItem> = {}): SteamReviewSourceItem => ({
  steamAppId: 123,
  name: "A completely unrelated family game",
  playtimeMinutes: 0,
  recentPlaytimeMinutes: null,
  lastPlayedAt: null,
  iconUrl: null,
  matchMethod: "NO_MATCH",
  licenseType: "FAMILY_SHARED",
  ...overrides
});

describe("Steam match workbench", () => {
  it("keeps owned records in the high-priority lane", () => {
    const result = buildSteamMatchWorkbench([item({ licenseType: "OWNED" })], []);
    expect(result.items[0].lane).toBe("OWNED_MISSING");
    expect(result.counts.actionable).toBe(1);
  });

  it("separates demos, prologues and test clients from games", () => {
    const result = buildSteamMatchWorkbench([
      item({ steamAppId: 1, name: "Example Game Playtest" }),
      item({ steamAppId: 2, name: "Example Game Demo" }),
      item({ steamAppId: 3, name: "Example Game: Prologue" }),
      item({ steamAppId: 4, name: "Example Game - Public Beta Client" }),
      item({ steamAppId: 5, name: "Example Game - Test Server" }),
      item({ steamAppId: 6, name: "示例游戏（测试服)" })
    ], []);
    expect(result.counts.NON_GAME).toBe(6);
  });

  it("promotes family records with play history for review", () => {
    const result = buildSteamMatchWorkbench([item({ playtimeMinutes: 1 })], []);
    expect(result.items[0]).toMatchObject({ lane: "REVIEW", hasPlayHistory: true });
  });

  it("suggests a distinctive high-score title without automatically matching it", () => {
    const result = buildSteamMatchWorkbench([
      item({ name: "The Last of Us Part 1" })
    ], [game()]);
    expect(result.items[0].lane).toBe("REVIEW");
    expect(result.items[0].candidates[0]).toMatchObject({ nameZh: "The Last of Us Part I" });
    expect(result.items[0].candidates[0].score).toBeGreaterThanOrEqual(75);
  });

  it("labels sequel-number collisions as risks", () => {
    const result = buildSteamMatchWorkbench([
      item({ name: "Mafia III: Definitive Edition" })
    ], [game({ nameZh: "Mafia II: Definitive Edition", nameEn: "Mafia II: Definitive Edition", steamAppId: 360430 })]);
    expect(result.items[0].candidates[0].risks).toEqual(expect.arrayContaining([
      "SERIES_NUMBER_CONFLICT",
      "TARGET_ALREADY_HAS_STEAM_APP"
    ]));
  });

  it("keeps quiet family records in the searchable catalog", () => {
    const result = buildSteamMatchWorkbench([item()], [game()]);
    expect(result.items[0].lane).toBe("CATALOG");
    expect(result.counts).toMatchObject({ CATALOG: 1, actionable: 0 });
  });
});
