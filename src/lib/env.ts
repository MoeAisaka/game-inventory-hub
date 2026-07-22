import { z } from "zod";

const booleanString = z.enum(["true", "false"]).default("true").transform((value) => value === "true");
const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  SESSION_COOKIE_SECURE: booleanString,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  APP_VERSION: z.string().min(1).max(50).default("0.31.1"),
  STEAM_WEB_API_KEY: optionalSecret,
  IGDB_CLIENT_ID: optionalSecret,
  IGDB_CLIENT_SECRET: optionalSecret,
  SYNC_CRON_SECRET: optionalSecret,
  EXTERNAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  MEDIA_STORAGE_ROOT: z.string().min(1).default("/data/media"),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1_000_000).max(100_000_000).default(25_000_000)
});

let cached: z.infer<typeof schema> | undefined;

export function env() {
  cached ??= schema.parse(process.env);
  return cached;
}
