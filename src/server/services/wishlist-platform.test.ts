import { describe, expect, it } from "vitest";
import { acquireWishlistItemSchema, providerForPlatform } from "@/server/services/wishlist";

describe("wishlist platform selection", () => {
  it("derives the platform provider deterministically", () => {
    expect(providerForPlatform("STEAM")).toBe("STEAM");
    expect(providerForPlatform("PS5")).toBe("PLAYSTATION");
    expect(providerForPlatform("NINTENDO_SWITCH_2")).toBe("NINTENDO");
  });

  it("accepts a matching platform and rejects a mismatched provider", () => {
    expect(acquireWishlistItemSchema.safeParse({
      channel: "SELF_PURCHASED",
      selection: { provider: "PLAYSTATION", platform: "PS5", externalGameId: null, storeUrl: null, catalogEventId: null }
    }).success).toBe(true);
    expect(acquireWishlistItemSchema.safeParse({
      channel: "SELF_PURCHASED",
      selection: { provider: "STEAM", platform: "PS5", externalGameId: null, storeUrl: null, catalogEventId: null }
    }).success).toBe(false);
  });
});
