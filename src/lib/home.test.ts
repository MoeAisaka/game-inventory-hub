import { describe, expect, it } from "vitest";
import { formatHomeDate, formatHomeMonthDay, formatHomeMonthDayTime } from "./home";

describe("action home date formatting", () => {
  it("keeps date-only release dates in the Shanghai calendar day", () => {
    expect(formatHomeMonthDay("2026-07-16")).toBe("7/16");
  });

  it("formats instants in a fixed timezone for hydration stability", () => {
    const instant = "2026-07-15T16:30:00.000Z";
    expect(formatHomeMonthDayTime(instant)).toBe("7/16 00:30");
    expect(formatHomeDate(instant)).toBe("2026/7/16");
  });
});
