import { createHash } from "node:crypto";

export type CatalogProvider = "STEAM" | "PLAYSTATION" | "NINTENDO" | "IGDB";

export type SourceItem = {
  provider: Exclude<CatalogProvider, "IGDB">;
  externalGameId: string;
  name: string;
  identityTitleOverride?: string | null;
  platform?: string | null;
  coverUrl?: string | null;
  playtimeMinutes?: number;
  recentPlaytimeMinutes?: number | null;
  firstPlayedAt?: string | null;
  lastPlayedAt?: string | null;
  progressPercent?: number | null;
  isOwned: boolean;
  rawMetadata?: Record<string, unknown>;
};

export type IgdbMetadata = {
  externalGameId: string;
  oldGameId: string;
  nameZh: string;
  nameEn: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  communityRating: number | null;
  communityRatingCount: number | null;
  criticRating: number | null;
  criticRatingCount: number | null;
  estimatedHastilyMinutes: number | null;
  estimatedNormallyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
};

export type ExistingMapping = {
  oldGameId: string;
  provider: CatalogProvider;
  externalGameId: string;
};

export type RebuildSources = {
  ownerUserId: string;
  capturedAt: string;
  steam: SourceItem[];
  playstation: { status: string; contentSha256: string; externalUserId: string; displayName: string | null; items: SourceItem[] };
  nintendo: { status: string; contentSha256: string; externalUserId: string; displayName: string | null; items: SourceItem[] };
  igdb: IgdbMetadata[];
  existingMappings: ExistingMapping[];
};

export type PlannedGame = {
  id: string;
  canonicalKey: string;
  nameZh: string;
  nameEn: string | null;
  platform: string;
  ownershipStatus: "OWNED" | "PLAYED_ONLY";
  playStatus: "BACKLOG" | "PLAYING" | "COMPLETED";
  startedAt: string | null;
  completedAt: string | null;
  lastPlayedAt: string | null;
  progressPercent: number | null;
  playtimeMinutesSynced: number;
  coverUrl: string | null;
  coverUrlSource: CatalogProvider | null;
  releaseDate: string | null;
  communityRating: number | null;
  communityRatingCount: number | null;
  criticRating: number | null;
  criticRatingCount: number | null;
  estimatedHastilyMinutes: number | null;
  estimatedNormallyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
  steamAppId: number | null;
  igdbGameId: number | null;
  sources: Array<{ provider: CatalogProvider; externalGameId: string; matchMethod: string }>;
};

export type CatalogRebuildPlan = {
  schemaVersion: "catalog-rebuild-plan.v1";
  generatedAt: string;
  ownerUserId: string;
  sourceSnapshotSha256: string;
  planSha256: string;
  accounts: Array<{ provider: "PLAYSTATION" | "NINTENDO"; externalUserId: string; displayName: string | null }>;
  summary: {
    steamCount: number;
    playstationCount: number;
    nintendoCount: number;
    igdbCount: number;
    canonicalGameCount: number;
    mergedSourceItemCount: number;
    ownedGameCount: number;
    playedOnlyGameCount: number;
    ambiguousTitleGroups: number;
  };
  ambiguities: Array<{ titleKey: string; igdbIds: string[]; sourceNodes: string[] }>;
  games: PlannedGame[];
  sourceItems: SourceItem[];
  igdb: IgdbMetadata[];
};

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(value: string) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) throw new Error(`UNKNOWN_UNION_NODE:${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string) {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    this.parent.set(a < b ? b : a, a < b ? a : b);
  }
}

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function deterministicUuid(key: string) {
  const hex = sha256(`game-inventory-catalog-v13:${key}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function strictTitle(value: string) {
  return String(value ?? "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/\biii\b/g, "3")
    .replace(/\bii\b/g, "2")
    .replace(/\biv\b/g, "4")
    .replace(/\bvi\b/g, "6")
    .replace(/\bvii\b/g, "7")
    .replace(/\bviii\b/g, "8")
    .replace(/\bix\b/g, "9")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function identityTitle(value: string) {
  return strictTitle(String(value ?? "")
    .replace(/\b(?:standard|digital deluxe|deluxe|ultimate|complete|definitive|enhanced|special|gold|legacy|collector'?s|premium)\s+edition\b/gi, " ")
    .replace(/\b(?:cross[- ]gen|ps4|ps5|playstation\s*[45])\s*(?:version|edition|bundle)?\b/gi, " ")
    .replace(/(?:标准|完全|完整|终极|究极|决定|豪华|加强|增强|特别|典藏|数字豪华)(?:版|版本)?/gi, " "));
}

function hasMergeableEditionMarker(value: string) {
  return /\b(?:standard|digital deluxe|deluxe|ultimate|complete|definitive|enhanced|special|gold|legacy|collector'?s|premium)\s+edition\b/i.test(value)
    || /(?:标准|完全|完整|终极|究极|决定|豪华|加强|增强|特别|典藏|数字豪华)(?:版|版本)?/u.test(value);
}

function metadataCompleteness(item: IgdbMetadata) {
  return [item.coverUrl, item.releaseDate, item.communityRating, item.criticRating, item.estimatedNormallyMinutes]
    .filter((value) => value !== null).length;
}

function primaryIgdb(items: IgdbMetadata[]) {
  return [...items].sort((left, right) => {
    const leftEdition = [left.nameZh, left.nameEn].filter((value): value is string => Boolean(value)).some(hasMergeableEditionMarker);
    const rightEdition = [right.nameZh, right.nameEn].filter((value): value is string => Boolean(value)).some(hasMergeableEditionMarker);
    if (leftEdition !== rightEdition) return leftEdition ? 1 : -1;
    const completeness = metadataCompleteness(right) - metadataCompleteness(left);
    if (completeness) return completeness;
    return (left.releaseDate ?? "9999").localeCompare(right.releaseDate ?? "9999") || left.externalGameId.localeCompare(right.externalGameId);
  })[0];
}

function nodeId(provider: CatalogProvider, externalGameId: string) {
  return `${provider}:${externalGameId}`;
}

function isEnglishTitle(value: string) {
  return /[A-Za-z]/.test(value) && !/[\p{Script=Han}]/u.test(value);
}

function isChineseTitle(value: string) {
  return /[\p{Script=Han}]/u.test(value);
}

function safeDate(value: string | null | undefined) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : null;
}

function minDate(values: Array<string | null | undefined>) {
  return values.map(safeDate).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function maxDate(values: Array<string | null | undefined>) {
  return values.map(safeDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function bestTitle(values: string[], preferred: (value: string) => boolean) {
  const candidates = [...new Set(values.filter((value) => value && preferred(value)))];
  return candidates.sort((left, right) => left.length - right.length || left.localeCompare(right, "en"))[0] ?? null;
}

function sourcePlatform(item: SourceItem) {
  if (item.provider === "STEAM") return "STEAM";
  if (item.provider === "NINTENDO") return item.platform || "NINTENDO SWITCH";
  return item.platform || "PLAYSTATION";
}

function validateSources(sources: RebuildSources) {
  if (sources.steam.length === 0) throw new Error("STEAM_EMPTY");
  if (sources.playstation.status !== "COMPLETE") throw new Error(`PLAYSTATION_NOT_COMPLETE:${sources.playstation.status}`);
  if (sources.playstation.items.length === 0) throw new Error("PLAYSTATION_EMPTY");
  if (sources.nintendo.status !== "COMPLETE") throw new Error(`NINTENDO_NOT_COMPLETE:${sources.nintendo.status}`);
  if (sources.nintendo.items.length === 0) throw new Error("NINTENDO_EMPTY");
  if (sources.igdb.length === 0) throw new Error("IGDB_EMPTY");
  const sourceKeys = new Set<string>();
  for (const item of [...sources.steam, ...sources.playstation.items, ...sources.nintendo.items]) {
    const key = nodeId(item.provider, item.externalGameId);
    if (sourceKeys.has(key)) throw new Error(`DUPLICATE_SOURCE_ITEM:${key}`);
    sourceKeys.add(key);
    if (!identityTitle(item.name)) throw new Error(`SOURCE_TITLE_EMPTY:${key}`);
  }
}

export function buildCatalogRebuildPlan(sources: RebuildSources, generatedAt = new Date()): CatalogRebuildPlan {
  validateSources(sources);
  const sourceItems = [...sources.steam, ...sources.playstation.items, ...sources.nintendo.items]
    .map((item) => ({ ...item, playtimeMinutes: Math.max(0, item.playtimeMinutes ?? 0) }))
    .sort((left, right) => nodeId(left.provider, left.externalGameId).localeCompare(nodeId(right.provider, right.externalGameId)));
  const uf = new UnionFind();
  const titlesByNode = new Map<string, string[]>();
  const itemByNode = new Map<string, SourceItem>();
  const igdbByNode = new Map<string, IgdbMetadata>();

  for (const item of sourceItems) {
    const node = nodeId(item.provider, item.externalGameId);
    uf.add(node);
    itemByNode.set(node, item);
    titlesByNode.set(node, [item.identityTitleOverride ?? item.name]);
  }
  for (const item of sources.igdb) {
    const node = nodeId("IGDB", item.externalGameId);
    uf.add(node);
    igdbByNode.set(node, item);
    titlesByNode.set(node, [item.nameZh, item.nameEn].filter((value): value is string => Boolean(value)));
  }

  const mappingsByOldGame = new Map<string, ExistingMapping[]>();
  for (const mapping of sources.existingMappings) {
    const node = nodeId(mapping.provider, mapping.externalGameId);
    if (!titlesByNode.has(node)) continue;
    mappingsByOldGame.set(mapping.oldGameId, [...(mappingsByOldGame.get(mapping.oldGameId) ?? []), mapping]);
  }
  for (const mappings of mappingsByOldGame.values()) {
    const nodes = mappings.map((mapping) => nodeId(mapping.provider, mapping.externalGameId)).sort();
    for (let index = 1; index < nodes.length; index += 1) uf.union(nodes[0], nodes[index]);
  }

  const nodesByTitle = new Map<string, string[]>();
  for (const [node, titles] of titlesByNode) {
    for (const title of titles) {
      const key = identityTitle(title);
      if (!key) continue;
      nodesByTitle.set(key, [...new Set([...(nodesByTitle.get(key) ?? []), node])]);
    }
  }
  const ambiguities: CatalogRebuildPlan["ambiguities"] = [];
  for (const [titleKey, nodes] of nodesByTitle) {
    const igdbIds = [...new Set(nodes.filter((node) => node.startsWith("IGDB:")).map((node) => node.slice(5)))];
    const igdbRoots = [...new Set(nodes.filter((node) => node.startsWith("IGDB:")).map((node) => uf.find(node)))];
    const igdbTitles = nodes.filter((node) => node.startsWith("IGDB:")).flatMap((node) => titlesByNode.get(node) ?? []);
    const isExplicitEditionFamily = igdbTitles.some(hasMergeableEditionMarker);
    if (igdbIds.length > 1 && igdbRoots.length > 1 && !isExplicitEditionFamily) {
      ambiguities.push({ titleKey, igdbIds: igdbIds.sort(), sourceNodes: [...nodes].sort() });
      continue;
    }
    const ordered = [...nodes].sort();
    for (let index = 1; index < ordered.length; index += 1) uf.union(ordered[0], ordered[index]);
  }

  const components = new Map<string, string[]>();
  for (const node of titlesByNode.keys()) {
    const root = uf.find(node);
    components.set(root, [...(components.get(root) ?? []), node]);
  }

  const games: PlannedGame[] = [];
  for (const nodes of components.values()) {
    const platformNodes = nodes.filter((node) => itemByNode.has(node));
    if (platformNodes.length === 0) continue;
    const items = platformNodes.map((node) => itemByNode.get(node)!);
    const igdbItems = nodes.map((node) => igdbByNode.get(node)).filter((value): value is IgdbMetadata => Boolean(value));
    const igdb = igdbItems.length ? primaryIgdb(igdbItems) : null;
    const orderedNodeKeys = [...nodes].sort();
    const canonicalKey = igdb ? `IGDB:${igdb.externalGameId}` : orderedNodeKeys[0];
    const names = [...items.map((item) => item.name), ...(igdb ? [igdb.nameZh, igdb.nameEn].filter((value): value is string => Boolean(value)) : [])];
    const nameEn = igdb?.nameEn ?? bestTitle(names, isEnglishTitle) ?? null;
    const nameZh = bestTitle(names, isChineseTitle) ?? igdb?.nameZh ?? nameEn ?? items[0].name;
    const providerTotals = new Map<CatalogProvider, number>();
    for (const provider of ["STEAM", "PLAYSTATION", "NINTENDO"] as const) {
      const totals = items.filter((item) => item.provider === provider).map((item) => item.playtimeMinutes ?? 0);
      providerTotals.set(provider, provider === "STEAM" ? totals.reduce((sum, value) => sum + value, 0) : Math.max(0, ...totals));
    }
    const totalPlaytime = [...providerTotals.values()].reduce((sum, value) => sum + value, 0);
    const lastPlayedAt = maxDate(items.map((item) => item.lastPlayedAt));
    const firstPlayedAt = minDate(items.map((item) => item.firstPlayedAt));
    const owned = items.some((item) => item.isOwned);
    const recentCutoff = generatedAt.getTime() - 48 * 60 * 60 * 1000;
    const playStatus = totalPlaytime === 0
      ? "BACKLOG" as const
      : lastPlayedAt && Date.parse(lastPlayedAt) < recentCutoff
        ? "COMPLETED" as const
        : "PLAYING" as const;
    const progressValues = items.map((item) => item.progressPercent).filter((value): value is number => value !== null && value !== undefined);
    const covers: Array<{ provider: CatalogProvider; value: string | null | undefined }> = [
      { provider: "IGDB", value: igdb?.coverUrl },
      ...items.filter((item) => item.provider === "PLAYSTATION").map((item) => ({ provider: item.provider, value: item.coverUrl })),
      ...items.filter((item) => item.provider === "NINTENDO").map((item) => ({ provider: item.provider, value: item.coverUrl })),
      ...items.filter((item) => item.provider === "STEAM").map((item) => ({ provider: item.provider, value: item.coverUrl }))
    ];
    const cover = covers.find((candidate) => candidate.value) ?? null;
    const steamItems = items.filter((item) => item.provider === "STEAM").sort((left, right) => (right.playtimeMinutes ?? 0) - (left.playtimeMinutes ?? 0));
    games.push({
      id: deterministicUuid(canonicalKey),
      canonicalKey,
      nameZh,
      nameEn,
      platform: [...new Set(items.map(sourcePlatform))].sort().join(" / "),
      ownershipStatus: owned ? "OWNED" : "PLAYED_ONLY",
      playStatus,
      startedAt: dateOnly(firstPlayedAt),
      completedAt: playStatus === "COMPLETED" ? dateOnly(lastPlayedAt) : null,
      lastPlayedAt,
      progressPercent: progressValues.length ? Math.max(...progressValues) : null,
      playtimeMinutesSynced: totalPlaytime,
      coverUrl: cover?.value ?? null,
      coverUrlSource: cover?.provider ?? null,
      releaseDate: igdb?.releaseDate ?? null,
      communityRating: igdb?.communityRating ?? null,
      communityRatingCount: igdb?.communityRatingCount ?? null,
      criticRating: igdb?.criticRating ?? null,
      criticRatingCount: igdb?.criticRatingCount ?? null,
      estimatedHastilyMinutes: igdb?.estimatedHastilyMinutes ?? null,
      estimatedNormallyMinutes: igdb?.estimatedNormallyMinutes ?? null,
      estimatedCompletelyMinutes: igdb?.estimatedCompletelyMinutes ?? null,
      steamAppId: steamItems[0] ? Number(steamItems[0].externalGameId) : null,
      igdbGameId: igdb ? Number(igdb.externalGameId) : null,
      sources: orderedNodeKeys.map((node) => {
        const [provider, ...external] = node.split(":");
        const externalGameId = external.join(":");
        const mapping = sources.existingMappings.find((candidate) => candidate.provider === provider && candidate.externalGameId === externalGameId);
        return { provider: provider as CatalogProvider, externalGameId, matchMethod: mapping ? "EXISTING_EXTERNAL_MAPPING" : "DETERMINISTIC_TITLE_IDENTITY" };
      })
    });
  }
  games.sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));
  const sourceSnapshotSha256 = sha256(sources);
  const unsigned = {
    schemaVersion: "catalog-rebuild-plan.v1" as const,
    generatedAt: generatedAt.toISOString(),
    ownerUserId: sources.ownerUserId,
    sourceSnapshotSha256,
    accounts: [
      { provider: "PLAYSTATION" as const, externalUserId: sources.playstation.externalUserId, displayName: sources.playstation.displayName },
      { provider: "NINTENDO" as const, externalUserId: sources.nintendo.externalUserId, displayName: sources.nintendo.displayName }
    ],
    summary: {
      steamCount: sources.steam.length,
      playstationCount: sources.playstation.items.length,
      nintendoCount: sources.nintendo.items.length,
      igdbCount: sources.igdb.length,
      canonicalGameCount: games.length,
      mergedSourceItemCount: sourceItems.length - games.length,
      ownedGameCount: games.filter((game) => game.ownershipStatus === "OWNED").length,
      playedOnlyGameCount: games.filter((game) => game.ownershipStatus === "PLAYED_ONLY").length,
      ambiguousTitleGroups: ambiguities.length
    },
    ambiguities: ambiguities.sort((left, right) => left.titleKey.localeCompare(right.titleKey)),
    games,
    sourceItems,
    igdb: [...sources.igdb].sort((left, right) => left.externalGameId.localeCompare(right.externalGameId))
  };
  return { ...unsigned, planSha256: sha256(unsigned) };
}

export function verifyCatalogRebuildPlan(plan: CatalogRebuildPlan) {
  const { planSha256, ...unsigned } = plan;
  if (sha256(unsigned) !== planSha256) throw new Error("CATALOG_PLAN_HASH_MISMATCH");
  if (plan.summary.steamCount <= 0 || plan.summary.playstationCount <= 0 || plan.summary.igdbCount <= 0) {
    throw new Error("CATALOG_PLAN_SOURCE_COUNTS_INVALID");
  }
  if (plan.summary.nintendoCount <= 0 || plan.games.length === 0) throw new Error("CATALOG_PLAN_EMPTY");
  if (new Set(plan.games.map((game) => game.id)).size !== plan.games.length) throw new Error("CATALOG_PLAN_DUPLICATE_GAME_ID");
}
