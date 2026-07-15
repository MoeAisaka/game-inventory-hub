"use client";

import { useState, type FormEvent } from "react";
import { DatabaseZap, Gamepad2, RefreshCw, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatShanghaiDateTime } from "@/lib/date-format";

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function SyncControl({ steamAccount, steamReady, igdbReady, platformCounts }: {
  steamAccount: { steamId: string; displayName: string | null; status: string; lastSyncedAt: string | null } | null;
  steamReady: boolean;
  igdbReady: boolean;
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

  async function sync(provider: "steam" | "steam-metadata" | "igdb") {
    setBusy(provider); setMessage("");
    try {
      const result = await api(`/api/v1/sync/${provider}`, { method: "POST", headers: { "idempotency-key": `${provider}-${crypto.randomUUID()}` } });
      setMessage(provider === "steam"
        ? `Steam同步完成：拉取 ${result.processed ?? result.job?.processedCount ?? 0} 项，已匹配 ${result.matched ?? result.job?.updatedCount ?? 0} 项，待确认 ${result.unmatched ?? result.job?.skippedCount ?? 0} 项。`
        : provider === "steam-metadata"
          ? `Steam元数据本批处理 ${result.processed ?? 0} 项，更新 ${result.updated ?? 0} 项；${result.hasMore ? "仍有下一批。" : "当前已处理完毕。"}`
        : `IGDB本批处理 ${result.processed ?? 0} 项；${result.hasMore ? "仍有下一批。" : "当前批次已完成。"}`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "同步失败"); }
    finally { setBusy(null); }
  }

  return <>
    {message ? <div className="inline-alert">{message}</div> : null}
    <section className="integration-grid">
      <article className="integration-panel"><header><span className="tool-icon"><Gamepad2 size={19} /></span><div><h2>Steam</h2><p>游戏库、游玩时间、封面、名称、发售日与评分</p></div><span className={`result ${steamReady ? "success" : "warning"}`}>{steamReady ? "密钥已配置" : "待配置密钥"}</span></header><form onSubmit={saveSteam}><label>SteamID64<input name="steamId" required pattern="\d{17}" defaultValue={steamAccount?.steamId ?? ""} placeholder="17位数字" /></label><label>显示名称<input name="displayName" defaultValue={steamAccount?.displayName ?? ""} /></label><div className="panel-actions"><button className="secondary-button" disabled={busy !== null}>{busy === "steam-save" ? "保存中…" : "保存账号"}</button><button type="button" className="primary-button" disabled={!steamReady || !steamAccount || busy !== null} onClick={() => sync("steam")}><RefreshCw size={15} className={busy === "steam" ? "spin" : ""} /> 同步游戏库</button><button type="button" className="secondary-button" disabled={!steamAccount || busy !== null} onClick={() => sync("steam-metadata")}><RefreshCw size={15} className={busy === "steam-metadata" ? "spin" : ""} /> 补齐元数据</button></div></form><p className="integration-copy">游戏库同步建立入库记录与游玩快照；元数据同步每批处理 8 款，候选值保留来源，手工锁定字段不会被覆盖。</p>{steamAccount ? <small>状态 {steamAccount.status} · 最近同步 {steamAccount.lastSyncedAt ? formatShanghaiDateTime(steamAccount.lastSyncedAt) : "从未"}</small> : null}</article>
      <article className="integration-panel"><header><span className="tool-icon"><DatabaseZap size={19} /></span><div><h2>IGDB</h2><p>发售日、封面与预计通关时长</p></div><span className={`result ${igdbReady ? "success" : "warning"}`}>{igdbReady ? "凭证已配置" : "待配置凭证"}</span></header><p className="integration-copy">每次处理 20 个待匹配游戏；仅唯一精确匹配自动写入，歧义项跳过。手工发售日期不会被覆盖。</p><div className="panel-actions"><button className="primary-button" disabled={!igdbReady || busy !== null} onClick={() => sync("igdb")}><RefreshCw size={15} className={busy === "igdb" ? "spin" : ""} /> 拉取下一批</button></div></article>
      <article className="integration-panel"><header><span className="tool-icon"><ShieldAlert size={19} /></span><div><h2>PlayStation</h2><p>游戏库、游玩时间与奖杯快照</p></div><span className="result warning">适配器待授权</span></header><p className="integration-copy">主系统的只读快照入口已就绪，现有快照 {platformCounts.playstation} 项。后续使用隔离 Sidecar 换取短期令牌；NPSSO 不写数据库、不进入浏览器日志，首次同步只生成预览。</p></article>
      <article className="integration-panel"><header><span className="tool-icon"><Gamepad2 size={19} /></span><div><h2>Nintendo</h2><p>游玩活动与家长控制快照</p></div><span className="result warning">适配器待评估</span></header><p className="integration-copy">标准化只读快照入口已就绪，现有快照 {platformCounts.nintendo} 项。Nintendo 暂无稳定的完整购买库接口；AGPL 逆向客户端只允许作为隔离 Sidecar，不复制进主系统。</p></article>
    </section>
  </>;
}
