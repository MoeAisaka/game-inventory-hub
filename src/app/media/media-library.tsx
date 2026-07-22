"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  CloudDownload,
  Gamepad2,
  HardDrive,
  ImagePlus,
  Images,
  Maximize2,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";

type MediaItem = {
  id: string;
  gameId: string;
  gameName: string;
  gameNameEn: string | null;
  gameCoverUrl: string | null;
  source: "MANUAL" | "STEAM";
  sourceUrl: string | null;
  title: string | null;
  capturedAt: string | null;
  width: number;
  height: number;
  createdAt: string;
  byteSize: number;
};

type Album = {
  mediaId: string;
  gameId: string;
  gameName: string;
  gameNameEn: string | null;
  gameCoverUrl: string | null;
  capturedAt: string | null;
  createdAt: string;
  count: number;
};

type GameOption = { id: string; nameZh: string; nameEn: string | null; coverUrl: string | null };

type Props = {
  items: MediaItem[];
  albums: Album[];
  gameOptions: GameOption[];
  stats: { total: number; gameCount: number; totalBytes: number; steamCount: number; manualCount: number };
  total: number;
  query: { q: string; gameId?: string; source?: "MANUAL" | "STEAM"; page: number; pageSize: number };
};

function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${Math.max(0, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatDate(value: string | null) {
  if (!value) return "日期未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC"
  }).format(new Date(value));
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? `请求失败（${response.status}）`;
}

export function MediaLibrary({ items, albums, gameOptions, stats, total, query }: Props) {
  const router = useRouter();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [gameSearch, setGameSearch] = useState("");
  const [selectedGameId, setSelectedGameId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [capturedDate, setCapturedDate] = useState("");
  const selectedGame = gameOptions.find((game) => game.id === selectedGameId) ?? null;
  const gameMatches = useMemo(() => {
    const normalized = gameSearch.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return gameOptions.slice(0, 10);
    return gameOptions.filter((game) => `${game.nameZh} ${game.nameEn ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, 12);
  }, [gameOptions, gameSearch]);

  function notify(text: string, tone: "success" | "error" = "success") {
    setMessage(text);
    setMessageTone(tone);
  }

  async function syncSteam() {
    setBusy(true);
    notify("正在读取 Steam 公开截图并生成缩略图，首次同步可能需要几分钟…");
    try {
      const response = await fetch("/api/v1/sync/steam-screenshots", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() }
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { data: { summary?: { createdCount: number; duplicateCount: number; unmatchedCount: number; failedCount: number; dateBackfilledCount?: number; dateBackfillFailedCount?: number } } };
      const summary = payload.data.summary;
      notify(summary
        ? `Steam 同步完成：新增 ${summary.createdCount} 张，已有 ${summary.duplicateCount} 张，未匹配游戏 ${summary.unmatchedCount} 张，失败 ${summary.failedCount} 张；日期补齐 ${summary.dateBackfilledCount ?? 0} 张，日期失败 ${summary.dateBackfillFailedCount ?? 0} 张。`
        : "Steam 截图同步任务已处理。");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Steam 截图同步失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function uploadMedia(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedGameId) return notify("请先选择游戏", "error");
    if (!files.length) return notify("请选择至少一张图片", "error");
    if (files.length > 12) return notify("单次最多上传 12 张图片", "error");
    setBusy(true);
    let created = 0;
    let duplicate = 0;
    try {
      for (const file of files) {
        const body = new FormData();
        body.set("gameId", selectedGameId);
        body.set("file", file);
        if (title.trim()) body.set("title", title.trim());
        if (capturedDate) body.set("capturedAt", new Date(`${capturedDate}T12:00:00`).toISOString());
        const response = await fetch("/api/v1/media", { method: "POST", body });
        if (!response.ok) throw new Error(`${file.name}：${await responseMessage(response)}`);
        const payload = await response.json() as { data: { created: boolean } };
        if (payload.data.created) created += 1;
        else duplicate += 1;
      }
      notify(`上传完成：新增 ${created} 张${duplicate ? `，去重 ${duplicate} 张` : ""}。`);
      setUploadOpen(false);
      setFiles([]);
      setTitle("");
      setCapturedDate("");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "上传图片失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: MediaItem) {
    if (!window.confirm(`从媒体库移除「${item.title || item.gameName}」？原图暂不物理删除，可以恢复。`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/media/${item.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseMessage(response));
      if (lightbox?.id === item.id) setLightbox(null);
      notify("已从媒体库移除。");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "移除图片失败", "error");
    } finally {
      setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.gameId) params.set("gameId", query.gameId);
    if (query.source) params.set("source", query.source);
    params.set("page", String(page));
    return `/media?${params.toString()}`;
  };

  return <>
    <header className="page-header media-header">
      <div><span className="eyebrow">GAME MEDIA LIBRARY</span><h1>游戏媒体库</h1><p>集中保存 Steam 截图和手工上传图片，原图留在 NAS，缩略图用于快速浏览。</p></div>
      <div className="header-actions media-header-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={syncSteam}><CloudDownload size={15} />{busy ? "处理中…" : "同步 Steam 截图"}</button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => setUploadOpen(true)}><Upload size={15} />上传图片</button>
      </div>
    </header>

    {message ? <div className={`inline-alert ${messageTone === "error" ? "error" : ""}`} aria-live="polite">{message}</div> : null}

    <section className="media-summary" aria-label="媒体库统计">
      <div><Images size={17} /><span><strong>{stats.total}</strong><small>张图片</small></span></div>
      <div><Gamepad2 size={17} /><span><strong>{stats.gameCount}</strong><small>个游戏相册</small></span></div>
      <div><CloudDownload size={17} /><span><strong>{stats.steamCount}</strong><small>Steam 同步</small></span></div>
      <div><ImagePlus size={17} /><span><strong>{stats.manualCount}</strong><small>手工上传</small></span></div>
      <div><HardDrive size={17} /><span><strong>{formatBytes(stats.totalBytes)}</strong><small>NAS 原图体积</small></span></div>
    </section>

    {albums.length ? <section className="album-strip" aria-label="游戏相册">
      <div className="album-strip-heading"><div><span className="eyebrow">ALBUMS</span><h2>游戏相册</h2></div>{query.gameId ? <a href="/media">查看全部</a> : <small>按截图数量排序</small>}</div>
      <div className="album-rail">
        {albums.map((album) => <a className={query.gameId === album.gameId ? "album-tile active" : "album-tile"} href={`/media?gameId=${album.gameId}`} key={album.gameId}>
          <Image src={`/api/v1/media/${album.mediaId}/content?variant=thumbnail`} alt="" width={62} height={50} unoptimized />
          <span><strong>{album.gameName}</strong><small>{album.count} 张</small></span>
        </a>)}
      </div>
    </section> : null}

    <section className="media-toolbar">
      <form method="get" className="filter-form media-filter-form">
        <label className="search-field"><Search size={15} /><input name="q" defaultValue={query.q} placeholder="搜索游戏名称或截图标题" /></label>
        {query.gameId ? <input type="hidden" name="gameId" value={query.gameId} /> : null}
        <select name="source" defaultValue={query.source ?? ""} aria-label="图片来源"><option value="">全部来源</option><option value="STEAM">Steam</option><option value="MANUAL">手工上传</option></select>
        <button className="secondary-button" type="submit"><Search size={14} />搜索</button>
        {(query.q || query.gameId || query.source) ? <a className="text-button" href="/media">清空</a> : null}
      </form>
      <span>{total} 张{query.gameId ? "，当前相册" : ""}</span>
    </section>

    {items.length ? <section className="media-grid" aria-label="截图列表">
      {items.map((item) => <article className="media-card" key={item.id}>
        <button className="media-preview" type="button" onClick={() => setLightbox(item)} aria-label={`查看 ${item.title || item.gameName} 原图`}>
          <Image src={`/api/v1/media/${item.id}/content?variant=thumbnail`} alt={item.title || `${item.gameName} 截图`} width={item.width} height={item.height} unoptimized />
          <span className="media-expand"><Maximize2 size={15} /></span>
          <span className={`media-source ${item.source.toLowerCase()}`}>{item.source === "STEAM" ? "STEAM" : "UPLOAD"}</span>
        </button>
        <div className="media-card-copy"><div><strong>{item.gameName}</strong><span>{item.title || "未命名截图"}</span></div><small>{formatDate(item.capturedAt)} · {item.width}×{item.height} · {formatBytes(item.byteSize)}</small></div>
        <button className="media-remove" type="button" disabled={busy} onClick={() => remove(item)} aria-label="移除图片"><Trash2 size={14} /></button>
      </article>)}
    </section> : <section className="media-empty"><Images size={30} /><strong>{stats.total ? "没有匹配当前条件的图片" : "媒体库还是空的"}</strong><p>{stats.total ? "试试清空筛选条件。" : "可以先同步 Steam 公开截图，或给任意游戏上传图片。"}</p></section>}

    {pages > 1 ? <nav className="pagination" aria-label="媒体库分页">
      {query.page > 1 ? <a href={pageHref(query.page - 1)}>上一页</a> : <span />}
      <span>第 {query.page} / {pages} 页</span>
      {query.page < pages ? <a href={pageHref(query.page + 1)}>下一页</a> : <span />}
    </nav> : null}

    {uploadOpen ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setUploadOpen(false); }}>
      <div className="modal-panel media-upload-modal" role="dialog" aria-modal="true" aria-labelledby="media-upload-title">
        <header><div><span className="eyebrow">UPLOAD TO NAS</span><h2 id="media-upload-title">上传游戏图片</h2><p>JPEG、PNG 或 WebP；单张最大 25 MB，单次最多 12 张。</p></div><button className="icon-button" type="button" disabled={busy} onClick={() => setUploadOpen(false)} aria-label="关闭"><X size={18} /></button></header>
        <form onSubmit={uploadMedia}>
          <fieldset className="game-form-section media-game-picker"><legend>归属游戏</legend>
            {selectedGame ? <div className="selected-media-game"><span><strong>{selectedGame.nameZh}</strong><small>{selectedGame.nameEn || "已选择"}</small></span><button type="button" onClick={() => setSelectedGameId("")}>重选</button></div> : <>
              <label className="search-field"><Search size={15} /><input value={gameSearch} onChange={(event) => setGameSearch(event.target.value)} placeholder={`搜索 ${gameOptions.length} 款平台游戏`} autoFocus /></label>
              <div className="media-game-results">{gameMatches.map((game) => <button type="button" key={game.id} onClick={() => setSelectedGameId(game.id)}><strong>{game.nameZh}</strong><small>{game.nameEn || "中文名称"}</small></button>)}</div>
            </>}
          </fieldset>
          <fieldset className="game-form-section"><legend>图片与说明</legend>
            <label className="media-file-drop"><ImagePlus size={24} /><strong>{files.length ? `已选 ${files.length} 张图片` : "选择图片"}</strong><span>{files.length ? files.map((file) => file.name).join("、") : "支持多选，内容指纹相同时自动去重"}</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 12))} /></label>
            <div className="form-grid"><label className="span-2">标题（可选）<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="例如：首次到达黄金树" /></label><label>拍摄日期（可选）<input type="date" value={capturedDate} onChange={(event) => setCapturedDate(event.target.value)} /></label></div>
          </fieldset>
          <footer><button className="secondary-button" type="button" disabled={busy} onClick={() => setUploadOpen(false)}>取消</button><button className="primary-button" disabled={busy || !selectedGameId || !files.length}>{busy ? "上传中…" : files.length ? `上传 ${files.length} 张` : "上传图片"}</button></footer>
        </form>
      </div>
    </div> : null}

    {lightbox ? <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${lightbox.gameName} 原图`}>
      <button className="media-lightbox-close" type="button" onClick={() => setLightbox(null)} aria-label="关闭"><X size={21} /></button>
      <div className="media-lightbox-stage" onClick={() => setLightbox(null)}><Image src={`/api/v1/media/${lightbox.id}/content?variant=original`} alt={lightbox.title || `${lightbox.gameName} 截图`} width={lightbox.width} height={lightbox.height} unoptimized onClick={(event) => event.stopPropagation()} /></div>
      <footer><div><span>{lightbox.source === "STEAM" ? "STEAM" : "UPLOAD"}</span><strong>{lightbox.gameName}</strong><small>{lightbox.title || "未命名截图"} · {formatDate(lightbox.capturedAt)}</small></div><button type="button" onClick={() => remove(lightbox)} disabled={busy}><Trash2 size={15} />移除</button></footer>
    </div> : null}
  </>;
}
