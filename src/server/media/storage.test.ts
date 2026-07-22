import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStoredContent, storeImage } from "./storage";

let storageRoot = "";

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "game-media-storage-"));
  process.env.MEDIA_STORAGE_ROOT = storageRoot;
  process.env.MEDIA_MAX_UPLOAD_BYTES = "25000000";
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe("game media storage", () => {
  it("stores an original and deterministic WebP thumbnail by content checksum", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const first = await storeImage(png, "pixel.png");
    const second = await storeImage(png, "pixel-copy.png");
    expect(first.original.relativePath).toBe(second.original.relativePath);
    expect(first.thumbnail.relativePath).toBe(second.thumbnail.relativePath);
    expect(first).toMatchObject({ width: 1, height: 1, original: { mimeType: "image/png", byteSize: png.length } });
    expect(await readStoredContent(first.original.relativePath)).toEqual(png);
    expect((await readStoredContent(first.thumbnail.relativePath)).length).toBeGreaterThan(0);
  });

  it("rejects non-image input", async () => {
    await expect(storeImage(Buffer.from("not-an-image"), "bad.txt")).rejects.toMatchObject({
      code: "MEDIA_DECODE_FAILED"
    });
  });
});
