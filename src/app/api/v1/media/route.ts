import { basename } from "node:path";
import { NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { MediaStorageError } from "@/server/media/storage";
import { createManualMedia, manualMediaSchema } from "@/server/services/media";

function mediaApiError(error: unknown, id: string) {
  if (!(error instanceof MediaStorageError)) return apiError("INTERNAL_ERROR", "上传图片失败", 500, id);
  if (error.status === 404) return apiError("NOT_FOUND", error.message, 404, id);
  if (error.status === 409) return apiError("PRECONDITION_FAILED", error.message, 409, id);
  return apiError("INVALID_REQUEST", error.message, error.status, id, { mediaCode: error.code });
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return apiError("INVALID_REQUEST", "请选择图片", 400, id);
    if (file.size > env().MEDIA_MAX_UPLOAD_BYTES) {
      return apiError("INVALID_REQUEST", `单张图片不能超过 ${Math.floor(env().MEDIA_MAX_UPLOAD_BYTES / 1_000_000)} MB`, 413, id);
    }
    const parsed = manualMediaSchema.safeParse({
      gameId: form.get("gameId"),
      title: form.get("title") || undefined,
      capturedAt: form.get("capturedAt") || undefined
    });
    if (!parsed.success) return apiError("INVALID_REQUEST", "图片信息不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await createManualMedia(parsed.data, {
      name: basename(file.name || "upload-image").slice(0, 255),
      bytes: Buffer.from(await file.arrayBuffer())
    }, auth.userId, id);
    return apiOk(result, result.created ? 201 : 200, id);
  } catch (error) {
    return mediaApiError(error, id);
  }
}
