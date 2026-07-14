import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DATABASE_UNAVAILABLE"
  | "DEPENDENCY_UNAVAILABLE"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "NOT_CONFIGURED"
  | "PRECONDITION_FAILED"
  | "INTERNAL_ERROR";

export function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id");
  return candidate && /^[a-zA-Z0-9._:-]{8,100}$/.test(candidate) ? candidate : randomUUID();
}

export function apiOk<T>(data: T, status = 200, id: string = randomUUID()) {
  return NextResponse.json({ data, requestId: id }, { status, headers: { "x-request-id": id } });
}

export function apiError(code: ApiErrorCode, message: string, status: number, id: string = randomUUID(), details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) }, requestId: id },
    { status, headers: { "x-request-id": id } }
  );
}

export async function safeJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new Error("INVALID_CONTENT_TYPE");
  return request.json();
}
