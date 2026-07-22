import { CalendarDays, ExternalLink, Star } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { gameGenreLabels, gameGenreValues } from "@/lib/game-genres";
import { listReleaseCalendar, listReleaseCatalog, releaseCalendarQuerySchema, releaseCatalogQuerySchema } from "@/server/services/releases";
import { listWishlist, wishlistQuerySchema } from "@/server/services/wishlist";
import { ReleaseCalendarAction } from "../releases/release-calendar-action";
import { ReleaseCatalogWorkbench } from "../releases/release-catalog-workbench";
import { WishlistManager } from "./wishlist-manager";

export const dynamic = "force-dynamic";

const platformOptions = [
  ["STEAM", "Steam"], ["PLAYSTATION", "PlayStation"], ["NINTENDO_SWITCH", "Switch"],
  ["NINTENDO_SWITCH_2", "Switch 2"], ["XBOX_GAME_PASS", "XGP"], ["PC_OTHER", "PC"], ["IOS", "iOS"]
] as const;

const sourceLabels: Record<string, string> = {
  MANUAL: "手工", IMPORT: "原表", STEAM: "Steam", IGDB: "IGDB", RAWG: "RAWG",
  PLAYSTATION: "PlayStation", NINTENDO: "Nintendo", WEB: "网页核验"
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date());
}

function adjacentMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

function precisionLabel(releaseDate: string, precision: string) {
  const year = releaseDate.slice(0, 4);
  if (precision === "YEAR") return `${year} 年`;
  if (precision === "MONTH") return `${releaseDate.slice(0, 7)} 月`;
  if (precision === "QUARTER") return `${year} Q${Math.ceil(Number(releaseDate.slice(5, 7)) / 3)}`;
  return releaseDate;
}

function HubTabs({ view }: { view: "list" | "catalog" | "calendar" }) {
  return <nav className="release-view-tabs wishlist-hub-tabs" aria-label="心愿单页面视图">
    <Link className={view === "list" ? "active" : ""} href="/wishlist?view=list">心愿清单</Link>
    <Link className={view === "catalog" ? "active" : ""} href="/wishlist?view=catalog">发现游戏</Link>
    <Link className={view === "calendar" ? "active" : ""} href="/wishlist?view=calendar">发售日历</Link>
  </nav>;
}

export default async function WishlistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const requestedView = single(raw.view);
  const view = requestedView === "catalog" || requestedView === "calendar" ? requestedView : "list";

  if (view === "list") {
    const parsed = wishlistQuerySchema.parse({
      q: single(raw.q) ?? "",
      provider: single(raw.provider) || undefined,
      genre: single(raw.genre) || undefined
    });
    const result = await listWishlist(session.userId, parsed);
    const items = result.items.map((item) => ({
      ...item,
      provider: item.provider as "STEAM" | "PLAYSTATION" | "NINTENDO",
      addedAt: item.addedAt?.toISOString() ?? null,
      lastSeenAt: item.lastSeenAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    }));
    return <AppShell username={session.username} active="/wishlist">
      <header className="page-header"><div><span className="eyebrow">WISH HUB</span><h1>心愿单</h1><p>心愿、游戏发现与发售时间集中在一个工作台；选定平台和入手渠道后自动排入“接下来玩”。</p></div><span className="count-badge">{result.total} 项</span></header>
      <HubTabs view="list" />
      <section className="filter-bar" aria-label="筛选心愿单"><form className="filter-form" method="get">
        <input type="hidden" name="view" value="list" />
        <label className="search-field"><input name="q" aria-label="搜索心愿单" defaultValue={parsed.q} placeholder="搜索游戏名称" /></label>
        <select name="provider" defaultValue={parsed.provider ?? ""} aria-label="心愿单平台"><option value="">全部平台</option><option value="STEAM">Steam</option><option value="PLAYSTATION">PlayStation</option><option value="NINTENDO">Nintendo</option></select>
        <select name="genre" defaultValue={parsed.genre ?? ""} aria-label="心愿单类型"><option value="">全部类型</option>{gameGenreValues.map((genre) => <option key={genre} value={genre}>{gameGenreLabels[genre]}</option>)}</select>
        <button className="secondary-button" type="submit">搜索 / 筛选</button>
        {parsed.q || parsed.provider || parsed.genre ? <a className="text-button filter-reset" href="/wishlist?view=list">重置</a> : null}
      </form></section>
      <WishlistManager initialItems={items} total={result.total} />
    </AppShell>;
  }

  if (view === "catalog") {
    const query = releaseCatalogQuerySchema.parse({
      q: single(raw.q) ?? "", platform: raw.platform ?? [], readiness: single(raw.readiness) ?? "ALL",
      listState: single(raw.listState) ?? "ALL", window: single(raw.window) ?? "24M",
      sort: single(raw.sort) ?? "ready_date", page: single(raw.page) ?? "1", pageSize: single(raw.pageSize) ?? "24"
    });
    const catalog = await listReleaseCatalog(session.userId, query);
    const items = catalog.items.map((item) => ({
      ...item,
      metadataFetchedAt: item.metadataFetchedAt?.toISOString() ?? null,
      fetchedAt: item.fetchedAt.toISOString(), createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString()
    }));
    return <AppShell username={session.username} active="/wishlist">
      <header className="page-header release-page-header"><div><span className="eyebrow">WISH DISCOVERY</span><h1>发现游戏</h1><p>同一作品的多平台版本自动合并；加入心愿时先选择具体平台。</p></div><span className="count-badge">作品 {catalog.counts.total} 项</span></header>
      <HubTabs view="catalog" />
      <ReleaseCatalogWorkbench items={items} total={catalog.total} counts={catalog.counts} page={catalog.page} pageCount={catalog.pageCount} latestFetchedAt={catalog.latestFetchedAt?.toISOString() ?? null} query={query} />
    </AppShell>;
  }

  const parsed = releaseCalendarQuerySchema.parse({ month: single(raw.month) ?? currentMonth(), platform: raw.platform ?? [] });
  const calendar = await listReleaseCalendar(session.userId, parsed);
  const byDay = new Map<number, typeof calendar.events>();
  for (const event of calendar.events) {
    const day = Number(event.releaseDate.slice(8, 10));
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  const href = (month: string) => {
    const query = new URLSearchParams({ view: "calendar", month });
    parsed.platform.forEach((platform) => query.append("platform", platform));
    return `/wishlist?${query.toString()}`;
  };
  const cells = [...Array.from({ length: calendar.firstWeekday }, () => null), ...Array.from({ length: calendar.daysInMonth }, (_, index) => index + 1)];
  const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const catalogHref = (name: string) => `/wishlist?view=catalog&q=${encodeURIComponent(name)}`;
  return <AppShell username={session.username} active="/wishlist">
    <header className="page-header release-page-header"><div><span className="eyebrow">WISH CALENDAR</span><h1>发售日历</h1><p>多平台同日发售自动归并为一张作品卡；加入心愿时仍保留具体平台版本。</p></div><span className="count-badge">心愿 {calendar.wishlistCount} 项</span></header>
    <HubTabs view="calendar" />
    <section className="filter-bar release-toolbar"><form className="filter-form" method="get">
      <label className="month-field">月份<input type="month" name="month" defaultValue={parsed.month} /></label>
      <details className="status-filter-menu"><summary>{parsed.platform.length ? `平台 ${parsed.platform.length} 项` : "全部平台"}</summary><div role="group" aria-label="平台筛选"><p>同组满足任一平台</p>{platformOptions.map(([value, label]) => <label key={value}><input type="checkbox" name="platform" value={value} defaultChecked={parsed.platform.includes(value)} />{label}</label>)}</div></details>
      <button className="secondary-button" type="submit">筛选</button><input type="hidden" name="view" value="calendar" />
      <Link className="text-button filter-reset" href="/wishlist?view=calendar">回到本月</Link>
    </form><div className="month-nav"><Link href={href(adjacentMonth(parsed.month, -1))}>上月</Link><strong>{parsed.month}</strong><Link href={href(adjacentMonth(parsed.month, 1))}>下月</Link></div></section>
    <section className="release-calendar" aria-label={`${parsed.month} 发售日历`}><div className="release-weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div><div className="release-grid">{cells.map((day, index) => day === null ? <div className="release-day empty" key={`empty-${index}`} /> : (() => {
      const events = byDay.get(day) ?? [];
      const weekday = weekdayLabels[(calendar.firstWeekday + day - 1) % 7];
      return <div className={`release-day ${events.length ? "has-events" : "no-events"}`} key={day}><strong className="release-day-label"><span>{day}</span><small>{weekday}</small></strong><div>{events.map((event) => {
        const queryName = event.nameEn?.trim() || event.nameZh;
        const detailHref = catalogHref(queryName);
        return <article key={`${event.groupKey}:${event.releaseDate}`} className={event.isWishlisted ? "wishlisted" : undefined}>
          <span>{event.platforms.join(" / ")}{event.isWishlisted ? <em><Star size={9} fill="currentColor" />心愿单</em> : null}</span>
          <Link className="release-calendar-title" href={detailHref}><b>{event.nameZh}</b>{event.nameEn && event.nameEn !== event.nameZh ? <small>{event.nameEn}</small> : null}</Link>
          <footer><span>{sourceLabels[event.source] ?? event.source}{event.storeUrl ? <a href={event.storeUrl} target="_blank" rel="noreferrer" aria-label="打开商店"><ExternalLink size={11} /></a> : null}</span><ReleaseCalendarAction variants={event.variants} name={event.nameZh} isWishlisted={event.isWishlisted} catalogHref={detailHref} /></footer>
        </article>;
      })}</div></div>;
    })())}</div></section>
    {calendar.approximate.length ? <section className="content-section release-approximate"><div className="section-heading"><div><h2>{parsed.month.slice(0, 4)} 年暂未公布具体日期</h2><p>只保留真实精度，不把季度或年份伪装成某一天。</p></div><span className="count-badge">{calendar.approximate.length} 项</span></div><div className="release-approximate-list">{calendar.approximate.map((event) => <article key={`${event.groupKey}:${event.releaseDate}`}><span>{precisionLabel(event.releaseDate, event.datePrecision)}</span><strong>{event.nameZh}</strong><small>{event.platforms.join(" / ")} · {sourceLabels[event.source] ?? event.source}{event.isWishlisted ? " · 心愿单" : ""}</small></article>)}</div></section> : null}
    {!calendar.events.length && !calendar.approximate.length ? <div className="empty-state"><CalendarDays size={26} /><p>本月暂无已公布的发行记录。</p></div> : null}
  </AppShell>;
}
