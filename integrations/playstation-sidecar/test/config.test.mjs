import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

test("defaults to explicit preview mode and bounded limits", () => {
  const config = loadConfig(["--preview"]);
  assert.equal(config.mode, "preview");
  assert.equal(config.maxItems, 5000);
  assert.equal(config.requestTimeoutMs, 20_000);
});

test("rejects missing or conflicting modes", () => {
  assert.throws(() => loadConfig([]), /必须且只能指定/);
  assert.throws(() => loadConfig(["--preview", "--submit"]), /必须且只能指定/);
});
