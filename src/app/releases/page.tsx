import { CalendarDays, ExternalLink } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { listReleaseCalendar, releaseCalendarQuerySchema } from "@/server/services/releases";

export const dynamic = "force-dynamic";

const platformOptions = [
  ["STEAM", "Steam"],
  ["PLAYSTATION", "PlayStation"],
  ["NINTENDO_SWITCH", "Switch"],
  ["NINTENDO_SWITCH_2", "Switch 2"],
  ["XBOX_GAME_PASS", "XGP"],
  ["PC_OTHER", "PC"],
  ["IOS", "iOS"]
] as const;

const sourceLabels: Record<string, string> = {
  MANUAL: "手工",
  IMPORT: "原表",
  STEAM: "Steam",
  IGDB: "IGDB",
  RAWG: "RAWG",
  PLAYSTATION: "PlayStation",
  NINTENDO: "Nintendo"
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(new Date());
}

function adjacentMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

export default async function ReleasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const parsed = releaseCalendarQuerySchema.parse({
    month: single(raw.month) ?? currentMonth(),
    platform: raw.platform ?? []
  });
  const calendar = await listReleaseCalendar(session.userId, parsed);
  const byDay = new Map<number, typeof calendar.events>();
  for (const event of calendar.events) {
    const day = Number(event.releaseDate.slice(8, 10));
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  const href = (month: string) => {
    const query = new URLSearchParams({ month });
    parsed.platform.forEach((platform) => query.append("platform", platform));
    return `/releases?${query.toString()}`;
  };
  const cells = [
    ...Array.from({ length: calendar.firstWeekday }, () => null),
    ...Array.from({ length: calendar.daysInMonth }, (_, index) => index + 1)
  ];
  return <AppShell username={session.username} active="/releases">
    <header className="page-header"><div><span className="eyebrow">RELEASE CALENDAR</span><h1>游戏发售日历</h1><p>统一查看 Steam、PlayStation、Switch 2 等平台的发行记录；同一游戏允许保留多个平台日期。</p></div></header>
    <section className="filter-bar release-toolbar">
      <form className="filter-form" method="get">
        <label className="month-field">月份<input type="month" name="month" defaultValue={parsed.month} /></label>
        <details className="status-filter-menu"><summary>{parsed.platform.length ? `平台 ${parsed.platform.length} 项` : "全部平台"}</summary><div role="group" aria-label="平台筛选"><p>同组满足任一平台</p>{platformOptions.map(([value, label]) => <label key={value}><input type="checkbox" name="platform" value={value} defaultChecked={parsed.platform.includes(value)} />{label}</label>)}</div></details>
        <button className="secondary-button" type="submit">筛选</button>
        <Link className="text-button filter-reset" href="/releases">回到本月</Link>
      </form>
      <div className="month-nav"><Link href={href(adjacentMonth(parsed.month, -1))}>上月</Link><strong>{parsed.month}</strong><Link href={href(adjacentMonth(parsed.month, 1))}>下月</Link></div>
    </section>
    <section className="release-calendar" aria-label={`${parsed.month} 发售日历`}>
      <div className="release-weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="release-grid">{cells.map((day, index) => day === null
        ? <div className="release-day empty" key={`empty-${index}`} />
        : <div className="release-day" key={day}><strong>{day}</strong><div>{(byDay.get(day) ?? []).map((event) => <article key={event.id}><span>{event.platform}</span><b>{event.nameZh}</b>{event.nameEn ? <small>{event.nameEn}</small> : null}<footer>{sourceLabels[event.source] ?? event.source}{event.storeUrl ? <a href={event.storeUrl} target="_blank" rel="noreferrer" aria-label="打开商店"><ExternalLink size={11} /></a> : null}</footer></article>)}</div></div>)}</div>
    </section>
    {!calendar.events.length ? <div className="empty-state"><CalendarDays size={26} /><p>本月暂无已同步的发售记录。后续平台同步会自动写入这里。</p></div> : null}
  </AppShell>;
}
