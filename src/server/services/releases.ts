import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { gameReleaseEvents } from "@/server/db/schema";

const platformFilter = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}, z.array(z.string().trim().min(1).max(100)).max(20).transform((values) => [...new Set(values)]).default([]));

export const releaseCalendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  platform: platformFilter
});

export function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const next = new Date(Date.UTC(year, monthNumber, 1));
  const last = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  return {
    start: first.toISOString().slice(0, 10),
    end: last.toISOString().slice(0, 10),
    firstWeekday: first.getUTCDay(),
    daysInMonth: last.getUTCDate()
  };
}

export async function listReleaseCalendar(
  ownerUserId: string,
  input: z.infer<typeof releaseCalendarQuerySchema>
) {
  const bounds = monthBounds(input.month);
  const conditions = [
    eq(gameReleaseEvents.ownerUserId, ownerUserId),
    gte(gameReleaseEvents.releaseDate, bounds.start),
    lte(gameReleaseEvents.releaseDate, bounds.end)
  ];
  if (input.platform.length) conditions.push(inArray(gameReleaseEvents.platform, input.platform));
  const events = await db.select().from(gameReleaseEvents)
    .where(and(...conditions))
    .orderBy(asc(gameReleaseEvents.releaseDate), asc(gameReleaseEvents.nameZh));
  return { ...bounds, month: input.month, platforms: input.platform, events };
}
