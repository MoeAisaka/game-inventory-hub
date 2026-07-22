import { describe, expect, it } from "vitest";
import { hasChineseCatalogText } from "@/lib/release-catalog-completeness";
import { releaseCatalogMatchesQuery, releaseCatalogSelectable, releaseWorkIdentity } from "@/server/services/releases";

describe("release catalog bilingual completeness", () => {
  it("requires the Chinese summary to contain Chinese text", () => {
    expect(hasChineseCatalogText("这是一段中文简介。")).toBe(true);
    expect(hasChineseCatalogText("English-only summary")).toBe(false);
    expect(hasChineseCatalogText(null)).toBe(false);
  });

  it("accepts official titles that mix Chinese and Latin characters", () => {
    expect(hasChineseCatalogText("冰汽时代 2: Breach of Trust")).toBe(true);
  });
});

describe("release catalog search and selection", () => {
  const aincrad = {
    nameZh: "Echoes of Aincrad",
    nameEn: "Echoes of Aincrad",
    platform: "PLAYSTATION",
    developers: [],
    publishers: [],
    genresZh: [],
    genresEn: []
  };

  it("matches the commonly used Chinese Aincrad aliases", () => {
    expect(releaseCatalogMatchesQuery(aincrad, "艾恩格朗特")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "艾恩葛朗特")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "艾恩")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "恩格")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "艾恩格郎特")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "Aincrad")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "Aincard")).toBe(true);
    expect(releaseCatalogMatchesQuery(aincrad, "艾")).toBe(false);
    expect(releaseCatalogMatchesQuery(aincrad, "完全无关")).toBe(false);
  });

  it("normalizes punctuation, case and traditional Chinese before fuzzy matching", () => {
    const multilingual = {
      ...aincrad,
      nameZh: "塞尔达传说：旷野之息",
      nameEn: "The Legend of Zelda: Breath of the Wild"
    };
    expect(releaseCatalogMatchesQuery(multilingual, "塞尔达传说旷野之息")).toBe(true);
    expect(releaseCatalogMatchesQuery(multilingual, "薩爾達傳說：曠野之息")).toBe(true);
    expect(releaseCatalogMatchesQuery(multilingual, "Breth of the Wild")).toBe(true);
  });

  it("allows a confirmed platform-store identity before optional metadata is complete", () => {
    expect(releaseCatalogSelectable({ storeProvider: "PLAYSTATION", storeExternalGameId: "UP9000-CUSA00001" })).toBe(true);
    expect(releaseCatalogSelectable({ storeProvider: "STEAM", storeExternalGameId: "123456" })).toBe(true);
    expect(releaseCatalogSelectable({ storeProvider: null, storeExternalGameId: null })).toBe(false);
  });

  it("groups platform variants only by stable work identity", () => {
    const base = { id: "11111111-1111-4111-8111-111111111111", gameId: null, externalGameId: "98765", source: "IGDB" as const };
    expect(releaseWorkIdentity(base)).toBe("igdb:98765");
    expect(releaseWorkIdentity({ ...base, id: "22222222-2222-4222-8222-222222222222" })).toBe("igdb:98765");
    expect(releaseWorkIdentity({ ...base, source: "MANUAL", externalGameId: null })).toBe(`event:${base.id}`);
  });
});
