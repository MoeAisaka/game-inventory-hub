import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DashboardFilters, defaultDashboardFilters, parseDashboardFilters } from "@/lib/dashboard";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { userPreferences } from "@/server/db/schema";

export const DASHBOARD_FILTER_NAMESPACE = "dashboard.filters.v1";

export async function getDashboardFilters(ownerUserId: string): Promise<DashboardFilters> {
  const preference = (await db.select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.ownerUserId, ownerUserId),
      eq(userPreferences.namespace, DASHBOARD_FILTER_NAMESPACE)
    ))
    .limit(1))[0];
  return preference ? parseDashboardFilters(preference.value) : defaultDashboardFilters;
}

export async function saveDashboardFilters(
  ownerUserId: string,
  filters: DashboardFilters,
  requestId: string = randomUUID()
) {
  const now = new Date();
  const [preference] = await db.insert(userPreferences).values({
    ownerUserId,
    namespace: DASHBOARD_FILTER_NAMESPACE,
    value: filters,
    updatedAt: now
  }).onConflictDoUpdate({
    target: [userPreferences.ownerUserId, userPreferences.namespace],
    set: { value: filters, updatedAt: now }
  }).returning();
  await writeAudit({
    actorUserId: ownerUserId,
    action: "preference.dashboard.update",
    entityType: "user_preference",
    entityId: preference.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { namespace: DASHBOARD_FILTER_NAMESPACE }
  });
  return preference;
}
