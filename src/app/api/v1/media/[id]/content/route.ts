import { NextRequest } from "next/server";
import { apiError, requestId } from "@/lib/api";
import { requireApiSession } from "@/server/http/auth";
import { MediaStorageError } from "@/server/media/storage";
import { getMediaContent } from "@/server/services/media";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const variant = request.nextUrl.searchParams.get("variant") === "original" ? "original" : "thumbnail";
  try {
    const content = await getMediaContent(auth.userId, (await params).id, variant);
    return new Response(new Uint8Array(content.bytes), {
      status: 200,
      headers: {
        "content-type": content.mimeType,
        "content-length": String(content.byteSize),
        "cache-control": "private, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
        "x-request-id": id
      }
    });
  } catch (error) {
    if (error instanceof MediaStorageError && error.status === 404) return apiError("NOT_FOUND", error.message, 404, id);
    return apiError("INTERNAL_ERROR", "读取图片失败", 500, id);
  }
}
