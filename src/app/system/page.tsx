import Link from "next/link";
import { BarChart3, FileClock, PackageOpen, RefreshCw, Settings } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";

export const dynamic = "force-dynamic";

const tools = [
  { href: "/analytics", title: "数据分析", description: "查看结构、时长、通关趋势和平台覆盖。", icon: BarChart3 },
  { href: "/sync", title: "数据同步", description: "管理 Steam、IGDB、发售目录和平台快照。", icon: RefreshCw },
  { href: "/imports", title: "导入批次", description: "查看迁移试跑、提交和回滚记录。", icon: PackageOpen },
  { href: "/audit", title: "操作记录", description: "追踪写操作、批量变更和失败结果。", icon: FileClock }
];

export default async function SystemPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  return <AppShell username={session.username} active="/system">
    <header className="page-header"><div><span className="eyebrow">SETTINGS</span><h1>设置</h1><p>同步、导入、分析和审计统一收纳为低频设置能力。</p></div><Settings size={22} /></header>
    <section className="system-tool-grid">{tools.map(({ href, title, description, icon: Icon }) => <Link href={href} key={href}><Icon size={19} /><span><strong>{title}</strong><small>{description}</small></span></Link>)}</section>
  </AppShell>;
}
