import { describe, expect, it } from "vitest";
import {
  igdbCalendarPlatform,
  igdbCatalogChineseName,
  igdbCatalogEligible,
  igdbCatalogMetadataPriority,
  igdbCatalogSteamAppId,
  igdbCatalogStoreUrl,
  igdbDatePrecision
} from "./igdb";

describe("release catalog normalization", () => {
  it("preserves IGDB date precision instead of treating placeholders as exact dates", () => {
    expect(igdbDatePrecision(0)).toBe("DAY");
    expect(igdbDatePrecision(1)).toBe("MONTH");
    expect(igdbDatePrecision(2)).toBe("YEAR");
    expect(igdbDatePrecision(3)).toBe("QUARTER");
    expect(igdbDatePrecision(4)).toBe("QUARTER");
    expect(igdbDatePrecision(7)).toBe("YEAR");
  });

  it("maps market platforms and detects Steam PC releases", () => {
    expect(igdbCalendarPlatform(167)).toBe("PLAYSTATION");
    expect(igdbCalendarPlatform(130)).toBe("NINTENDO_SWITCH");
    expect(igdbCalendarPlatform(508)).toBe("NINTENDO_SWITCH_2");
    expect(igdbCalendarPlatform(6, [{ url: "https://store.steampowered.com/app/42/" }])).toBe("STEAM");
    expect(igdbCalendarPlatform(6, [])).toBe("PC_OTHER");
  });

  it("keeps tracked games and filters untracked catalog noise without popularity signals", () => {
    expect(igdbCatalogEligible({}, false)).toBe(false);
    expect(igdbCatalogEligible({ hypes: 1 }, false)).toBe(true);
    expect(igdbCatalogEligible({ total_rating_count: 1 }, false)).toBe(true);
    expect(igdbCatalogEligible({}, true)).toBe(true);
  });

  it("uses only an explicit Steam store URL as a trustworthy Steam app identity", () => {
    expect(igdbCatalogSteamAppId([{ uid: "123456", url: "https://store.steampowered.com/app/123456/demo" }])).toBe(123456);
    expect(igdbCatalogSteamAppId([{ uid: "123456", url: "https://example.test/game/123456" }])).toBeNull();
    expect(igdbCatalogSteamAppId([{ url: "https://store.steampowered.com.evil.test/app/123456" }])).toBeNull();
    expect(igdbCatalogSteamAppId([{ url: "https://store.steampowered.com@evil.test/app/123456" }])).toBeNull();
    expect(igdbCalendarPlatform(6, [{ url: "https://evil.test/?next=store.steampowered.com" }])).toBe("PC_OTHER");
  });

  it("accepts only HTTPS URLs on the expected official store host", () => {
    expect(igdbCatalogStoreUrl([{ url: "https://store.playstation.com/en-us/product/example" }], "PLAYSTATION"))
      .toBe("https://store.playstation.com/en-us/product/example");
    expect(igdbCatalogStoreUrl([{ url: "https://www.nintendo.com/store/products/example" }], "NINTENDO_SWITCH"))
      .toBe("https://www.nintendo.com/store/products/example");
    expect(igdbCatalogStoreUrl([{ url: "http://store.steampowered.com/app/42/" }], "STEAM")).toBeNull();
    expect(igdbCatalogStoreUrl([{ url: "https://playstation.com.evil.test/product/example" }], "PLAYSTATION")).toBeNull();
    expect(igdbCatalogStoreUrl([{ url: "https://nintendo.com@evil.test/store/products/example" }], "NINTENDO_SWITCH")).toBeNull();
  });

  it("selects the first CJK alternative as the Chinese catalog name", () => {
    expect(igdbCatalogChineseName([{ name: "Project Example" }, { name: "项目示例" }])).toBe("项目示例");
    expect(igdbCatalogChineseName([{ name: "Project Example" }])).toBeNull();
  });

  it("prioritizes releases visible in the selection workbench over older catalog history", () => {
    const visibleFrom = 2_000;
    expect(igdbCatalogMetadataPriority(2_001, visibleFrom)).toBe(0);
    expect(igdbCatalogMetadataPriority(1_999, visibleFrom)).toBe(1);
  });
});
