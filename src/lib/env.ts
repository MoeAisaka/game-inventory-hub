import { z } from "zod";

const booleanString = z.enum(["true", "false"]).default("true").transform((value) => value === "true");
const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  APP_ORIGIN: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  SESSION_COOKIE_SECURE: booleanString,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  APP_VERSION: z.string().min(1).max(50).default("0.11.0"),
  STEAM_WEB_API_KEY: optionalSecret,
  IGDB_CLIENT_ID: optionalSecret,
  IGDB_CLIENT_SECRET: optionalSecret,
  SYNC_CRON_SECRET: optionalSecret,
  EXTERNAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000)
});

let cached: z.infer<typeof schema> | undefined;

export function env() {
  cached ??= schema.parse(process.env);
  if (process.env.NODE_ENV === "production" && !cached.APP_ORIGIN) {
    throw new Error("APP_ORIGIN is required in production");
  }
  return cached;
}
