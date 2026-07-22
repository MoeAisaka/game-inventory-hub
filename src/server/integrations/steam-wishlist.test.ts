import { describe, expect, it } from "vitest";
import { fetchSteamWishlist } from "./steam-wishlist";

describe("Steam wishlist connector", () => {
  it("reads wishlist items without treating them as owned games", async () => {
    const fetcher = async () => new Response(JSON.stringify({ response: { items: [
      { appid: 3274580, priority: 2, date_added: 1731456000 },
      { appid: 4115450, priority: 10, date_added: 1731542400 }
    ] } }), { status: 200, headers: { "content-type": "application/json" } });
    const items = await fetchSteamWishlist("76561198000000000", "test-key", fetcher as typeof fetch);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ appid: 3274580, priority: 2 });
    expect(items[0]).not.toHaveProperty("isOwned");
  });
});
