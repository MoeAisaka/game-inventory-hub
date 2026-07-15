import test from "node:test";
import assert from "node:assert/strict";
import { parseNintendoCallback, validateNintendoCallbackState } from "../src/auth.mjs";

test("accepts a Nintendo app callback with state and code", () => {
  const params = parseNintendoCallback("npf71b963c1b7b6d119://auth#session_token_code=code-value&state=state-value");
  assert.equal(params.get("session_token_code"), "code-value");
  assert.equal(params.get("state"), "state-value");
});

test("extracts a Nintendo callback from surrounding clipboard text", () => {
  const params = parseNintendoCallback([
    "复制链接地址：",
    "npf71b963c1b7b6d119://auth#session_token_code=code-value&state=state-value",
    "不要复制浏览器地址栏。",
  ].join("\n"));
  assert.equal(params.get("session_token_code"), "code-value");
  assert.equal(params.get("state"), "state-value");
});

test("accepts an HTML-escaped Nintendo callback", () => {
  const params = parseNintendoCallback(
    "<npf71b963c1b7b6d119://auth#session_token_code=code-value&amp;state=state-value>",
  );
  assert.equal(params.get("session_token_code"), "code-value");
  assert.equal(params.get("state"), "state-value");
});

test("rejects the authorization page URL", () => {
  assert.throws(
    () => parseNintendoCallback("https://accounts.nintendo.com/connect/1.0.0/authorize?state=x"),
    (error) => error.code === "NINTENDO_CALLBACK_WRONG_SCHEME",
  );
});

test("rejects a relative authorize fragment", () => {
  assert.throws(
    () => parseNintendoCallback("authorize?state=x"),
    (error) => error.code === "NINTENDO_CALLBACK_INVALID_URL",
  );
});

test("accepts a callback from the current authorization batch", () => {
  const params = new URLSearchParams({ session_token_code: "code", state: "current-state" });
  assert.doesNotThrow(() => validateNintendoCallbackState(params, "current-state"));
});

test("rejects a callback from a stale authorization batch before exchange", () => {
  const params = new URLSearchParams({ session_token_code: "code", state: "old-state" });
  assert.throws(
    () => validateNintendoCallbackState(params, "current-state"),
    (error) => error.code === "NINTENDO_AUTH_STATE_MISMATCH" && /旧授权批次/.test(error.message),
  );
});
