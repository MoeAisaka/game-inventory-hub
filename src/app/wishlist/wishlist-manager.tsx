"use client";

import { useState, type FormEvent } from "react";
import { Disc3, ExternalLink, Gift, Heart, Plus, ShoppingBag, Trash2, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { gameGenreLabels, type GameGenre } from "@/lib/game-genres";
import { providerForPlatform, recommendedChannel } from "@/lib/game-state-engine";
import type { PurchaseAdvice } from "@/lib/purchase-advisor";

type Provider = "STEAM" | "PLAYSTATION" | "NINTENDO";
type PlatformSelection = {
  provider: Provider;
  platform: string;
  externalGameId: string | null;
  storeUrl: string | null;
  catalogEventId: string | null;
  releaseDate?: string;
  isSelectable?: boolean;
};

type WishlistItemView = {
  id: string;
  provider: Provider;
  externalGameId: string;
  name: string;
  displayName: string;
  platform: string | null;
  releaseDate: string | null;
  releaseDatePrecision: string;
  storeUrl: string | null;
  coverUrl: string | null;
  matchedGameId: string | null;
  source: "MANUAL" | "PLATFORM";
  planOrder: number | null;
  addedAt: string | null;
  lastSeenAt: string;
  platformVariants: Array<Omit<PlatformSelection, "provider"> & { provider: Provider | null }>;
  genres: GameGenre[];
  purchaseAdvice: PurchaseAdvice | null;
};

const providerLabels: Record<Provider, string> = { STEAM: "Steam", PLAYSTATION: "PlayStation", NINTENDO: "Nintendo" };
const platformLabels: Record<string, string> = {
  STEAM: "Steam", PLAYSTATION: "PlayStation", PS5: "PlayStation 5", PS4: "PlayStation 4",
  NINTENDO_SWITCH: "Nintendo Switch", NINTENDO_SWITCH_2: "Nintendo Switch 2"
};

const canonicalPlatforms: PlatformSelection[] = [
  { provider: "STEAM", platform: "STEAM", externalGameId: null, storeUrl: null, catalogEventId: null },
  { provider: "PLAYSTATION", platform: "PS5", externalGameId: null, storeUrl: null, catalogEventId: null },
  { provider: "PLAYSTATION", platform: "PS4", externalGameId: null, storeUrl: null, catalogEventId: null },
  { provider: "NINTENDO", platform: "NINTENDO_SWITCH_2", externalGameId: null, storeUrl: null, catalogEventId: null },
  { provider: "NINTENDO", platform: "NINTENDO_SWITCH", externalGameId: null, storeUrl: null, catalogEventId: null }
];

type AcquisitionChannel = "SUBSCRIPTION" | "FAMILY_SHARED" | "PHYSICAL" | "SELF_PURCHASED";
const channels = [
  { value: "SUBSCRIPTION" as const, label: "会免", note: "已领取会免或订阅权限", Icon: Gift },
  { value: "FAMILY_SHARED" as const, label: "家庭", note: "家庭共享当前可用", Icon: Users },
  { value: "PHYSICAL" as const, label: "实体", note: "卡带或光盘已经到手", Icon: Disc3 },
  { value: "SELF_PURCHASED" as const, label: "自购", note: "数字版已经购买", Icon: ShoppingBag }
];

function selectionKey(selection: Pick<PlatformSelection, "provider" | "platform">) {
  return `${selection.provider}:${selection.platform}`;
}

function platformOptions(item: WishlistItemView) {
  const known = item.platformVariants.filter((variant): variant is PlatformSelection => variant.provider !== null && variant.isSelectable !== false);
  const options = [...known, ...canonicalPlatforms];
  const deduped = new Map<string, PlatformSelection>();
  for (const option of options) if (!deduped.has(selectionKey(option))) deduped.set(selectionKey(option), option);
  return [...deduped.values()];
}

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function WishlistManager({ initialItems, total }: { initialItems: WishlistItemView[]; total: number }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [acquiringItem, setAcquiringItem] = useState<WishlistItemView | null>(null);
  const [selectedPlatformKey, setSelectedPlatformKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function openAcquire(item: WishlistItemView) {
    const options = platformOptions(item);
    const current = options.find((option) => option.provider === item.provider && option.platform === item.platform)
      ?? options.find((option) => option.provider === item.provider)
      ?? options[0];
    setAcquiringItem(item); setSelectedPlatformKey(selectionKey(current)); setMessage("");
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const platform = String(form.get("platform"));
    try {
      await api("/api/v1/wishlist", { method: "POST", body: JSON.stringify({
        name: String(form.get("name")), provider: providerForPlatform(platform),
        externalGameId: String(form.get("externalGameId") || "") || null, platform,
        storeUrl: String(form.get("storeUrl") || "") || null, coverUrl: null,
        releaseDate: String(form.get("releaseDate") || "") || null, releaseDatePrecision: "DAY"
      }) });
      setAdding(false); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "添加失败"); }
    finally { setBusy(false); }
  }

  async function remove(item: WishlistItemView) {
    if (!window.confirm(`确认将“${item.displayName}”移出心愿单？`)) return;
    setBusy(true); setMessage("");
    try { await api(`/api/v1/wishlist/${item.id}`, { method: "DELETE" }); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "移出失败"); }
    finally { setBusy(false); }
  }

  async function acquire(channel: AcquisitionChannel) {
    if (!acquiringItem) return;
    const item = acquiringItem;
    const selection = platformOptions(item).find((option) => selectionKey(option) === selectedPlatformKey);
    if (!selection) { setMessage("请先选择具体游戏平台"); return; }
    setBusy(true); setMessage("");
    try {
      await api(`/api/v1/wishlist/${item.id}/acquire`, { method: "POST", body: JSON.stringify({ channel, selection }) });
      setAcquiringItem(null); setMessage(`“${item.displayName}”已从心愿单转入“接下来玩”队列`); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "转入“接下来玩”失败"); }
    finally { setBusy(false); }
  }

  const activeOptions = acquiringItem ? platformOptions(acquiringItem) : [];
  const selectedPlatform = activeOptions.find((option) => selectionKey(option) === selectedPlatformKey) ?? null;

  return <>
    <section className="content-section wishlist-section">
      <div className="section-heading"><div><h2>我的心愿</h2><p>一款作品只保留一条心愿；平台可在入手前自由调整。</p></div><div className="heading-actions"><span className="count-badge">{total} 项</span><button className="primary-button compact" onClick={() => { setAdding(true); setMessage(""); }}><Plus size={15} />添加游戏</button></div></div>
      {message && !adding && !acquiringItem ? <div className={`inline-alert ${message.includes("已从心愿单") ? "success" : "error"}`}>{message}</div> : null}
      {initialItems.length ? <div className="wishlist-grid">{initialItems.map((item) => <article key={item.id} className="wishlist-card">
        <div className="wishlist-cover">{item.coverUrl ? <span className="wishlist-cover-image" role="img" aria-label={`${item.displayName}封面`} style={{ backgroundImage: `url(${JSON.stringify(item.coverUrl)})` }} /> : <Heart size={24} />}</div>
        <div className="wishlist-copy"><span>{providerLabels[item.provider]} · {item.source === "MANUAL" ? "手工" : "目录"}</span><strong>{item.displayName}</strong><small>{item.releaseDate ? `发售 ${item.releaseDate}` : "发售日期待公布"}{item.platform ? ` · ${platformLabels[item.platform] ?? item.platform}` : ""}</small>{item.genres.length ? <span className="status-chip-list">{item.genres.slice(0, 3).map((genre, index) => <span key={genre} className={`status-chip genre-chip${index === 0 ? " primary" : ""}`}>{gameGenreLabels[genre]}</span>)}</span> : null}{item.purchaseAdvice ? <small className={`wishlist-advice-summary mode-${item.purchaseAdvice.mode.toLowerCase()}`}>💡 {item.purchaseAdvice.summary}</small> : null}</div>
        <div className="wishlist-actions"><button className="wishlist-acquire-trigger" disabled={busy} aria-label={`选择${item.displayName}的平台和入手渠道`} onClick={() => openAcquire(item)}><ShoppingBag size={14} /><span>选择平台并入手</span></button>{item.storeUrl ? <a href={item.storeUrl} target="_blank" rel="noreferrer" aria-label={`打开${item.displayName}商店页`}><ExternalLink size={14} /></a> : null}<button disabled={busy} aria-label={`移出${item.displayName}`} onClick={() => remove(item)}><Trash2 size={14} /></button></div>
      </article>)}</div> : <div className="empty-state"><Heart size={24} /><p>心愿单为空。可从“发现游戏”或“发售日历”加入作品。</p></div>}
    </section>

    {adding ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(false); }}><div className="modal-panel narrow" role="dialog" aria-modal="true" aria-labelledby="wishlist-dialog-title"><header><div><span className="eyebrow">ADD WISH</span><h2 id="wishlist-dialog-title">添加心愿</h2><p>直接选择具体游戏平台，避免来源与平台分开填写。</p></div><button className="icon-button" aria-label="关闭" onClick={() => setAdding(false)}><X size={18} /></button></header>
      <form onSubmit={create}><div className="form-grid"><label className="span-2">游戏名称<input name="name" required maxLength={300} /></label><label className="span-2">目标平台<select name="platform" defaultValue="STEAM">{canonicalPlatforms.map((option) => <option value={option.platform} key={selectionKey(option)}>{platformLabels[option.platform]}</option>)}</select></label><label className="span-2">商店链接<input type="url" name="storeUrl" placeholder="https://…" /></label><label>平台游戏 ID<input name="externalGameId" placeholder="可选" /></label><label>发售日期<input type="date" name="releaseDate" /></label></div>{message ? <div className="inline-alert error">{message}</div> : null}<footer><button type="button" className="secondary-button" onClick={() => setAdding(false)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "加入心愿单"}</button></footer></form>
    </div></div> : null}

    {acquiringItem ? <div className="modal-backdrop wishlist-acquire-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setAcquiringItem(null); }}><div className="modal-panel narrow wishlist-acquire-panel" role="dialog" aria-modal="true" aria-labelledby="wishlist-acquire-title"><header><div><span className="eyebrow">ACQUIRED</span><h2 id="wishlist-acquire-title">选择平台与入手渠道</h2><p>“{acquiringItem.displayName}”确认渠道后会立即移入候玩池。</p></div><button className="icon-button" disabled={busy} aria-label="关闭" onClick={() => setAcquiringItem(null)}><X size={18} /></button></header>
      <fieldset className="wishlist-platform-fieldset"><legend>具体游戏平台</legend><div className="wishlist-platform-options">{activeOptions.map((option) => <label className={selectedPlatformKey === selectionKey(option) ? "selected" : ""} key={selectionKey(option)}><input type="radio" name="acquirePlatform" value={selectionKey(option)} checked={selectedPlatformKey === selectionKey(option)} onChange={() => setSelectedPlatformKey(selectionKey(option))} /><strong>{platformLabels[option.platform] ?? option.platform}</strong>{option.externalGameId ? <small>目录版本</small> : <small>手动指定</small>}</label>)}</div></fieldset>
      {acquiringItem.purchaseAdvice ? <div className="wishlist-advice-panel" aria-label="平台购买建议">
        <div className="purchase-advice-head"><strong>平台购买建议</strong><span>{acquiringItem.purchaseAdvice.summary}</span></div>
        {acquiringItem.purchaseAdvice.suggestions.map((suggestion) => <div key={suggestion.platform} className="purchase-advice-option">
          <strong>{suggestion.title}</strong>
          {suggestion.reasons.length ? <ul>{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          {suggestion.cautions.length ? <ul className="purchase-advice-cautions">{suggestion.cautions.map((caution) => <li key={caution}>⚠️ {caution}</li>)}</ul> : null}
        </div>)}
        {acquiringItem.purchaseAdvice.notes.map((note) => <p key={note} className="purchase-advice-note">{note}</p>)}
      </div> : null}
      <div className="wishlist-channel-heading"><strong>入手渠道</strong><small>点击渠道即确认并排入“接下来玩”队尾</small></div>
      <div className="wishlist-channel-grid">{channels.map(({ value, label, note, Icon }) => {
        const recommended = value === recommendedChannel(selectedPlatform?.provider ?? acquiringItem.provider);
        return <button key={value} type="button" className={recommended ? "recommended" : ""} disabled={busy || !selectedPlatform} onClick={() => acquire(value)}><Icon size={20} /><span><strong>{label}{recommended ? <em>推荐</em> : null}</strong><small>{note}</small></span></button>;
      })}</div>
      {message ? <div className="inline-alert error">{message}</div> : null}
      <p className="wishlist-acquire-note">该操作原子登记平台与渠道、归档心愿并自动排入“接下来玩”队尾（Switch 系默认通勤场景，其余默认固定场景，可在游玩规划拖拽调整）；不会占用“正在玩”槽位。</p>
    </div></div> : null}
  </>;
}
