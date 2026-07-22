import { Search } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ItemTabs } from "@/components/item-tabs";
import { currentSession } from "@/server/auth/current";
import { inventoryQuerySchema, listInventory } from "@/server/services/inventory";

export const dynamic = "force-dynamic";

export default async function LegacyInventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const parsed = inventoryQuerySchema.parse({ q: Array.isArray(raw.q) ? raw.q[0] : raw.q ?? "", page: "1", pageSize: "100" });
  const result = await listInventory(session.userId, parsed);
  const items = result.items.map((item) => ({ ...item, deletedAt: item.deletedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() }));
  return <AppShell username={session.username} active="/inventory">
    <header className="page-header"><div><span className="eyebrow">LEGACY INVENTORY · READ ONLY</span><h1>旧版库存台账</h1><p>只读保留，用于回退核对；所有新增、拆封和报废操作均在货品卡片页完成。</p></div></header>
    <ItemTabs active="inventory" />
    <section className="filter-bar"><form className="filter-form" method="get"><label className="search-field"><Search size={15} /><input name="q" defaultValue={parsed.q} placeholder="搜索商品、品牌、颜色或位置" /></label><button className="secondary-button">搜索</button></form></section>
    <section className="content-section">
      <div className="section-heading"><div><h2>库存明细</h2><p>V0.22通过同一事务同步维护这份兼容台账。</p></div><span className="count-badge">{result.total} 项</span></div>
      {items.length ? <div className="table-wrap"><table><thead><tr><th>商品</th><th>颜色</th><th>未拆封</th><th>使用中</th><th>位置</th><th>版本</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.productName}</strong><small className="cell-note">{item.brand ?? "—"}</small></td><td>{item.color}</td><td>{item.unopenedQuantity}</td><td>{item.openedQuantity}</td><td>{item.currentLocation ?? "—"}</td><td>{item.version}</td></tr>)}</tbody></table></div> : <div className="empty-state">没有符合条件的库存记录。</div>}
    </section>
  </AppShell>;
}
