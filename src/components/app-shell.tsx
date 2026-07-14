import Link from "next/link";
import { CalendarRange, FileClock, Gamepad2, HardDrive, LayoutDashboard, PackageOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { LogoutButton } from "./logout-button";

const navigation = [
  { href: "/", label: "数据看板", icon: LayoutDashboard },
  { href: "/games", label: "游戏库", icon: Gamepad2 },
  { href: "/releases", label: "发售日历", icon: CalendarRange },
  { href: "/inventory", label: "库存", icon: PackageOpen },
  { href: "/assets", label: "资产", icon: HardDrive, mobileHidden: true },
  { href: "/sync", label: "数据同步", icon: RefreshCw },
  { href: "/imports", label: "导入批次", icon: PackageOpen, mobileHidden: true },
  { href: "/audit", label: "操作记录", icon: FileClock, mobileHidden: true }
];

export function AppShell({
  username,
  active,
  children
}: {
  username: string;
  active: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark"><Gamepad2 size={19} aria-hidden="true" /></div>
          <div><strong>游戏与库存</strong><span>在线管理服务</span></div>
        </div>
        <nav aria-label="主要导航">
          {navigation.map(({ href, label, icon: Icon, mobileHidden }) => (
            <Link className={`${active === href ? "nav-link active" : "nav-link"}${mobileHidden ? " mobile-hidden" : ""}`} href={href} key={href}>
              <Icon size={17} aria-hidden="true" />{label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="signed-user"><ShieldCheck size={16} /><span><small>当前账号</small>{username}</span></div>
          <LogoutButton />
        </div>
      </aside>
      <div className="mobile-topbar">
        <span><Gamepad2 size={17} /> 游戏与库存</span>
        <div><small>{username}</small><LogoutButton /></div>
      </div>
      <main className="main-content">{children}</main>
    </div>
  );
}
