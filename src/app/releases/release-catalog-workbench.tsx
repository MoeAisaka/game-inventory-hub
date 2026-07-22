"use client";

import { useState } from "react";
import { CalendarDays, Check, Clock3, ExternalLink, Heart, RefreshCw, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GameCover } from "@/components/game-cover";
import { formatShanghaiDateTime } from "@/lib/date-format";

type CatalogItem = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string;
  releaseDate: string;
  datePrecision: string;
  storeUrl: string | null;
  coverUrl: string | null;
  summaryZh: string | null;
  summaryEn: string | null;
  developers: string[];
  publishers: string[];
  genresZh: string[];
  genresEn: string[];
  metadataFetchedAt: string | null;
  isComplete: boolean;
  isSelectable: boolean;
  missingLabels: string[];
  listState: "NOT_ADDED" | "ADDED";
  planOrder: number | null;
  platforms: string[];
  variants: Array<{
    id: string;
    platform: string;
    releaseDate: string;
    datePrecision: string;
    storeProvider: string | null;
    storeExternalGameId: string | null;
    storeUrl: string | null;
    isSelectable: boolean;
  }>;
};

type CatalogQuery = {
  q: string;
  platform: string[];
  readiness: "ALL" | "READY" | "PENDING";
  listState: "ALL" | "NOT_ADDED" | "ADDED";
  window: "6M" | "12M" | "24M";
  sort: "ready_date" | "date_asc" | "date_desc" | "name_asc";
  page: number;
  pageSize: number;
};

const platformOptions = [
  ["STEAM", "Steam"],
  ["PLAYSTATION", "PlayStation"],
  ["NINTENDO_SWITCH", "Switch"],
  ["NINTENDO_SWITCH_2", "Switch 2"],
  ["PC_OTHER", "PC"]
] as const;

const platformLabels: Record<string, string> = {
  STEAM: "Steam",
  PLAYSTATION: "PlayStation",
  NINTENDO_SWITCH: "Nintendo Switch",
  NINTENDO_SWITCH_2: "Nintendo Switch 2",
  PC_OTHER: "PC"
};

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

function precisionLabel(releaseDate: string, precision: string) {
  if (precision === "YEAR") return `${releaseDate.slice(0, 4)} 年`;
  if (precision === "MONTH") return `${releaseDate.slice(0, 7)} 月`;
  if (precision === "QUARTER") return `${releaseDate.slice(0, 4)} Q${Math.ceil(Number(releaseDate.slice(5, 7)) / 3)}`;
  return releaseDate;
}

function pageHref(query: CatalogQuery, page: number) {
  const params = new URLSearchParams({
    view: "catalog",
    q: query.q,
    readiness: query.readiness,
    listState: query.listState,
    window: query.window,
    sort: query.sort,
    page: String(page),
    pageSize: String(query.pageSize)
  });
  query.platform.forEach((platform) => params.append("platform", platform));
  return `/wishlist?${params.toString()}`;
}

export function ReleaseCatalogWorkbench({
  items,
  total,
  counts,
  page,
  pageCount,
  latestFetchedAt,
  query
}: {
  items: CatalogItem[];
  total: number;
  counts: { total: number; ready: number; selectable: number; pending: number; added: number };
  page: number;
  pageCount: number;
  latestFetchedAt: string | null;
  query: CatalogQuery;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [selectingItem, setSelectingItem] = useState<CatalogItem | null>(null);

  async function select(item: CatalogItem, eventId: string) {
    const busyKey = `${eventId}:ADDED`;
    setBusy(busyKey);
    setMessage("");
    try {
      await api(`/api/v1/releases/${eventId}/selection`, {
        method: "POST",
        body: JSON.stringify({ target: "WISHLIST" })
      });
      setSelectingItem(null);
      setMessage(`已将“${item.nameZh}”加入心愿单。入手时可再次选择具体平台与渠道。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加入清单失败");
    } finally {
      setBusy(null);
    }
  }

  return <>
    <section className="release-catalog-overview" aria-label="发售目录状态">
      <div><Sparkles size={18} /><span>可加入清单<strong>{counts.selectable}</strong><small>商店身份已确认</small></span></div>
      <div><Clock3 size={18} /><span>资料补全中<strong>{counts.pending}</strong><small>不阻断收藏意图</small></span></div>
      <div><Heart size={18} /><span>已加入清单<strong>{counts.added}</strong><small>待购入与愿望统一维护</small></span></div>
    </section>

    <section className="release-catalog-toolbar" aria-label="筛选发售目录">
      <form method="get">
        <input type="hidden" name="view" value="catalog" />
        <label className="release-catalog-search"><span className="sr-only">搜索发售目录</span><input name="q" defaultValue={query.q} placeholder="搜索中英文名、厂商或类型" /></label>
        <details className="status-filter-menu"><summary>{query.platform.length ? `平台 ${query.platform.length} 项` : "全部平台"}</summary><div role="group" aria-label="平台筛选"><p>同组满足任一平台</p>{platformOptions.map(([value, label]) => <label key={value}><input type="checkbox" name="platform" value={value} defaultChecked={query.platform.includes(value)} />{label}</label>)}</div></details>
        <select name="readiness" defaultValue={query.readiness} aria-label="资料完整度"><option value="ALL">全部完整度</option><option value="READY">仅资料齐全</option><option value="PENDING">仅补全中</option></select>
        <select name="listState" defaultValue={query.listState} aria-label="清单状态"><option value="ALL">全部清单状态</option><option value="NOT_ADDED">尚未加入</option><option value="ADDED">已加入清单</option></select>
        <select name="window" defaultValue={query.window} aria-label="发售时间范围"><option value="6M">未来 6 个月</option><option value="12M">未来 12 个月</option><option value="24M">未来 24 个月</option></select>
        <select name="sort" defaultValue={query.sort} aria-label="排序"><option value="ready_date">资料齐全优先 · 发售日</option><option value="date_asc">发售日从近到远</option><option value="date_desc">发售日从远到近</option><option value="name_asc">名称排序</option></select>
        <button className="primary-button compact" type="submit">应用</button>
        <Link className="text-button" href="/wishlist?view=catalog">重置</Link>
      </form>
      <div className="release-catalog-sync-state"><RefreshCw size={13} /><span>每 6 小时检查平台目录{latestFetchedAt ? ` · 最近 ${formatShanghaiDateTime(latestFetchedAt)}` : ""}</span></div>
    </section>

    {message ? <div className="inline-alert release-catalog-alert" aria-live="polite">{message}</div> : null}

    {items.length ? <section className="release-catalog-grid" aria-label="发售目录候选">
      {items.map((item) => <article className={item.isComplete ? "release-catalog-card ready" : "release-catalog-card pending"} key={item.id}>
        <div className="release-catalog-cover"><GameCover src={item.coverUrl} alt={`${item.nameZh}封面`} /><span>{item.platforms.map((platform) => platformLabels[platform] ?? platform).join(" / ")}</span></div>
        <div className="release-catalog-body">
          <header>
            <div><span className={item.isComplete ? "catalog-ready-badge" : "catalog-pending-badge"}>{item.isComplete ? <><Check size={11} />资料完整</> : <><Clock3 size={11} />补全中</>}</span><span className="catalog-release-date"><CalendarDays size={11} />{precisionLabel(item.releaseDate, item.datePrecision)}</span></div>
            {item.storeUrl ? <a href={item.storeUrl} target="_blank" rel="noreferrer" aria-label={`打开${item.nameZh}平台商店`}><ExternalLink size={15} /></a> : null}
          </header>
          <h2>{item.nameZh}</h2>
          <p className="release-catalog-en">{item.nameEn ?? "英文名待补全"}</p>
          <p className="release-catalog-summary">{item.summaryZh ?? "中文简介正在从平台补全。"}</p>
          <div className="release-catalog-facts">
            <span><small>开发</small>{item.developers.join(" / ") || "待补全"}</span>
            <span><small>发行</small>{item.publishers.join(" / ") || "待补全"}</span>
            <span><small>类型</small>{(item.genresZh.length ? item.genresZh : item.genresEn).join(" · ") || "待补全"}</span>
          </div>
          {!item.isComplete ? <p className="release-catalog-missing">仍缺：{item.missingLabels.join("、")}</p> : null}
        </div>
        <footer>
          {item.listState === "ADDED" ? <span className="release-catalog-selected"><Heart size={13} />已加入心愿单</span> : <span className="release-catalog-selected muted">尚未加入心愿</span>}
          <div>
            <button className="primary-button" disabled={!item.isSelectable || busy !== null || item.listState === "ADDED"} title={item.isSelectable ? undefined : "平台商店身份尚未确认"} onClick={() => setSelectingItem(item)}>
              <Heart size={13} />选择平台并加入心愿
            </button>
          </div>
        </footer>
      </article>)}
    </section> : <div className="empty-state release-catalog-empty"><Sparkles size={26} /><p>当前筛选下没有候选。可尝试搜索中英文名、别名或平台；目录每 6 小时刷新。</p></div>}

    <nav className="release-catalog-pagination" aria-label="目录分页">
      <span>筛选结果 {total} 项 · 第 {page}/{pageCount} 页</span>
      <div>{page > 1 ? <Link className="secondary-button" href={pageHref(query, page - 1)}>上一页</Link> : null}{page < pageCount ? <Link className="secondary-button" href={pageHref(query, page + 1)}>下一页</Link> : null}</div>
    </nav>
    {selectingItem ? <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setSelectingItem(null); }}><div className="modal-panel narrow platform-choice-panel" role="dialog" aria-modal="true" aria-labelledby="catalog-platform-title">
      <header><div><span className="eyebrow">CHOOSE PLATFORM</span><h2 id="catalog-platform-title">选择心愿平台</h2><p>“{selectingItem.nameZh}”包含多个平台版本，只会创建一条作品心愿。</p></div><button className="icon-button" aria-label="关闭" onClick={() => setSelectingItem(null)}><X size={18} /></button></header>
      <div className="platform-choice-list">{selectingItem.variants.filter((variant) => variant.isSelectable).map((variant) => <button key={variant.id} disabled={busy !== null} onClick={() => select(selectingItem, variant.id)}><span><strong>{platformLabels[variant.platform] ?? variant.platform}</strong><small>{precisionLabel(variant.releaseDate, variant.datePrecision)}</small></span>{busy === `${variant.id}:ADDED` ? <RefreshCw size={15} className="spin" /> : <Heart size={15} />}</button>)}</div>
      <p className="platform-choice-note">加入后仍可在心愿卡片中改选平台；选择入手渠道后会自动转入候玩池。</p>
    </div></div> : null}
  </>;
}
