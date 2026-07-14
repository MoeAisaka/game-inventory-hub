import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://media.steampowered.com https://shared.fastly.steamstatic.com https://shared.cloudflare.steamstatic.com https://cdn.akamai.steamstatic.com https://steamcdn-a.akamaihd.net https://images.igdb.com https://media.rawg.io; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["argon2", "pg"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
