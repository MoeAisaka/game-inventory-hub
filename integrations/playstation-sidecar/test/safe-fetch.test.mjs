import assert from "node:assert/strict";
import test from "node:test";
import { installSafeFetch } from "../src/safe-fetch.mjs";

test("psn-api transport resolves the guarded fetch when imported afterwards", async () => {
  const originalFetch = globalThis.fetch;
  const restoreFetch = installSafeFetch(1_000);
  try {
    const transport = await import("isomorphic-unfetch");
    assert.equal(transport.default, globalThis.fetch);
  } finally {
    restoreFetch();
    globalThis.fetch = originalFetch;
  }
});
