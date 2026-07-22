import { normalizeGameSearchText } from "./game-search";

export const steamReviewLanes = ["OWNED_MISSING", "REVIEW", "NON_GAME", "CATALOG"] as const;
export type SteamReviewLane = (typeof steamReviewLanes)[number];

export type SteamReviewSourceItem = {
  steamAppId: number;
  name: string;
  playtimeMinutes: number;
  recentPlaytimeMinutes: number | null;
  lastPlayedAt: Date | string | null;
  iconUrl: string | null;
  matchMethod: string;
  licenseType: "OWNED" | "FAMILY_SHARED";
  updatedAt?: Date | string;
};

export type SteamReviewLocalGame = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  steamAppId: number | null;
  searchAliases?: string[];
};

export type SteamReviewCandidateRisk = "SERIES_NUMBER_CONFLICT" | "TARGET_ALREADY_HAS_STEAM_APP";

export type SteamReviewCandidate = {
  gameId: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  steamAppId: number | null;
  score: number;
  margin: number;
  matchedName: string;
  risks: SteamReviewCandidateRisk[];
};

export type SteamReviewItem = SteamReviewSourceItem & {
  lane: SteamReviewLane;
  hasPlayHistory: boolean;
  suspectedNonGame: boolean;
  candidates: SteamReviewCandidate[];
};

export type SteamMatchWorkbench = {
  items: SteamReviewItem[];
  counts: Record<SteamReviewLane, number> & { actionable: number };
};

const fuzzyScoreThreshold = 81;
const fuzzyMarginThreshold = 8;
const suspectedNonGamePattern = /(?:^|[\s:：_\-—–|｜])(playtest|demo|prologue|test\s+server|public\s+test\s+server|public\s+beta\s+client)(?:$|[\s:：_\-—–|｜])|试玩版|试玩体验|序章版|测试服|测试服务器/iu;

type PreparedName = { raw: string; normalized: string; pairs: Map<string, number> };
type PreparedGame = SteamReviewLocalGame & { names: PreparedName[] };

function uniqueNames(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const raw = value?.trim();
    if (!raw) continue;
    const normalized = normalizeGameSearchText(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(raw);
  }
  return result;
}

function bigramCounts(value: string) {
  const counts = new Map<string, number>();
  if (value.length < 2) return counts;
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

function diceCoefficient(left: PreparedName, right: PreparedName) {
  if (left.normalized === right.normalized) return 1;
  if (left.normalized.length < 2 || right.normalized.length < 2) return 0;
  let intersection = 0;
  for (const [pair, count] of left.pairs) {
    intersection += Math.min(count, right.pairs.get(pair) ?? 0);
  }
  return (2 * intersection) / (left.normalized.length - 1 + right.normalized.length - 1);
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function similarity(left: PreparedName, right: PreparedName) {
  if (left.normalized === right.normalized) return 100;
  const shorter = Math.min(left.normalized.length, right.normalized.length);
  const longer = Math.max(left.normalized.length, right.normalized.length);
  if (!shorter || shorter / longer < 0.42) return 0;
  const contains = left.normalized.includes(right.normalized) || right.normalized.includes(left.normalized);
  if (!contains && diceCoefficient(left, right) < 0.42) return 0;
  const distance = levenshteinDistance(left.normalized, right.normalized);
  return Math.round((1 - distance / longer) * 1_000) / 10;
}

function seriesNumbers(value: string) {
  const roman: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const numbers = normalized.match(/\d+|\b(?:viii|vii|iii|vi|iv|ii|ix|x|v|i)\b/g) ?? [];
  return [...new Set(numbers.map((value) => roman[value] ?? value))];
}

function candidateRisks(item: SteamReviewSourceItem, game: PreparedGame, matchedName: string): SteamReviewCandidateRisk[] {
  const risks: SteamReviewCandidateRisk[] = [];
  const sourceNumbers = seriesNumbers(item.name);
  const targetNumbers = seriesNumbers(matchedName);
  if (sourceNumbers.length && targetNumbers.length && !sourceNumbers.some((value) => targetNumbers.includes(value))) {
    risks.push("SERIES_NUMBER_CONFLICT");
  }
  if (game.steamAppId !== null && game.steamAppId !== item.steamAppId) risks.push("TARGET_ALREADY_HAS_STEAM_APP");
  return risks;
}

function prepareGames(games: SteamReviewLocalGame[]): PreparedGame[] {
  return games.map((game) => ({
    ...game,
    names: uniqueNames([game.nameZh, game.nameEn, ...(game.searchAliases ?? [])]).map((raw) => {
      const normalized = normalizeGameSearchText(raw);
      return { raw, normalized, pairs: bigramCounts(normalized) };
    })
  }));
}

function rankCandidates(item: SteamReviewSourceItem, games: PreparedGame[]): SteamReviewCandidate[] {
  const normalized = normalizeGameSearchText(item.name);
  const source: PreparedName = { raw: item.name, normalized, pairs: bigramCounts(normalized) };
  const ranked = games.map((game) => {
    let bestScore = 0;
    let matchedName = game.nameZh;
    for (const name of game.names) {
      const score = similarity(source, name);
      if (score > bestScore) {
        bestScore = score;
        matchedName = name.raw;
      }
    }
    return { game, score: bestScore, matchedName };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.game.nameZh.localeCompare(right.game.nameZh, "zh-CN"));
  const margin = ranked[0] ? Math.round((ranked[0].score - (ranked[1]?.score ?? 0)) * 10) / 10 : 0;
  if (!ranked[0] || ranked[0].score < fuzzyScoreThreshold || margin < fuzzyMarginThreshold) return [];
  return ranked.slice(0, 3).map(({ game, score, matchedName }, index) => ({
    gameId: game.id,
    nameZh: game.nameZh,
    nameEn: game.nameEn,
    platform: game.platform,
    steamAppId: game.steamAppId,
    score,
    margin: index === 0 ? margin : 0,
    matchedName,
    risks: candidateRisks(item, game, matchedName)
  }));
}

function sortItems(items: SteamReviewItem[]) {
  return items.sort((left, right) => {
    if (left.lane === "REVIEW" && right.lane === "REVIEW") {
      const historyOrder = Number(right.hasPlayHistory) - Number(left.hasPlayHistory);
      if (historyOrder) return historyOrder;
      const candidateOrder = (right.candidates[0]?.score ?? 0) - (left.candidates[0]?.score ?? 0);
      if (candidateOrder) return candidateOrder;
    }
    const playtimeOrder = right.playtimeMinutes - left.playtimeMinutes;
    return playtimeOrder || left.name.localeCompare(right.name, "zh-CN");
  });
}

export function buildSteamMatchWorkbench(
  unresolvedItems: SteamReviewSourceItem[],
  localGames: SteamReviewLocalGame[]
): SteamMatchWorkbench {
  const preparedGames = prepareGames(localGames);
  const items = unresolvedItems.map<SteamReviewItem>((item) => {
    const suspectedNonGame = suspectedNonGamePattern.test(item.name);
    const hasPlayHistory = item.playtimeMinutes > 0 || item.lastPlayedAt !== null;
    const candidates = suspectedNonGame ? [] : rankCandidates(item, preparedGames);
    const lane: SteamReviewLane = item.licenseType === "OWNED"
      ? "OWNED_MISSING"
      : suspectedNonGame
        ? "NON_GAME"
        : hasPlayHistory || candidates.length
          ? "REVIEW"
          : "CATALOG";
    return { ...item, lane, hasPlayHistory, suspectedNonGame, candidates };
  });
  const counts = Object.fromEntries(steamReviewLanes.map((lane) => [lane, items.filter((item) => item.lane === lane).length])) as Record<SteamReviewLane, number>;
  return {
    items: sortItems(items),
    counts: {
      ...counts,
      actionable: counts.OWNED_MISSING + counts.REVIEW + counts.NON_GAME
    }
  };
}
