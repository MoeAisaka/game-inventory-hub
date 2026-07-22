"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gamepad2,
  Library,
  Link2,
  Search,
  ShieldAlert
} from "lucide-react";
import { formatShanghaiDateTime } from "@/lib/date-format";
import type { SteamReviewCandidateRisk, SteamReviewLane } from "@/lib/steam-match-workbench";

type SteamReviewItem = {
  steamAppId: number;
  name: string;
  playtimeMinutes: number;
  recentPlaytimeMinutes: number | null;
  lastPlayedAt: string | null;
  iconUrl: string | null;
  matchMethod: string;
  licenseType: "OWNED" | "FAMILY_SHARED";
  lane: SteamReviewLane;
  hasPlayHistory: boolean;
  suspectedNonGame: boolean;
  candidates: Array<{
    gameId: string;
    nameZh: string;
    nameEn: string | null;
    platform: string | null;
    steamAppId: number | null;
    score: number;
    margin: number;
    matchedName: string;
    risks: SteamReviewCandidateRisk[];
  }>;
};

type WorkbenchCounts = Record<SteamReviewLane, number> & { actionable: number };

const laneOptions: Array<{
  value: SteamReviewLane;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  { value: "OWNED_MISSING", label: "自购缺失", shortLabel: "自购", description: "优先补齐正式目录" },
  { value: "REVIEW", label: "建议复核", shortLabel: "复核", description: "有游玩历史或名称候选" },
  { value: "NON_GAME", label: "疑似非游戏", shortLabel: "非游戏", description: "测试服与独立测试客户端" },
  { value: "CATALOG", label: "家庭共享目录", shortLabel: "目录", description: "保留发现，不制造待办" }
];

const riskLabels: Record<SteamReviewCandidateRisk, string> = {
  SERIES_NUMBER_CONFLICT: "系列序号冲突",
  TARGET_ALREADY_HAS_STEAM_APP: "目标已有其他 App ID"
};

function playtime(minutes: number) {
  if (minutes <= 0) return "尚无时长";
  if (minutes < 60) return `${minutes} 分钟`;
  const value = minutes / 60;
  return `${value.toFixed(minutes % 60 === 0 ? 0 : 1)} 小时`;
}

function reason(item: SteamReviewItem) {
  if (item.lane === "OWNED_MISSING") return "自购许可尚未关联正式游戏";
  if (item.lane === "NON_GAME") return "名称符合测试客户端或测试服特征";
  if (item.hasPlayHistory && item.candidates.length) return "存在游玩历史，并找到名称候选";
  if (item.hasPlayHistory) return "存在游玩历史，值得单独确认";
  if (item.candidates.length) return "找到高相似候选，仅供人工判断";
  return "当前无兴趣与游玩信号，作为可玩目录保留";
}

export function SteamMatchReview({
  summary,
  counts,
  items
}: {
  summary: {
    total: number;
    owned: number;
    familyShared: number;
    matched: number;
    unmatched: number;
    ignored: number;
    unavailableFamily: number;
  };
  counts: WorkbenchCounts;
  items: SteamReviewItem[];
}) {
  const initialLane = laneOptions.find((option) => counts[option.value] > 0)?.value ?? "CATALOG";
  const [lane, setLane] = useState<SteamReviewLane>(initialLane);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"RECOMMENDED" | "PLAYTIME" | "NAME">("RECOMMENDED");
  const [page, setPage] = useState(1);
  const pageSize = lane === "CATALOG" ? 30 : 18;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const result = items.filter((item) => item.lane === lane && (!normalized || [
      item.name,
      String(item.steamAppId),
      ...item.candidates.flatMap((candidate) => [candidate.nameZh, candidate.nameEn ?? ""])
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized))));
    if (sort === "PLAYTIME") return result.toSorted((left, right) => right.playtimeMinutes - left.playtimeMinutes || left.name.localeCompare(right.name, "zh-CN"));
    if (sort === "NAME") return result.toSorted((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return result;
  }, [items, lane, query, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function chooseLane(nextLane: SteamReviewLane) {
    setLane(nextLane);
    setPage(1);
    setQuery("");
    setSort("RECOMMENDED");
  }

  if (summary.total === 0) return null;
  return <section className="content-section steam-workbench">
    <div className="steam-workbench-hero">
      <div className="steam-workbench-copy">
        <span className="eyebrow">STEAM MATCHING WORKBENCH</span>
        <h2>把真正的决定，从目录噪音里分离出来。</h2>
        <p>当前只读预览。候选只提供判断依据，不会自动关联、新建或忽略任何游戏。</p>
      </div>
      <div className="steam-preview-status"><ShieldAlert size={16} /><span><strong>预览模式</strong><small>0 项生产写入</small></span></div>
    </div>

    <div className="steam-workbench-metrics" aria-label="Steam 匹配概览">
      <div><span>需要决策</span><strong>{counts.actionable}</strong><small>自购、复核与疑似非游戏</small></div>
      <div><span>仅目录</span><strong>{counts.CATALOG}</strong><small>可搜索，不制造待办</small></div>
      <div><span>已经关联</span><strong>{summary.matched}</strong><small>当前可用记录</small></div>
      <div><span>当前不可用</span><strong>{summary.unavailableFamily}</strong><small>保留历史，不参与处理</small></div>
    </div>

    <div className="steam-lane-tabs" role="tablist" aria-label="匹配处理泳道">
      {laneOptions.map((option) => <button
        key={option.value}
        type="button"
        role="tab"
        aria-selected={lane === option.value}
        className={lane === option.value ? "active" : ""}
        onClick={() => chooseLane(option.value)}
      >
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
        <b>{counts[option.value]}</b>
      </button>)}
    </div>

    <div className="steam-workbench-toolbar">
      <label className="search-field steam-workbench-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          placeholder={`搜索${laneOptions.find((option) => option.value === lane)?.shortLabel ?? "当前"}记录、App ID 或候选`}
        />
      </label>
      <label className="steam-sort-field"><span>排序</span><select value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(1); }}>
        <option value="RECOMMENDED">建议顺序</option>
        <option value="PLAYTIME">游玩时长</option>
        <option value="NAME">名称</option>
      </select></label>
      <span className="steam-result-count">{filtered.length} 项</span>
    </div>

    {visibleItems.length ? <div className={`steam-review-grid ${lane === "CATALOG" ? "catalog" : ""}`}>
      {visibleItems.map((item) => {
        const candidate = item.candidates[0];
        return <article className="steam-review-card" key={item.steamAppId}>
          <div className="steam-review-card-head">
            {item.iconUrl ? <span className="steam-review-icon" aria-hidden="true" style={{ backgroundImage: `url(${item.iconUrl})` }} /> : <span className="steam-review-icon placeholder" aria-hidden="true"><Gamepad2 size={19} /></span>}
            <div className="steam-review-title"><h3>{item.name}</h3><p>App {item.steamAppId} · {item.licenseType === "OWNED" ? "自购" : "家庭共享"}</p></div>
          </div>
          <p className="steam-review-reason">{reason(item)}</p>
          <div className="steam-review-facts">
            <span><Clock3 size={14} />{playtime(item.playtimeMinutes)}</span>
            <span><Library size={14} />{item.lastPlayedAt ? formatShanghaiDateTime(item.lastPlayedAt) : "从未启动"}</span>
          </div>
          {candidate ? <div className="steam-candidate-preview">
            <div className="steam-candidate-heading"><span><Link2 size={14} />候选预览</span><b>{candidate.score.toFixed(candidate.score % 1 === 0 ? 0 : 1)}%</b></div>
            <strong>{candidate.nameZh}</strong>
            <small>{[candidate.nameEn, candidate.platform, candidate.steamAppId !== null ? `App ${candidate.steamAppId}` : null].filter(Boolean).join(" · ") || "本地正式目录"}</small>
            {candidate.risks.length ? <div className="steam-risk-list">{candidate.risks.map((risk) => <span key={risk}><AlertTriangle size={12} />{riskLabels[risk]}</span>)}</div> : <p className="steam-candidate-note">无硬冲突，但仍需人工确认。</p>}
          </div> : null}
        </article>;
      })}
    </div> : <div className="empty-state">当前泳道没有符合搜索条件的记录。</div>}

    {pageCount > 1 ? <nav className="steam-pagination" aria-label="Steam 匹配记录翻页">
      <button type="button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button>
      <span>第 {currentPage} / {pageCount} 页</span>
      <button type="button" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={16} /></button>
    </nav> : null}
  </section>;
}
