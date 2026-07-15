"use client";

import { useState, type FormEvent } from "react";
import { CalendarDays, Clock3, ListOrdered, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { GameCover } from "@/components/game-cover";
import {
  activityStateLabels,
  purchaseStateLabels,
  type ActivityState,
  type PurchaseState
} from "@/lib/game-insights";
import { gameStatusLabels, gameStatusValues, type GameStatus } from "@/lib/game-status";

type RatingSource = "MANUAL" | "STEAM" | "IGDB" | "RAWG" | "METACRITIC" | "IGN" | "XIAOHEIHE";

type GameView = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  nameEnSource: string;
  notes: string | null;
  platform: string | null;
  mediaType: string | null;
  ownershipStatus: string | null;
  queueOrder: number | null;
  repeatable: boolean;
  releaseDate: string | null;
  releaseDateSource: string;
  communityRating: number | null;
  communityRatingCount: number | null;
  criticRating: number | null;
  criticRatingCount: number | null;
  ratingSource: RatingSource | null;
  statuses: GameStatus[];
  playStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number | null;
  playtimeMinutesManual: number | null;
  playtimeMinutesSynced: number;
  totalPlaytimeMinutes: number;
  firstObservedPlayedAt: string | null;
  playtimeLastChangedAt: string | null;
  lastPlayedAt: string | null;
  acquisitionSources: string[];
  purchaseState: PurchaseState;
  activityState: ActivityState;
  estimatedNormallyMinutes: number | null;
  coverUrl: string | null;
  version: number;
  updatedAt: string;
  [key: string]: unknown;
};

const platformLabels: Record<string, string> = { STEAM: "Steam", PLAYSTATION: "PlayStation", NINTENDO_SWITCH: "Switch", NINTENDO_SWITCH_2: "Switch 2", XBOX_GAME_PASS: "XGP", PC_OTHER: "PC", IOS: "iOS" };
const sourceLabels: Record<string, string> = {
  MANUAL: "手工维护",
  IMPORT: "原表导入",
  STEAM: "Steam",
  IGDB: "IGDB",
  RAWG: "RAWG",
  HLTB: "HowLongToBeat",
  WIKIDATA: "Wikidata",
  STEAMGRIDDB: "SteamGridDB",
  PLAYSTATION: "PlayStation",
  NINTENDO: "Nintendo",
  METACRITIC: "Metacritic",
  IGN: "IGN",
  XIAOHEIHE: "小黑盒"
};

function hours(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return "—";
  return `${Math.round(minutes / 6) / 10}h`;
}

function score(value: number | null) {
  return value === null ? null : Number(value.toFixed(1));
}

function optionalNumber(form: FormData, field: string) {
  const raw = String(form.get(field) ?? "");
  return raw === "" ? null : Number(raw);
}

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function GameManager({ initialGames, total }: { initialGames: GameView[]; total: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState<GameView | "new" | null>(null);
  const [formStatuses, setFormStatuses] = useState<GameStatus[]>(["BACKLOG"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [minutes, setMinutes] = useState("");

  function openEditor(game: GameView | "new") {
    setEditing(game);
    setFormStatuses(game === "new" ? ["BACKLOG"] : game.statuses ?? (game.playStatus ? [game.playStatus as GameStatus] : []));
    setMessage("");
  }

  function toggleStatus(status: GameStatus) {
    setFormStatuses((current) => current.includes(status)
      ? current.filter((value) => value !== status)
      : gameStatusValues.filter((value) => current.includes(value) || value === status));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const communityRating = optionalNumber(form, "communityRating");
    const criticRating = optionalNumber(form, "criticRating");
    const payload = {
      nameZh: String(form.get("nameZh") || ""),
      nameEn: String(form.get("nameEn") || "").trim() || null,
      notes: String(form.get("notes") || "").trim() || null,
      platform: String(form.get("platform") || "").trim() || null,
      statuses: formStatuses,
      queueOrder: formStatuses.includes("BACKLOG") ? optionalNumber(form, "queueOrder") : null,
      releaseDate: String(form.get("releaseDate") || "") || null,
      communityRating,
      criticRating,
      ratingSource: communityRating === null && criticRating === null
        ? null
        : String(form.get("ratingSource") || "MANUAL"),
      startedAt: String(form.get("startedAt") || "") || null,
      completedAt: String(form.get("completedAt") || "") || null,
      progressPercent: optionalNumber(form, "progressPercent"),
      playtimeMinutesManual: form.get("playtimeHours") === "" ? null : Math.round(Number(form.get("playtimeHours")) * 60),
      manualOwned: form.get("manualOwned") === "on"
    };
    try {
      if (editing === "new") await api("/api/v1/games", { method: "POST", body: JSON.stringify(payload) });
      else if (editing) await api(`/api/v1/games/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...payload, version: editing.version }) });
      setEditing(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function remove(game: GameView) {
    if (!window.confirm(`确认删除《${game.nameZh}》？可通过API恢复。`)) return;
    setBusy(true);
    try { await api(`/api/v1/games/${game.id}`, { method: "DELETE" }); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  }

  async function addTime(game: GameView) {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value <= 0) { setMessage("请输入正整数分钟数"); return; }
    setBusy(true);
    try {
      await api(`/api/v1/games/${game.id}/play-sessions`, { method: "POST", body: JSON.stringify({ minutes: value, startedAt: new Date().toISOString() }) });
      setMinutes(""); setEditing(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "记录失败"); }
    finally { setBusy(false); }
  }

  return <>
    <section className="content-section game-list-section">
      <div className="section-heading"><div><h2>游戏记录</h2><p>待玩队列按序号排序；评分、发售日与英文名均保留来源。</p></div><div className="heading-actions"><span className="count-badge">{total} 项</span><button className="primary-button compact" type="button" onClick={() => openEditor("new")}><Plus size={15} /> 添加游戏</button></div></div>
      {message ? <div className="inline-alert error">{message}</div> : null}
      {initialGames.length ? <div className="table-wrap"><table className="game-table"><thead><tr><th>游戏信息</th><th>状态</th><th>发售与评分</th><th>待玩队列</th><th>进度与时长</th><th>操作</th></tr></thead><tbody>
        {initialGames.map((game) => <tr key={game.id}>
          <td><div className="game-title-cell"><GameCover src={game.coverUrl} /><div><strong>{game.nameZh}</strong><small className={game.nameEn ? "" : "missing-field"}>{game.nameEn ?? "英文名待补全"}</small><span className="game-meta-line">{platformLabels[game.platform ?? ""] ?? game.platform ?? "未设置平台"}</span></div></div></td>
          <td><div className="status-chip-list">{game.statuses.length ? game.statuses.map((status) => <span key={status} className={`status-chip status-${status.toLowerCase()}`}>{gameStatusLabels[status]}</span>) : <span className="status-chip status-unset">未设置</span>}<span className={`status-chip activity-${game.activityState.toLowerCase()}`}>{activityStateLabels[game.activityState]}</span><span className={`status-chip purchase-${game.purchaseState.toLowerCase()}`}>{purchaseStateLabels[game.purchaseState]}</span></div><small className="cell-note">开始：{game.startedAt ?? game.firstObservedPlayedAt?.slice(0, 10) ?? "待记录"} · 最后：{game.lastPlayedAt?.slice(0, 10) ?? "—"}</small>{game.activityState === "COMPLETION_CANDIDATE" ? <small className="cell-note">超过 48 小时未增加时长，仅标记为待确认，不覆盖人工通关状态。</small> : null}</td>
          <td><div className="release-rating-cell"><span><CalendarDays size={13} /><strong>{game.releaseDate ?? "发售日待补全"}</strong><small>{sourceLabels[game.releaseDateSource] ?? game.releaseDateSource}</small></span><div className="rating-row">{game.communityRating !== null ? <em><Star size={11} />玩家 {score(game.communityRating)}</em> : null}{game.criticRating !== null ? <em>媒体 {score(game.criticRating)}</em> : null}{game.ratingSource ? <span className="rating-source">{sourceLabels[game.ratingSource] ?? game.ratingSource}</span> : null}{game.communityRating === null && game.criticRating === null ? <small>评分待补全</small> : null}</div></div></td>
          <td>{game.statuses.includes("BACKLOG") ? <div className={game.queueOrder ? "queue-position" : "queue-position empty"}><ListOrdered size={14} /><strong>{game.queueOrder ? `#${game.queueOrder}` : "未排队"}</strong></div> : <span className="cell-muted">—</span>}</td>
          <td><div className="progress-time-cell"><div><strong>{game.progressPercent === null ? "—" : `${game.progressPercent}%`}</strong><span className="progress-track"><i style={{ width: `${game.progressPercent ?? 0}%` }} /></span></div><small>已玩 {hours(game.totalPlaytimeMinutes)} · 主线预估 {hours(game.estimatedNormallyMinutes)}</small><small>{game.acquisitionSources.length ? `入库：${game.acquisitionSources.map((source) => sourceLabels[source] ?? source).join("、")}` : "尚无入库记录"}</small></div></td>
          <td><div className="row-actions"><button aria-label="编辑" onClick={() => openEditor(game)}><Pencil size={14} /></button><button aria-label="删除" disabled={busy} onClick={() => remove(game)}><Trash2 size={14} /></button></div></td>
        </tr>)}
      </tbody></table></div> : <div className="empty-state">没有符合条件的游戏。可清除筛选或添加新记录。</div>}
    </section>
    {editing ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
      <div className="modal-panel game-form-modal" role="dialog" aria-modal="true" aria-labelledby="game-form-title">
        <header><div><span className="eyebrow">{editing === "new" ? "NEW GAME" : "EDIT GAME"}</span><h2 id="game-form-title">{editing === "new" ? "添加游戏" : editing.nameZh}</h2><p>字段按信息、评价、游玩和备注分组；自动数据可以手工覆盖。</p></div><button className="icon-button" onClick={() => setEditing(null)} aria-label="关闭"><X size={18} /></button></header>
        <form onSubmit={save}>
          <fieldset className="game-form-section">
            <legend>基本信息</legend><p>用于搜索和识别；英文名缺失时可由 Steam 或 IGDB 安全补全。</p>
            <div className="form-grid">
              <label className="span-2">中文名称<input name="nameZh" required maxLength={200} defaultValue={editing === "new" ? "" : editing.nameZh} /></label>
              <label className="span-2">英文名称<input name="nameEn" maxLength={200} placeholder="例如 Persona 5 Royal" defaultValue={editing === "new" ? "" : editing.nameEn ?? ""} /></label>
              <label>平台<select name="platform" defaultValue={editing === "new" ? "" : editing.platform ?? ""}><option value="">未设置</option><option value="STEAM">Steam</option><option value="PLAYSTATION">PlayStation</option><option value="NINTENDO_SWITCH">Switch</option><option value="NINTENDO_SWITCH_2">Switch 2</option><option value="XBOX_GAME_PASS">XGP</option><option value="PC_OTHER">PC</option><option value="IOS">iOS</option></select></label>
              <label>发售日期<input type="date" name="releaseDate" defaultValue={editing === "new" ? "" : editing.releaseDate ?? ""} /></label>
            </div>
          </fieldset>
          <fieldset className="game-form-section">
            <legend>评分信息</legend><p>统一采用 0–100 分；IGDB 自动同步社区与媒体评分，手工值不会被覆盖。</p>
            <div className="form-grid three-columns">
              <label>玩家评分<input type="number" name="communityRating" min="0" max="100" step="0.1" placeholder="0–100" defaultValue={editing === "new" ? "" : editing.communityRating ?? ""} /></label>
              <label>媒体评分<input type="number" name="criticRating" min="0" max="100" step="0.1" placeholder="0–100" defaultValue={editing === "new" ? "" : editing.criticRating ?? ""} /></label>
              <label>评分来源<select name="ratingSource" defaultValue={editing === "new" ? "MANUAL" : editing.ratingSource ?? "MANUAL"}><option value="MANUAL">手工</option><option value="STEAM">Steam</option><option value="IGDB">IGDB</option><option value="RAWG">RAWG</option><option value="METACRITIC">Metacritic</option><option value="IGN">IGN</option><option value="XIAOHEIHE">小黑盒</option></select></label>
            </div>
            {editing !== "new" && (editing.communityRatingCount || editing.criticRatingCount) ? <small className="source-detail">样本量：玩家 {editing.communityRatingCount ?? "—"} · 媒体 {editing.criticRatingCount ?? "—"}</small> : null}
          </fieldset>
          <fieldset className="game-form-section">
            <legend>状态、游玩与待玩队列</legend><p>状态可多选，例如“待发售 + 待购入”；筛选时满足任一所选状态即可。待玩序号仅在选择“待玩”后生效。</p>
            <div className="status-multiselect" role="group" aria-label="游戏状态">
              {gameStatusValues.map((status) => <label key={status} className={formStatuses.includes(status) ? "selected" : ""}>
                <input type="checkbox" checked={formStatuses.includes(status)} onChange={() => toggleStatus(status)} />
                <span>{gameStatusLabels[status]}</span>
              </label>)}
            </div>
            <div className="form-grid">
              <label className="span-2 checkbox-field"><input type="checkbox" name="manualOwned" defaultChecked={editing !== "new" && editing.acquisitionSources.includes("MANUAL")} /><span><strong>已建立手工入库记录</strong><small>勾选后计为已购入；Steam、PlayStation 等平台入库记录不受此开关影响。</small></span></label>
              <label>待玩顺序<input type="number" name="queueOrder" min="1" max="9999" disabled={!formStatuses.includes("BACKLOG")} placeholder={formStatuses.includes("BACKLOG") ? "例如 10" : "选择“待玩”后可用"} defaultValue={editing === "new" ? "" : editing.queueOrder ?? ""} /></label>
              <label>进度（%）<input type="number" name="progressPercent" min="0" max="100" defaultValue={editing === "new" ? "" : editing.progressPercent ?? ""} /></label>
              <label>手工累计游玩（小时）<input type="number" name="playtimeHours" min="0" step="0.1" defaultValue={editing === "new" ? "" : editing.playtimeMinutesManual === null ? "" : gameHours(editing.playtimeMinutesManual)} /></label>
              <label>开始日期<input type="date" name="startedAt" defaultValue={editing === "new" ? "" : editing.startedAt ?? ""} /></label>
              <label>完成日期<input type="date" name="completedAt" defaultValue={editing === "new" ? "" : editing.completedAt ?? ""} /></label>
            </div>
          </fieldset>
          <fieldset className="game-form-section compact-section">
            <legend>备注</legend><div className="form-grid"><label className="span-2">补充说明<textarea name="notes" rows={4} maxLength={5000} defaultValue={editing === "new" ? "" : editing.notes ?? ""} /></label></div>
          </fieldset>
          {message ? <div className="inline-alert error">{message}</div> : null}
          <footer><button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存"}</button></footer>
        </form>
        {editing !== "new" ? <div className="quick-time"><div><Clock3 size={16} /><span><strong>追加游玩时间</strong><small>保留独立游玩记录并更新手工累计值。</small></span></div><div><input value={minutes} onChange={(event) => setMinutes(event.target.value)} type="number" min="1" max="1440" placeholder="分钟" /><button className="secondary-button" disabled={busy} onClick={() => addTime(editing)}>记录</button></div></div> : null}
      </div>
    </div> : null}
  </>;
}

function gameHours(minutes: number) { return Math.round(minutes / 6) / 10; }
