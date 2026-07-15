/**
 * Browser origins used by cover URLs persisted from supported catalog sources.
 * Keep this list explicit so the CSP remains restrictive while platform imports
 * can render their native artwork.
 */
export const coverImageOrigins = [
  "https://image.api.playstation.com",
  "https://atum-img-lp1.cdn.nintendo.net",
  "https://media.steampowered.com",
  "https://shared.akamai.steamstatic.com",
  "https://shared.fastly.steamstatic.com",
  "https://shared.cloudflare.steamstatic.com",
  "https://cdn.akamai.steamstatic.com",
  "https://steamcdn-a.akamaihd.net",
  "https://images.igdb.com",
  "https://media.rawg.io"
] as const;
