import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DashboardFilters, defaultDashboardFilters, parseDashboardFilters } from "@/lib/dashboard";
import { type HomeQueuePreferences, defaultHomeQueuePreferences, parseHomeQueuePreferences } from "@/lib/home";
import { type HardwareProfile, defaultHardwareProfile, parseHardwareProfile } from "@/lib/purchase-advisor";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { userPreferences } from "@/server/db/schema";

export const DASHBOARD_FILTER_NAMESPACE = "dashboard.filters.v1";
export const HOME_QUEUE_NAMESPACE = "home.queue.v1";
export const HARDWARE_PROFILE_NAMESPACE = "hardware.profile.v1";

/** 用户硬件档案（拥有 PS5 / 高端 RTX PC / Switch）；缺省时回落到默认种子档案。 */
export async function getHardwareProfile(ownerUserId: string): Promise<HardwareProfile> {
  const preference = (await db.select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.ownerUserId, ownerUserId),
      eq(userPreferences.namespace, HARDWARE_PROFILE_NAMESPACE)
    ))
    .limit(1))[0];
  return preference ? parseHardwareProfile(preference.value) : defaultHardwareProfile;
}

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

export async function getHomeQueuePreferences(ownerUserId: string): Promise<HomeQueuePreferences> {
  const preference = (await db.select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.ownerUserId, ownerUserId),
      eq(userPreferences.namespace, HOME_QUEUE_NAMESPACE)
    ))
    .limit(1))[0];
  return preference ? parseHomeQueuePreferences(preference.value) : defaultHomeQueuePreferences;
}

export async function saveHomeQueuePreferences(
  ownerUserId: string,
  preferences: HomeQueuePreferences,
  requestId: string = randomUUID()
) {
  const now = new Date();
  const [preference] = await db.insert(userPreferences).values({
    ownerUserId,
    namespace: HOME_QUEUE_NAMESPACE,
    value: preferences,
    updatedAt: now
  }).onConflictDoUpdate({
    target: [userPreferences.ownerUserId, userPreferences.namespace],
    set: { value: preferences, updatedAt: now }
  }).returning();
  await writeAudit({
    actorUserId: ownerUserId,
    action: "preference.home_queue.update",
    entityType: "user_preference",
    entityId: preference.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { namespace: HOME_QUEUE_NAMESPACE, showCandidatePool: preferences.showCandidatePool }
  });
  return preference;
}
