export const gameGenreValues = [
  "ACT",
  "ARPG",
  "JRPG",
  "CRPG",
  "SRPG",
  "FPS",
  "TPS",
  "AVG_GAL",
  "SLG",
  "RTS",
  "FIGHTING",
  "PLATFORMER",
  "ROGUELIKE",
  "SIMULATION",
  "RACING",
  "SPORTS",
  "RHYTHM",
  "PUZZLE",
  "HORROR",
  "SURVIVAL",
  "SANDBOX",
  "MMO",
  "PARTY",
  "OTHER"
] as const;

export type GameGenre = (typeof gameGenreValues)[number];

export const gameGenreLabels: Record<GameGenre, string> = {
  ACT: "动作",
  ARPG: "ARPG",
  JRPG: "JRPG",
  CRPG: "CRPG",
  SRPG: "战棋",
  FPS: "FPS",
  TPS: "TPS",
  AVG_GAL: "AVG／Gal",
  SLG: "策略 SLG",
  RTS: "RTS",
  FIGHTING: "格斗",
  PLATFORMER: "平台跳跃",
  ROGUELIKE: "Roguelike",
  SIMULATION: "模拟经营",
  RACING: "竞速",
  SPORTS: "体育",
  RHYTHM: "音游",
  PUZZLE: "解谜",
  HORROR: "恐怖",
  SURVIVAL: "生存",
  SANDBOX: "沙盒",
  MMO: "MMO",
  PARTY: "派对",
  OTHER: "其他"
};

/**
 * 外部类型名 → 受控词表映射。
 * 覆盖 IGDB genres 官方词表，另附 Steam 商店中英文 genre 别名（发售目录元数据优先取 Steam 本地化 genre）。
 * 语义无法精确落到词表的条目（如 IGDB 的 Shooter 分不清 FPS/TPS、泛化的 RPG / Adventure / Indie）刻意不映射，留空待人工。
 */
export const externalGenreMapping: Record<string, GameGenre> = {
  // IGDB genres
  "fighting": "FIGHTING",
  "music": "RHYTHM",
  "platform": "PLATFORMER",
  "puzzle": "PUZZLE",
  "racing": "RACING",
  "real time strategy (rts)": "RTS",
  "simulator": "SIMULATION",
  "sport": "SPORTS",
  "strategy": "SLG",
  "turn-based strategy (tbs)": "SLG",
  "hack and slash/beat 'em up": "ACT",
  "visual novel": "AVG_GAL",
  "point-and-click": "AVG_GAL",
  "pinball": "OTHER",
  "card & board game": "OTHER",
  "moba": "OTHER",
  "quiz/trivia": "PARTY",
  // Steam 英文 genre 别名
  "action": "ACT",
  "massively multiplayer": "MMO",
  "simulation": "SIMULATION",
  "sports": "SPORTS",
  // Steam 中文 genre 别名
  "动作": "ACT",
  "策略": "SLG",
  "模拟": "SIMULATION",
  "体育": "SPORTS",
  "竞速": "RACING",
  "赛车": "RACING",
  "大型多人在线": "MMO",
  "格斗": "FIGHTING",
  "视觉小说": "AVG_GAL",
  "音乐": "RHYTHM",
  "解谜": "PUZZLE",
  "恐怖": "HORROR"
};

/** 主类型选择优先级：越具体的类型越靠前；命中多个时第一个作主类型，其余进入子标签。 */
const primaryGenrePriority: GameGenre[] = [
  "AVG_GAL",
  "FIGHTING",
  "RHYTHM",
  "PLATFORMER",
  "ROGUELIKE",
  "RTS",
  "SRPG",
  "FPS",
  "TPS",
  "RACING",
  "SPORTS",
  "PUZZLE",
  "SIMULATION",
  "MMO",
  "PARTY",
  "ARPG",
  "JRPG",
  "CRPG",
  "ACT",
  "SLG",
  "HORROR",
  "SURVIVAL",
  "SANDBOX",
  "OTHER"
];

export type MappedGenres = {
  primaryGenre: GameGenre | null;
  subGenres: GameGenre[];
};

export function mapExternalGenres(genreNames: readonly string[]): MappedGenres {
  const mapped = new Set<GameGenre>();
  for (const name of genreNames) {
    const genre = externalGenreMapping[name.trim().toLowerCase()];
    if (genre) mapped.add(genre);
  }
  const ordered = primaryGenrePriority.filter((genre) => mapped.has(genre));
  return {
    primaryGenre: ordered[0] ?? null,
    subGenres: ordered.slice(1)
  };
}

export function gameGenreList(primaryGenre: GameGenre | string | null, subGenres: readonly (GameGenre | string)[]) {
  const values = [primaryGenre, ...subGenres].filter((value): value is GameGenre =>
    Boolean(value) && (gameGenreValues as readonly string[]).includes(value as string));
  return [...new Set(values)];
}
