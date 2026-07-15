import { SidecarError } from "./errors.mjs";

export function installSafeFetch(timeoutMs) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const upstreamSignal = init.signal;
    const signal = upstreamSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([upstreamSignal, controller.signal])
      : controller.signal;
    try {
      const response = await nativeFetch(input, { ...init, signal });
      const manualRedirect = init.redirect === "manual" && response.status >= 300 && response.status < 400;
      if (!response.ok && !manualRedirect) {
        throw new SidecarError(
          `PSN_HTTP_${response.status}`,
          `PlayStation 依赖返回 HTTP ${response.status}`,
          { status: response.status, retryable: response.status === 429 || response.status >= 500 }
        );
      }
      return response;
    } catch (error) {
      if (error instanceof SidecarError) throw error;
      if (controller.signal.aborted) {
        throw new SidecarError("PSN_TIMEOUT", "PlayStation 请求超时", { retryable: true });
      }
      throw new SidecarError("PSN_NETWORK_ERROR", "PlayStation 网络请求失败", { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  };
  return () => {
    globalThis.fetch = nativeFetch;
  };
}

export async function withRetry(operation, { maxAttempts, baseDelayMs = 600 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof SidecarError ? error.retryable : false;
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
