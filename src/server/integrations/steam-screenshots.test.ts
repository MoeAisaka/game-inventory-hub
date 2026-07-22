import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSteamScreenshotDetail, parseSteamScreenshotDetail, parseSteamScreenshotMarkdown, parseSteamScreenshotPage } from "./steam-screenshots";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Steam screenshot parser", () => {
  it("extracts screenshot identities, app ids and captions from the public image wall", () => {
    const html = `<a class="profile_media_item modalContentLink ugc" data-desired-aspect="1.7" data-appid="814380" data-publishedfileid="1710183315">
      <div style="background-image: url('https://images.steamusercontent.com/ugc/1/ABC/?imw=640')"><q class="ellipsis">剑&amp;火</q></div>
    </a>`;
    expect(parseSteamScreenshotPage(html)).toEqual([{
      publishedFileId: "1710183315",
      appId: 814380,
      previewUrl: "https://images.steamusercontent.com/ugc/1/ABC/?imw=640",
      caption: "剑&火"
    }]);
  });

  it("decodes entities once and removes tags only after decoding", () => {
    const html = `<a class="profile_media_item" data-appid="42" data-publishedfileid="safe-caption">
      <div><img src="https://images.steamusercontent.com/ugc/1/SAFE/?imw=640"><q>&lt;script&gt;alert(1)&lt;/script&gt;&amp;lt;b&amp;gt;safe</q></div>
    </a>`;
    expect(parseSteamScreenshotPage(html)[0]?.caption).toBe("alert(1)&lt;b&gt;safe");
  });

  it("extracts original media and posted time from a detail page", () => {
    const html = `<a href="https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&amp;letterbox=false"><img id="ActualMedia" src="thumb"></a>
      <div class="detailsStatRight">0.208 MB</div><div class="detailsStatRight">12 Apr, 2019 @ 3:16am</div>
      <div class="detailsStatRight">2560 x 1440</div><div class="screenshotDescription">&quot;一苇渡江&quot;</div>`;
    expect(parseSteamScreenshotDetail(html)).toEqual({
      originalUrl: "https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&letterbox=false",
      caption: "一苇渡江",
      postedText: "12 Apr, 2019 @ 3:16am",
      capturedAt: new Date("2019-04-12T03:16:00.000Z"),
      retrievalMode: "STEAM_HTML"
    });
  });

  it("keeps the allowlisted transform query required by legacy Steam UGC images", () => {
    const html = `<div class="actualmediactn"><a href="https://images.steamusercontent.com/ugc/933813165416716359/ABC/?imw=5000&amp;imh=5000&amp;ima=fit&amp;impolicy=Letterbox&amp;imcolor=%23000000&amp;letterbox=false&amp;tracking=drop-me" target="_blank"><img id="ActualMedia" src="thumb"></a></div>`;
    expect(parseSteamScreenshotDetail(html).originalUrl).toBe(
      "https://images.steamusercontent.com/ugc/933813165416716359/ABC/?imw=5000&imh=5000&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false"
    );
  });

  it("extracts the original media and date from a reader fallback", () => {
    const markdown = `[![Image](https://images.steamusercontent.com/ugc/2/THUMB/?imw=1024)](https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&imh=5000&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false)\r\n\r\nApr 21, 2018 @ 9:31am\r\n`;
    expect(parseSteamScreenshotMarkdown(markdown)).toEqual({
      originalUrl: "https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&imh=5000&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false",
      caption: null,
      postedText: "Apr 21, 2018 @ 9:31am",
      capturedAt: new Date("2018-04-21T09:31:00.000Z"),
      retrievalMode: "JINA_READER"
    });
  });

  it("falls back to the reader after a rate-limited Steam detail request", async () => {
    const markdown = `[![Image](https://images.steamusercontent.com/ugc/2/THUMB/?imw=1024)](https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&amp;letterbox=false)`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(markdown, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSteamScreenshotDetail("1385922457")).resolves.toMatchObject({
      originalUrl: "https://images.steamusercontent.com/ugc/2/DEF/?imw=5000&letterbox=false",
      retrievalMode: "JINA_READER"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
