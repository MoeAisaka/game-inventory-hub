import { describe, expect, it } from "vitest";
import { gameRatingConstraints } from "./game-rating";

describe("game rating input constraints", () => {
  it("accepts two-decimal ratings returned by metadata providers", () => {
    const providerRating = 76.37;
    const units = providerRating / gameRatingConstraints.step;

    expect(Number.isInteger(units)).toBe(true);
    expect(providerRating).toBeGreaterThanOrEqual(gameRatingConstraints.min);
    expect(providerRating).toBeLessThanOrEqual(gameRatingConstraints.max);
  });
});
