import { describe, expect, it } from "vitest";
import { coverImageOrigins } from "./cover-image-hosts";

describe("cover image CSP origins", () => {
  it.each([
    "https://image.api.playstation.com",
    "https://atum-img-lp1.cdn.nintendo.net",
    "https://shared.akamai.steamstatic.com",
    "https://images.igdb.com"
  ])("allows the catalog source %s", (origin) => {
    expect(coverImageOrigins).toContain(origin);
  });

  it("contains only secure origins", () => {
    expect(coverImageOrigins.every((origin) => origin.startsWith("https://"))).toBe(true);
  });
});
