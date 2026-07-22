import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { inventoryV2QuerySchema, listInventoryProducts } from "@/server/services/inventory-v2";
import { InventoryCollection } from "./inventory-collection";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const result = await listInventoryProducts(session.userId, inventoryV2QuerySchema.parse({ q: "", filter: "all" }));
  const products = result.products.map((product) => ({
    ...product,
    deletedAt: product.deletedAt?.toISOString() ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    variants: product.variants.map((variant) => ({
      ...variant,
      createdAt: variant.createdAt.toISOString(),
      updatedAt: variant.updatedAt.toISOString()
    }))
  }));
  return (
    <AppShell username={session.username} active="/inventory">
      <InventoryCollection initialProducts={products} initialOverview={result.overview} />
    </AppShell>
  );
}
