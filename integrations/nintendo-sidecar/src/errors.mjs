export class NintendoSidecarError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "NintendoSidecarError";
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof NintendoSidecarError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "NINTENDO_PREVIEW_FAILED", message: "Nintendo 只读预览失败" };
}
