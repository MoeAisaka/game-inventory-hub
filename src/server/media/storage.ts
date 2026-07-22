import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import sharp, { type Metadata } from "sharp";
import { env } from "@/lib/env";

const MAX_INPUT_PIXELS = 40_000_000;
const allowedFormats = new Set(["jpeg", "png", "webp"]);

const formatDetails = {
  jpeg: { extension: "jpg", mimeType: "image/jpeg" },
  png: { extension: "png", mimeType: "image/png" },
  webp: { extension: "webp", mimeType: "image/webp" }
} as const;

export class MediaStorageError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export type StoredImage = {
  original: {
    checksumSha256: string;
    relativePath: string;
    mimeType: string;
    byteSize: number;
    originalName: string;
  };
  thumbnail: {
    checksumSha256: string;
    relativePath: string;
    mimeType: "image/webp";
    byteSize: number;
    originalName: string;
  };
  width: number;
  height: number;
};

function checksum(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function storageRoot() {
  return resolve(env().MEDIA_STORAGE_ROOT);
}

function absoluteStoragePath(relativePath: string) {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new MediaStorageError("MEDIA_PATH_INVALID", "媒体存储路径不合法", 500);
  }
  const root = storageRoot();
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new MediaStorageError("MEDIA_PATH_INVALID", "媒体存储路径越界", 500);
  }
  return target;
}

async function persistContent(relativePath: string, bytes: Buffer) {
  const target = absoluteStoragePath(relativePath);
  const temporary = absoluteStoragePath(`.tmp/${randomUUID()}.part`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function orientedDimensions(width: number, height: number, orientation?: number) {
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

export async function storeImage(bytes: Buffer, originalName: string): Promise<StoredImage> {
  if (!bytes.length) throw new MediaStorageError("MEDIA_EMPTY", "图片内容为空");
  if (bytes.length > env().MEDIA_MAX_UPLOAD_BYTES) {
    throw new MediaStorageError("MEDIA_TOO_LARGE", `单张图片不能超过 ${Math.floor(env().MEDIA_MAX_UPLOAD_BYTES / 1_000_000)} MB`, 413);
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new MediaStorageError("MEDIA_DECODE_FAILED", "无法解析图片，请上传 JPEG、PNG 或 WebP");
  }
  if (!metadata.format || !allowedFormats.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new MediaStorageError("MEDIA_FORMAT_UNSUPPORTED", "仅支持 JPEG、PNG 和 WebP 图片");
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new MediaStorageError("MEDIA_ANIMATION_UNSUPPORTED", "媒体库暂不支持动图");
  }

  const format = metadata.format as keyof typeof formatDetails;
  const details = formatDetails[format];
  const dimensions = orientedDimensions(metadata.width, metadata.height, metadata.orientation);
  const originalChecksum = checksum(bytes);
  const originalRelativePath = `originals/${originalChecksum.slice(0, 2)}/${originalChecksum}.${details.extension}`;
  const thumbnailResult = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: 960, height: 640, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  const thumbnailChecksum = checksum(thumbnailResult);
  const thumbnailRelativePath = `thumbnails/${thumbnailChecksum.slice(0, 2)}/${thumbnailChecksum}.webp`;

  await persistContent(originalRelativePath, bytes);
  await persistContent(thumbnailRelativePath, thumbnailResult);

  return {
    original: {
      checksumSha256: originalChecksum,
      relativePath: originalRelativePath,
      mimeType: details.mimeType,
      byteSize: bytes.length,
      originalName
    },
    thumbnail: {
      checksumSha256: thumbnailChecksum,
      relativePath: thumbnailRelativePath,
      mimeType: "image/webp",
      byteSize: thumbnailResult.length,
      originalName: `${originalChecksum}-thumbnail.webp`
    },
    ...dimensions
  };
}

export async function readStoredContent(relativePath: string) {
  const target = absoluteStoragePath(relativePath);
  const info = await stat(target);
  if (!info.isFile()) throw new MediaStorageError("MEDIA_FILE_MISSING", "媒体文件不存在", 404);
  return readFile(target);
}
