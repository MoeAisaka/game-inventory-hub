import fs from "node:fs/promises";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

import { addUserAgent } from "nxapi";
import { NintendoAccountSessionAuthorisationCoral } from "nxapi/coral";
import { initStorage } from "../node_modules/nxapi/dist/util/storage.js";
import { getToken } from "../node_modules/nxapi/dist/common/auth/coral.js";
import {
  NxapiClientAssertionProvider,
  setClientAssertionProvider,
} from "../node_modules/nxapi/dist/util/nxapi-auth.js";

const CALLBACK_PROTOCOL = "npf71b963c1b7b6d119:";
const CALLBACK_PREFIX = "npf71b963c1b7b6d119://auth";
const CALLBACK_PATTERN = /npf71b963c1b7b6d119:\/\/auth[#?][^\s<>"'`]+/i;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;
const NXAPI_AUTH_SCOPE = "ca:gf ca:er ca:dr ca:na";
let nxapiConfigured = false;

function stateFingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 8).toUpperCase();
}

export function validateNintendoCallbackState(params, expectedState) {
  const receivedState = params.get("state") ?? "";
  const expected = Buffer.from(String(expectedState ?? ""));
  const received = Buffer.from(receivedState);
  const matches = expected.length === received.length && timingSafeEqual(expected, received);
  if (!matches) {
    const error = new Error(
      `该回调属于旧授权批次（收到 ${stateFingerprint(receivedState)}，当前 ${stateFingerprint(expectedState)}）；请关闭旧 Nintendo 授权标签页并重新开始授权`,
    );
    error.code = "NINTENDO_AUTH_STATE_MISMATCH";
    throw error;
  }
}

async function configureNxapi() {
  if (nxapiConfigured) {
    return;
  }

  const packageUrl = new URL("../node_modules/nxapi/package.json", import.meta.url);
  const packageData = JSON.parse(await fs.readFile(packageUrl, "utf8"));
  const clientId = process.env.NXAPI_AUTH_CLIENT_ID ?? packageData.__nxapi_auth?.cli?.client_id;
  if (!clientId) {
    const error = new Error("nxapi 客户端认证未配置");
    error.code = "NINTENDO_NXAPI_CLIENT_AUTH_MISSING";
    throw error;
  }

  addUserAgent(process.env.NXAPI_USER_AGENT ?? "game-inventory-hub-nintendo-sidecar/0.2.0");
  setClientAssertionProvider(new NxapiClientAssertionProvider(clientId, undefined, NXAPI_AUTH_SCOPE));
  nxapiConfigured = true;
}

export function parseNintendoCallback(value) {
  // Browsers and chat/terminal surfaces may wrap the copied custom-protocol
  // URL in surrounding text or HTML-escape its query separators. Extract only
  // the Nintendo callback without ever logging the sensitive token.
  const input = String(value ?? "")
    .trim()
    .replaceAll("&amp;", "&")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const callback = input.match(CALLBACK_PATTERN)?.[0] ?? input;
  let url;
  try {
    url = new URL(callback);
  } catch {
    const error = new Error(
      `剪贴板中未找到有效 Nintendo 回调；请重新复制以 ${CALLBACK_PREFIX} 开头的“选择此人”链接`,
    );
    error.code = "NINTENDO_CALLBACK_INVALID_URL";
    throw error;
  }

  if (url.protocol !== CALLBACK_PROTOCOL || url.hostname !== "auth") {
    const error = new Error("请复制以 npf71b963c1b7b6d119://auth 开头的回调链接");
    error.code = "NINTENDO_CALLBACK_WRONG_SCHEME";
    throw error;
  }

  const params = new URLSearchParams(url.hash.slice(1));
  if (!params.get("session_token_code") || !params.get("state")) {
    const error = new Error("Nintendo 回调缺少 session_token_code 或 state");
    error.code = "NINTENDO_CALLBACK_MISSING_FIELDS";
    throw error;
  }
  return params;
}

export async function startNintendoAuthorization({ dataPath, now = new Date() }) {
  await fs.mkdir(dataPath, { recursive: true, mode: 0o700 });
  const authenticator = NintendoAccountSessionAuthorisationCoral.create();
  const pending = {
    schemaVersion: "nintendo-auth-pending.v1",
    createdAt: now.toISOString(),
    authoriseUrl: authenticator.authorise_url,
    state: authenticator.state,
    verifier: authenticator.verifier,
    redirectUri: authenticator.redirect_uri,
  };
  const pendingPath = path.join(dataPath, ".auth-pending.json");
  const temporaryPath = `${pendingPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, pendingPath);
  await fs.chmod(pendingPath, 0o600);
  return {
    authoriseUrl: authenticator.authorise_url,
    pendingPath,
    batchId: stateFingerprint(authenticator.state),
  };
}

export async function completeNintendoAuthorization({ dataPath, callback, now = new Date(), zncProxyUrl }) {
  const pendingPath = path.join(dataPath, ".auth-pending.json");
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  if (pending.schemaVersion !== "nintendo-auth-pending.v1") {
    const error = new Error("Nintendo 授权状态版本无效，请重新开始授权");
    error.code = "NINTENDO_AUTH_STATE_INVALID";
    throw error;
  }
  const createdAt = Date.parse(pending.createdAt);
  if (!Number.isFinite(createdAt) || now.getTime() - createdAt > MAX_PENDING_AGE_MS) {
    const error = new Error("Nintendo 授权已超过 30 分钟，请重新开始授权");
    error.code = "NINTENDO_AUTH_STATE_EXPIRED";
    throw error;
  }

  const params = parseNintendoCallback(callback);
  // Validate before nxapi exchanges the one-time code. This turns stale-tab
  // mistakes into a recoverable, actionable error and preserves the code.
  validateNintendoCallbackState(params, pending.state);
  const authenticator = NintendoAccountSessionAuthorisationCoral.resume(
    pending.authoriseUrl,
    pending.state,
    pending.verifier,
    pending.redirectUri,
  );
  const token = await authenticator.getSessionToken(params);
  await configureNxapi();
  const storage = await initStorage(dataPath);
  const { data } = await getToken(storage, token.session_token, zncProxyUrl);
  await storage.setItem(`NintendoAccountToken.${data.user.id}`, token.session_token);
  const users = new Set((await storage.getItem("NintendoAccountIds")) ?? []);
  users.add(data.user.id);
  await storage.setItem("NintendoAccountIds", [...users]);
  await storage.setItem("SelectedUser", data.user.id);
  await fs.rm(pendingPath, { force: true });
  return {
    externalUserId: data.user.id,
    screenName: data.user.screenName ?? null,
    nickname: data.user.nickname ?? null,
    nsoName: data.nsoAccount?.user?.name ?? null,
  };
}
