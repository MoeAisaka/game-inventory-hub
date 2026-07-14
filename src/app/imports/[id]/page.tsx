import { and, asc, eq, inArray } from "drizzle-orm";
import { ArrowLeft, CheckCircle2, CircleAlert, Images, Rows3 } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { db } from "@/server/db";
import { importBatches, importReconciliations, importRows } from "@/server/db/schema";
import { RollbackButton } from "./rollback-button";
import { CommitButton } from "./commit-button";

export const dynamic = "force-dynamic";

export default async function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const batch = (await db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1))[0];
  if (!batch) notFound();
  const [reconciliations, exceptions] = await Promise.all([
    db.select().from(importReconciliations).where(eq(importReconciliations.batchId, id)).orderBy(asc(importReconciliations.metric)),
    db.select().from(importRows).where(and(eq(importRows.batchId, id), inArray(importRows.status, ["ERROR", "WARNING"]))).orderBy(asc(importRows.sheetName), asc(importRows.sourceRow)).limit(200)
  ]);
  const readyForCommit = batch.summary?.readyForCommit === true;
  return <AppShell username={session.username} active="/imports">
    <header className="page-header"><div><Link className="back-link" href="/imports"><ArrowLeft size={15} />返回批次列表</Link><span className="eyebrow">MIGRATION DRY RUN</span><h1>试迁移报告</h1><p>{batch.sourceName} · {batch.sourceChecksum.slice(0, 16)}…</p></div><div className="header-actions"><CommitButton batchId={batch.id} disabled={!readyForCommit || batch.status === "COMMITTED"} committed={batch.status === "COMMITTED"} /><RollbackButton batchId={batch.id} disabled={batch.status === "ROLLED_BACK" || batch.status === "COMMITTED"} /></div></header>
    <section className="metric-grid">
      <Metric icon={<Rows3 size={18} />} label="暂存行" value={batch.totalRows} detail={`${batch.excludedRows} 行已隔离`} />
      <Metric icon={<CircleAlert size={18} />} label="异常" value={batch.errorRows} detail={`${batch.warningRows} 行警告`} tone={batch.errorRows ? "danger" : "good"} />
      <Metric icon={<Images size={18} />} label="图片锚点" value={batch.imageRefCount} detail={`${batch.uniqueMediaCount} 个独立媒体`} />
      <Metric icon={<CheckCircle2 size={18} />} label="提交状态" value={readyForCommit ? "可提交" : "已阻断"} detail={readyForCommit ? "全部门禁通过" : "需先处理ERROR"} tone={readyForCommit ? "good" : "danger"} />
    </section>
    <section className="content-section">
      <div className="section-heading"><div><h2>硬门禁对账</h2><p>数量对账通过不代表可以提交；ERROR 必须降为0。</p></div><span className="count-badge">{reconciliations.filter((item) => item.passed).length}/{reconciliations.length}</span></div>
      <div className="table-wrap"><table><thead><tr><th>指标</th><th>预期</th><th>实际</th><th>结果</th></tr></thead><tbody>{reconciliations.map((item) => <tr key={item.id}><td><code>{item.metric}</code></td><td>{item.expectedCount}</td><td>{item.actualCount}</td><td><span className={`result ${item.passed ? "success" : "danger"}`}>{item.passed ? "通过" : "失败"}</span></td></tr>)}</tbody></table></div>
    </section>
    <section className="content-section">
      <div className="section-heading"><div><h2>需要处理的记录</h2><p>只展示 ERROR 与 WARNING；被硬排除的库存尾部不会展示原值。</p></div><span className="count-badge">{exceptions.length} 项</span></div>
      {exceptions.length ? <div className="table-wrap"><table><thead><tr><th>工作表</th><th>行</th><th>类型</th><th>级别</th><th>问题</th></tr></thead><tbody>{exceptions.map((row) => <tr key={row.id}><td>{row.sheetName}</td><td>{row.sourceRow}</td><td>{row.recordType}</td><td><span className={`result ${row.status === "ERROR" ? "danger" : "warning"}`}>{row.status}</span></td><td>{row.issues.map((issue) => issue.message).join("；")}</td></tr>)}</tbody></table></div> : <div className="empty-state">没有需要处理的记录。</div>}
    </section>
  </AppShell>;
}

function Metric({ icon, label, value, detail, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string | number; detail: string; tone?: string }) {
  return <article className={`metric ${tone}`}><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>{icon}</article>;
}
