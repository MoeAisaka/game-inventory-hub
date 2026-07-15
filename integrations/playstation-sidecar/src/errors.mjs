export class SidecarError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SidecarError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.status = options.status ?? null;
  }
}

export function publicError(error) {
  if (error instanceof SidecarError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "UNEXPECTED_ERROR", message: "PlayStation Sidecar 执行失败", retryable: false };
}
