"use client";

import { useState, type FormEvent } from "react";
import { Clock3, DatabaseZap, Gamepad2, RefreshCw, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatShanghaiDateTime } from "@/lib/date-format";

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function SyncControl({ steamAccount, steamReady, igdbReady, wishlistCount, platformCounts }: {
  steamAccount: { steamId: string; displayName: string | null; status: string; lastSyncedAt: string | null } | null;
  steamReady: boolean;
  igdbReady: boolean;
  wishlistCount: number;
  platformCounts: { playstation: number; nintendo: number };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function saveSteam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("steam-save"); setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/external-accounts/steam", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ steamId: String(form.get("steamId")), displayName: String(form.get("displayName") || "") || null }) });
      setMessage("Steam账号已保存。密钥仍只存在于服务端环境变量。"); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(null); }
  }

  async function sync(provider: "steam" | "steam-metadata" | "steam-wishlist" | "igdb" | "releases" | "hltb") {
    setBusy(provider); setMessage("");
    try {
      const result = await api(`/api/v1/sync/${provider}`, { method: "POST", headers: { "idempotency-key": `${provider}-${crypto.randomUUID()}` } });
      setMessage(provider === "steam"
        ? `Steam同步完成：拉取 ${result.processed ?? result.job?.processedCount ?? 0} 项，已匹配 ${result.matched ?? result.job?.updatedCount ?? 0} 项，待分类 ${result.unmatched ?? result.job?.skippedCount ?? 0} 项。请在下方匹配工作台查看真正需要决策的项目。`
        : provider === "steam-metadata"
          ? `Steam元数据本批处理 ${result.processed ?? 0} 项，更新 ${result.updated ?? 0} 项；${result.hasMore ? "仍有下一批。" : "当前已处理完毕。"}`
        : provider === "steam-wishlist"
          ? `Steam愿望单同步完成：读取 ${result.processed ?? 0} 项，更新 ${result.updated ?? 0} 项。`
        : provider === "igdb"
          ? `IGDB本批处理 ${result.processed ?? 0} 项；${result.hasMore ? "仍有下一批。" : "当前批次已完成。"}`
        : provider === "releases"
          ? `公共发售目录同步完成：读取 ${result.processed ?? 0} 条平台发行记录，新增 ${result.created ?? 0} 条；本批补齐 ${result.localizedProcessed ?? 0} 款中英文平台资料。`
          : `HowLongToBeat本批处理 ${result.processed ?? 0} 项，安全匹配 ${result.updated ?? 0} 项；${result.hasMore ? "仍有下一批。" : "当前批次已完成。"}`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "同步失败"); }
    finally { setBusy(null); }
  }

  return <>
    {message ? <div className="inline-alert">{message}</div> : null}
    <section className="integration-grid">
      <article className="integration-panel"><header><span className="tool-icon"><Gamepad2 size={19} /></span><div><h2>Steam</h2><p>游戏库、愿望单、家庭共享与商店元数据</p></div><span className={`result ${steamReady ? "success" : "warning"}`}>{steamReady ? `愿望单 ${wishlistCount} 项` : "待配置密钥"}</span></header><form onSubmit={saveSteam}><label>SteamID64<input name="steamId" required pattern="\d{17}" defaultValue={steamAccount?.steamId ?? ""} placeholder="17位数字" /></label><label>显示名称<input name="displayName" defaultValue={steamAccount?.displayName ?? ""} /></label><div className="panel-actions"><button className="secondary-button" disabled={busy !== null}>{busy === "steam-save" ? "保存中…" : "保存账号"}</button><button type="button" className="primary-button" disabled={!steamReady || !steamAccount || busy !== null} onClick={() => sync("steam")}><RefreshCw size={15} className={busy === "steam" ? "spin" : ""} /> 同步游戏库</button><button type="button" className="secondary-button" disabled={!steamReady || !steamAccount || busy !== null} onClick={() => sync("steam-wishlist")}><RefreshCw size={15} className={busy === "steam-wishlist" ? "spin" : ""} /> 同步愿望单</button><button type="button" className="secondary-button" disabled={!steamAccount || busy !== null} onClick={() => sync("steam-metadata")}><RefreshCw size={15} className={busy === "steam-metadata" ? "spin" : ""} /> 补齐元数据</button></div></form><p className="integration-copy">自购游戏使用官方 GetOwnedGames，并包含未完成商店特性审核的 App；家庭共享由本机 Sidecar 发送标准化快照，短期 access token 不进入 NAS，且不会把共享访问权记成已购买。</p>{steamAccount ? <small>状态 {steamAccount.status} · 最近同步 {steamAccount.lastSyncedAt ? formatShanghaiDateTime(steamAccount.lastSyncedAt) : "从未"}</small> : null}</article>
      <article className="integration-panel"><header><span className="tool-icon"><DatabaseZap size={19} /></span><div><h2>平台发售目录</h2><p>IGDB 发售身份 + 平台中英文商店资料</p></div><span className={`result ${igdbReady ? "success" : "warning"}`}>{igdbReady ? "每 6 小时检查" : "待配置凭证"}</span></header><p className="integration-copy">覆盖未来两年的 PC、PlayStation、Switch 与 Switch 2；同步分批补齐中英文名称、双语简介、封面、厂商、类型与商店身份，不完整记录不会开放一键加入。</p><div className="panel-actions"><button className="primary-button" disabled={!igdbReady || busy !== null} onClick={() => sync("releases")}><RefreshCw size={15} className={busy === "releases" ? "spin" : ""} /> 刷新并补齐目录</button><button className="secondary-button" disabled={!igdbReady || busy !== null} onClick={() => sync("igdb")}><RefreshCw size={15} className={busy === "igdb" ? "spin" : ""} /> 补齐正式游戏元数据</button></div></article>
      <article className="integration-panel"><header><span className="tool-icon"><Clock3 size={19} /></span><div><h2>HowLongToBeat</h2><p>主线、主线+支线与全收集时长</p></div><span className="result success">无需凭证</span></header><p className="integration-copy">使用非官方只读接口，每批仅处理 6 款；只有标题唯一精确匹配且年份不冲突时才写入，歧义项跳过，手工锁定时长不会被覆盖。</p><div className="panel-actions"><button className="primary-button" disabled={busy !== null} onClick={() => sync("hltb")}><RefreshCw size={15} className={busy === "hltb" ? "spin" : ""} /> 补齐下一批</button></div></article>
      <article className="integration-panel"><header><span className="tool-icon"><ShieldAlert size={19} /></span><div><h2>PlayStation</h2><p>游戏库、游玩时间与奖杯快照</p></div><span className="result warning">愿望单不可用</span></header><p className="integration-copy">现有快照 {platformCounts.playstation} 项。当前适配器没有稳定的账号愿望单接口；不注入浏览器会话、不抓取私有网页，避免登录态和账号风险。</p></article>
      <article className="integration-panel"><header><span className="tool-icon"><Gamepad2 size={19} /></span><div><h2>Nintendo</h2><p>NSO游玩活动快照</p></div><span className="result warning">愿望单不可用</span></header><p className="integration-copy">现有快照 {platformCounts.nintendo} 项。NSO授权范围不提供稳定愿望单读取能力；继续保持安全关闭，不要求重新授权，也不使用账号密码或Cookie抓取。</p></article>
    </section>
  </>;
}
