import { createHash } from "node:crypto";
import { NintendoSidecarError } from "./errors.mjs";

function secondsToMinutes(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value / 60);
}

function unixToIso(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function dayToIso(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? `${value}T00:00:00.000Z` : null;
}

function titleIdFromShopUri(value) {
  const matched = /^https:\/\/ec\.nintendo\.com\/apps\/([0-9a-f]{16})\//i.exec(value ?? "");
  return matched?.[1]?.toLowerCase() ?? null;
}

function normalizePrevious(previous) {
  if (!previous?.snapshot?.items || !Array.isArray(previous.snapshot.items)) return new Map();
  return new Map(previous.snapshot.items.map((item) => [item.externalGameId, item]));
}

function snapshotForContentHash(snapshot) {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      const stableRawMetadata = { ...item.rawMetadata };
      delete stableRawMetadata.priorPlaytimeMinutes;
      return { ...item, rawMetadata: stableRawMetadata };
    })
  };
}

export function buildNintendoNsoPreview({ playLog, previous = null, capturedAt = new Date() }) {
  if (!Array.isArray(playLog)) {
    throw new NintendoSidecarError("NINTENDO_NSO_RESPONSE_INVALID", "Nintendo NSO 游玩记录格式无效");
  }
  const previousById = normalizePrevious(previous);
  const items = playLog.map((game, index) => {
    const titleId = titleIdFromShopUri(game.shopUri);
    const externalGameId = titleId ? `title:${titleId}` : `nso:${createHash("sha256").update(`${game.name}\n${game.shopUri ?? ""}`).digest("hex").slice(0, 32)}`;
    const playtimeMinutes = secondsToMinutes(game.totalPlayTime);
    const prior = previousById.get(externalGameId);
    const increased = prior && playtimeMinutes > (prior.playtimeMinutes ?? 0);
    return {
      externalGameId,
      name: String(game.name || `Nintendo game ${index + 1}`),
      platform: "NINTENDO_SWITCH_FAMILY",
      coverUrl: typeof game.imageUri === "string" && /^https?:\/\//i.test(game.imageUri) ? game.imageUri : null,
      playtimeMinutes,
      firstPlayedAt: unixToIso(game.firstPlayedAt),
      lastPlayedAt: increased ? capturedAt.toISOString() : (prior?.lastPlayedAt ?? null),
      progressPercent: null,
      isOwned: false,
      rawMetadata: {
        shopUrl: typeof game.shopUri === "string" ? game.shopUri : null,
        titleId,
        source: "nintendo_nso_play_activity",
        ownershipInferred: false,
        lastPlayedDerivedFromSnapshot: Boolean(increased),
        priorPlaytimeMinutes: prior?.playtimeMinutes ?? null
      }
    };
  }).sort((a, b) => (b.lastPlayedAt || "").localeCompare(a.lastPlayedAt || "") || a.name.localeCompare(b.name, "en"));

  const snapshot = {
    provider: "NINTENDO",
    externalUserId: "nso-self",
    displayName: "Nintendo Account",
    items
  };
  // priorPlaytimeMinutes is local comparison bookkeeping, not a Nintendo source fact.
  // Excluding it keeps consecutive no-change previews idempotent while preserving it
  // in the private preview for troubleshooting and future activity derivation.
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(snapshotForContentHash(snapshot)))
    .digest("hex");
  return {
    schemaVersion: "nintendo-nso-preview.v1",
    summary: {
      capturedAt: capturedAt.toISOString(),
      status: "COMPLETE",
      sourceCount: playLog.length,
      gameCount: items.length,
      withPlaytimeCount: items.filter((item) => item.playtimeMinutes > 0).length,
      totalPlaytimeMinutes: items.reduce((sum, item) => sum + item.playtimeMinutes, 0),
      lastPlayedDerivedCount: items.filter((item) => item.rawMetadata.lastPlayedDerivedFromSnapshot).length,
      contentSha256,
      limitations: [
        "PLAYED_TITLES_DO_NOT_PROVE_OWNERSHIP",
        "SWITCH_GENERATION_NOT_AVAILABLE",
        "LAST_PLAYED_REQUIRES_PERIODIC_SNAPSHOTS",
        "NO_PROGRESS_PERCENT"
      ]
    },
    snapshot,
    idempotencyKey: `nintendo-${contentSha256.slice(0, 40)}`
  };
}

export function discoverPlayers(daily, monthly) {
  const players = new Map();
  for (const summary of daily) {
    for (const player of summary.devicePlayers ?? []) {
      players.set(player.playerId, { id: player.playerId, nickname: player.nickname || "Nintendo player", anonymous: false });
    }
    if (summary.anonymousPlayer) players.set("__anonymous__", { id: "__anonymous__", nickname: "Unknown user", anonymous: true });
  }
  for (const summary of monthly) {
    for (const player of summary.devicePlayers ?? []) {
      players.set(player.playerId, { id: player.playerId, nickname: player.nickname || "Nintendo player", anonymous: false });
    }
  }
  return [...players.values()].sort((a, b) => a.nickname.localeCompare(b.nickname, "en"));
}

function selectPlayer(players, configuredId) {
  if (configuredId) {
    const player = players.find((candidate) => candidate.id === configuredId);
    if (!player) throw new NintendoSidecarError("NINTENDO_PLAYER_NOT_FOUND", "指定的 Nintendo 玩家不存在", { players });
    return player;
  }
  if (players.length === 1) return players[0];
  if (players.length === 0) throw new NintendoSidecarError("NINTENDO_USAGE_EMPTY", "Nintendo 家长控制中没有可用的玩家记录");
  throw new NintendoSidecarError("NINTENDO_PLAYER_SELECTION_REQUIRED", "检测到多个 Nintendo 玩家，必须明确选择一个玩家", { players });
}

function titleCatalog(daily, monthly) {
  const titles = new Map();
  for (const summary of [...daily, ...monthly]) {
    for (const title of summary.playedApps ?? []) {
      titles.set(title.applicationId, {
        id: title.applicationId,
        name: title.title,
        coverUrl: title.imageUri?.large || title.imageUri?.medium || null,
        shopUrl: title.shopUri || null,
        firstPlayDate: title.firstPlayDate || null
      });
    }
  }
  return titles;
}

function addUsage(target, applicationId, seconds, date, deviceId, source) {
  const current = target.get(applicationId) ?? { seconds: 0, first: null, last: null, devices: new Set(), sources: new Set(), days: new Set() };
  current.seconds += Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (date && (!current.first || date < current.first)) current.first = date;
  if (date && (!current.last || date > current.last)) current.last = date;
  if (deviceId) current.devices.add(deviceId);
  if (source) current.sources.add(source);
  if (date) current.days.add(date.slice(0, 10));
  target.set(applicationId, current);
}

function monthlyUsage(monthly, player, target) {
  const coveredMonths = new Set();
  for (const summary of monthly) {
    const selected = (summary.devicePlayers ?? []).find((candidate) => candidate.playerId === player.id);
    if (!selected) continue;
    coveredMonths.add(`${summary.deviceId}:${summary.month}`);
    for (const ranking of selected.insights?.rankings?.byTime ?? []) {
      addUsage(target, ranking.applicationId, ranking.units, `${summary.month}-01T00:00:00.000Z`, summary.deviceId, "parental_controls_monthly");
    }
  }
  return coveredMonths;
}

function dailyUsage(daily, player, target, coveredMonths) {
  for (const summary of daily) {
    if (coveredMonths.has(`${summary.deviceId}:${summary.date?.slice(0, 7)}`)) continue;
    const selected = player.anonymous
      ? summary.anonymousPlayer
      : (summary.devicePlayers ?? []).find((candidate) => candidate.playerId === player.id);
    if (!selected) continue;
    for (const title of selected.playedApps ?? []) {
      addUsage(target, title.applicationId, title.playingTime, unixToIso(summary.lastPlayedAt) || dayToIso(summary.date), summary.deviceId, "parental_controls_daily");
    }
  }
}

export function buildNintendoPreview({ devices, daily, monthly, playerId, capturedAt = new Date() }) {
  const players = discoverPlayers(daily, monthly);
  const player = selectPlayer(players, playerId);
  const catalog = titleCatalog(daily, monthly);
  const usage = new Map();
  const coveredMonths = monthlyUsage(monthly, player, usage);
  dailyUsage(daily, player, usage, coveredMonths);

  const items = [...usage.entries()].map(([applicationId, record]) => {
    const title = catalog.get(applicationId) ?? { name: applicationId, coverUrl: null, shopUrl: null, firstPlayDate: null };
    return {
      externalGameId: applicationId,
      name: title.name,
      platform: "NINTENDO_SWITCH_FAMILY",
      coverUrl: title.coverUrl,
      playtimeMinutes: secondsToMinutes(record.seconds),
      firstPlayedAt: dayToIso(title.firstPlayDate) || record.first,
      lastPlayedAt: record.last,
      progressPercent: null,
      isOwned: false,
      rawMetadata: {
        shopUrl: title.shopUrl,
        source: "nintendo_parental_controls",
        sourceRecords: [...record.sources].sort(),
        deviceIds: [...record.devices].sort(),
        playingDays: record.days.size,
        ownershipInferred: false
      }
    };
  }).sort((a, b) => (b.lastPlayedAt || "").localeCompare(a.lastPlayedAt || "") || a.name.localeCompare(b.name, "en"));

  const snapshot = {
    provider: "NINTENDO",
    externalUserId: `pctl-player:${player.id}`,
    displayName: player.nickname,
    items
  };
  const contentSha256 = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return {
    schemaVersion: "nintendo-pctl-preview.v1",
    summary: {
      capturedAt: capturedAt.toISOString(),
      status: "COMPLETE",
      deviceCount: devices?.count ?? devices?.items?.length ?? 0,
      playerCount: players.length,
      selectedPlayer: player,
      dailySummaryCount: daily.length,
      monthlySummaryCount: monthly.length,
      gameCount: items.length,
      totalPlaytimeMinutes: items.reduce((sum, item) => sum + item.playtimeMinutes, 0),
      contentSha256,
      limitations: [
        "PLAYED_TITLES_DO_NOT_PROVE_OWNERSHIP",
        "SWITCH_GENERATION_NOT_AVAILABLE",
        "NO_PROGRESS_PERCENT"
      ]
    },
    snapshot,
    idempotencyKey: `nintendo-${contentSha256.slice(0, 40)}`
  };
}
