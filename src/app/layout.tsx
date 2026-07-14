import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "游戏与库存系统",
  description: "游戏进度、科技资产与消耗库存的自托管管理工具",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "游戏与库存", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
