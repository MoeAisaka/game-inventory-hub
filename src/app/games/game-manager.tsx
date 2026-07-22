"use client";

import { useState, type FormEvent } from "react";
import { Ban, CalendarDays, CheckSquare2, Clock3, Heart, Layers3, Pencil, Play, Plus, Star, Trash2, Trophy, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { GameCover } from "@/components/game-cover";
import { gameRatingConstraints } from "@/lib/game-rating";
import {
  activityStateLabels,
  completionControl,
  displayStatuses,
  isWishlisted,
  purchaseStateLabels,
  visibleActivityState,
  type ActivityState,
  type PurchaseState
} from "@/lib/game-state-engine";
import { gameGenreLabels, gameGenreValues, type GameGenre } from "@/lib/game-genres";
import {
  dualsenseDimensions,
  dualsenseEnvironmentHints,
  dualsenseEnvironmentLabels,
  dualsenseEnvironmentValues,
  dualsenseFeatureLevelLabels,
  dualsenseFeatureLevelValues,
  dualsenseProfileMatrix,
  rayTracingLevelLabels,
  rayTracingLevelValues,
  rayTracingProfileFromGame,
  type DualsenseProfile,
  type DualsenseFeatureLevel,
  type RayTracingLevel
} from "@/lib/game-hardware";
import { advisePurchase, type HardwareProfile, type PurchaseAdvice } from "@/lib/purchase-advisor";
import { gameStatusLabels, gameStatusValues, type GameStatus } from "@/lib/game-status";

type RatingSource = "MANUAL" | "STEAM" | "IGDB" | "RAWG" | "METACRITIC" | "IGN" | "XIAOHEIHE";

type GameView = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  searchAliases: string[];
  nameEnSource: string;
  notes: string | null;
  platform: string | null;
  mediaType: string | null;
  ownershipStatus: string | null;
  primaryGenre: GameGenre | null;
  subGenres: GameGenre[];
  genreSource: string | null;
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
  zeroCostChannels: string[];
  dualsenseAdaptiveTriggers: DualsenseFeatureLevel;
  dualsenseHapticFeedback: DualsenseFeatureLevel;
  dualsenseControllerSpeaker: DualsenseFeatureLevel;
  dualsenseTouchpad: DualsenseFeatureLevel;
  dualsenseControllerMic: DualsenseFeatureLevel;
  dualsenseNotes: string | null;
  pcWiredRequired: "TRUE" | "FALSE" | "UNKNOWN";
  dualsenseProfiles: DualsenseProfile[];
  rayTracing: RayTracingLevel;
  rayTracingNotes: string | null;
  hardwareProfileSource: string | null;
  purchaseState: PurchaseState;
  activityState: ActivityState;
  wishlistEligible: boolean;
  estimatedNormallyMinutes: number | null;
  estimatedHastilyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
  estimateSource: string | null;
  coverUrl: string | null;
  version: number;
  updatedAt: string;
  [key: string]: unknown;
};

type SelectionQuery = {
  q: string;
  status: GameStatus[];
  platform: string[];
  genre: GameGenre[];
  sort: "updated_desc" | "name_asc" | "release_asc" | "queue_asc";
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
  WEB: "网页核验",
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

const hardwareFieldDefaults = {
  rayTracing: "UNKNOWN",
  rayTracingNotes: null
} as const;

type HardwareFieldKey = keyof typeof hardwareFieldDefaults;

/** 只提交真正变化的硬件档案字段，避免普通保存误触发 DUALSENSE_PROFILE / RAY_TRACING_PROFILE 字段锁。 */
function changedHardwareFields(form: FormData, editing: GameView | "new") {
  const profiles = dualsenseEnvironmentValues.map((environment): DualsenseProfile => ({
    environment,
    adaptiveTriggers: String(form.get(`dualsense.${environment}.adaptiveTriggers`) || "UNKNOWN") as DualsenseFeatureLevel,
    hapticFeedback: String(form.get(`dualsense.${environment}.hapticFeedback`) || "UNKNOWN") as DualsenseFeatureLevel,
    controllerSpeaker: String(form.get(`dualsense.${environment}.controllerSpeaker`) || "UNKNOWN") as DualsenseFeatureLevel,
    touchpad: String(form.get(`dualsense.${environment}.touchpad`) || "UNKNOWN") as DualsenseFeatureLevel,
    controllerMic: String(form.get(`dualsense.${environment}.controllerMic`) || "UNKNOWN") as DualsenseFeatureLevel,
    notes: String(form.get(`dualsense.${environment}.notes`) || "").trim() || null
  }));
  const next: Record<HardwareFieldKey, string | null> = {
    rayTracing: String(form.get("rayTracing") || "UNKNOWN"),
    rayTracingNotes: String(form.get("rayTracingNotes") || "").trim() || null
  };
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(next) as HardwareFieldKey[]) {
    const current = editing === "new" ? hardwareFieldDefaults[key] : editing[key];
    if (next[key] !== (current ?? null)) changed[key] = next[key];
  }
  const currentProfiles = editing === "new"
    ? dualsenseEnvironmentValues.map((environment) => dualsenseProfileMatrix([])[environment])
    : dualsenseEnvironmentValues.map((environment) => dualsenseProfileMatrix(editing.dualsenseProfiles, editing)[environment]);
  if (JSON.stringify(profiles) !== JSON.stringify(currentProfiles)) changed.dualsenseProfiles = profiles;
  return changed;
}

function gameAdvice(game: GameView, hardware: HardwareProfile): PurchaseAdvice {
  return advisePurchase({
    dualsenseProfiles: dualsenseProfileMatrix(game.dualsenseProfiles, game),
    rayTracing: rayTracingProfileFromGame(game),
    platforms: [game.platform],
    zeroCostChannels: game.zeroCostChannels.filter((channel): channel is "SUBSCRIPTION" | "FAMILY_SHARED" =>
      channel === "SUBSCRIPTION" || channel === "FAMILY_SHARED"),
    hardware
  });
}

function DualsenseIconRow({ game }: { game: GameView }) {
  const matrix = dualsenseProfileMatrix(game.dualsenseProfiles, game);
  return <div className="dualsense-profile-matrix" aria-label="DualSense 分环境特性与光追档案">
    {dualsenseEnvironmentValues.map((environment) => <section key={environment} className="dualsense-environment-row">
      <strong>{dualsenseEnvironmentLabels[environment]}</strong>
      <div className="dualsense-icon-row">{dualsenseDimensions.map((dimension) => {
        const level = matrix[environment][dimension.key];
        return <span key={dimension.key} className={`dualsense-icon level-${level.toLowerCase()}`} title={`${dualsenseEnvironmentLabels[environment]} · ${dimension.label}：${dualsenseFeatureLevelLabels[level]}。${dimension.hint}`}>
          <em aria-hidden>{dimension.emoji}</em><small>{dimension.label}</small><b>{dualsenseFeatureLevelLabels[level]}</b>
        </span>;
      })}</div>
      {matrix[environment].notes ? <small>{matrix[environment].notes}</small> : null}
    </section>)}
    <span className={`rt-badge rt-${game.rayTracing.toLowerCase()}`} title={game.rayTracingNotes ?? undefined}>光追：{rayTracingLevelLabels[game.rayTracing]}</span>
  </div>;
}

function PurchaseAdviceCard({ advice }: { advice: PurchaseAdvice }) {
  return <div className="purchase-advice-card" aria-label="平台购买建议">
    <div className="purchase-advice-head"><strong>平台购买建议</strong><span>{advice.summary}</span></div>
    {advice.suggestions.map((suggestion) => <div key={suggestion.platform} className="purchase-advice-option">
      <strong>{suggestion.title}</strong>
      {suggestion.reasons.length ? <ul>{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
      {suggestion.cautions.length ? <ul className="purchase-advice-cautions">{suggestion.cautions.map((caution) => <li key={caution}>⚠️ {caution}</li>)}</ul> : null}
    </div>)}
    {advice.notes.map((note) => <p key={note} className="purchase-advice-note">{note}</p>)}
  </div>;
}

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function GameManager({ initialGames, total, selectionQuery, hardware }: { initialGames: GameView[]; total: number; selectionQuery: SelectionQuery; hardware: HardwareProfile }) {
  const router = useRouter();
  const [gamesList, setGamesList] = useState(initialGames);
  const [lastInitialGames, setLastInitialGames] = useState(initialGames);
  const [editing, setEditing] = useState<GameView | "new" | null>(null);
  const [formStatuses, setFormStatuses] = useState<GameStatus[]>(["UNPLANNED"]);
  const [formSubGenres, setFormSubGenres] = useState<GameGenre[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("error");
  const [minutes, setMinutes] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<"STATUSES" | "PLATFORM" | "DELETE">("STATUSES");
  const [bulkStatusMode, setBulkStatusMode] = useState<"ADD" | "REMOVE" | "REPLACE">("ADD");
  const [bulkStatuses, setBulkStatuses] = useState<GameStatus[]>([]);
  const [bulkPlatform, setBulkPlatform] = useState("");
  if (lastInitialGames !== initialGames) {
    setLastInitialGames(initialGames);
    setGamesList(initialGames);
  }

  const pageIds = gamesList.map((game) => game.id);
  const selectedCount = selectAllFiltered ? Math.max(0, total - excludedIds.size) : selectedIds.size;
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selectAllFiltered ? !excludedIds.has(id) : selectedIds.has(id));

  function openEditor(game: GameView | "new") {
    setEditing(game);
    setFormStatuses(game === "new" ? ["UNPLANNED"] : game.statuses ?? (game.playStatus ? [game.playStatus as GameStatus] : []));
    setFormSubGenres(game === "new" ? [] : game.subGenres ?? []);
    setMessage("");
  }

  function toggleSubGenre(genre: GameGenre) {
    setFormSubGenres((current) => current.includes(genre)
      ? current.filter((value) => value !== genre)
      : gameGenreValues.filter((value) => current.includes(value) || value === genre));
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setExcludedIds(new Set());
    setSelectAllFiltered(false);
    setBulkOpen(false);
  }

  function toggleSelected(id: string) {
    if (selectAllFiltered) {
      setExcludedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleCurrentPage() {
    if (selectAllFiltered) {
      setExcludedIds((current) => {
        const next = new Set(current);
        for (const id of pageIds) {
          if (pageAllSelected) next.add(id); else next.delete(id);
        }
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (pageAllSelected) next.delete(id); else next.add(id);
      }
      return next;
    });
  }

  function selectEveryFilteredGame() {
    if (total > 1000) {
      setMessageTone("error");
      setMessage("单次最多批量操作 1000 款游戏，请先缩小筛选范围");
      return;
    }
    setSelectAllFiltered(true);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
  }

  function toggleBulkStatus(status: GameStatus) {
    setBulkStatuses((current) => current.includes(status)
      ? current.filter((value) => value !== status)
      : gameStatusValues.filter((value) => current.includes(value) || value === status));
  }

  async function applyBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCount) return;
    let action: Record<string, unknown>;
    if (bulkAction === "STATUSES") {
      if (!bulkStatuses.length) { setMessageTone("error"); setMessage("请至少选择一个状态"); return; }
      action = { type: "STATUSES", mode: bulkStatusMode, statuses: bulkStatuses };
    } else if (bulkAction === "PLATFORM") {
      action = { type: "PLATFORM", platform: bulkPlatform === "__CLEAR__" ? null : bulkPlatform };
    } else {
      if (!window.confirm(`确认删除已选择的 ${selectedCount} 款游戏？操作会写入审计日志，可通过数据库备份回档。`)) return;
      action = { type: "DELETE" };
    }
    const selection = selectAllFiltered
      ? { mode: "FILTER", query: selectionQuery, excludedIds: [...excludedIds], expectedTotal: total }
      : { mode: "IDS", ids: [...selectedIds] };
    setBusy(true); setMessage("");
    try {
      const result = await api("/api/v1/games/bulk", { method: "POST", body: JSON.stringify({ selection, action }) });
      setMessageTone("success");
      setMessage(`已完成 ${result.updatedCount} 款游戏的批量操作`);
      clearSelection();
      router.refresh();
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "批量操作失败");
    } finally { setBusy(false); }
  }

  function toggleStatus(status: GameStatus) {
    setFormStatuses((current) => current.includes(status)
      ? current.filter((value) => value !== status)
      : gameStatusValues.filter((value) => current.includes(value) || value === status));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(""); setMessageTone("error");
    const form = new FormData(event.currentTarget);
    const communityRating = optionalNumber(form, "communityRating");
    const criticRating = optionalNumber(form, "criticRating");
    const payload = {
      nameZh: String(form.get("nameZh") || ""),
      nameEn: String(form.get("nameEn") || "").trim() || null,
      searchAliases: String(form.get("searchAliases") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      notes: String(form.get("notes") || "").trim() || null,
      platform: String(form.get("platform") || "").trim() || null,
      primaryGenre: String(form.get("primaryGenre") || "") || null,
      subGenres: formSubGenres,
      statuses: formStatuses,
      queueOrder: null,
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
      manualOwned: form.get("manualOwned") === "on",
      ...changedHardwareFields(form, editing ?? "new")
    };
    try {
      const result = editing === "new"
        ? await api("/api/v1/games", { method: "POST", body: JSON.stringify(payload) })
        : editing
          ? await api(`/api/v1/games/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...payload, version: editing.version }) })
          : null;
      if (result?.game) {
        const saved = result.game as GameView;
        setGamesList((current) => editing === "new"
          ? [saved, ...current]
          : current.map((game) => game.id === saved.id ? saved : game));
      }
      setEditing(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function remove(game: GameView) {
    if (!window.confirm(`确认删除《${game.nameZh}》？可通过API恢复。`)) return;
    setBusy(true); setMessageTone("error");
    try { await api(`/api/v1/games/${game.id}`, { method: "DELETE" }); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  }

  async function addTime(game: GameView) {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value <= 0) { setMessageTone("error"); setMessage("请输入正整数分钟数"); return; }
    setBusy(true); setMessageTone("error");
    try {
      await api(`/api/v1/games/${game.id}/play-sessions`, { method: "POST", body: JSON.stringify({ minutes: value, startedAt: new Date().toISOString() }) });
      setMinutes(""); setEditing(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "记录失败"); }
    finally { setBusy(false); }
  }

  async function quickStatus(game: GameView, action: "COMPLETE" | "UNCOMPLETE" | "ABANDON") {
    if (action === "ABANDON" && !window.confirm(`确认将《${game.nameZh}》标记为弃坑并移出所有游玩队列吗？`)) return;
    setBusy(true); setMessage(""); setMessageTone("error");
    try {
      await api(`/api/v1/games/${game.id}/quick-status`, {
        method: "POST",
        body: JSON.stringify({ action, version: game.version })
      });
      setMessageTone("success");
      setMessage(action === "COMPLETE" ? `《${game.nameZh}》已标记通关并归档`
        : action === "ABANDON" ? `《${game.nameZh}》已标记弃坑并归档`
          : `《${game.nameZh}》已撤销通关标记`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "快捷操作失败"); }
    finally { setBusy(false); }
  }

  async function toggleWishlist(game: GameView) {
    const active = !isWishlisted(game.statuses);
    setBusy(true); setMessage(""); setMessageTone("error");
    try {
      await api(`/api/v1/games/${game.id}/wishlist`, {
        method: "POST",
        body: JSON.stringify({ active, version: game.version })
      });
      setMessageTone("success");
      setMessage(active ? `《${game.nameZh}》已加入待购入／愿望单` : `《${game.nameZh}》已移出待购入／愿望单`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "愿望单更新失败"); }
    finally { setBusy(false); }
  }

  return <>
    <section className="content-section game-list-section">
      <div className="section-heading"><div><h2>游戏记录</h2><p>评分、发售日与英文名均保留来源；场景队列与入手渠道统一在“游玩规划”维护。</p></div><div className="heading-actions"><a className="secondary-button compact" href="/play"><Play size={15} />游玩规划</a><span className="count-badge">{total} 项</span>{gamesList.length ? <button className="secondary-button compact" type="button" onClick={toggleCurrentPage}><CheckSquare2 size={15} />{pageAllSelected ? "取消本页" : "选择本页"}</button> : null}<button className="primary-button compact" type="button" onClick={() => openEditor("new")}><Plus size={15} /> 添加游戏</button></div></div>
      {message ? <div className={`inline-alert ${messageTone === "error" ? "error" : ""}`}>{message}</div> : null}
      {selectedCount ? <div className="bulk-toolbar" aria-live="polite"><div><Layers3 size={17} /><strong>已选择 {selectedCount} 款</strong>{!selectAllFiltered && total > selectedCount ? <button type="button" className="text-button" onClick={selectEveryFilteredGame}>选择全部 {total} 项筛选结果</button> : selectAllFiltered ? <span>已覆盖当前全部筛选结果</span> : null}</div><div><button type="button" className="text-button" onClick={clearSelection}>取消选择</button><button type="button" className="primary-button compact" onClick={() => setBulkOpen(true)}>批量管理</button></div></div> : null}
      {gamesList.length ? <div className="table-wrap"><table className="game-table"><thead><tr><th><label className="selection-check"><input type="checkbox" checked={pageAllSelected} onChange={toggleCurrentPage} /><span>游戏信息</span></label></th><th>状态</th><th>发售与评分</th><th>进度与时长</th><th>操作</th></tr></thead><tbody>
        {gamesList.map((game) => {
          const selected = selectAllFiltered ? !excludedIds.has(game.id) : selectedIds.has(game.id);
          const activityState = visibleActivityState(game.statuses, game.activityState);
          const completion = completionControl(game.statuses);
          const displayedStatuses = displayStatuses(game.statuses);
          const wishlisted = isWishlisted(game.statuses);
          const abandoned = game.statuses.includes("ABANDONED");
          const archived = completion.completed || abandoned;
          return <tr key={game.id} className={selected ? "selected-row" : ""}>
          <td><div className="game-title-select"><label className="selection-check item-check"><input type="checkbox" checked={selected} onChange={() => toggleSelected(game.id)} aria-label={`选择《${game.nameZh}》`} /></label><button type="button" className="game-title-open" onClick={() => openEditor(game)} aria-label={`查看并编辑《${game.nameZh}》`}><div className="game-title-cell"><GameCover src={game.coverUrl} /><div><strong>{game.nameZh}</strong><small className={game.nameEn ? "" : "missing-field"}>{game.nameEn ?? "英文名待补全"}</small><span className="game-meta-line">{platformLabels[game.platform ?? ""] ?? game.platform ?? "未设置平台"}</span>{game.primaryGenre || game.subGenres.length ? <span className="status-chip-list">{game.primaryGenre ? <span className="status-chip genre-chip primary">{gameGenreLabels[game.primaryGenre]}</span> : null}{game.subGenres.filter((genre) => genre !== game.primaryGenre).map((genre) => <span key={genre} className="status-chip genre-chip">{gameGenreLabels[genre]}</span>)}</span> : null}</div></div></button></div></td>
          <td><div className="status-chip-list">{displayedStatuses.length ? displayedStatuses.map((status) => <span key={status} className={`status-chip status-${status.toLowerCase()}`}>{gameStatusLabels[status]}</span>) : <span className="status-chip status-unset">未设置</span>}{activityState ? <span className={`status-chip activity-${activityState.toLowerCase()}`}>活动：{activityStateLabels[activityState]}</span> : null}<span className={`status-chip purchase-${game.purchaseState.toLowerCase()}`}>{purchaseStateLabels[game.purchaseState]}</span></div><small className="cell-note">开始：{game.startedAt ?? game.firstObservedPlayedAt?.slice(0, 10) ?? "待记录"} · 最后：{game.lastPlayedAt?.slice(0, 10) ?? "—"}</small>{game.activityState === "COMPLETION_CANDIDATE" && !game.statuses.includes("COMPLETED") ? <small className="cell-note">最后游玩已超过 48 小时，自动归类为“已游玩”；这不代表已经通关。</small> : null}</td>
          <td><div className="release-rating-cell"><span><CalendarDays size={13} /><strong>{game.releaseDate ?? "发售日待补全"}</strong><small>{sourceLabels[game.releaseDateSource] ?? game.releaseDateSource}</small></span><div className="rating-row">{game.communityRating !== null ? <em><Star size={11} />玩家 {score(game.communityRating)}</em> : null}{game.criticRating !== null ? <em>媒体 {score(game.criticRating)}</em> : null}{game.ratingSource ? <span className="rating-source">{game.ratingSource === "STEAM" && game.criticRating !== null ? "Steam / Metacritic" : sourceLabels[game.ratingSource] ?? game.ratingSource}</span> : null}{game.communityRating === null && game.criticRating === null ? <small>评分待补全</small> : null}</div></div></td>
          <td><div className="progress-time-cell"><div><strong>{game.progressPercent === null ? "—" : `${game.progressPercent}%`}</strong><span className="progress-track"><i style={{ width: `${game.progressPercent ?? 0}%` }} /></span></div><small>{game.totalPlaytimeMinutes > 0 ? `已玩 ${hours(game.totalPlaytimeMinutes)}` : "平台未提供游玩时长"}</small><small>主线 {hours(game.estimatedHastilyMinutes)} · 主线+支线 {hours(game.estimatedNormallyMinutes)} · 全收集 {hours(game.estimatedCompletelyMinutes)}{game.estimateSource ? ` · ${sourceLabels[game.estimateSource] ?? game.estimateSource}` : ""}</small><small>{game.acquisitionSources.length ? `入库：${game.acquisitionSources.map((source) => sourceLabels[source] ?? source).join("、")}` : "尚无入库记录"}</small></div></td>
          <td><div className="row-actions quick-row-actions">{game.wishlistEligible || wishlisted ? <button className={`quick-row-button wishlist-toggle ${wishlisted ? "active" : ""}`} aria-pressed={wishlisted} disabled={busy} onClick={() => toggleWishlist(game)}><Heart size={13} />{wishlisted ? "移出" : "选购"}</button> : null}{!archived ? <button className="quick-row-button" disabled={busy} onClick={() => router.push("/play")}><Play size={13} />规划</button> : null}<button className={`quick-row-button completion-toggle ${completion.completed ? "completed" : "complete"}`} aria-pressed={completion.completed} disabled={busy} onClick={() => quickStatus(game, completion.action)}>{completion.completed ? <Undo2 size={13} /> : <Trophy size={13} />}{completion.label}</button>{!archived ? <button className="quick-row-button abandon-toggle" disabled={busy} onClick={() => quickStatus(game, "ABANDON")}><Ban size={13} />弃坑</button> : null}<button aria-label="编辑" disabled={busy} onClick={() => openEditor(game)}><Pencil size={14} /></button><button aria-label="删除" disabled={busy} onClick={() => remove(game)}><Trash2 size={14} /></button></div></td>
        </tr>;})}
      </tbody></table></div> : <div className="empty-state">没有符合条件的游戏。可清除筛选或添加新记录。</div>}
    </section>
    {bulkOpen ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setBulkOpen(false); }}>
      <div className="modal-panel bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-form-title">
        <header><div><span className="eyebrow">BULK MANAGEMENT</span><h2 id="bulk-form-title">批量管理 {selectedCount} 款游戏</h2><p>所有变更在同一事务内完成；失败时整批回滚。</p></div><button className="icon-button" disabled={busy} onClick={() => setBulkOpen(false)} aria-label="关闭"><X size={18} /></button></header>
        <form onSubmit={applyBulk}>
          <fieldset className="game-form-section"><legend>选择操作</legend><div className="bulk-action-tabs" role="group" aria-label="批量操作类型">
            <button type="button" className={bulkAction === "STATUSES" ? "selected" : ""} onClick={() => setBulkAction("STATUSES")}>状态</button>
            <button type="button" className={bulkAction === "PLATFORM" ? "selected" : ""} onClick={() => setBulkAction("PLATFORM")}>平台</button>
            <button type="button" className={bulkAction === "DELETE" ? "selected danger" : "danger"} onClick={() => setBulkAction("DELETE")}>删除</button>
          </div></fieldset>
          {bulkAction === "STATUSES" ? <fieldset className="game-form-section"><legend>批量调整状态</legend><p>新增/移除会保留其他状态；替换会以本次选择为准。愿望单请使用游戏行内心形按钮管理，游玩中与接下来玩请使用游玩规划。</p><div className="form-grid"><label>处理方式<select value={bulkStatusMode} onChange={(event) => setBulkStatusMode(event.target.value as typeof bulkStatusMode)}><option value="ADD">新增状态</option><option value="REMOVE">移除状态</option><option value="REPLACE">替换全部状态</option></select></label></div><div className="status-multiselect" role="group" aria-label="批量状态">{gameStatusValues.filter((status) => !["WISHLIST", "BACKLOG", "PLAYING"].includes(status)).map((status) => <label key={status} className={bulkStatuses.includes(status) ? "selected" : ""}><input type="checkbox" checked={bulkStatuses.includes(status)} onChange={() => toggleBulkStatus(status)} /><span>{gameStatusLabels[status]}</span></label>)}</div></fieldset> : null}
          {bulkAction === "PLATFORM" ? <fieldset className="game-form-section"><legend>批量设置平台</legend><p>会同步更新发售事件中的平台信息。</p><div className="form-grid"><label>目标平台<select required value={bulkPlatform} onChange={(event) => setBulkPlatform(event.target.value)}><option value="" disabled>请选择</option><option value="STEAM">Steam</option><option value="PLAYSTATION">PlayStation</option><option value="NINTENDO_SWITCH">Switch</option><option value="NINTENDO_SWITCH_2">Switch 2</option><option value="XBOX_GAME_PASS">XGP</option><option value="PC_OTHER">PC</option><option value="IOS">iOS</option><option value="__CLEAR__">清空平台</option></select></label></div></fieldset> : null}
          {bulkAction === "DELETE" ? <div className="bulk-danger-panel"><Trash2 size={20} /><div><strong>软删除 {selectedCount} 款游戏</strong><p>这些游戏会从当前列表移除。提交前还会再次确认。</p></div></div> : null}
          {message ? <div className={`inline-alert ${messageTone === "error" ? "error" : ""}`}>{message}</div> : null}
          <footer><button type="button" className="secondary-button" disabled={busy} onClick={() => setBulkOpen(false)}>取消</button><button className={bulkAction === "DELETE" ? "danger-button" : "primary-button"} disabled={busy}>{busy ? "处理中…" : `应用到 ${selectedCount} 款`}</button></footer>
        </form>
      </div>
    </div> : null}
    {editing ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
      <div className="modal-panel game-form-modal" role="dialog" aria-modal="true" aria-labelledby="game-form-title">
        <header><div><span className="eyebrow">{editing === "new" ? "NEW GAME" : "EDIT GAME"}</span><h2 id="game-form-title">{editing === "new" ? "添加游戏" : editing.nameZh}</h2><p>字段按信息、评价、游玩和备注分组；自动数据可以手工覆盖。</p></div><button className="icon-button" onClick={() => setEditing(null)} aria-label="关闭"><X size={18} /></button></header>
        <form onSubmit={save}>
          <fieldset className="game-form-section">
            <legend>基本信息</legend><p>用于搜索和识别；英文名缺失时可由 Steam 或 IGDB 安全补全。</p>
            <div className="form-grid">
              <label className="span-2">中文名称<input name="nameZh" required maxLength={200} defaultValue={editing === "new" ? "" : editing.nameZh} /></label>
              <label className="span-2">英文名称<input name="nameEn" maxLength={200} placeholder="例如 Persona 5 Royal" defaultValue={editing === "new" ? "" : editing.nameEn ?? ""} /></label>
              <label className="span-2">搜索别名<textarea name="searchAliases" rows={3} maxLength={4000} placeholder={"每行一个，例如：\n异度之刃X 终极版\nXenoblade X"} defaultValue={editing === "new" ? "" : editing.searchAliases.join("\n")} /><small>用于译名、简称与旧名；简体和繁体会自动双向匹配。</small></label>
              <label>平台<select name="platform" defaultValue={editing === "new" ? "" : editing.platform ?? ""}><option value="">未设置</option><option value="STEAM">Steam</option><option value="PLAYSTATION">PlayStation</option><option value="NINTENDO_SWITCH">Switch</option><option value="NINTENDO_SWITCH_2">Switch 2</option><option value="XBOX_GAME_PASS">XGP</option><option value="PC_OTHER">PC</option><option value="IOS">iOS</option></select></label>
              <label>发售日期<input type="date" name="releaseDate" defaultValue={editing === "new" ? "" : editing.releaseDate ?? ""} /></label>
            </div>
          </fieldset>
          <fieldset className="game-form-section">
            <legend>类型</legend><p>主类型单选、子标签多选；人工修改后会锁定字段，IGDB 自动回填不再覆盖。</p>
            <div className="form-grid">
              <label>主类型<select name="primaryGenre" defaultValue={editing === "new" ? "" : editing.primaryGenre ?? ""}><option value="">未设置</option>{gameGenreValues.map((genre) => <option key={genre} value={genre}>{gameGenreLabels[genre]}</option>)}</select></label>
            </div>
            <div className="status-multiselect" role="group" aria-label="子标签">
              {gameGenreValues.map((genre) => <label key={genre} className={formSubGenres.includes(genre) ? "selected" : ""}>
                <input type="checkbox" checked={formSubGenres.includes(genre)} onChange={() => toggleSubGenre(genre)} />
                <span>{gameGenreLabels[genre]}</span>
              </label>)}
            </div>
          </fieldset>
          <fieldset className="game-form-section">
            <legend>DualSense 分环境档案与光追</legend><p>PS5 主机、PC USB 有线、PC 蓝牙分别记录 🔫📳🔊👋🎤 五项特性；不再用一个“PC 需有线”标签概括不同连接方式。</p>
            {editing !== "new" ? <DualsenseIconRow game={editing} /> : null}
            <div className="dualsense-editor-matrix">
              {dualsenseEnvironmentValues.map((environment) => {
                const profile = editing === "new"
                  ? dualsenseProfileMatrix([])[environment]
                  : dualsenseProfileMatrix(editing.dualsenseProfiles, editing)[environment];
                return <fieldset key={environment} className="dualsense-environment-editor">
                  <legend>{dualsenseEnvironmentLabels[environment]}</legend><p>{dualsenseEnvironmentHints[environment]}</p>
                  <div className="form-grid three-columns">
                    {dualsenseDimensions.map((dimension) => <label key={dimension.key} title={dimension.hint}>{dimension.emoji} {dimension.label}
                      <select name={`dualsense.${environment}.${dimension.key}`} defaultValue={profile[dimension.key]}>
                        {dualsenseFeatureLevelValues.map((level) => <option key={level} value={level}>{dualsenseFeatureLevelLabels[level]}</option>)}
                      </select>
                    </label>)}
                  </div>
                  <label>环境备注<textarea name={`dualsense.${environment}.notes`} rows={2} maxLength={2000} placeholder="只记录该环境下的连接限制、已验证行为与证据结论" defaultValue={profile.notes ?? ""} /></label>
                </fieldset>;
              })}
            </div>
            <div className="form-grid">
              <label>光追档案
                <select name="rayTracing" defaultValue={editing === "new" ? "UNKNOWN" : editing.rayTracing}>
                  {rayTracingLevelValues.map((level) => <option key={level} value={level}>{rayTracingLevelLabels[level]}</option>)}
                </select>
              </label>
              <label className="span-2">光追平台差异备注<input name="rayTracingNotes" maxLength={2000} placeholder="例如：路径光追为 PC 独占" defaultValue={editing === "new" ? "" : editing.rayTracingNotes ?? ""} /></label>
            </div>
            {editing !== "new" ? <PurchaseAdviceCard advice={gameAdvice(editing, hardware)} /> : null}
          </fieldset>
          <fieldset className="game-form-section">
            <legend>评分信息</legend><p>统一采用 0–100 分；IGDB 自动同步社区与媒体评分，手工值不会被覆盖。</p>
            <div className="form-grid three-columns">
              <label>玩家评分<input type="number" name="communityRating" {...gameRatingConstraints} inputMode="decimal" placeholder="0–100，最多两位小数" defaultValue={editing === "new" ? "" : editing.communityRating ?? ""} /></label>
              <label>媒体评分<input type="number" name="criticRating" {...gameRatingConstraints} inputMode="decimal" placeholder="0–100，最多两位小数" defaultValue={editing === "new" ? "" : editing.criticRating ?? ""} /></label>
              <label>评分来源<select name="ratingSource" defaultValue={editing === "new" ? "MANUAL" : editing.ratingSource ?? "MANUAL"}><option value="MANUAL">手工</option><option value="STEAM">Steam</option><option value="IGDB">IGDB</option><option value="RAWG">RAWG</option><option value="METACRITIC">Metacritic</option><option value="IGN">IGN</option><option value="XIAOHEIHE">小黑盒</option></select></label>
            </div>
            {editing !== "new" && (editing.communityRatingCount || editing.criticRatingCount) ? <small className="source-detail">样本量：玩家 {editing.communityRatingCount ?? "—"} · 媒体 {editing.criticRatingCount ?? "—"}</small> : null}
          </fieldset>
          <fieldset className="game-form-section">
            <legend>状态与游玩事实</legend><p>“游玩中”和“接下来玩”由双场景游玩规划统一维护；这里保留其他生命周期状态与通关事实。</p>
            <div className="status-multiselect" role="group" aria-label="游戏状态">
              {gameStatusValues.filter((status) => !["COMPLETED", "WISHLIST", "BACKLOG", "PLAYING"].includes(status)).map((status) => <label key={status} className={formStatuses.includes(status) ? "selected" : ""}>
                <input type="checkbox" checked={formStatuses.includes(status)} onChange={() => toggleStatus(status)} />
                <span>{gameStatusLabels[status]}</span>
              </label>)}
            </div>
            <label className={formStatuses.includes("COMPLETED") ? "completion-fact-field selected" : "completion-fact-field"}><input type="checkbox" checked={formStatuses.includes("COMPLETED")} onChange={() => toggleStatus("COMPLETED")} /><Trophy size={17} /><span><strong>已经通关</strong><small>独立事实，不会再被 48 小时活动归类覆盖；日期可以留空。</small></span></label>
            <div className="form-grid">
              <label className="span-2 checkbox-field"><input type="checkbox" name="manualOwned" defaultChecked={editing !== "new" && editing.acquisitionSources.includes("MANUAL")} /><span><strong>已建立手工入库记录</strong><small>勾选后计为已购入；Steam、PlayStation 等平台入库记录不受此开关影响。</small></span></label>
              <label>进度（%）<input type="number" name="progressPercent" min="0" max="100" defaultValue={editing === "new" ? "" : editing.progressPercent ?? ""} /></label>
              <label>手工累计游玩（小时）<input type="number" name="playtimeHours" min="0" step="0.1" defaultValue={editing === "new" ? "" : editing.playtimeMinutesManual === null ? "" : gameHours(editing.playtimeMinutesManual)} /></label>
              <label>开始日期<input type="date" name="startedAt" defaultValue={editing === "new" ? "" : editing.startedAt ?? ""} /></label>
              <label>完成日期<input type="date" name="completedAt" disabled={!formStatuses.includes("COMPLETED")} defaultValue={editing === "new" ? "" : editing.completedAt ?? ""} /></label>
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
