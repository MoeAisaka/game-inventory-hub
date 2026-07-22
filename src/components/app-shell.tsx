import Link from "next/link";
import { Gamepad2, Heart, Home, Images, PackageOpen, Settings, ShieldCheck } from "lucide-react";
import { LogoutButton } from "./logout-button";

const navigation = [
  { href: "/", label: "今日", icon: Home, activePaths: ["/", "/play"] },
  { href: "/games", label: "游戏库", icon: Gamepad2, activePaths: ["/games"] },
  { href: "/wishlist", label: "心愿单", icon: Heart, activePaths: ["/wishlist", "/releases"] },
  { href: "/media", label: "媒体", icon: Images, activePaths: ["/media"] },
  { href: "/inventory", label: "库存", icon: PackageOpen, activePaths: ["/inventory", "/assets"] },
  { href: "/system", label: "设置", icon: Settings, activePaths: ["/system", "/analytics", "/sync", "/imports", "/audit"] }
];

function NavLinks({ active }: { active: string }) {
  return <>
    {navigation.map(({ href, label, icon: Icon, activePaths }) => (
      <Link className={activePaths.includes(active) ? "nav-link active" : "nav-link"} href={href} key={href}>
        <Icon size={15} aria-hidden="true" /><span>{label}</span>
      </Link>
    ))}
  </>;
}

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
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="site-brand" href="/" aria-label="游戏与库存首页">
            <span className="site-brand-mark"><Gamepad2 size={17} aria-hidden="true" /></span>
            <span><strong>游戏与库存</strong><small>Collection</small></span>
          </Link>
          <nav className="site-nav" aria-label="主要导航">
            <NavLinks active={active} />
          </nav>
          <div className="site-account">
            <div className="signed-user"><ShieldCheck size={15} /><span><small>当前账号</small>{username}</span></div>
            <LogoutButton />
          </div>
        </div>
      </header>
      {/* 移动端底部标签栏：位于 header（backdrop-filter 会拦截 fixed 定位）之外，≤768px 显示 */}
      <nav className="site-tabbar" aria-label="移动端主要导航">
        <NavLinks active={active} />
      </nav>
      <main className="main-content">{children}</main>
    </div>
  );
}
