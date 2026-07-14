import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { Search } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { db } from "@/server/db";
import { assets } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const q = String(Array.isArray(raw.q) ? raw.q[0] : raw.q ?? "").trim().slice(0, 100);
  const conditions = [eq(assets.ownerUserId, session.userId), isNull(assets.deletedAt)];
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    conditions.push(sql`(${assets.assetName} ILIKE ${pattern} ESCAPE '\\' OR ${assets.categoryLarge} ILIKE ${pattern} ESCAPE '\\' OR ${assets.categorySmall} ILIKE ${pattern} ESCAPE '\\')`);
  }
  const where = and(...conditions);
  const [records, [total]] = await Promise.all([
    db.select().from(assets).where(where).orderBy(asc(assets.categoryLarge), asc(assets.assetName)).limit(200),
    db.select({ value: count() }).from(assets).where(where)
  ]);
  return <AppShell username={session.username} active="/assets">
    <header className="page-header"><div><span className="eyebrow">ASSET REGISTER</span><h1>科技资产</h1><p>Phase 3 已进入正式业务表；图片文件将在 NAS 附件阶段接入。</p></div></header>
    <section className="filter-bar"><form className="filter-form" method="get"><label className="search-field"><Search size={15} /><input name="q" defaultValue={q} placeholder="搜索资产名称或分类" /></label><button className="secondary-button">搜索</button></form></section>
    <section className="content-section"><div className="section-heading"><div><h2>资产明细</h2><p>当前最多展示前 200 项。</p></div><span className="count-badge">{total.value} 项</span></div>{records.length ? <div className="table-wrap"><table><thead><tr><th>资产</th><th>分类</th><th>购入日期</th><th>渠道</th><th>购入/售出</th><th>状态</th></tr></thead><tbody>{records.map((asset) => <tr key={asset.id}><td><strong>{asset.assetName}</strong><small className="cell-note">{asset.parentNameSource ?? "—"}</small></td><td>{asset.categoryLarge ?? "—"}<small className="cell-note">{asset.categorySmall ?? "—"}</small></td><td>{asset.purchasedAt ?? "—"}</td><td>{asset.purchaseChannel ?? "—"}</td><td>{asset.purchasePrice ?? "—"}<small className="cell-note">售出 {asset.saleIncome ?? "—"}</small></td><td><span className="result neutral">{asset.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state">没有符合条件的资产。</div>}</section>
  </AppShell>;
}
