import { describe, expect, it } from "vitest";
import { sameOrigin } from "./auth";

describe("sameOrigin", () => {
  it("accepts the configured application origin", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api", {
      headers: { origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000" }
    }))).toBe(true);
  });

  it("rejects a forged forwarded host and foreign origin", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api", {
      headers: { origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid" }
    }))).toBe(false);
  });

  it("rejects requests without an Origin header", () => {
    expect(sameOrigin(new Request("http://internal.invalid/api"))).toBe(false);
  });
});
