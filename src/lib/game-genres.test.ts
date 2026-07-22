import { describe, expect, it } from "vitest";
import { gameGenre } from "@/server/db/schema";
import { gameGenreLabels, gameGenreList, gameGenreValues, mapExternalGenres } from "@/lib/game-genres";

describe("game genre vocabulary", () => {
  it("matches the database enum exactly", () => {
    expect(gameGenre.enumValues).toEqual([...gameGenreValues]);
  });

  it("has a Chinese-facing label for every genre", () => {
    for (const genre of gameGenreValues) {
      expect(gameGenreLabels[genre]).toBeTruthy();
    }
  });

  it("maps IGDB and Steam genre names with specific-first priority", () => {
    expect(mapExternalGenres(["Platform", "Puzzle", "Indie"])).toEqual({ primaryGenre: "PLATFORMER", subGenres: ["PUZZLE"] });
    expect(mapExternalGenres(["Strategy", "Turn-based strategy (TBS)"])).toEqual({ primaryGenre: "SLG", subGenres: [] });
    expect(mapExternalGenres(["Visual Novel", "Adventure"])).toEqual({ primaryGenre: "AVG_GAL", subGenres: [] });
    expect(mapExternalGenres(["Music", "Fighting"])).toEqual({ primaryGenre: "FIGHTING", subGenres: ["RHYTHM"] });
    expect(mapExternalGenres(["Hack and slash/Beat 'em up"])).toEqual({ primaryGenre: "ACT", subGenres: [] });
    expect(mapExternalGenres(["动作", "模拟"])).toEqual({ primaryGenre: "SIMULATION", subGenres: ["ACT"] });
  });

  it("leaves ambiguous external genres unmapped for manual curation", () => {
    expect(mapExternalGenres(["Shooter"])).toEqual({ primaryGenre: null, subGenres: [] });
    expect(mapExternalGenres(["Role-playing (RPG)", "Adventure", "Indie"])).toEqual({ primaryGenre: null, subGenres: [] });
    expect(mapExternalGenres([])).toEqual({ primaryGenre: null, subGenres: [] });
  });

  it("builds a deduplicated display list from primary and sub genres", () => {
    expect(gameGenreList("ACT", ["ACT", "HORROR", "bogus"])).toEqual(["ACT", "HORROR"]);
    expect(gameGenreList(null, [])).toEqual([]);
  });
});
