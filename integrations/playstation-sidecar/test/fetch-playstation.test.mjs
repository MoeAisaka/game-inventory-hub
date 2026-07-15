import test from "node:test";
import assert from "node:assert/strict";
import { fetchPlaystationData } from "../src/fetch-playstation.mjs";
import { SidecarError } from "../src/errors.mjs";

const config = { pageSize: 2, maxItems: 10, maxAttempts: 1 };
const playedItem = (titleId) => ({ titleId, name: titleId, localizedName: titleId });

test("paginates the required played-games source and collects optional sources", async () => {
  const offsets = [];
  const client = {
    getProfileFromAccountId: async () => ({ onlineId: "Yukina", isPlus: true }),
    getUserPlayedGames: async (_auth, _account, options) => {
      offsets.push(options.offset);
      if (options.offset === 0) return { titles: [playedItem("A"), playedItem("B")], totalItemCount: 3, nextOffset: 2 };
      return { titles: [playedItem("C")], totalItemCount: 3, nextOffset: 3 };
    },
    getPurchasedGames: async () => ({ data: { purchasedTitlesRetrieve: { games: [{ titleId: "A" }] } } }),
    getUserTitles: async () => ({ trophyTitles: [{ trophyTitleName: "A", progress: 50 }], totalItemCount: 1 })
  };
  const result = await fetchPlaystationData({ accessToken: "redacted", idToken: "invalid" }, config, client);
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.account.externalUserId, "Yukina");
  assert.equal(result.played.length, 3);
  assert.equal(result.purchased.length, 1);
  assert.equal(result.trophies.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("keeps a usable partial preview when an optional endpoint fails", async () => {
  const client = {
    getProfileFromAccountId: async () => ({ onlineId: "Yukina", isPlus: false }),
    getUserPlayedGames: async () => ({ titles: [playedItem("A")], totalItemCount: 1 }),
    getPurchasedGames: async () => { throw new SidecarError("PSN_HTTP_503", "dependency unavailable", { retryable: true }); },
    getUserTitles: async () => ({ trophyTitles: [], totalItemCount: 0 })
  };
  const result = await fetchPlaystationData({ accessToken: "redacted", idToken: "invalid" }, config, client);
  assert.equal(result.played.length, 1);
  assert.equal(result.purchased.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings[0], {
    source: "purchased_games",
    code: "PSN_HTTP_503",
    message: "dependency unavailable",
    retryable: true
  });
});

test("uses the numeric account id from the id token for account-scoped endpoints", async () => {
  const accountIds = [];
  const client = {
    getProfileFromAccountId: async (_auth, accountId) => {
      accountIds.push(["profile", accountId]);
      return { onlineId: "Yukina", isPlus: true };
    },
    getUserPlayedGames: async (_auth, accountId) => {
      accountIds.push(["played", accountId]);
      return { titles: [], totalItemCount: 0 };
    },
    getPurchasedGames: async () => ({ data: { purchasedTitlesRetrieve: { games: [] } } }),
    getUserTitles: async (_auth, accountId) => {
      accountIds.push(["trophies", accountId]);
      return { trophyTitles: [], totalItemCount: 0 };
    }
  };
  const payload = Buffer.from(JSON.stringify({ accountId: "123456789" })).toString("base64url");
  await fetchPlaystationData({ accessToken: "redacted", idToken: `header.${payload}.signature` }, config, client);
  assert.deepEqual(accountIds, [
    ["profile", "123456789"],
    ["played", "123456789"],
    ["trophies", "123456789"]
  ]);
});
