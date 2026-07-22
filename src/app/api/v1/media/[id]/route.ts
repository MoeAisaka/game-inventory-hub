import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { MediaStorageError } from "@/server/media/storage";
import { removeMedia } from "@/server/services/media";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    return apiOk(await removeMedia(auth.userId, (await params).id, id), 200, id);
  } catch (error) {
    if (error instanceof MediaStorageError && error.status === 404) return apiError("NOT_FOUND", error.message, 404, id);
    return apiError("INTERNAL_ERROR", "移除图片失败", 500, id);
  }
}
