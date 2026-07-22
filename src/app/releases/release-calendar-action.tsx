"use client";

import { Check, Heart, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type CalendarVariant = {
  id: string;
  platform: string;
  releaseDate: string;
  datePrecision: string;
  storeProvider: string | null;
  storeExternalGameId: string | null;
  storeUrl: string | null;
  isSelectable: boolean;
};

const platformLabels: Record<string, string> = {
  STEAM: "Steam", PLAYSTATION: "PlayStation", NINTENDO_SWITCH: "Switch",
  NINTENDO_SWITCH_2: "Switch 2", PC_OTHER: "PC"
};

async function addToWishlist(eventId: string) {
  const response = await fetch(`/api/v1/releases/${eventId}/selection`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "WISHLIST" })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "加入心愿失败");
}

export function ReleaseCalendarAction({ variants, name, isWishlisted, catalogHref }: {
  variants: CalendarVariant[];
  name: string;
  isWishlisted: boolean;
  catalogHref: string;
}) {
  const router = useRouter();
  const selectable = variants.filter((variant) => variant.isSelectable);
  const [added, setAdded] = useState(isWishlisted);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function select(eventId: string) {
    setBusy(eventId); setMessage("");
    try {
      await addToWishlist(eventId);
      setAdded(true); setChoosing(false); setMessage(`已将“${name}”加入心愿单。`); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "加入心愿失败"); }
    finally { setBusy(null); }
  }

  return <div className="release-calendar-action">
    {added ? <span><Check size={11} />已在心愿</span> : selectable.length ? <button type="button" disabled={busy !== null} onClick={() => setChoosing(true)}><Heart size={11} />加入心愿</button> : <Link href={catalogHref}>查看资料</Link>}
    {message ? <small role="status">{message}</small> : null}
    {choosing ? <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setChoosing(false); }}><div className="modal-panel narrow platform-choice-panel" role="dialog" aria-modal="true" aria-labelledby="calendar-platform-title">
      <header><div><span className="eyebrow">CHOOSE PLATFORM</span><h2 id="calendar-platform-title">选择心愿平台</h2><p>“{name}”会作为一条作品心愿保存。</p></div><button className="icon-button" aria-label="关闭" onClick={() => setChoosing(false)}><X size={18} /></button></header>
      <div className="platform-choice-list">{selectable.map((variant) => <button key={variant.id} disabled={busy !== null} onClick={() => select(variant.id)}><span><strong>{platformLabels[variant.platform] ?? variant.platform}</strong><small>{variant.releaseDate}</small></span>{busy === variant.id ? <RefreshCw size={15} className="spin" /> : <Heart size={15} />}</button>)}</div>
    </div></div> : null}
  </div>;
}
