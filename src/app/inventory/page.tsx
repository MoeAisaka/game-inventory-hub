import { Search } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { inventoryQuerySchema, listInventory } from "@/server/services/inventory";
import { InventoryManager } from "./inventory-manager";

export const dynamic = "force-dynamic";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const parsed = inventoryQuerySchema.parse({ q: Array.isArray(raw.q) ? raw.q[0] : raw.q ?? "", page: "1", pageSize: "100" });
  const result = await listInventory(session.userId, parsed);
  const items = result.items.map((item) => ({ ...item, deletedAt: item.deletedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() }));
  return <AppShell username={session.username} active="/inventory">
    <header className="page-header"><div><span className="eyebrow">INVENTORY LEDGER</span><h1>消耗库存</h1><p>数量只能通过流水变化；拆封在未拆封与已拆封之间等量转移。</p></div></header>
    <section className="filter-bar"><form className="filter-form" method="get"><label className="search-field"><Search size={15} /><input name="q" defaultValue={parsed.q} placeholder="搜索商品、品牌、颜色或位置" /></label><button className="secondary-button">搜索</button></form></section>
    <InventoryManager initialItems={items} total={result.total} />
  </AppShell>;
}
