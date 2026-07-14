import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "游戏与库存系统",
    short_name: "游戏与库存",
    description: "自托管的游戏进度、资产与消耗库存管理工具",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f5f7",
    theme_color: "#17232d",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]
  };
}
