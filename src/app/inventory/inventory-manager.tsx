"use client";

import { useState, type FormEvent } from "react";
import { ArrowRightLeft, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

type ItemView = {
  id: string; productName: string; color: string; brand: string | null; style: string | null; material: string | null;
  unitPrice: string | null; unopenedQuantity: number; openedQuantity: number; currentLocation: string | null; notes: string | null; version: number;
  [key: string]: unknown;
};

async function api(path: string, init: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

export function InventoryManager({ initialItems, total }: { initialItems: ItemView[]; total: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<"new" | "movement" | null>(null);
  const [selected, setSelected] = useState<ItemView | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name) || 0);
    try {
      await api("/api/v1/inventory", { method: "POST", body: JSON.stringify({
        productName: String(form.get("productName")), color: String(form.get("color")), brand: String(form.get("brand") || "") || null,
        style: String(form.get("style") || "") || null, material: String(form.get("material") || "") || null,
        unitPrice: form.get("unitPrice") === "" ? null : number("unitPrice"), unopenedQuantity: number("unopenedQuantity"), openedQuantity: number("openedQuantity"),
        currentLocation: String(form.get("currentLocation") || "") || null, notes: String(form.get("notes") || "") || null
      }) });
      setMode(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const movementType = String(form.get("movementType"));
    const quantity = Number(form.get("quantity"));
    const deltas: Record<string, [number, number]> = {
      PURCHASE: [quantity, 0], OPENED: [-quantity, quantity], CONSUMED: [0, -quantity], DISCARDED: [-quantity, 0],
      GIFTED: [-quantity, 0], TRANSFER_IN: [quantity, 0], TRANSFER_OUT: [-quantity, 0]
    };
    const [unopenedDelta, openedDelta] = deltas[movementType] ?? [Number(form.get("unopenedDelta") || 0), Number(form.get("openedDelta") || 0)];
    try {
      await api(`/api/v1/inventory/${selected.id}/movements`, { method: "POST", body: JSON.stringify({ movementType, unopenedDelta, openedDelta, reason: String(form.get("reason")), version: selected.version }) });
      setMode(null); setSelected(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "调整失败"); }
    finally { setBusy(false); }
  }

  async function remove(item: ItemView) {
    if (!window.confirm(`确认删除“${item.productName} / ${item.color}”？历史流水会保留。`)) return;
    setBusy(true);
    try { await api(`/api/v1/inventory/${item.id}`, { method: "DELETE" }); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  }

  return <>
    <section className="content-section">
      <div className="section-heading"><div><h2>库存明细</h2><p>总持有 = 未拆封 + 已拆封；负库存由事务门禁拦截。</p></div><div className="heading-actions"><span className="count-badge">{total} 项</span><button className="primary-button compact" onClick={() => { setMode("new"); setMessage(""); }}><Plus size={15} /> 添加</button></div></div>
      {message ? <div className="inline-alert error">{message}</div> : null}
      {initialItems.length ? <div className="table-wrap"><table><thead><tr><th>商品</th><th>颜色/材质</th><th>未拆封</th><th>已拆封</th><th>总持有</th><th>位置</th><th>操作</th></tr></thead><tbody>{initialItems.map((item) => <tr key={item.id}><td><strong>{item.productName}</strong><small className="cell-note">{item.brand ?? "—"}</small></td><td>{item.color}<small className="cell-note">{item.material ?? item.style ?? "—"}</small></td><td>{item.unopenedQuantity}</td><td>{item.openedQuantity}</td><td><strong>{item.unopenedQuantity + item.openedQuantity}</strong></td><td>{item.currentLocation ?? "—"}</td><td><div className="row-actions"><button title="调整库存" onClick={() => { setSelected(item); setMode("movement"); setMessage(""); }}><ArrowRightLeft size={14} /></button><button title="删除" disabled={busy} onClick={() => remove(item)}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div> : <div className="empty-state">没有符合条件的库存记录。</div>}
    </section>
    {mode ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMode(null); }}><div className="modal-panel narrow" role="dialog" aria-modal="true"><header><div><span className="eyebrow">{mode === "new" ? "NEW INVENTORY" : "STOCK MOVEMENT"}</span><h2>{mode === "new" ? "添加库存" : selected?.productName}</h2></div><button className="icon-button" onClick={() => setMode(null)}><X size={18} /></button></header>
      {mode === "new" ? <form onSubmit={create}><div className="form-grid"><label className="span-2">商品名称<input name="productName" required /></label><label>颜色<input name="color" required /></label><label>品牌<input name="brand" /></label><label>款式<input name="style" /></label><label>材质<input name="material" /></label><label>单价<input type="number" min="0" step="0.01" name="unitPrice" /></label><label>未拆封初值<input type="number" min="0" name="unopenedQuantity" defaultValue="0" /></label><label>已拆封初值<input type="number" min="0" name="openedQuantity" defaultValue="0" /></label><label>位置<input name="currentLocation" /></label><label className="span-2">备注<textarea name="notes" rows={3} /></label></div>{message ? <div className="inline-alert error">{message}</div> : null}<footer><button type="button" className="secondary-button" onClick={() => setMode(null)}>取消</button><button className="primary-button" disabled={busy}>保存</button></footer></form>
      : <form onSubmit={move}><div className="form-grid"><label className="span-2">流水类型<select name="movementType" defaultValue="PURCHASE"><option value="PURCHASE">采购入库</option><option value="OPENED">拆封</option><option value="CONSUMED">消耗</option><option value="DISCARDED">废弃未拆封</option><option value="GIFTED">赠送</option><option value="TRANSFER_IN">转入</option><option value="TRANSFER_OUT">转出</option><option value="ADJUSTMENT">盘点调整</option></select></label><label>数量<input type="number" min="1" name="quantity" defaultValue="1" /></label><label>未拆封调整<input type="number" name="unopenedDelta" defaultValue="0" /></label><label>已拆封调整<input type="number" name="openedDelta" defaultValue="0" /></label><label className="span-2">原因<input name="reason" required minLength={2} placeholder="例如：本周采购" /></label></div>{message ? <div className="inline-alert error">{message}</div> : null}<footer><button type="button" className="secondary-button" onClick={() => setMode(null)}>取消</button><button className="primary-button" disabled={busy}>提交流水</button></footer></form>}
    </div></div> : null}
  </>;
}
