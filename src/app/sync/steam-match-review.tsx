"use client";

import { useMemo, useState } from "react";
import { Link2, Plus, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatShanghaiDateTime } from "@/lib/date-format";

type SteamItem = {
  steamAppId: number;
  name: string;
  playtimeMinutes: number;
  recentPlaytimeMinutes: number | null;
  lastPlayedAt: string | null;
  iconUrl: string | null;
  matchMethod: string;
};

type LocalGame = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  steamAppId: number | null;
};

async function api(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "操作失败");
  return payload.data;
}

function hours(minutes: number) {
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} 小时`;
}

export function SteamMatchReview({
  summary,
  items,
  localGames
}: {
  summary: { total: number; matched: number; unmatched: number; ignored: number };
  items: SteamItem[];
  localGames: LocalGame[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<SteamItem | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const candidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return localGames.filter((game) => {
      if (!normalized) return true;
      return [game.nameZh, game.nameEn, game.platform].some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalized));
    }).slice(0, 30);
  }, [localGames, query]);

  async function resolve(item: SteamItem, action: "MATCH" | "CREATE" | "IGNORE", gameId?: string) {
    if (action === "CREATE" && !window.confirm(`将“${item.name}”作为新游戏加入游戏库？`)) return;
    if (action === "IGNORE" && !window.confirm(`忽略“${item.name}”？下次同步仍会保留忽略状态。`)) return;
    setBusy(`${item.steamAppId}:${action}`);
    setMessage("");
    try {
      await api(`/api/v1/steam-library/${item.steamAppId}/resolve`, action === "MATCH" ? { action, gameId } : { action });
      setMessage(action === "MATCH" ? "Steam记录已关联到本地游戏。" : action === "CREATE" ? "已从Steam记录创建新游戏。" : "已忽略该Steam记录。");
      setSelected(null);
      setQuery("");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  if (summary.total === 0) return null;
  return <>
    <section className="content-section steam-review">
      <div className="section-heading">
        <div><h2>Steam 游戏记录匹配</h2><p>Steam时长与最近游玩时间只写入同步字段；本地手工字段保持优先。</p></div>
        <div className="steam-summary"><span className="result success">已匹配 {summary.matched}</span><span className="result warning">待处理 {summary.unmatched}</span><span className="result neutral">已忽略 {summary.ignored}</span></div>
      </div>
      {message ? <div className="inline-alert">{message}</div> : null}
      {items.length ? <div className="table-wrap"><table><thead><tr><th>Steam游戏</th><th>累计时长</th><th>最近游玩</th><th>未自动匹配原因</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.steamAppId}>
        <td><div className="steam-game-cell">{item.iconUrl ? <span className="steam-icon" aria-hidden="true" style={{ backgroundImage: `url(${item.iconUrl})` }} /> : <span className="cover-placeholder" />}<div><strong>{item.name}</strong><small>App ID {item.steamAppId}</small></div></div></td>
        <td>{hours(item.playtimeMinutes)}{item.recentPlaytimeMinutes ? <small className="cell-note">近两周 {hours(item.recentPlaytimeMinutes)}</small> : null}</td>
        <td>{item.lastPlayedAt ? formatShanghaiDateTime(item.lastPlayedAt) : "从未"}</td>
        <td><span className="result warning">{item.matchMethod === "AMBIGUOUS_EXACT_TITLE" ? "同名记录不唯一" : "没有唯一同名记录"}</span></td>
        <td><div className="steam-row-actions"><button className="secondary-button" disabled={busy !== null} onClick={() => { setSelected(item); setQuery(""); }}><Link2 size={14} />关联已有</button><button className="secondary-button" disabled={busy !== null} onClick={() => resolve(item, "CREATE")}><Plus size={14} />新建</button><button className="text-button" disabled={busy !== null} onClick={() => resolve(item, "IGNORE")}>忽略</button></div></td>
      </tr>)}</tbody></table></div> : <div className="empty-state">Steam游戏记录已经全部处理。</div>}
    </section>
    {selected ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setSelected(null); }}>
      <section className="modal-panel narrow" role="dialog" aria-modal="true" aria-labelledby="steam-match-title">
        <header><div><span className="eyebrow">MANUAL MATCH</span><h2 id="steam-match-title">关联“{selected.name}”</h2></div><button className="icon-button" aria-label="关闭" disabled={busy !== null} onClick={() => setSelected(null)}><X size={16} /></button></header>
        <div className="steam-match-body">
          <label className="search-field"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索中文名、英文名或平台" /></label>
          <div className="steam-candidate-list">{candidates.length ? candidates.map((game) => <button key={game.id} disabled={busy !== null} onClick={() => resolve(selected, "MATCH", game.id)}><span><strong>{game.nameZh}</strong><small>{[
            game.nameEn,
            game.platform,
            game.steamAppId !== null ? `主 App ${game.steamAppId} · 可追加关联` : null
          ].filter(Boolean).join(" · ") || "未设置平台"}</small></span><Link2 size={15} /></button>) : <div className="empty-state">没有可关联的本地游戏。</div>}</div>
        </div>
      </section>
    </div> : null}
  </>;
}
