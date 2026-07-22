"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
  Gamepad2,
  Gauge,
  HardDrive,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Trophy
} from "lucide-react";
import {
  type DashboardData,
  type DashboardFilters,
  dashboardFiltersSchema,
  defaultDashboardFilters
} from "@/lib/dashboard";
import { formatShanghaiDateTime } from "@/lib/date-format";
import { gameStatusLabels, gameStatusValues, type GameStatus } from "@/lib/game-status";

const filterStorageKey = "game-inventory.dashboard.filters.v2";

const platformLabels: Record<string, string> = {
  STEAM: "Steam",
  PLAYSTATION: "PlayStation",
  NINTENDO_SWITCH: "Switch",
  NINTENDO_SWITCH_2: "Switch 2",
  XBOX_GAME_PASS: "XGP",
  PC_OTHER: "PC",
  IOS: "iOS"
};

function hours(minutes: number) {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(minutes / 60)} 小时`;
}

function percentage(value: number) {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}%`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "读取失败");
  return body.data;
}

async function saveFilters(filters: DashboardFilters, signal?: AbortSignal) {
  const response = await fetch("/api/v1/preferences/dashboard", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(filters),
    signal
  });
  if (!response.ok) throw new Error("筛选条件保存失败");
}

function queryFor(filters: DashboardFilters) {
  const query = new URLSearchParams({
    platform: filters.platform,
    scope: filters.scope,
    completionWindow: filters.completionWindow
  });
  for (const status of filters.statuses) query.append("statuses", status);
  return query.toString();
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Gamepad2;
  tone?: string;
}) {
  return <article className={`metric dashboard-metric ${tone ?? ""}`}><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><Icon size={19} aria-hidden="true" /></article>;
}

function HorizontalBars({
  items,
  valueLabel = (value) => new Intl.NumberFormat("zh-CN").format(value),
  emptyLabel = "当前筛选下没有可展示的数据"
}: {
  items: Array<{ key: string; label: string; value: number }>;
  valueLabel?: (value: number) => string;
  emptyLabel?: string;
}) {
  const maximum = Math.max(1, ...items.map((item) => item.value));
  if (!items.length) return <div className="chart-empty">{emptyLabel}</div>;
  return <div className="horizontal-bars">
    {items.map((item) => <div className="bar-row" key={item.key}>
      <div className="bar-meta"><span title={item.label}>{item.label}</span><strong>{valueLabel(item.value)}</strong></div>
      <div className="bar-track" aria-label={`${item.label}：${valueLabel(item.value)}`} role="img"><span style={{ width: `${Math.max(2, (item.value / maximum) * 100)}%` }} /></div>
    </div>)}
  </div>;
}

function CompletionTrend({ items }: { items: DashboardData["completionTrend"] }) {
  const maximum = Math.max(1, ...items.map((item) => item.value));
  return <div className="trend-scroll">
    <div className="trend-bars" style={{ minWidth: `${Math.max(460, items.length * 48)}px` }}>
      {items.map((item) => <div className="trend-column" key={item.year}>
        <strong>{item.value || ""}</strong>
        <div className="trend-track"><span style={{ height: `${item.value ? Math.max(5, (item.value / maximum) * 100) : 0}%` }} /></div>
        <small>{item.year}</small>
      </div>)}
    </div>
  </div>;
}

function DashboardCharts({ data }: { data: DashboardData }) {
  const topGameBars = data.topGames.map((game) => ({ key: game.id, label: game.name, value: game.minutes }));
  return <div className="dashboard-chart-grid">
    <section className="content-section chart-panel">
      <div className="chart-heading"><div><h2>游戏状态分布</h2><p>按状态标签统计；一款多状态游戏会进入多个分类。</p></div><span>{data.metrics.gameCount} 项</span></div>
      <HorizontalBars items={data.statusDistribution} />
    </section>
    <section className="content-section chart-panel">
      <div className="chart-heading"><div><h2>平台结构</h2><p>按游戏记录的平台字段统计，不重复计算。</p></div><span>{data.platformDistribution.length} 类</span></div>
      <HorizontalBars items={data.platformDistribution.slice(0, 8)} />
    </section>
    <section className="content-section chart-panel wide">
      <div className="chart-heading"><div><h2>累计游玩时间 Top 8</h2><p>同一游戏优先采用手工累计值，否则采用平台同步累计值。</p></div><span>小时</span></div>
      <HorizontalBars items={topGameBars} valueLabel={hours} emptyLabel="当前筛选下尚无游玩时间" />
    </section>
    <section className="content-section chart-panel wide">
      <div className="chart-heading"><div><h2>通关趋势</h2><p>按完成日期所在年份统计；缺少完成日期的记录不计入。</p></div><span>{data.filters.completionWindow === "ALL" ? "全部年份" : data.filters.completionWindow === "5Y" ? "近 5 年" : "近 10 年"}</span></div>
      <CompletionTrend items={data.completionTrend} />
    </section>
  </div>;
}

export function DashboardClient({ initialData }: { initialData: DashboardData }) {
  const [filters, setFilters] = useState(initialData.filters);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const lastApplied = useRef(JSON.stringify(initialData.filters));

  useEffect(() => {
    let storedFilters: DashboardFilters | null = null;
    try {
      const stored = window.localStorage.getItem(filterStorageKey);
      if (stored) {
        const parsed = dashboardFiltersSchema.safeParse(JSON.parse(stored));
        if (parsed.success && JSON.stringify(parsed.data) !== lastApplied.current) storedFilters = parsed.data;
      }
    } catch {
      window.localStorage.removeItem(filterStorageKey);
    }
    queueMicrotask(() => {
      if (storedFilters) setFilters(storedFilters);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const serialized = JSON.stringify(filters);
    if (serialized === lastApplied.current) return;
    lastApplied.current = serialized;
    window.localStorage.setItem(filterStorageKey, serialized);
    setLoading(true);
    setSaved(false);
    setMessage("");
    const controller = new AbortController();
    getJson<DashboardData>(`/api/v1/dashboard?${queryFor(filters)}`, controller.signal)
      .then(setData)
      .catch((error) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "看板刷新失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = window.setTimeout(() => {
      saveFilters(filters, controller.signal)
        .then(() => {
          window.localStorage.removeItem(filterStorageKey);
          setSaved(true);
        })
        .catch(() => { if (!controller.signal.aborted) setMessage("看板已更新，但筛选条件暂未同步到账号；本浏览器仍会保留。") });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [filters, hydrated]);

  function update<K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function toggleStatus(status: GameStatus) {
    setFilters((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((value) => value !== status)
        : gameStatusValues.filter((value) => current.statuses.includes(value) || value === status)
    }));
  }

  const metrics = data.metrics;
  const freshness = data.freshness.steamLastSyncedAt
    ? formatShanghaiDateTime(data.freshness.steamLastSyncedAt)
    : "尚未同步";
  return <>
    <header className="page-header dashboard-header"><div><span className="eyebrow">PERSONAL DATA DASHBOARD</span><h1>数据看板</h1><p>从游戏结构、进度、时间投入与 Steam 匹配覆盖观察你的个人游戏库。</p></div><div className="dashboard-save-state" aria-live="polite">{loading ? <><LoaderCircle className="spin" size={14} /> 更新中</> : saved ? <><Check size={14} /> 筛选已记住</> : "等待保存"}</div></header>
    <section className="dashboard-filter-bar" aria-label="看板筛选">
      <div className="dashboard-filter-grid">
        <label>平台<select value={filters.platform} onChange={(event) => update("platform", event.target.value)}><option value="ALL">全部平台</option>{data.filterOptions.platforms.map((platform) => <option key={platform} value={platform}>{platformLabels[platform] ?? platform}</option>)}</select></label>
        <div className="dashboard-filter-field"><span>游戏状态</span><details className="status-filter-menu dashboard-status-filter"><summary>{filters.statuses.length ? `已选 ${filters.statuses.length} 项` : "全部状态"}</summary><div role="group" aria-label="看板状态筛选"><p>满足任一状态，条件会随账号保存</p>{gameStatusValues.map((status) => <label key={status}><input type="checkbox" checked={filters.statuses.includes(status)} onChange={() => toggleStatus(status)} />{gameStatusLabels[status]}</label>)}</div></details></div>
        <label>游戏范围<select value={filters.scope} onChange={(event) => update("scope", event.target.value as DashboardFilters["scope"])}><option value="ALL">全部游戏</option><option value="STEAM_LINKED">仅 Steam 已关联</option></select></label>
        <label>通关趋势<select value={filters.completionWindow} onChange={(event) => update("completionWindow", event.target.value as DashboardFilters["completionWindow"])}><option value="5Y">近 5 年</option><option value="10Y">近 10 年</option><option value="ALL">全部年份</option></select></label>
      </div>
      <button className="secondary-button compact" type="button" onClick={() => setFilters(defaultDashboardFilters)}><RotateCcw size={14} /> 恢复默认</button>
    </section>
    {message ? <div className="inline-alert warning" role="status">{message}</div> : null}
    <section className="metric-grid dashboard-metric-grid" aria-label="核心指标">
      <MetricCard label="游戏记录" value={new Intl.NumberFormat("zh-CN").format(metrics.gameCount)} detail="当前筛选结果" icon={Gamepad2} tone="good" />
      <MetricCard label="通关率" value={percentage(metrics.completionRate)} detail={`${metrics.completedCount} 项已通关`} icon={Trophy} />
      <MetricCard label="累计游玩" value={hours(metrics.playtimeMinutes)} detail="手工值优先，平台值兜底" icon={Clock3} />
      <MetricCard label="平均进度" value={metrics.averageProgress === null ? "—" : percentage(metrics.averageProgress)} detail="仅统计已记录进度的游戏" icon={Gauge} />
    </section>
    <section className="operations-strip" aria-label="系统数据概览">
      <div><HardDrive size={17} /><span><strong>{metrics.assetCount}</strong><small>科技资产</small></span></div>
      <div><PackageOpen size={17} /><span><strong>{metrics.inventorySkuCount}</strong><small>库存 SKU · {metrics.inventoryUnitCount} 件</small></span></div>
      <div className="steam-health"><RefreshCw size={17} /><span><strong>Steam {percentage(data.steamCoverage.coveragePercent)}</strong><small>{data.steamCoverage.matched}/{data.steamCoverage.total} 已关联 · 最近同步 {freshness}</small></span><Link href="/sync">处理 {data.steamCoverage.unmatched} 项待复核</Link></div>
    </section>
    <section className="content-section steam-coverage-panel">
      <div className="chart-heading"><div><h2>Steam 匹配覆盖</h2><p>仅统计当前账号拥有的 Steam 游戏；未匹配记录不会自动创建本地游戏。</p></div><span>{data.steamCoverage.total} 项</span></div>
      <div className="coverage-track" role="img" aria-label={`Steam 已关联 ${data.steamCoverage.matched} 项，待复核 ${data.steamCoverage.unmatched} 项，仅目录 ${data.steamCoverage.catalog} 项，已忽略 ${data.steamCoverage.ignored} 项`}>
        {data.steamCoverage.total ? <>
          <span className="coverage-matched" style={{ width: `${(data.steamCoverage.matched / data.steamCoverage.total) * 100}%` }} />
          <span className="coverage-unmatched" style={{ width: `${(data.steamCoverage.unmatched / data.steamCoverage.total) * 100}%` }} />
          <span className="coverage-catalog" style={{ width: `${(data.steamCoverage.catalog / data.steamCoverage.total) * 100}%` }} />
          <span className="coverage-ignored" style={{ width: `${(data.steamCoverage.ignored / data.steamCoverage.total) * 100}%` }} />
        </> : null}
      </div>
      <div className="coverage-legend"><span><i className="matched" />已关联 {data.steamCoverage.matched}</span><span><i className="unmatched" />待复核 {data.steamCoverage.unmatched}</span><span><i className="catalog" />仅目录 {data.steamCoverage.catalog}</span><span><i className="ignored" />已忽略 {data.steamCoverage.ignored}</span></div>
    </section>
    <DashboardCharts data={data} />
    <p className="dashboard-source-note">数据源：本系统正式业务表与 Steam 官方 GetOwnedGames；生成于 {formatShanghaiDateTime(data.generatedAt)}。</p>
  </>;
}
