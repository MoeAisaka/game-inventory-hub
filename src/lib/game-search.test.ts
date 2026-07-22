import { describe, expect, it } from "vitest";
import { gameSearchVariants, normalizeGameSearchAliases, normalizeGameSearchText } from "@/lib/game-search";

describe("game search normalization", () => {
  it("expands simplified and traditional Chinese in both directions", () => {
    expect(gameSearchVariants("异度神剑X 终极版")).toEqual(expect.arrayContaining([
      "异度神剑X 终极版",
      "異度神劍X 終極版"
    ]));
    expect(gameSearchVariants("異度神劍X 終極版")).toEqual(expect.arrayContaining([
      "異度神劍X 終極版",
      "异度神剑X 终极版"
    ]));
  });

  it("deduplicates aliases by punctuation-insensitive normalized form", () => {
    expect(normalizeGameSearchAliases([
      "Xenoblade Chronicles X: Definitive Edition",
      " Xenoblade Chronicles X Definitive Edition ",
      "异度之刃X 终极版",
      ""
    ])).toEqual([
      "Xenoblade Chronicles X: Definitive Edition",
      "异度之刃X 终极版"
    ]);
    expect(normalizeGameSearchText("Xenoblade：X™ ")).toBe("xenobladex");
  });
});
