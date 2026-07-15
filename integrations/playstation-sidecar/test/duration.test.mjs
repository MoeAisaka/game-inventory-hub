import test from "node:test";
import assert from "node:assert/strict";
import { durationToMinutes } from "../src/duration.mjs";

test("converts ISO-8601 play duration to whole minutes", () => {
  assert.equal(durationToMinutes("PT228H56M33S"), 13736);
  assert.equal(durationToMinutes("P1DT2H3M4S"), 1563);
  assert.equal(durationToMinutes("PT59S"), 0);
});

test("rejects malformed or negative durations safely", () => {
  assert.equal(durationToMinutes("not-a-duration"), 0);
  assert.equal(durationToMinutes("PT-2H"), 0);
  assert.equal(durationToMinutes(null), 0);
});
