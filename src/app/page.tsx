import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { getHomeData } from "@/server/services/home";
import { getHomeQueuePreferences } from "@/server/services/preferences";
import { ActionHomeClient } from "./action-home-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const [data, queuePreferences] = await Promise.all([
    getHomeData(session.userId),
    getHomeQueuePreferences(session.userId)
  ]);
  return (
    <AppShell username={session.username} active="/">
      <ActionHomeClient data={data} queuePreferences={queuePreferences} />
    </AppShell>
  );
}
