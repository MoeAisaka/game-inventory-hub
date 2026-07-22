import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { addUserAgent } from "nxapi";
import { initStorage } from "../node_modules/nxapi/dist/util/storage.js";
import { getToken } from "../node_modules/nxapi/dist/common/auth/coral.js";
import { getNintendoAccountSessionToken } from "../node_modules/nxapi/dist/api/na.js";
import { ZNCA_CLIENT_ID } from "../node_modules/nxapi/dist/api/coral.js";

const CALLBACK_PROTOCOL = "npf71b963c1b7b6d119:";
const CALLBACK_PREFIX = "npf71b963c1b7b6d119://auth";
const CALLBACK_PATTERN = /npf71b963c1b7b6d119:\/\/auth[#?][^\s<>"'`]+/i;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;
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

  addUserAgent(process.env.NXAPI_USER_AGENT ?? "games.example.invalid-nintendo-sidecar/0.2.0");
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
  const state = randomBytes(36).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirectUri = "npf71b963c1b7b6d119://auth";
  const authoriseUrl = `https://accounts.nintendo.com/connect/1.0.0/authorize?${new URLSearchParams({
    state,
    redirect_uri: redirectUri,
    client_id: ZNCA_CLIENT_ID,
    scope: "openid user user.birthday user.mii user.screenName",
    response_type: "session_token_code",
    session_token_code_challenge: challenge,
    session_token_code_challenge_method: "S256",
    theme: "login_form",
  })}`;
  const pending = {
    schemaVersion: "nintendo-auth-pending.v1",
    createdAt: now.toISOString(),
    authoriseUrl,
    state,
    verifier,
    redirectUri,
  };
  const pendingPath = path.join(dataPath, ".auth-pending.json");
  const temporaryPath = `${pendingPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, pendingPath);
  await fs.chmod(pendingPath, 0o600);
  return {
    authoriseUrl,
    pendingPath,
    batchId: stateFingerprint(state),
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
  const token = await getNintendoAccountSessionToken(
    params.get("session_token_code"),
    pending.verifier,
    ZNCA_CLIENT_ID,
  );
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
