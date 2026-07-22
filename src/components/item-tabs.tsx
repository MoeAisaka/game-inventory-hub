import Link from "next/link";
import { HardDrive, PackageOpen } from "lucide-react";

export function ItemTabs({ active }: { active: "inventory" | "assets" }) {
  return <nav className="section-tabs" aria-label="物品模块">
    <Link className={active === "inventory" ? "active" : ""} href="/inventory"><PackageOpen size={14} />消耗库存</Link>
    <Link className={active === "assets" ? "active" : ""} href="/assets"><HardDrive size={14} />数码设备</Link>
  </nav>;
}
