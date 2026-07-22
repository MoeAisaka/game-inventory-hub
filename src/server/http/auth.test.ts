import { describe, expect, it } from "vitest";
import { sameOrigin } from "./auth";

describe("sameOrigin", () => {
  it("accepts an origin that matches the effective host", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api", {
      headers: { origin: "http://internal.invalid", host: "internal.invalid" }
    }))).toBe(true);
  });

  it("rejects a forged forwarded host and foreign origin", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api", {
      headers: { origin: "https://attacker.invalid", "x-forwarded-host": "games.example.invalid" }
    }))).toBe(false);
  });

  it("rejects requests without an Origin header", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api"))).toBe(false);
  });
});
