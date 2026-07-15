import * as psnApi from "psn-api";
import { SidecarError, publicError } from "./errors.mjs";
import { withRetry } from "./safe-fetch.mjs";

async function fetchPlayed(auth, accountId, config, client) {
  const titles = [];
  let offset = 0;
  while (titles.length < config.maxItems) {
    const response = await withRetry(
      () => client.getUserPlayedGames(auth, accountId, { limit: config.pageSize, offset }),
      { maxAttempts: config.maxAttempts }
    );
    const page = Array.isArray(response?.titles) ? response.titles : [];
    titles.push(...page.slice(0, config.maxItems - titles.length));
    if (!page.length || titles.length >= (response?.totalItemCount ?? 0)) break;
    const nextOffset = Number.isInteger(response?.nextOffset) ? response.nextOffset : offset + page.length;
    if (nextOffset <= offset) throw new SidecarError("PSN_PAGINATION_STALLED", "PlayStation 游玩记录分页游标未前进");
    offset = nextOffset;
  }
  return titles;
}

async function fetchPurchased(auth, config, client) {
  const games = [];
  const pageSize = Math.min(config.pageSize, 200);
  for (let start = 0; start < config.maxItems; start += pageSize) {
    const response = await withRetry(
      () => client.getPurchasedGames(auth, { size: pageSize, start }),
      { maxAttempts: config.maxAttempts }
    );
    const page = response?.data?.purchasedTitlesRetrieve?.games ?? [];
    games.push(...page.slice(0, config.maxItems - games.length));
    if (page.length < pageSize || games.length >= config.maxItems) break;
  }
  return games;
}

async function fetchTrophies(auth, accountId, config, client) {
  const trophyTitles = [];
  let offset = 0;
  const pageSize = Math.min(config.pageSize, 800);
  while (trophyTitles.length < config.maxItems) {
    const response = await withRetry(
      () => client.getUserTitles(auth, accountId, { limit: pageSize, offset }),
      { maxAttempts: config.maxAttempts }
    );
    const page = Array.isArray(response?.trophyTitles) ? response.trophyTitles : [];
    trophyTitles.push(...page.slice(0, config.maxItems - trophyTitles.length));
    if (!page.length || trophyTitles.length >= (response?.totalItemCount ?? 0)) break;
    const nextOffset = Number.isInteger(response?.nextOffset) ? response.nextOffset : offset + page.length;
    if (nextOffset <= offset) throw new SidecarError("PSN_PAGINATION_STALLED", "PlayStation 奖杯记录分页游标未前进");
    offset = nextOffset;
  }
  return trophyTitles;
}

function decodeSubject(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    const value = payload.accountId ?? payload.sub;
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  } catch {
    return null;
  }
}

async function fetchRequiredSource(source, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SidecarError) {
      throw new SidecarError(
        `PSN_${source.toUpperCase()}_FAILED`,
        `PlayStation ${source} 数据读取失败${error.status ? `（HTTP ${error.status}）` : ""}`,
        { status: error.status, retryable: error.retryable, cause: error }
      );
    }
    throw new SidecarError(
      `PSN_${source.toUpperCase()}_FAILED`,
      `PlayStation ${source} 数据读取失败`,
      { cause: error }
    );
  }
}

export async function fetchPlaystationData(authorization, config, client = psnApi) {
  const auth = { accessToken: authorization.accessToken };
  const tokenAccountId = decodeSubject(authorization.idToken);
  const accountId = tokenAccountId ?? "me";
  const [profile, played] = await Promise.all([
    fetchRequiredSource("profile", () =>
      withRetry(() => client.getProfileFromAccountId(auth, accountId), { maxAttempts: config.maxAttempts })
    ),
    fetchRequiredSource("played_games", () => fetchPlayed(auth, accountId, config, client))
  ]);
  const optional = await Promise.allSettled([
    fetchPurchased(auth, config, client),
    fetchTrophies(auth, accountId, config, client)
  ]);
  const warnings = [];
  const purchased = optional[0].status === "fulfilled" ? optional[0].value : [];
  const trophies = optional[1].status === "fulfilled" ? optional[1].value : [];
  if (optional[0].status === "rejected") warnings.push({ source: "purchased_games", ...publicError(optional[0].reason) });
  if (optional[1].status === "rejected") warnings.push({ source: "trophies", ...publicError(optional[1].reason) });
  return {
    account: {
      externalUserId: tokenAccountId ?? profile.onlineId,
      displayName: profile.onlineId,
      isPlus: Boolean(profile.isPlus)
    },
    played,
    purchased,
    trophies,
    warnings
  };
}
