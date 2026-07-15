import { createHash } from "node:crypto";
import { durationToMinutes } from "./duration.mjs";

export function normalizeTitle(value) {
  return String(value ?? "").replace(/[™®©]/g, "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function playedKey(item) {
  if (item?.concept?.id !== null && item?.concept?.id !== undefined) return `concept:${item.concept.id}`;
  if (item?.titleId) return `title:${item.titleId}`;
  return `name:${normalizeTitle(item?.localizedName || item?.name)}`;
}

function purchasedKey(item) {
  if (item?.conceptId) return `concept:${item.conceptId}`;
  if (item?.titleId) return `title:${item.titleId}`;
  if (item?.productId) return `product:${item.productId}`;
  return `name:${normalizeTitle(item?.name)}`;
}

function platformFromPlayed(item) {
  const category = item?.category;
  if (category === "ps5_native_game") return "PS5";
  if (category === "ps4_game") return "PS4";
  if (category === "pspc_game") return "PC";
  return null;
}

function chooseCover(item) {
  return item?.localizedImageUrl || item?.imageUrl || item?.concept?.media?.images?.find((image) => image?.url)?.url || null;
}

function safeDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function trophyProgressByName(trophies) {
  const byName = new Map();
  for (const trophy of trophies) {
    const key = normalizeTitle(trophy?.trophyTitleName);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), trophy]);
  }
  return byName;
}

export function buildSnapshot(data, capturedAt = new Date()) {
  const merged = new Map();
  const nameToKey = new Map();
  const trophiesByName = trophyProgressByName(data.trophies);

  for (const item of data.played) {
    const key = playedKey(item);
    const name = item.localizedName || item.concept?.name || item.name;
    const normalized = normalizeTitle(name);
    const trophyCandidates = trophiesByName.get(normalized) ?? [];
    merged.set(key, {
      externalGameId: key,
      name,
      platform: platformFromPlayed(item),
      coverUrl: chooseCover(item),
      playtimeMinutes: durationToMinutes(item.playDuration),
      firstPlayedAt: safeDate(item.firstPlayedDateTime),
      lastPlayedAt: safeDate(item.lastPlayedDateTime),
      progressPercent: trophyCandidates.length === 1 ? trophyCandidates[0].progress : null,
      isOwned: item.service === "none_purchased" || item.service === "ps_plus",
      rawMetadata: {
        conceptId: item.concept?.id ?? null,
        titleId: item.titleId ?? null,
        titleIds: item.concept?.titleIds ?? [],
        category: item.category ?? null,
        service: item.service ?? null,
        playCount: item.playCount ?? null,
        sources: ["played_games"],
        trophyMatch: trophyCandidates.length === 1 ? "UNIQUE_NORMALIZED_NAME" : trophyCandidates.length > 1 ? "AMBIGUOUS" : "NONE"
      }
    });
    if (normalized) nameToKey.set(normalized, [...(nameToKey.get(normalized) ?? []), key]);
  }

  for (const item of data.purchased) {
    const directKey = purchasedKey(item);
    const normalized = normalizeTitle(item.name);
    const nameMatches = [...new Set(nameToKey.get(normalized) ?? [])];
    const key = merged.has(directKey) ? directKey : nameMatches.length === 1 ? nameMatches[0] : directKey;
    const existing = merged.get(key);
    if (existing) {
      existing.isOwned = true;
      existing.coverUrl ||= item.image?.url || null;
      existing.platform ||= item.platform || null;
      existing.rawMetadata = {
        ...existing.rawMetadata,
        productId: item.productId ?? null,
        entitlementId: item.entitlementId ?? null,
        membership: item.membership ?? null,
        isPreOrder: Boolean(item.isPreOrder),
        sources: [...new Set([...(existing.rawMetadata.sources ?? []), "purchased_games"])]
      };
      continue;
    }
    merged.set(key, {
      externalGameId: key,
      name: item.name,
      platform: item.platform || null,
      coverUrl: item.image?.url || null,
      playtimeMinutes: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      progressPercent: null,
      isOwned: true,
      rawMetadata: {
        conceptId: item.conceptId ?? null,
        titleId: item.titleId ?? null,
        productId: item.productId ?? null,
        entitlementId: item.entitlementId ?? null,
        membership: item.membership ?? null,
        isPreOrder: Boolean(item.isPreOrder),
        sources: ["purchased_games"]
      }
    });
  }

  const items = [...merged.values()].sort((a, b) => {
    const aTime = a.lastPlayedAt ? Date.parse(a.lastPlayedAt) : 0;
    const bTime = b.lastPlayedAt ? Date.parse(b.lastPlayedAt) : 0;
    return bTime - aTime || a.name.localeCompare(b.name, "en");
  });
  const snapshot = {
    provider: "PLAYSTATION",
    externalUserId: data.account.externalUserId,
    displayName: data.account.displayName,
    items
  };
  const digestPayload = JSON.stringify(snapshot);
  const digest = createHash("sha256").update(digestPayload).digest("hex");
  const summary = {
    capturedAt: capturedAt.toISOString(),
    status: data.warnings.length ? "PARTIAL" : "COMPLETE",
    playedSourceCount: data.played.length,
    purchasedSourceCount: data.purchased.length,
    trophySourceCount: data.trophies.length,
    mergedItemCount: items.length,
    ownedItemCount: items.filter((item) => item.isOwned).length,
    withPlaytimeCount: items.filter((item) => item.playtimeMinutes > 0).length,
    withProgressCount: items.filter((item) => item.progressPercent !== null).length,
    contentSha256: digest,
    warnings: data.warnings
  };
  return {
    schemaVersion: "playstation-preview.v1",
    summary,
    snapshot,
    idempotencyKey: `playstation-${digest.slice(0, 40)}`
  };
}
