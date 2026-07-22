import assert from "node:assert/strict";
import test from "node:test";
import { fetchFamilySnapshot, postSnapshot } from "./steam-family-sync.mjs";

test("normalizes Steam Family responses without exposing the access token", async () => {
  const seen = [];
  const fetcher = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname.includes("GetFamilyGroupForUser")) {
      return new Response(JSON.stringify({ response: { family_groupid: "123" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: { apps: [{ appid: 620, name: "Portal 2", owner_steamids: ["76561198000000001"], exclude_reason: 0, rt_playtime: 7_200, rt_last_played: 1_700_000_000 }] } }), { status: 200 });
  };
  const snapshot = await fetchFamilySnapshot({ steamId: "76561198000000000", accessToken: "secret-token", fetcher });
  assert.equal(snapshot.familyGroupId, "123");
  assert.equal(snapshot.items[0].appId, 620);
  assert.equal(snapshot.items[0].name, "Portal 2");
  assert.equal(snapshot.items[0].playtimeMinutes, 120);
  assert.equal(snapshot.items[0].ownerSteamIds[0], "76561198000000001");
  assert.equal(seen.every((url) => url.searchParams.get("access_token") === "secret-token"), true);
  assert.equal(JSON.stringify(snapshot).includes("secret-token"), false);
});

test("posts only the normalized snapshot and bearer secret", async () => {
  let request;
  const fetcher = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ data: { matched: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await postSnapshot({
    apiBaseUrl: "https://games.example.test",
    syncSecret: "x".repeat(32),
    snapshot: { steamId: "76561198000000000", familyGroupId: "123", items: [] },
    fetcher
  });
  assert.equal(result.matched, 1);
  assert.equal(request.url, "https://games.example.test/api/v1/internal/steam-family-snapshot");
  assert.equal(request.init.headers.authorization, `Bearer ${"x".repeat(32)}`);
});
