import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { db } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
  return (
    <AppShell username={session.username} active="/audit">
      <header className="page-header"><div><span className="eyebrow">AUDIT TRAIL</span><h1>操作记录</h1><p>登录、退出、附件登记和导入批次等关键动作统一留痕。</p></div></header>
      <section className="content-section full-height">
        <div className="section-heading"><div><h2>最近100条</h2><p>日志不保存密码、Cookie或源文件正文。</p></div><span className="count-badge">{logs.length} 项</span></div>
        {logs.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>结果</th><th>请求ID</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{log.createdAt.toLocaleString("zh-CN")}</td><td><code>{log.action}</code></td><td>{log.entityType}{log.entityId ? <small className="sub-id">{log.entityId.slice(0, 8)}</small> : null}</td><td><span className={log.outcome === "SUCCESS" ? "result success" : "result failure"}>{log.outcome === "SUCCESS" ? "成功" : "失败"}</span></td><td><code>{log.requestId.slice(0, 12)}…</code></td></tr>)}</tbody></table></div> : <div className="empty-state">尚无操作记录。</div>}
      </section>
    </AppShell>
  );
}
