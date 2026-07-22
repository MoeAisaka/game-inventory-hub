import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { getPlayPlannerData } from "@/server/services/play-planning";
import { PlayPlannerClient } from "./play-planner-client";

export const dynamic = "force-dynamic";

export default async function PlayPlannerPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const data = await getPlayPlannerData(session.userId);
  return <AppShell username={session.username} active="/play"><PlayPlannerClient data={data} /></AppShell>;
}
