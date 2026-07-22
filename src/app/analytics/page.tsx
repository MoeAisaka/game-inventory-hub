import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { getDashboardData } from "@/server/services/dashboard";
import { getDashboardFilters } from "@/server/services/preferences";
import { DashboardClient } from "../dashboard-client";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const filters = await getDashboardFilters(session.userId);
  const initialData = await getDashboardData(session.userId, filters);
  return <AppShell username={session.username} active="/analytics">
    <DashboardClient initialData={initialData} />
  </AppShell>;
}
