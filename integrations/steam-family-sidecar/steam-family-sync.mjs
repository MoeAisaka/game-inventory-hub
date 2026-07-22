import process from "node:process";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.steampowered.com/IFamilyGroupsService";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

async function getJson(url, accessToken, fetcher = fetch) {
  url.searchParams.set("access_token", accessToken);
  const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`STEAM_HTTP_${response.status}`);
  return response.json();
}

export async function fetchFamilySnapshot({ steamId, accessToken, fetcher = fetch }) {
  const familyUrl = new URL(`${API_ROOT}/GetFamilyGroupForUser/v1/`);
  familyUrl.searchParams.set("steamid", steamId);
  familyUrl.searchParams.set("include_family_group_response", "true");
  const familyPayload = await getJson(familyUrl, accessToken, fetcher);
  const familyGroupId = String(familyPayload?.response?.family_groupid ?? "");
  if (!familyGroupId || familyGroupId === "0") throw new Error("STEAM_FAMILY_GROUP_MISSING");

  const appsUrl = new URL(`${API_ROOT}/GetSharedLibraryApps/v1/`);
  appsUrl.searchParams.set("steamid", steamId);
  appsUrl.searchParams.set("family_groupid", familyGroupId);
  appsUrl.searchParams.set("include_own", "false");
  appsUrl.searchParams.set("include_excluded", "true");
  appsUrl.searchParams.set("include_non_games", "false");
  appsUrl.searchParams.set("language", "schinese");
  appsUrl.searchParams.set("max_apps", "20000");
  const appsPayload = await getJson(appsUrl, accessToken, fetcher);
  const apps = Array.isArray(appsPayload?.response?.apps) ? appsPayload.response.apps : [];
  return {
    steamId,
    familyGroupId,
    items: apps.map((app) => ({
      appId: Number(app.appid),
      name: String(app.name ?? app.sort_as ?? `Steam App ${app.appid}`),
      ownerSteamIds: Array.isArray(app.owner_steamids) ? app.owner_steamids.map(String) : [],
      excludeReason: Math.max(0, Number(app.exclude_reason ?? 0)),
      playtimeMinutes: Math.max(0, Math.floor(Number(app.rt_playtime ?? 0) / 60)),
      lastPlayedAt: Number(app.rt_last_played ?? 0) > 0 ? new Date(Number(app.rt_last_played) * 1000).toISOString() : null,
      iconUrl: null,
      rawMetadata: {
        appType: app.app_type ?? null,
        sortAs: app.sort_as ?? null,
        capsuleFilename: app.capsule_filename ?? null,
        acquiredAtEpoch: app.rt_time_acquired ?? null,
        rawPlaytimeSeconds: app.rt_playtime ?? null
      }
    })).filter((item) => Number.isInteger(item.appId) && item.appId > 0 && item.name)
  };
}

export async function postSnapshot({ apiBaseUrl, syncSecret, snapshot, fetcher = fetch }) {
  const response = await fetcher(new URL("/api/v1/internal/steam-family-snapshot", apiBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${syncSecret}`,
      "content-type": "application/json",
      "idempotency-key": `steam-family-${snapshot.familyGroupId}-${Date.now()}`
    },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.code ?? `APP_HTTP_${response.status}`);
  return payload.data;
}

async function main() {
  const preview = process.argv.includes("--preview");
  const snapshot = await fetchFamilySnapshot({
    steamId: requiredEnv("STEAM_ID"),
    accessToken: requiredEnv("STEAM_FAMILY_ACCESS_TOKEN")
  });
  if (preview) {
    process.stdout.write(`${JSON.stringify({ familyGroupId: snapshot.familyGroupId, itemCount: snapshot.items.length, available: snapshot.items.filter((item) => item.excludeReason === 0).length }, null, 2)}\n`);
    return;
  }
  const result = await postSnapshot({
    apiBaseUrl: requiredEnv("GAME_INVENTORY_API_BASE_URL"),
    syncSecret: requiredEnv("SYNC_CRON_SECRET"),
    snapshot
  });
  process.stdout.write(`${JSON.stringify({ matched: result.matched, unmatched: result.unmatched, unavailable: result.unavailable, ownedPrecedence: result.ownedPrecedence }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Steam Family同步失败：${error instanceof Error ? error.message : "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
