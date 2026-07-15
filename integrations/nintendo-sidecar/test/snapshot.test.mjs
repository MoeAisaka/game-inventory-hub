import test from "node:test";
import assert from "node:assert/strict";
import { buildNintendoNsoPreview, buildNintendoPreview, discoverPlayers } from "../src/snapshot.mjs";

const title = {
  applicationId: "0100TEST00000000",
  title: "Example Game",
  imageUri: { large: "https://example.com/cover.jpg" },
  shopUri: "https://example.com/game",
  firstPlayDate: "2026-07-01"
};

const daily = [{
  deviceId: "device-1",
  date: "2026-07-14",
  lastPlayedAt: 1783990000,
  playedApps: [title],
  devicePlayers: [{ playerId: "player-1", nickname: "Yukina", playedApps: [{ applicationId: title.applicationId, playingTime: 3600 }] }],
  anonymousPlayer: null
}];

test("discovers named players without merging them", () => {
  const players = discoverPlayers(daily, []);
  assert.deepEqual(players, [{ id: "player-1", nickname: "Yukina", anonymous: false }]);
});

test("builds a preview-only snapshot and does not infer ownership", () => {
  const preview = buildNintendoPreview({ devices: { count: 1, items: [] }, daily, monthly: [], playerId: null, capturedAt: new Date("2026-07-14T00:00:00Z") });
  assert.equal(preview.snapshot.items.length, 1);
  assert.equal(preview.snapshot.items[0].playtimeMinutes, 60);
  assert.equal(preview.snapshot.items[0].isOwned, false);
  assert.equal(preview.snapshot.items[0].platform, "NINTENDO_SWITCH_FAMILY");
  assert.match(preview.idempotencyKey, /^nintendo-[a-f0-9]{40}$/);
});

test("requires explicit player selection on multi-user consoles", () => {
  const multiple = [{ ...daily[0], devicePlayers: [
    ...daily[0].devicePlayers,
    { playerId: "player-2", nickname: "Guest", playedApps: [] }
  ] }];
  assert.throws(
    () => buildNintendoPreview({ devices: { count: 1 }, daily: multiple, monthly: [], playerId: null }),
    (error) => error.code === "NINTENDO_PLAYER_SELECTION_REQUIRED" && error.details.players.length === 2
  );
});

test("monthly totals take precedence over daily records for the same month", () => {
  const monthly = [{
    deviceId: "device-1",
    month: "2026-07",
    playedApps: [title],
    devicePlayers: [{
      playerId: "player-1",
      nickname: "Yukina",
      insights: { rankings: { byTime: [{ applicationId: title.applicationId, units: 7200 }] } }
    }]
  }];
  const preview = buildNintendoPreview({ devices: { count: 1 }, daily, monthly, playerId: "player-1" });
  assert.equal(preview.snapshot.items[0].playtimeMinutes, 120);
});

test("builds NSO play activity without inferring ownership", () => {
  const preview = buildNintendoNsoPreview({
    playLog: [{
      name: "The Legend of Zelda",
      imageUri: "https://example.com/zelda.jpg",
      shopUri: "https://ec.nintendo.com/apps/0100abcdef123456/US",
      totalPlayTime: 5400,
      firstPlayedAt: 1780000000
    }],
    capturedAt: new Date("2026-07-14T12:00:00.000Z")
  });
  assert.equal(preview.schemaVersion, "nintendo-nso-preview.v1");
  assert.equal(preview.snapshot.items[0].externalGameId, "title:0100abcdef123456");
  assert.equal(preview.snapshot.items[0].playtimeMinutes, 90);
  assert.equal(preview.snapshot.items[0].isOwned, false);
  assert.equal(preview.snapshot.items[0].lastPlayedAt, null);
});

test("derives NSO last played time only when a later snapshot increases", () => {
  const first = buildNintendoNsoPreview({
    playLog: [{ name: "Game", imageUri: "", shopUri: "https://ec.nintendo.com/apps/0100000000000001/US", totalPlayTime: 3600, firstPlayedAt: 1780000000 }],
    capturedAt: new Date("2026-07-14T10:00:00.000Z")
  });
  const second = buildNintendoNsoPreview({
    playLog: [{ name: "Game", imageUri: "", shopUri: "https://ec.nintendo.com/apps/0100000000000001/US", totalPlayTime: 7200, firstPlayedAt: 1780000000 }],
    previous: first,
    capturedAt: new Date("2026-07-14T12:00:00.000Z")
  });
  assert.equal(second.snapshot.items[0].lastPlayedAt, "2026-07-14T12:00:00.000Z");
  assert.equal(second.summary.lastPlayedDerivedCount, 1);
});

test("keeps NSO content hash stable when only prior snapshot bookkeeping changes", () => {
  const playLog = [{
    name: "Game",
    imageUri: "",
    shopUri: "https://ec.nintendo.com/apps/0100000000000001/US",
    totalPlayTime: 3600,
    firstPlayedAt: 1780000000
  }];
  const first = buildNintendoNsoPreview({
    playLog,
    capturedAt: new Date("2026-07-14T10:00:00.000Z")
  });
  const second = buildNintendoNsoPreview({
    playLog,
    previous: first,
    capturedAt: new Date("2026-07-14T12:00:00.000Z")
  });
  assert.equal(first.summary.contentSha256, second.summary.contentSha256);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.snapshot.items[0].rawMetadata.priorPlaytimeMinutes, null);
  assert.equal(second.snapshot.items[0].rawMetadata.priorPlaytimeMinutes, 60);
});
