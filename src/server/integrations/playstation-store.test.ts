import { describe, expect, it } from "vitest";
import {
  cleanPlayStationStoreName,
  parsePlayStationStoreHtml,
  playStationStoreIdentifier
} from "./playstation-store";

function page(...caches: Array<Record<string, unknown>>) {
  return caches.map((cache, index) => `<script id="env:${index}" type="application/json">${JSON.stringify({ cache })}</script>`).join("\n");
}

describe("PlayStation Store metadata", () => {
  it("uses the concept release date and default product English name", () => {
    const html = page(
      {
        "Concept:10002065": {
          name: "Alan Wake 2",
          releaseDate: { type: "DAY_MONTH_YEAR", value: "2023-10-27T04:00:00Z" },
          defaultProduct: { __ref: "Product:UP1477-PPSA02571_00-ALANWAKE20000000" }
        }
      },
      {
        "Product:UP1477-PPSA02571_00-ALANWAKE20000000": {
          name: "Alan Wake 2 (Simplified Chinese, English, Japanese, Traditional Chinese)",
          releaseDate: "2023-10-27T04:00:00Z",
          storeDisplayClassification: "FULL_GAME",
          starRating: { averageRating: 4.63, totalRatingsCount: 64667 },
          concept: { __ref: "Concept:10002065" }
        }
      }
    );
    expect(parsePlayStationStoreHtml(html, { conceptId: "10002065" })).toMatchObject({
      conceptId: "10002065",
      productId: "UP1477-PPSA02571_00-ALANWAKE20000000",
      nameEn: "Alan Wake 2",
      releaseDate: "2023-10-27",
      datePrecision: "DAY",
      classification: "FULL_GAME",
      communityRating: 92.6,
      communityRatingCount: 64667
    });
  });

  it("uses a product date and converts midnight Hong Kong from UTC without losing a day", () => {
    const productId = "HP0106-CUSA30145_00-APPBRTIEDEMO0000";
    const html = page({
      [`Product:${productId}`]: {
        name: "BLUE REFLECTION: Second Light DEMO (Simplified Chinese, Traditional Chinese)",
        releaseDate: "2021-09-29T16:00:00Z",
        storeDisplayClassification: "DEMO",
        concept: { __ref: "Concept:10001806" }
      }
    });
    expect(parsePlayStationStoreHtml(html, { productId })).toMatchObject({
      conceptId: "10001806",
      productId,
      nameEn: "BLUE REFLECTION: Second Light DEMO",
      releaseDate: "2021-09-30",
      classification: "DEMO"
    });
  });

  it("does not strip ordinary parentheses from a title", () => {
    expect(cleanPlayStationStoreName("NieR Replicant ver.1.22474487139... (PS4)"))
      .toBe("NieR Replicant ver.1.22474487139... (PS4)");
  });

  it("extracts stable official identifiers from snapshot metadata and fallback keys", () => {
    expect(playStationStoreIdentifier({ conceptId: 10002065, productId: "UP1" }, "concept:10002065"))
      .toEqual({ conceptId: "10002065", productId: "UP1" });
    expect(playStationStoreIdentifier({}, "product:HP1")).toEqual({ conceptId: undefined, productId: "HP1" });
    expect(playStationStoreIdentifier({}, "title:CUSA00001_00")).toBeNull();
  });
});
