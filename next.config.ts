import type { NextConfig } from "next";
import { coverImageOrigins } from "./src/lib/cover-image-hosts";

const imageSourcePolicy = ["'self'", "data:", ...coverImageOrigins].join(" ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src ${imageSourcePolicy}; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` }
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["argon2", "pg"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
