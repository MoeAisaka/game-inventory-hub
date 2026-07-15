import { count, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { formatShanghaiDateTime } from "@/lib/date-format";
import { env } from "@/lib/env";
import { currentSession } from "@/server/auth/current";
import { db } from "@/server/db";
import { externalAccounts, platformLibraryItems, syncJobs } from "@/server/db/schema";
import { steamLibraryOverview } from "@/server/integrations/steam-library";
import { SteamMatchReview } from "./steam-match-review";
import { SyncControl } from "./sync-control";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const [accounts, jobs, library, platformCounts] = await Promise.all([
    db.select().from(externalAccounts).where(eq(externalAccounts.ownerUserId, session.userId)),
    db.select().from(syncJobs).where(eq(syncJobs.ownerUserId, session.userId)).orderBy(desc(syncJobs.createdAt)).limit(20),
    steamLibraryOverview(session.userId),
    db.select({ provider: platformLibraryItems.provider, value: count() }).from(platformLibraryItems).where(eq(platformLibraryItems.ownerUserId, session.userId)).groupBy(platformLibraryItems.provider)
  ]);
  const steam = accounts.find((account) => account.provider === "STEAM");
  const config = env();
  return <AppShell username={session.username} active="/sync">
    <header className="page-header"><div><span className="eyebrow">EXTERNAL DATA</span><h1>平台与元数据同步</h1><p>外部数据只更新平台字段；手工修正具有最高优先级。</p></div></header>
    <SyncControl steamAccount={steam ? { steamId: steam.externalUserId, displayName: steam.displayName, status: steam.status, lastSyncedAt: steam.lastSyncedAt?.toISOString() ?? null } : null} steamReady={Boolean(config.STEAM_WEB_API_KEY)} igdbReady={Boolean(config.IGDB_CLIENT_ID && config.IGDB_CLIENT_SECRET)} platformCounts={{ playstation: platformCounts.find((item) => item.provider === "PLAYSTATION")?.value ?? 0, nintendo: platformCounts.find((item) => item.provider === "NINTENDO")?.value ?? 0 }} />
    <SteamMatchReview
      summary={library.summary}
      items={library.unresolved.map((item) => ({
        steamAppId: item.steamAppId,
        name: item.name,
        playtimeMinutes: item.playtimeMinutes,
        recentPlaytimeMinutes: item.recentPlaytimeMinutes,
        lastPlayedAt: item.lastPlayedAt?.toISOString() ?? null,
        iconUrl: item.iconUrl,
        matchMethod: item.matchMethod
      }))}
      localGames={library.localGames}
    />
    <section className="content-section"><div className="section-heading"><div><h2>同步记录</h2><p>幂等键、处理数量与失败码均可追踪。</p></div><span className="count-badge">{jobs.length} 项</span></div>{jobs.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>状态</th><th>处理</th><th>新增/更新/跳过</th><th>错误</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{formatShanghaiDateTime(job.createdAt)}</td><td>{job.provider}</td><td><span className={`result ${job.status === "SUCCEEDED" ? "success" : job.status === "FAILED" ? "failure" : "warning"}`}>{job.status}</span></td><td>{job.processedCount}</td><td>{job.createdCount} / {job.updatedCount} / {job.skippedCount}</td><td>{job.errorCode ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-state">尚无同步任务。</div>}</section>
  </AppShell>;
}
