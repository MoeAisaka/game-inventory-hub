"use client";

import {
  ArchiveRestore,
  Ban,
  Box,
  Check,
  ExternalLink,
  Filter,
  Flame,
  Grid2X2,
  History,
  Package,
  PackageOpen,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject
} from "react";
import { ItemTabs } from "@/components/item-tabs";

type VariantView = {
  id: string;
  productId: string;
  color: string;
  colorSource: string | null;
  unitPrice: string | null;
  unopenedQuantity: number;
  inUseQuantity: number;
  currentLocation: string | null;
  purchaseUrlOverride: string | null;
  notes: string | null;
  repurchaseDecision: string | null;
  version: number;
  legacyItemId: string | null;
  scrappedQuantity: number;
  createdAt: string;
  updatedAt: string;
};

type ProductView = {
  id: string;
  productName: string;
  brand: string | null;
  style: string | null;
  denier: string | null;
  material: string | null;
  composition: string | null;
  purchaseUrl: string | null;
  priorityCode: string | null;
  consumptionPriority: number;
  productRating: number;
  legacyGroupKey: string | null;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variants: VariantView[];
};

type Overview = { products: number; variants: number; unopened: number; inUse: number; scrapped: number; retiredProducts: number };
type FilterValue = "all" | "in_use" | "low" | "multi";
type RatingFilter = "all" | "unrated" | "1" | "2" | "3" | "4" | "5";
type AvailabilityFilter = "all" | "unopened" | "in_use" | "empty";
type RepurchaseFilter = "all" | "REPURCHASE" | "KEEP_OBSERVING" | "DO_NOT_REPURCHASE" | "UNDECIDED";
type RepurchaseDecision = Exclude<RepurchaseFilter, "all">;
type SortValue = "consumption" | "rating" | "recent" | "name" | "unopened";
type AdvancedFilters = {
  consumptionPriority: RatingFilter;
  productRating: RatingFilter;
  availability: AvailabilityFilter;
  repurchase: RepurchaseFilter;
  sort: SortValue;
};
type DrawerState = { type: "product" } | { type: "variant"; product: ProductView } | { type: "movements" } | { type: "filters" } | null;
type ToastState = { message: string; kind: "success" | "error"; undo?: { movementId: string; variantId: string; version: number } } | null;

type MovementView = {
  id: string;
  movementType: string;
  unopenedDelta: number;
  inUseDelta: number;
  scrappedDelta: number;
  reason: string;
  createdAt: string;
  variantId: string;
  variantVersion: number;
  color: string;
  productName: string;
};

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body.data;
}

function productTotals(product: ProductView) {
  return product.variants.reduce((total, variant) => ({
    unopened: total.unopened + variant.unopenedQuantity,
    inUse: total.inUse + variant.inUseQuantity,
    scrapped: total.scrapped + variant.scrappedQuantity
  }), { unopened: 0, inUse: 0, scrapped: 0 });
}

function calculateOverview(products: ProductView[]): Overview {
  return products.reduce((total, product) => {
    const counts = productTotals(product);
    total.products += 1;
    total.variants += product.variants.length;
    total.unopened += counts.unopened;
    total.inUse += counts.inUse;
    total.scrapped += counts.scrapped;
    if (product.variants.length > 0 && product.variants.every((variant) => variant.repurchaseDecision === "DO_NOT_REPURCHASE")) {
      total.retiredProducts += 1;
    }
    return total;
  }, { products: 0, variants: 0, unopened: 0, inUse: 0, scrapped: 0, retiredProducts: 0 });
}

const colorValues: Record<string, string> = {
  黑色: "#25282a", 浅黑: "#4b4c4c", 白色: "#f3f1e9", 羽白: "#eee9df", 蜜色: "#c89f72",
  玉色: "#9ebeb1", 肉: "#c99479", 肉色: "#c99479", 砂色: "#b9a38c", 肤色: "#c9997f",
  浅肤: "#d1a48b", 紫熏色: "#8d7185", pink: "#d6a6ac", 灰色: "#858a88", 空姐灰: "#737b80",
  巧克力色: "#6f5144"
};

const repurchaseLabels: Record<string, string> = {
  REPURCHASE: "继续回购",
  KEEP_OBSERVING: "继续观察",
  DO_NOT_REPURCHASE: "淘汰",
  UNDECIDED: "待判断"
};

const repurchaseOptions: { value: RepurchaseDecision; label: string }[] = [
  { value: "UNDECIDED", label: "待判断" },
  { value: "REPURCHASE", label: "继续回购" },
  { value: "KEEP_OBSERVING", label: "继续观察" },
  { value: "DO_NOT_REPURCHASE", label: "淘汰 · 不再回购" }
];

function repurchaseDecisionOf(value: string | null): RepurchaseDecision {
  return repurchaseOptions.some((option) => option.value === value) ? value as RepurchaseDecision : "UNDECIDED";
}

const movementLabels: Record<string, string> = {
  STOCK_IN: "入库",
  OPEN_FOR_USE: "拆封",
  SCRAP_IN_USE: "报废",
  REVERSE: "撤销",
  LEGACY_PURCHASE: "历史入库",
  LEGACY_OPENED: "历史拆封",
  LEGACY_CONSUMED: "历史消耗",
  LEGACY_DISCARD_UNOPENED: "历史报废",
  LEGACY_GIFTED: "历史赠送",
  LEGACY_TRANSFER_IN: "历史转入",
  LEGACY_TRANSFER_OUT: "历史转出",
  LEGACY_ADJUSTMENT: "历史调整"
};

function numberFrom(form: FormData, name: string) {
  return Number(form.get(name) || 0);
}

function optionalText(form: FormData, name: string) {
  const value = String(form.get(name) ?? "").trim();
  return value || null;
}

export function InventoryCollection({ initialProducts, initialOverview }: { initialProducts: ProductView[]; initialOverview: Overview }) {
  const [products, setProducts] = useState(initialProducts);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilters>({
    consumptionPriority: "all",
    productRating: "all",
    availability: "all",
    repurchase: "all",
    sort: "consumption"
  });
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementView[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const overview = useMemo(() => calculateOverview(products), [products]);
  const baselineStable = overview.products === initialOverview.products && overview.variants === initialOverview.variants;
  const advancedFilterCount = Number(advancedFilters.consumptionPriority !== "all")
    + Number(advancedFilters.productRating !== "all")
    + Number(advancedFilters.availability !== "all")
    + Number(advancedFilters.repurchase !== "all")
    + Number(advancedFilters.sort !== "consumption");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const visible = products.filter((product) => {
      const totals = productTotals(product);
      const text = [product.productName, product.brand, product.style, product.denier, product.material,
        ...product.variants.flatMap((variant) => [
          variant.color,
          variant.currentLocation,
          repurchaseLabels[repurchaseDecisionOf(variant.repurchaseDecision)]
        ])]
        .filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
      const matchesText = !normalized || text.includes(normalized);
      const matchesFilter = filter === "all"
        || (filter === "in_use" && totals.inUse > 0)
        || (filter === "low" && totals.unopened <= 1)
        || (filter === "multi" && product.variants.length > 1);
      const matchesConsumptionPriority = advancedFilters.consumptionPriority === "all"
        || (advancedFilters.consumptionPriority === "unrated" && product.consumptionPriority === 0)
        || (advancedFilters.consumptionPriority !== "unrated" && product.consumptionPriority >= Number(advancedFilters.consumptionPriority));
      const matchesProductRating = advancedFilters.productRating === "all"
        || (advancedFilters.productRating === "unrated" && product.productRating === 0)
        || (advancedFilters.productRating !== "unrated" && product.productRating >= Number(advancedFilters.productRating));
      const matchesAvailability = advancedFilters.availability === "all"
        || (advancedFilters.availability === "unopened" && totals.unopened > 0)
        || (advancedFilters.availability === "in_use" && totals.inUse > 0)
        || (advancedFilters.availability === "empty" && totals.unopened + totals.inUse === 0);
      const matchesRepurchase = advancedFilters.repurchase === "all"
        || product.variants.some((variant) => (variant.repurchaseDecision ?? "UNDECIDED") === advancedFilters.repurchase);
      return matchesText && matchesFilter && matchesConsumptionPriority && matchesProductRating && matchesAvailability && matchesRepurchase;
    });
    return [...visible].sort((a, b) => {
      const aTotals = productTotals(a);
      const bTotals = productTotals(b);
      if (advancedFilters.sort === "recent") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.productName.localeCompare(b.productName, "zh-CN");
      if (advancedFilters.sort === "name") return a.productName.localeCompare(b.productName, "zh-CN");
      if (advancedFilters.sort === "unopened") return bTotals.unopened - aTotals.unopened || b.consumptionPriority - a.consumptionPriority || a.productName.localeCompare(b.productName, "zh-CN");
      if (advancedFilters.sort === "rating") return b.productRating - a.productRating || a.productName.localeCompare(b.productName, "zh-CN");
      return b.consumptionPriority - a.consumptionPriority || a.productName.localeCompare(b.productName, "zh-CN");
    });
  }, [advancedFilters, filter, products, query]);

  useEffect(() => {
    if (!drawer) return;
    const timer = window.setTimeout(() => firstInput.current?.focus(), 40);
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(null); };
    window.addEventListener("keydown", close);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", close); };
  }, [drawer]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function replaceVariant(variant: Omit<VariantView, "scrappedQuantity"> & { scrappedQuantity?: number }, scrappedDelta = 0) {
    setProducts((current) => current.map((product) => product.id !== variant.productId ? product : {
      ...product,
      variants: product.variants.map((existing) => existing.id !== variant.id ? existing : {
        ...existing,
        ...variant,
        scrappedQuantity: variant.scrappedQuantity ?? existing.scrappedQuantity + scrappedDelta
      })
    }));
  }

  async function performAction(product: ProductView, variant: VariantView, action: "STOCK_IN" | "OPEN_FOR_USE" | "SCRAP_IN_USE") {
    setBusyId(variant.id);
    try {
      const result = await api(`/api/v2/inventory/variants/${variant.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action, quantity: 1, version: variant.version, idempotencyKey: crypto.randomUUID() })
      });
      replaceVariant(result.variant, result.movement.scrappedDelta);
      const verb = action === "STOCK_IN" ? "已入库1件" : action === "OPEN_FOR_USE" ? "已拆封1件" : "已报废1件";
      setToast({
        message: `${product.productName} · ${variant.color} ${verb}`,
        kind: "success",
        undo: { movementId: result.movement.id, variantId: variant.id, version: result.variant.version }
      });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "库存操作失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function undoMovement() {
    if (!toast?.undo) return;
    const undo = toast.undo;
    setBusyId(undo.variantId);
    try {
      const result = await api(`/api/v2/inventory/movements/${undo.movementId}/reverse`, {
        method: "POST",
        body: JSON.stringify({ version: undo.version, idempotencyKey: crypto.randomUUID(), reason: "5秒内撤销错误操作" })
      });
      replaceVariant(result.variant, result.movement.scrappedDelta);
      setToast({ message: "刚才的库存操作已撤销。", kind: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "撤销失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId("create-product");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/v2/inventory", { method: "POST", body: JSON.stringify({
        productName: String(form.get("productName")).trim(),
        brand: optionalText(form, "brand"), style: optionalText(form, "style"), denier: optionalText(form, "denier"),
        material: optionalText(form, "material"), purchaseUrl: optionalText(form, "purchaseUrl"),
        consumptionPriority: numberFrom(form, "consumptionPriority"),
        productRating: numberFrom(form, "productRating"),
        color: String(form.get("color")).trim(), unitPrice: form.get("unitPrice") === "" ? null : numberFrom(form, "unitPrice"),
        initialUnopened: numberFrom(form, "initialUnopened"), currentLocation: optionalText(form, "currentLocation"),
        notes: optionalText(form, "notes"), repurchaseDecision: optionalText(form, "repurchaseDecision"),
        idempotencyKey: crypto.randomUUID()
      }) });
      setProducts((current) => [result.product, ...current]);
      setDrawer(null);
      setToast({ message: `${result.product.productName} 已创建并完成初始入库。`, kind: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "创建货品失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function updateRating(product: ProductView, field: "consumptionPriority" | "productRating", value: number) {
    if (product[field] === value) return;
    setBusyId(`ratings-${product.id}`);
    try {
      const result = await api(`/api/v2/inventory/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value, version: product.version })
      });
      setProducts((current) => current.map((item) => item.id === product.id ? result.product : item));
      const label = field === "consumptionPriority" ? "消耗优先级" : "商品评级";
      setToast({ message: value ? `${product.productName} 的${label}已设为 ${value} 级。` : `${product.productName} 的${label}已清除。`, kind: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "评级更新失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function updateRepurchase(product: ProductView, variant: VariantView, repurchaseDecision: RepurchaseDecision) {
    if (repurchaseDecisionOf(variant.repurchaseDecision) === repurchaseDecision) return;
    setBusyId(`repurchase-${variant.id}`);
    try {
      const result = await api(`/api/v2/inventory/variants/${variant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ repurchaseDecision, version: variant.version })
      });
      replaceVariant(result.variant);
      const message = repurchaseDecision === "DO_NOT_REPURCHASE"
        ? `${product.productName} · ${variant.color} 已淘汰，不再回购。`
        : `${product.productName} · ${variant.color} 已改为${repurchaseLabels[repurchaseDecision]}。`;
      setToast({ message, kind: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "回购状态更新失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  function resetAdvancedFilters() {
    setAdvancedFilters({ consumptionPriority: "all", productRating: "all", availability: "all", repurchase: "all", sort: "consumption" });
  }

  async function createVariant(event: FormEvent<HTMLFormElement>, product: ProductView) {
    event.preventDefault();
    setBusyId(`create-variant-${product.id}`);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api(`/api/v2/inventory/products/${product.id}/variants`, { method: "POST", body: JSON.stringify({
        color: String(form.get("color")).trim(), unitPrice: form.get("unitPrice") === "" ? null : numberFrom(form, "unitPrice"),
        initialUnopened: numberFrom(form, "initialUnopened"), currentLocation: optionalText(form, "currentLocation"),
        notes: optionalText(form, "notes"), repurchaseDecision: optionalText(form, "repurchaseDecision"),
        productVersion: product.version, idempotencyKey: crypto.randomUUID()
      }) });
      setProducts((current) => current.map((item) => item.id === product.id ? result.product : item));
      setDrawer(null);
      setToast({ message: `${product.productName} · ${String(form.get("color"))} 已添加并入库。`, kind: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "创建颜色款失败", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function openMovements() {
    setDrawer({ type: "movements" });
    setMovementsLoading(true);
    try {
      const result = await api("/api/v2/inventory/movements?limit=100");
      setMovements(result.movements);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "读取流水失败", kind: "error" });
    } finally {
      setMovementsLoading(false);
    }
  }

  return <>
    <header className="collection-page-top">
      <div><span className="collection-kicker">PERSONAL INVENTORY</span><h1>消耗库存</h1><p>货品归组，颜色分层；高频动作直接发生在颜色款上，数量变化始终由可撤销流水驱动。</p></div>
      <div className="collection-top-actions">
        <button className="collection-ghost-button" onClick={openMovements}><History size={17} />查看流水</button>
        <button className="collection-primary-button" aria-label="新增货品" title="新增货品" onClick={() => setDrawer({ type: "product" })}><Plus size={17} /><span>新增货品</span></button>
      </div>
    </header>
    <ItemTabs active="inventory" />

    <section className="collection-summary" aria-label="库存概览">
      <Summary icon={<Box />} value={overview.products} label="货品" />
      <Summary icon={<Grid2X2 />} value={overview.variants} label="颜色款" />
      <Summary icon={<Package />} value={overview.unopened} label="未拆封" />
      <Summary icon={<PackageOpen />} value={overview.inUse} label="使用中" tone="rose" />
      <Summary icon={<Trash2 />} value={overview.scrapped} label="累计报废" tone="amber" />
      <Summary icon={<Ban />} value={overview.retiredProducts} label="已淘汰货品" tone="retired" />
    </section>

    <div className="collection-toolbar">
      <label className="collection-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索货品、品牌、颜色或位置" /></label>
      <div className="collection-filter-group">
        {([['all', '全部'], ['in_use', '使用中'], ['low', '低库存'], ['multi', '多颜色']] as [FilterValue, string][]).map(([value, label]) =>
          <button key={value} className={`collection-chip ${filter === value ? "active" : ""}`} onClick={() => setFilter(value)}>{label}</button>)}
        <button
          aria-expanded={drawer?.type === "filters"}
          className={`collection-chip ${advancedFilterCount ? "active" : ""}`}
          onClick={() => setDrawer({ type: "filters" })}
        ><Filter size={14} />更多筛选{advancedFilterCount ? <span className="collection-filter-count">{advancedFilterCount}</span> : null}</button>
      </div>
    </div>
    <div className="collection-result-meta"><span>显示 <strong>{filtered.length}</strong> / {products.length} 个货品</span><span>{baselineStable ? "迁移基线已对齐" : "当前数据已产生新操作"} · {overview.variants}个颜色款</span></div>

    <section className="collection-product-grid">
      {filtered.length ? filtered.map((product, index) => <ProductCard
        busyId={busyId}
        index={index}
        key={product.id}
        onAction={performAction}
        onAddVariant={() => setDrawer({ type: "variant", product })}
        onRating={updateRating}
        onRepurchase={updateRepurchase}
        product={product}
      />) : <div className="collection-empty"><Search size={28} /><strong>没有符合条件的货品</strong><span>尝试清除搜索或切换筛选条件。</span></div>}
    </section>

    {drawer ? <><button className="collection-scrim" aria-label="关闭抽屉" onClick={() => setDrawer(null)} /><aside className="collection-drawer" role="dialog" aria-modal="true">
      <header className="collection-drawer-head"><div><h2>{drawer.type === "product" ? "新增货品" : drawer.type === "variant" ? "新增颜色" : drawer.type === "filters" ? "筛选与排序" : "库存流水"}</h2><p>{drawer.type === "product" ? "一次完成货品、首个颜色款和初始库存创建。" : drawer.type === "variant" ? `${drawer.product.productName} · 现有${drawer.product.variants.length}种颜色` : drawer.type === "filters" ? "组合消耗优先级、商品评级、库存状态和回购判断；结果会立即更新。" : "最近100条流水；旧报废按历史语义保留。"}</p></div><button className="collection-icon-button" onClick={() => setDrawer(null)} aria-label="关闭"><X size={18} /></button></header>
      {drawer.type === "product" ? <ProductForm busy={busyId === "create-product"} firstInput={firstInput} onCancel={() => setDrawer(null)} onSubmit={createProduct} /> : null}
      {drawer.type === "variant" ? <VariantForm busy={busyId === `create-variant-${drawer.product.id}`} firstInput={firstInput} onCancel={() => setDrawer(null)} onSubmit={(event) => createVariant(event, drawer.product)} product={drawer.product} /> : null}
      {drawer.type === "movements" ? <MovementList loading={movementsLoading} movements={movements} /> : null}
      {drawer.type === "filters" ? <FilterPanel filters={advancedFilters} onChange={setAdvancedFilters} onClose={() => setDrawer(null)} onReset={resetAdvancedFilters} /> : null}
    </aside></> : null}

    <div className="collection-toast-region" aria-live="polite">{toast ? <div className={`collection-toast ${toast.kind}`}>
      {toast.kind === "success" ? <Check size={17} /> : <X size={17} />}<span>{toast.message}</span>
      {toast.undo ? <button disabled={busyId === toast.undo.variantId} onClick={undoMovement}><RotateCcw size={13} />撤销</button> : null}
    </div> : null}</div>
  </>;
}

function Summary({ icon, value, label, tone = "green" }: { icon: ReactNode; value: number; label: string; tone?: "green" | "rose" | "amber" | "retired" }) {
  return <div className="collection-summary-cell"><span className={`collection-summary-icon ${tone}`}>{icon}</span><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function ProductCard({ product, index, busyId, onAction, onAddVariant, onRating, onRepurchase }: {
  product: ProductView;
  index: number;
  busyId: string | null;
  onAction: (product: ProductView, variant: VariantView, action: "STOCK_IN" | "OPEN_FOR_USE" | "SCRAP_IN_USE") => void;
  onAddVariant: () => void;
  onRating: (product: ProductView, field: "consumptionPriority" | "productRating", value: number) => void;
  onRepurchase: (product: ProductView, variant: VariantView, repurchaseDecision: RepurchaseDecision) => void;
}) {
  const totals = productTotals(product);
  const repurchases = [...new Set(product.variants.map((variant) => repurchaseDecisionOf(variant.repurchaseDecision)))];
  const repurchase = repurchases.length === 1 ? repurchaseLabels[repurchases[0]!] ?? repurchases[0] : repurchases.length > 1 ? "分颜色判断" : "待观察";
  const retiredVariants = product.variants.filter((variant) => repurchaseDecisionOf(variant.repurchaseDecision) === "DO_NOT_REPURCHASE").length;
  const retirement = retiredVariants === product.variants.length ? "retired" : retiredVariants > 0 ? "partial" : "active";
  const productStatus = retirement === "retired" ? "已淘汰" : retirement === "partial" ? `${retiredVariants}色淘汰` : repurchase;
  const locations = [...new Set(product.variants.map((variant) => variant.currentLocation).filter(Boolean))].join(" / ") || "位置待定";
  const themes = ["jade", "ink", "sand", "rose"];
  return <article className="collection-product-card">
    <header className="collection-product-head">
      <div className={`collection-product-visual ${themes[index % themes.length]}`}><small>{product.brand ?? "未标品牌"} · {product.style ?? "未分类"}</small><strong>{product.denier ?? "—"}</strong></div>
      <div className="collection-product-copy">
        <div className="collection-product-eyebrow"><span className="collection-product-brand">{product.brand ?? "未标品牌"}</span><span className={`collection-product-status ${retirement}`}>{productStatus}</span></div>
        <h2 title={product.productName}>{product.productName}</h2>
        <div className="collection-rating-controls">
          <RatingControl
            busy={busyId === `ratings-${product.id}`}
            icon="consumption"
            label="消耗优先级"
            onChange={(value) => onRating(product, "consumptionPriority", value)}
            value={product.consumptionPriority}
          />
          <RatingControl
            busy={busyId === `ratings-${product.id}`}
            icon="rating"
            label="商品评级"
            onChange={(value) => onRating(product, "productRating", value)}
            value={product.productRating}
          />
        </div>
        <div className="collection-product-meta"><span>{product.style ?? "款式未录"}</span><span>{product.denier ?? "厚度未录"}</span><span>{locations}</span><span>{product.variants.length}种颜色</span></div>
        <div className="collection-product-totals"><span><strong>{totals.unopened + totals.inUse}</strong><small>当前可用</small></span><span><strong>{totals.unopened}</strong><small>未拆封</small></span><span><strong>{totals.inUse}</strong><small>使用中</small></span></div>
      </div>
      {product.purchaseUrl ? <a className="collection-product-link" href={product.purchaseUrl} target="_blank" rel="noopener noreferrer" aria-label="打开购买链接"><ExternalLink size={16} /></a> : null}
    </header>
    <div className="collection-variant-list">
      {product.variants.map((variant) => {
        const repurchaseDecision = repurchaseDecisionOf(variant.repurchaseDecision);
        const variantBusy = busyId === variant.id || busyId === `repurchase-${variant.id}`;
        return <div className={`collection-variant-row ${repurchaseDecision === "DO_NOT_REPURCHASE" ? "retired" : ""}`} key={variant.id}>
        <div className="collection-variant-identity"><span className="collection-color-dot" style={{ "--swatch": colorValues[variant.color] ?? "#9da5a0" } as CSSProperties} /><span><strong>{variant.color}</strong><small>{variant.currentLocation ?? "位置待定"}</small><label className={`collection-repurchase-control ${repurchaseDecision === "DO_NOT_REPURCHASE" ? "retired" : ""}`}><span className="sr-only">修改{variant.color}回购状态</span><select aria-label={`修改${variant.color}回购状态`} disabled={variantBusy} onChange={(event) => onRepurchase(product, variant, event.target.value as RepurchaseDecision)} value={repurchaseDecision}>{repurchaseOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></span></div>
        <div className="collection-variant-counts"><span><strong>{variant.unopenedQuantity}</strong><small>未拆封</small></span><span><strong>{variant.inUseQuantity}</strong><small>使用中</small></span><span><strong>{variant.scrappedQuantity}</strong><small>累计报废</small></span></div>
        <div className="collection-variant-actions">
          <button disabled={variantBusy} onClick={() => onAction(product, variant, "STOCK_IN")}><Package size={13} />入库 +1</button>
          <button className="open" disabled={variantBusy || variant.unopenedQuantity <= 0} onClick={() => onAction(product, variant, "OPEN_FOR_USE")}><PackageOpen size={13} />拆封 +1</button>
          <button className="discard" disabled={variantBusy || variant.inUseQuantity <= 0} onClick={() => onAction(product, variant, "SCRAP_IN_USE")}><Trash2 size={13} />报废 +1</button>
        </div>
      </div>})}
    </div>
    <footer className="collection-product-foot"><button onClick={onAddVariant}><Plus size={14} />新增颜色</button><span>{product.legacyGroupKey ? "已完成旧记录映射" : "新模型创建"}</span></footer>
  </article>;
}

function RatingControl({ label, value, busy, icon, onChange }: {
  label: string;
  value: number;
  busy: boolean;
  icon: "consumption" | "rating";
  onChange: (value: number) => void;
}) {
  const Icon = icon === "consumption" ? Flame : Star;
  const unit = icon === "consumption" ? "级" : "星";
  return <div className={`collection-priority-control ${icon}`} role="radiogroup" aria-label={label}>
    <span>{label}</span>
    {[1, 2, 3, 4, 5].map((rating) => <button
      aria-checked={value === rating}
      aria-label={`${label}${rating}${unit}`}
      className={rating <= value ? "selected" : ""}
      disabled={busy}
      key={rating}
      onClick={() => onChange(value === rating ? 0 : rating)}
      role="radio"
      title={`${label}${rating}${unit}`}
      type="button"
    ><Icon size={14} fill={rating <= value ? "currentColor" : "none"} /></button>)}
    <strong>{value ? `${value}${unit}` : icon === "consumption" ? "未设置" : "未评级"}</strong>
  </div>;
}

function ProductForm({ onSubmit, onCancel, busy, firstInput }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void; busy: boolean; firstInput: RefObject<HTMLInputElement | null> }) {
  return <form className="collection-drawer-form" onSubmit={onSubmit}>
    <label className="collection-form-field">货品名称<input ref={firstInput} name="productName" required placeholder="例如：绫「凝脂」15D 微光" /></label>
    <div className="collection-form-row"><label className="collection-form-field">品牌<input name="brand" placeholder="绫" /></label><label className="collection-form-field">款式<input name="style" placeholder="无缝" /></label></div>
    <div className="collection-form-row"><label className="collection-form-field">消耗优先级<select name="consumptionPriority" defaultValue="0"><option value="0">未设置</option><option value="1">1级</option><option value="2">2级</option><option value="3">3级</option><option value="4">4级</option><option value="5">5级（最优先消耗）</option></select></label><label className="collection-form-field">商品评级<select name="productRating" defaultValue="0"><option value="0">未评级</option><option value="1">1星</option><option value="2">2星</option><option value="3">3星</option><option value="4">4星</option><option value="5">5星（最高评价）</option></select></label></div>
    <div className="collection-form-row"><label className="collection-form-field">厚度<input name="denier" placeholder="15D" /></label><label className="collection-form-field">材质<input name="material" placeholder="天鹅绒" /></label></div>
    <label className="collection-form-field">购买链接<input name="purchaseUrl" type="url" placeholder="https://…" /></label>
    <div className="collection-form-row"><label className="collection-form-field">首个颜色<input name="color" required placeholder="黑色" /></label><label className="collection-form-field">初始未拆封数量<input name="initialUnopened" type="number" min="1" defaultValue="1" /></label></div>
    <div className="collection-form-row"><label className="collection-form-field">单价<input name="unitPrice" type="number" min="0" step="0.01" /></label><label className="collection-form-field">存放位置<input name="currentLocation" placeholder="左柜" /></label></div>
    <label className="collection-form-field">回购判断<select name="repurchaseDecision" defaultValue="UNDECIDED">{repurchaseOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label className="collection-form-field">备注<textarea name="notes" placeholder="选填：体验或颜色款备注" /></label>
    <div className="collection-drawer-note"><Check size={16} /><span>保存时将通过同一事务创建货品、颜色款和初始入库流水，不会产生半成品记录。</span></div>
    <footer className="collection-drawer-actions"><button type="button" className="collection-ghost-button" onClick={onCancel}>取消</button><button className="collection-primary-button" disabled={busy}>创建并入库</button></footer>
  </form>;
}

function VariantForm({ onSubmit, onCancel, product, busy, firstInput }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void; product: ProductView; busy: boolean; firstInput: RefObject<HTMLInputElement | null> }) {
  const defaultLocation = product.variants.find((variant) => variant.currentLocation)?.currentLocation ?? "";
  return <form className="collection-drawer-form" onSubmit={onSubmit}>
    <label className="collection-form-field">颜色名称<input ref={firstInput} name="color" required placeholder="例如：砂色" /></label>
    <div className="collection-form-row"><label className="collection-form-field">初始未拆封数量<input name="initialUnopened" type="number" min="1" defaultValue="1" /></label><label className="collection-form-field">单价<input name="unitPrice" type="number" min="0" step="0.01" /></label></div>
    <label className="collection-form-field">存放位置<input name="currentLocation" defaultValue={defaultLocation} /></label>
    <label className="collection-form-field">回购判断<select name="repurchaseDecision" defaultValue="UNDECIDED">{repurchaseOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label className="collection-form-field">备注<textarea name="notes" placeholder="选填：这个颜色款的独立备注" /></label>
    <div className="collection-drawer-note"><Check size={16} /><span>系统会检查同一货品下是否已有同名颜色，并通过初始入库流水建立数量。</span></div>
    <footer className="collection-drawer-actions"><button type="button" className="collection-ghost-button" onClick={onCancel}>取消</button><button className="collection-primary-button" disabled={busy}>添加颜色并入库</button></footer>
  </form>;
}

function MovementList({ movements, loading }: { movements: MovementView[]; loading: boolean }) {
  if (loading) return <div className="collection-drawer-loading">正在读取流水…</div>;
  return <div className="collection-movement-list">{movements.length ? movements.map((movement) => <article key={movement.id}>
    <span className={`collection-movement-icon ${movement.movementType === "REVERSE" ? "reverse" : movement.scrappedDelta > 0 ? "scrap" : ""}`}>{movement.movementType === "REVERSE" ? <ArchiveRestore size={15} /> : <History size={15} />}</span>
    <div><strong>{movement.productName} · {movement.color}</strong><p>{movementLabels[movement.movementType] ?? movement.movementType} · {movement.reason}</p><small>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(movement.createdAt))}</small></div>
    <span className="collection-movement-deltas">{movement.unopenedDelta ? `未 ${movement.unopenedDelta > 0 ? "+" : ""}${movement.unopenedDelta}` : ""}{movement.inUseDelta ? ` 用 ${movement.inUseDelta > 0 ? "+" : ""}${movement.inUseDelta}` : ""}{movement.scrappedDelta ? ` 废 ${movement.scrappedDelta > 0 ? "+" : ""}${movement.scrappedDelta}` : ""}</span>
  </article>) : <div className="collection-drawer-loading">暂无流水。</div>}</div>;
}

function FilterPanel({ filters, onChange, onClose, onReset }: {
  filters: AdvancedFilters;
  onChange: (filters: AdvancedFilters) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const set = <Key extends keyof AdvancedFilters>(key: Key, value: AdvancedFilters[Key]) => onChange({ ...filters, [key]: value });
  return <div className="collection-filter-panel">
    <section>
      <h3>消耗优先级</h3><p>控制默认列表顺序；5级表示最优先消耗，未设置为0级。</p>
      <div className="collection-option-grid priority">
        {([['all', '全部'], ['unrated', '未设置'], ['1', '1级+'], ['2', '2级+'], ['3', '3级+'], ['4', '4级+'], ['5', '仅5级']] as [RatingFilter, string][]).map(([value, label]) => <button className={filters.consumptionPriority === value ? "selected" : ""} key={value} onClick={() => set("consumptionPriority", value)} type="button">{label}</button>)}
      </div>
    </section>
    <section>
      <h3>商品评级</h3><p>记录你对货品本身的评价，不改变消耗策略。</p>
      <div className="collection-option-grid priority">
        {([['all', '全部'], ['unrated', '未评级'], ['1', '1星+'], ['2', '2星+'], ['3', '3星+'], ['4', '4星+'], ['5', '仅5星']] as [RatingFilter, string][]).map(([value, label]) => <button className={filters.productRating === value ? "selected" : ""} key={value} onClick={() => set("productRating", value)} type="button">{label}</button>)}
      </div>
    </section>
    <section>
      <h3>库存状态</h3>
      <div className="collection-option-grid">
        {([['all', '全部'], ['unopened', '有未拆封'], ['in_use', '使用中'], ['empty', '已用完']] as [AvailabilityFilter, string][]).map(([value, label]) => <button className={filters.availability === value ? "selected" : ""} key={value} onClick={() => set("availability", value)} type="button">{label}</button>)}
      </div>
    </section>
    <section>
      <h3>回购判断</h3>
      <label className="collection-form-field"><span className="sr-only">回购判断</span><select onChange={(event) => set("repurchase", event.target.value as RepurchaseFilter)} value={filters.repurchase}><option value="all">全部判断</option>{repurchaseOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </section>
    <section>
      <h3>排序方式</h3>
      <label className="collection-form-field"><span className="sr-only">排序方式</span><select onChange={(event) => set("sort", event.target.value as SortValue)} value={filters.sort}><option value="consumption">消耗优先级：高到低（默认）</option><option value="rating">商品评级：高到低</option><option value="recent">最近更新</option><option value="name">名称：A到Z</option><option value="unopened">未拆封：多到少</option></select></label>
    </section>
    <footer className="collection-filter-actions"><button className="collection-ghost-button" onClick={onReset} type="button"><RotateCcw size={14} />重置</button><button className="collection-primary-button" onClick={onClose} type="button">查看结果</button></footer>
  </div>;
}
