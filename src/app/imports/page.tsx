import { desc } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { db } from "@/server/db";
import { importBatches } from "@/server/db/schema";
import { ImportMetadataForm } from "./import-metadata-form";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const batches = await db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(50);
  return (
    <AppShell username={session.username} active="/imports">
      <header className="page-header"><div><span className="eyebrow">IMPORT STAGING</span><h1>导入批次</h1><p>源文件只读解析，全部记录先进入暂存区；存在ERROR时禁止提交。</p></div></header>
      <ImportMetadataForm />
      <section className="content-section">
        <div className="section-heading"><div><h2>批次记录</h2><p>同一文件重复登记将返回原批次，不生成重复记录。</p></div><span className="count-badge">{batches.length} 项</span></div>
        {batches.length ? <div className="table-wrap"><table><thead><tr><th>创建时间</th><th>源文件</th><th>状态</th><th>成功/警告/错误/排除</th><th>图片</th><th>操作</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.id}><td>{batch.createdAt.toLocaleString("zh-CN")}</td><td>{batch.sourceName}<br /><code title={batch.sourceChecksum}>{batch.sourceChecksum.slice(0, 12)}…</code></td><td><span className={`result ${batch.errorRows ? "danger" : "neutral"}`}>{batch.status}</span></td><td>{batch.successRows} / {batch.warningRows} / {batch.errorRows} / {batch.excludedRows}</td><td>{batch.imageRefCount}</td><td><Link className="text-link" href={`/imports/${batch.id}`}>查看报告</Link></td></tr>)}</tbody></table></div> : <div className="empty-state">尚未登记导入批次。选择一个文件即可验证幂等链路。</div>}
      </section>
    </AppShell>
  );
}
