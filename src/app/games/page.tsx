import { Search } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { gameQuerySchema, listGames } from "@/server/services/games";
import { getHardwareProfile } from "@/server/services/preferences";
import { GameManager } from "./game-manager";
import { gameGenreLabels, gameGenreValues } from "@/lib/game-genres";
import { gameStatusLabels, gameStatusValues } from "@/lib/game-status";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const platformOptions = [
  ["STEAM", "Steam"],
  ["PLAYSTATION", "PlayStation"],
  ["NINTENDO_SWITCH", "Switch"],
  ["NINTENDO_SWITCH_2", "Switch 2"],
  ["XBOX_GAME_PASS", "XGP"],
  ["PC_OTHER", "PC"],
  ["IOS", "iOS"]
] as const;

export default async function GamesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const parsed = gameQuerySchema.parse({
    q: single(raw.q) ?? "",
    status: raw.status ?? [],
    platform: raw.platform ?? [],
    genre: raw.genre ?? [],
    sort: single(raw.sort) ?? "updated_desc",
    page: single(raw.page) ?? "1",
    pageSize: "30",
    includeDeleted: "false"
  });
  const [result, hardware] = await Promise.all([
    listGames(session.userId, parsed),
    getHardwareProfile(session.userId)
  ]);
  const initialGames = result.games.map((game) => ({
    ...game,
    lastPlayedAt: game.lastPlayedAt?.toISOString() ?? null,
    firstObservedPlayedAt: game.firstObservedPlayedAt?.toISOString() ?? null,
    playtimeLastChangedAt: game.playtimeLastChangedAt?.toISOString() ?? null,
    deletedAt: game.deletedAt?.toISOString() ?? null,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString()
  }));
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageHref = (page: number) => {
    const query = new URLSearchParams({ q: parsed.q, sort: parsed.sort, page: String(page) });
    for (const status of parsed.status) query.append("status", status);
    for (const platform of parsed.platform) query.append("platform", platform);
    for (const genre of parsed.genre) query.append("genre", genre);
    return `?${query.toString()}`;
  };
  const hasFilters = Boolean(parsed.q || parsed.status.length || parsed.platform.length || parsed.genre.length);
  return (
    <AppShell username={session.username} active="/games">
      <header className="page-header"><div><span className="eyebrow">GAME LIBRARY</span><h1>游戏库</h1><p>集中维护名称、发售、评分与游玩事实；入手渠道和双场景队列在“游玩规划”统一管理。</p></div><a className="secondary-button compact" href="/play">打开游玩规划</a></header>
      <section className="filter-bar" aria-label="筛选游戏">
        <form className="filter-form games-filter-form" method="get">
          <label className="search-field"><Search size={15} /><input name="q" aria-label="搜索游戏" defaultValue={parsed.q} placeholder="搜索中英名称、简繁译名或平台别名" /></label>
          <details className="status-filter-menu"><summary>{parsed.status.length ? `状态 ${parsed.status.length} 项` : "全部状态"}</summary><div role="group" aria-label="状态筛选"><p>同组满足任一状态</p>{gameStatusValues.map((status) => <label key={status}><input type="checkbox" name="status" value={status} defaultChecked={parsed.status.includes(status)} />{gameStatusLabels[status]}</label>)}</div></details>
          <details className="status-filter-menu"><summary>{parsed.platform.length ? `平台 ${parsed.platform.length} 项` : "全部平台"}</summary><div role="group" aria-label="平台筛选"><p>同组满足任一平台</p>{platformOptions.map(([value, label]) => <label key={value}><input type="checkbox" name="platform" value={value} defaultChecked={parsed.platform.includes(value)} />{label}</label>)}</div></details>
          <details className="status-filter-menu"><summary>{parsed.genre.length ? `类型 ${parsed.genre.length} 项` : "全部类型"}</summary><div role="group" aria-label="类型筛选"><p>匹配主类型或子标签</p>{gameGenreValues.map((genre) => <label key={genre}><input type="checkbox" name="genre" value={genre} defaultChecked={parsed.genre.includes(genre)} />{gameGenreLabels[genre]}</label>)}</div></details>
          <select name="sort" defaultValue={parsed.sort} aria-label="排序">
            <option value="updated_desc">最近更新</option><option value="name_asc">名称</option><option value="release_asc">发售日期</option>
          </select>
          <button className="secondary-button" type="submit"><Search size={14} />搜索 / 筛选</button>
          {hasFilters ? <a className="text-button filter-reset" href="/games">重置</a> : null}
        </form>
        {hasFilters ? <div className="active-filter-summary" aria-live="polite"><strong>当前条件：</strong>{parsed.q ? <span>搜索：{parsed.q}</span> : null}{parsed.status.map((status) => <span key={status}>状态：{gameStatusLabels[status]}</span>)}{parsed.platform.map((platform) => <span key={platform}>平台：{platformOptions.find(([value]) => value === platform)?.[1] ?? platform}</span>)}{parsed.genre.map((genre) => <span key={genre}>类型：{gameGenreLabels[genre]}</span>)}<a className="text-button" href="/games">清空全部</a><small>“已游玩”表示存在游玩记录且最后游玩已超过 48 小时，不等同于“已通关”。</small></div> : null}
      </section>
      <GameManager key={JSON.stringify({ q: parsed.q, status: parsed.status, platform: parsed.platform, genre: parsed.genre, sort: parsed.sort })} initialGames={initialGames} total={result.total} hardware={hardware} selectionQuery={{
        q: parsed.q,
        status: parsed.status,
        platform: parsed.platform,
        genre: parsed.genre,
        sort: parsed.sort
      }} />
      <nav className="pagination" aria-label="分页">
        {parsed.page > 1 ? <a href={pageHref(parsed.page - 1)}>上一页</a> : <span />}
        <span>第 {parsed.page} / {pages} 页，共 {result.total} 项</span>
        {parsed.page < pages ? <a href={pageHref(parsed.page + 1)}>下一页</a> : <span />}
      </nav>
    </AppShell>
  );
}
