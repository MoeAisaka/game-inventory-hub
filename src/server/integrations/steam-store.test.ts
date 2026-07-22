import { describe, expect, it } from "vitest";
import { fetchSteamStoreMetadata } from "./steam-store";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.SESSION_COOKIE_SECURE ??= "false";

describe("Steam Store metadata", () => {
  it("keeps release metadata when the independent reviews endpoint is unavailable", async () => {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/appreviews/")) return new Response("upstream unavailable", { status: 503 });
      const language = url.searchParams.get("l");
      return Response.json({
        "812560": {
          success: true,
          data: {
            name: language === "schinese" ? "CROSS†CHANNEL: Steam Edition" : "CROSS†CHANNEL: Steam Edition",
            short_description: language === "schinese" ? "一段中文简介。" : "An English summary.",
            header_image: "https://cdn.example.test/header.jpg",
            developers: ["Flying Shine"],
            publishers: ["Moe App"],
            genres: [{ id: "25", description: language === "schinese" ? "冒险" : "Adventure" }],
            release_date: { coming_soon: false, date: "27 Mar, 2018" }
          }
        }
      });
    }) as typeof fetch;

    await expect(fetchSteamStoreMetadata(812560, fetcher)).resolves.toMatchObject({
      releaseDate: "2018-03-27",
      summaryZh: "一段中文简介。",
      summaryEn: "An English summary.",
      developers: ["Flying Shine"],
      publishers: ["Moe App"],
      genresZh: ["冒险"],
      genresEn: ["Adventure"],
      communityRating: null,
      communityRatingCount: 0
    });
  });

  it("still fails closed when both localized app-details responses are unavailable", async () => {
    const fetcher = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await expect(fetchSteamStoreMetadata(812560, fetcher)).rejects.toThrow("UPSTREAM_FAILED");
  });
});
