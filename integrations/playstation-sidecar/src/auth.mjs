import {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens
} from "psn-api";
import { SidecarError } from "./errors.mjs";
import { readJsonFile, writePrivateJson } from "./files.mjs";
import { withRetry } from "./safe-fetch.mjs";

function validTokens(tokens) {
  return Boolean(tokens?.accessToken && tokens?.refreshToken && Number.isFinite(tokens?.expiresIn));
}

function accessTokenFresh(state, now) {
  const obtainedAt = Date.parse(state?.obtainedAt || "");
  return validTokens(state) && Number.isFinite(obtainedAt) && obtainedAt + state.expiresIn * 1000 - 60_000 > now.getTime();
}

function stateFromTokens(tokens, now) {
  if (!validTokens(tokens)) throw new SidecarError("PSN_AUTH_FAILED", "PlayStation 授权响应不完整");
  return { ...tokens, obtainedAt: now.toISOString() };
}

function normalizeBootstrapError(error, stage) {
  if (error instanceof SidecarError) return error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (stage === "npsso" && /NPSSO|access code/i.test(message)) {
    return new SidecarError(
      "PSN_NPSSO_INVALID",
      "PlayStation NPSSO 无效或已过期，请重新获取后更新钥匙串",
      { cause: error }
    );
  }
  return new SidecarError(
    stage === "npsso" ? "PSN_ACCESS_CODE_EXCHANGE_FAILED" : "PSN_TOKEN_EXCHANGE_FAILED",
    stage === "npsso" ? "PlayStation 授权码交换失败" : "PlayStation 令牌交换失败",
    { cause: error }
  );
}

export async function getAuthorization(config, now = new Date()) {
  const existing = readJsonFile(config.authStateFile);
  if (accessTokenFresh(existing, now)) {
    return { accessToken: existing.accessToken, idToken: existing.idToken, source: "cached_access_token" };
  }
  if (existing?.refreshToken) {
    try {
      const refreshed = await withRetry(
        () => exchangeRefreshTokenForAuthTokens(existing.refreshToken),
        { maxAttempts: config.maxAttempts }
      );
      const state = stateFromTokens(refreshed, now);
      writePrivateJson(config.authStateFile, state);
      return { accessToken: state.accessToken, idToken: state.idToken, source: "refresh_token" };
    } catch (error) {
      if (!config.npsso) {
        throw new SidecarError("PSN_REAUTH_REQUIRED", "PlayStation 刷新令牌已失效，需要重新提供 NPSSO", { cause: error });
      }
    }
  }
  if (!config.npsso) {
    throw new SidecarError("PSN_NPSSO_REQUIRED", "首次授权需要从 Mac 钥匙串提供 NPSSO");
  }
  let accessCode;
  try {
    accessCode = await withRetry(
      () => exchangeNpssoForAccessCode(config.npsso),
      { maxAttempts: config.maxAttempts }
    );
  } catch (error) {
    throw normalizeBootstrapError(error, "npsso");
  }
  if (!accessCode) throw new SidecarError("PSN_AUTH_FAILED", "PlayStation 未返回授权码");
  let tokens;
  try {
    tokens = await withRetry(
      () => exchangeAccessCodeForAuthTokens(accessCode),
      { maxAttempts: config.maxAttempts }
    );
  } catch (error) {
    throw normalizeBootstrapError(error, "token");
  }
  const state = stateFromTokens(tokens, now);
  writePrivateJson(config.authStateFile, state);
  return { accessToken: state.accessToken, idToken: state.idToken, source: "npsso_bootstrap" };
}
