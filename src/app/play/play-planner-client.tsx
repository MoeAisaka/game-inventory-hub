"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  BriefcaseBusiness,
  Check,
  Clock3,
  Gamepad2,
  GripVertical,
  HardDrive,
  MonitorPlay,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Star,
  Trash2,
  Trophy,
  X
} from "lucide-react";
import { GameCover } from "@/components/game-cover";
import {
  acquisitionAvailabilityLabels,
  acquisitionAvailabilityValues,
  acquisitionChannelLabels,
  acquisitionChannelValues,
  completionGoalLabels,
  completionGoalValues,
  playDeviceProfiles,
  playScenarioLabels,
  playScenarioValues,
  type PlannerAcquisition,
  type PlannerGame,
  type PlannerPlan,
  type PlayPlannerData,
  type PlayScenario
} from "@/lib/play-planning";

const platformLabels: Record<string, string> = {
  STEAM: "Steam", PLAYSTATION: "PlayStation", NINTENDO_SWITCH: "Switch",
  NINTENDO_SWITCH_2: "Switch 2", NINTENDO_SWITCH_FAMILY: "Switch",
  XBOX_GAME_PASS: "XGP", PC_OTHER: "PC", IOS: "iOS"
};

function platformLabel(value: string | null) {
  if (!value) return "未设置平台";
  return platformLabels[value] ?? value;
}

function duration(minutes: number | null) {
  if (minutes === null) return "待补全";
  return `${Math.round(minutes / 6) / 10}h`;
}

function weeks(value: number | null) {
  if (value === null) return "周期待补全";
  if (value < 1) return "预计 1 周内";
  return `预计 ${value} 周`;
}

function gameSupportsScenario(game: PlannerGame, scenario: PlayScenario) {
  return game.acquisitions.some((item) => item.availability === "AVAILABLE"
    && (scenario === "COMMUTE" ? item.commuteEligible : item.fixedEligible));
}

type AcquisitionEditor = { game: PlannerGame; acquisition: PlannerAcquisition | null };
type PlanEditor = { game: PlannerGame; scenario: PlayScenario; plan: PlannerPlan | null; state: "QUEUED" | "PLAYING" };
type PlannerDrag = { kind: "GAME"; game: PlannerGame } | { kind: "PLAN"; plan: PlannerPlan };
type PlannerDropState = "QUEUED" | "PLAYING";
type TouchDragState = { payload: PlannerDrag; x: number; y: number };

export function PlayPlannerClient({ data }: { data: PlayPlannerData }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [query, setQuery] = useState("");
  const [acquisitionEditor, setAcquisitionEditor] = useState<AcquisitionEditor | null>(null);
  const [planEditor, setPlanEditor] = useState<PlanEditor | null>(null);
  const [detailGame, setDetailGame] = useState<PlannerGame | null>(null);
  const [dragging, setDragging] = useState<PlannerDrag | null>(null);
  const [dragTarget, setDragTarget] = useState("");
  const [touchDrag, setTouchDrag] = useState<TouchDragState | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchSessionRef = useRef<{ pointerId: number; payload: PlannerDrag; startX: number; startY: number; active: boolean } | null>(null);
  const suppressCardClickRef = useRef(false);
  const [commuteHours, setCommuteHours] = useState(String(data.scenarios.COMMUTE.weeklyBudgetMinutes / 60));
  const [fixedHours, setFixedHours] = useState(String(data.scenarios.FIXED.weeklyBudgetMinutes / 60));

  const plannedKeys = useMemo(() => new Set(playScenarioValues.flatMap((scenario) => [
    ...(data.scenarios[scenario].current ? [`${data.scenarios[scenario].current!.gameId}:${scenario}`] : []),
    ...data.scenarios[scenario].queue.map((plan) => `${plan.gameId}:${scenario}`)
  ])), [data]);
  const visibleCandidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return data.candidates.filter((game) => !normalized
      || game.nameZh.toLocaleLowerCase("zh-CN").includes(normalized)
      || game.nameEn?.toLocaleLowerCase("en-US").includes(normalized)
      || game.acquisitions.some((item) => platformLabel(item.platform).toLocaleLowerCase("zh-CN").includes(normalized)))
      .slice(0, 120);
  }, [data.candidates, query]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      setDetailGame(null);
      setAcquisitionEditor(null);
      setPlanEditor(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy]);

  useEffect(() => () => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
  }, []);

  function openDetails(game: PlannerGame) {
    if (suppressCardClickRef.current) return;
    setDetailGame(game);
  }

  function openDetailsFromKeyboard(event: KeyboardEvent<HTMLElement>, game: PlannerGame) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails(game);
    }
  }

  function openAcquisition(game: PlannerGame, acquisition: PlannerAcquisition | null) {
    setDetailGame(null);
    setAcquisitionEditor({ game, acquisition });
  }

  function openPlan(game: PlannerGame, scenario: PlayScenario, plan: PlannerPlan | null, state: PlannerDropState) {
    setDetailGame(null);
    setPlanEditor({ game, scenario, plan, state });
  }

  async function action(payload: Record<string, unknown>, success: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/v1/play-planner/action", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
      setMessageTone("success"); setMessage(success);
      setAcquisitionEditor(null); setPlanEditor(null);
      router.refresh();
    } catch (error) {
      setMessageTone("error"); setMessage(error instanceof Error ? error.message : "操作失败");
    } finally { setBusy(false); }
  }

  async function saveBudgets(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const commute = Number(commuteHours); const fixed = Number(fixedHours);
    if (!Number.isFinite(commute) || !Number.isFinite(fixed) || commute < .5 || fixed < .5) {
      setMessageTone("error"); setMessage("每周预算至少为0.5小时"); return;
    }
    await action({ action: "SAVE_BUDGETS", commuteWeeklyMinutes: Math.round(commute * 60), fixedWeeklyMinutes: Math.round(fixed * 60) }, "每周游玩预算已保存");
  }

  async function saveAcquisition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acquisitionEditor) return;
    const form = new FormData(event.currentTarget);
    const existing = acquisitionEditor.acquisition;
    await action({
      action: "SET_ACQUISITION",
      gameId: acquisitionEditor.game.id,
      acquisitionId: existing?.id ?? null,
      ...(existing ? { version: existing.version } : {}),
      channel: form.get("channel"),
      platform: form.get("platform") || null,
      availability: form.get("availability"),
      offlineCapable: form.get("offlineCapable") === "on"
    }, `${acquisitionEditor.game.nameZh}的入手渠道已更新`);
  }

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planEditor) return;
    const form = new FormData(event.currentTarget);
    const current = data.scenarios[planEditor.scenario].current;
    const replacing = planEditor.state === "PLAYING" && current && current.gameId !== planEditor.game.id;
    if (replacing && !window.confirm(`“${playScenarioLabels[planEditor.scenario]}”当前正在玩《${current.game.nameZh}》。确认暂停它并替换吗？`)) return;
    await action({
      action: "SET_PLAN",
      gameId: planEditor.game.id,
      scenario: planEditor.scenario,
      state: planEditor.state,
      acquisitionId: form.get("acquisitionId") || null,
      preferredDevice: form.get("preferredDevice") || null,
      completionGoal: form.get("completionGoal"),
      queueOrder: form.get("queueOrder") ? Number(form.get("queueOrder")) : null,
      ...(planEditor.plan ? { version: planEditor.plan.version } : {}),
      replaceCurrent: Boolean(replacing)
    }, `${planEditor.game.nameZh}已加入${playScenarioLabels[planEditor.scenario]}`);
  }

  async function saveGameDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detailGame) return;
    const form = new FormData(event.currentTarget);
    const nullableNumber = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value ? Number(value) : null;
    };
    const playtimeHours = nullableNumber("playtimeHours");
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/v1/games/${detailGame.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: detailGame.version,
          nameZh: String(form.get("nameZh") ?? "").trim(),
          nameEn: String(form.get("nameEn") ?? "").trim() || null,
          platform: String(form.get("platform") ?? "").trim() || null,
          releaseDate: String(form.get("releaseDate") ?? "").trim() || null,
          communityRating: nullableNumber("communityRating"),
          criticRating: nullableNumber("criticRating"),
          progressPercent: nullableNumber("progressPercent"),
          playtimeMinutesManual: playtimeHours === null ? null : Math.round(playtimeHours * 60),
          notes: String(form.get("notes") ?? "").trim() || null
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "保存游戏信息失败");
      setMessageTone("success"); setMessage(`${detailGame.nameZh}的信息已保存`);
      setDetailGame(null);
      router.refresh();
    } catch (error) {
      setMessageTone("error"); setMessage(error instanceof Error ? error.message : "保存游戏信息失败");
    } finally { setBusy(false); }
  }

  async function pause(plan: PlannerPlan) {
    await action({
      action: "SET_PLAN", gameId: plan.gameId, scenario: plan.scenario, state: "QUEUED",
      acquisitionId: plan.acquisitionId, preferredDevice: plan.preferredDevice,
      completionGoal: plan.completionGoal, queueOrder: plan.queueOrder, version: plan.version, replaceCurrent: false
    }, `${plan.game.nameZh}已暂停并返回队列`);
  }

  async function start(plan: PlannerPlan) {
    const current = data.scenarios[plan.scenario].current;
    const replacing = current && current.gameId !== plan.gameId;
    if (replacing && !window.confirm(`确认暂停《${current.game.nameZh}》并开始《${plan.game.nameZh}》吗？`)) return;
    await action({
      action: "SET_PLAN", gameId: plan.gameId, scenario: plan.scenario, state: "PLAYING",
      acquisitionId: plan.acquisitionId, preferredDevice: plan.preferredDevice,
      completionGoal: plan.completionGoal, version: plan.version, replaceCurrent: Boolean(replacing)
    }, `${plan.game.nameZh}已开始游玩`);
  }

  async function removePlan(plan: PlannerPlan) {
    if (!window.confirm(`确认将《${plan.game.nameZh}》移出${playScenarioLabels[plan.scenario]}吗？`)) return;
    await action({ action: "REMOVE_PLAN", gameId: plan.gameId, scenario: plan.scenario, version: plan.version }, "已移出游玩规划");
  }

  async function archiveGame(game: PlannerGame, action: "COMPLETE" | "ABANDON") {
    if (action === "ABANDON" && !window.confirm(`确认将《${game.nameZh}》标记为弃坑并移出所有游玩队列吗？`)) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/v1/games/${game.id}/quick-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, version: game.version })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "快捷归档失败");
      setMessageTone("success");
      setMessage(action === "COMPLETE"
        ? `《${game.nameZh}》已标记通关并移出游玩队列`
        : `《${game.nameZh}》已标记弃坑并移出游玩队列`);
      setDetailGame(null);
      router.refresh();
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "快捷归档失败");
    } finally { setBusy(false); }
  }

  function beginDrag(event: DragEvent<HTMLElement>, payload: PlannerDrag) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = payload.kind === "PLAN" ? "move" : "copy";
    event.dataTransfer.setData("text/plain", payload.kind === "PLAN" ? payload.plan.game.nameZh : payload.game.nameZh);
    setDragging(payload);
  }

  function clearTouchSession() {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = null;
    touchSessionRef.current = null;
    setTouchDrag(null);
    setDragTarget("");
    setDragging(null);
  }

  function targetAtPoint(x: number, y: number, payload: PlannerDrag) {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-play-drop-target]");
    const raw = element?.dataset.playDropTarget;
    if (!raw) return null;
    const [scenario, state] = raw.split(":") as [PlayScenario, PlannerDropState];
    if (!playScenarioValues.includes(scenario) || !["QUEUED", "PLAYING"].includes(state)) return null;
    const game = payload.kind === "PLAN" ? payload.plan.game : payload.game;
    return { scenario, state, eligible: gameSupportsScenario(game, scenario) };
  }

  function touchPointerDown(event: ReactPointerEvent<HTMLElement>, payload: PlannerDrag) {
    event.stopPropagation();
    if (event.pointerType === "mouse" || busy) return;
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    touchSessionRef.current = { pointerId: event.pointerId, payload, startX: event.clientX, startY: event.clientY, active: false };
    touchTimerRef.current = setTimeout(() => {
      const session = touchSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      session.active = true;
      setDragging(payload);
      setTouchDrag({ payload, x: event.clientX, y: event.clientY });
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(8);
    }, 220);
  }

  function touchPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = touchSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (!session.active && distance > 10) {
      if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
      touchSessionRef.current = null;
      return;
    }
    if (!session.active) return;
    event.preventDefault();
    setTouchDrag({ payload: session.payload, x: event.clientX, y: event.clientY });
    const target = targetAtPoint(event.clientX, event.clientY, session.payload);
    setDragTarget(target ? target.eligible ? `${target.scenario}:${target.state}` : `${target.scenario}:BLOCKED` : "");
  }

  function touchPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    const session = touchSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const wasActive = session.active;
    const payload = session.payload;
    const target = wasActive ? targetAtPoint(event.clientX, event.clientY, payload) : null;
    if (wasActive) {
      suppressCardClickRef.current = true;
      window.setTimeout(() => { suppressCardClickRef.current = false; }, 300);
    }
    clearTouchSession();
    if (target?.eligible) void dropInto(target.scenario, target.state, payload);
  }

  function touchPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (touchSessionRef.current?.pointerId === event.pointerId) clearTouchSession();
  }

  async function dropInto(scenario: PlayScenario, state: PlannerDropState, explicitPayload?: PlannerDrag) {
    const payload = explicitPayload ?? dragging;
    setDragTarget(""); setDragging(null);
    if (!payload || busy) return;
    const game = payload.kind === "PLAN" ? payload.plan.game : payload.game;
    const current = data.scenarios[scenario].current;
    const replacing = state === "PLAYING" && current && current.gameId !== game.id;
    if (replacing && !window.confirm(`确认暂停《${current.game.nameZh}》并将《${game.nameZh}》拖入正在玩槽位吗？`)) return;
    if (payload.kind === "PLAN" && payload.plan.scenario !== scenario) {
      const targetPlan = data.scenarios[scenario].current?.gameId === game.id
        ? data.scenarios[scenario].current
        : data.scenarios[scenario].queue.find((plan) => plan.gameId === game.id) ?? null;
      await action({
        action: "MOVE_PLAN", gameId: game.id,
        sourceScenario: payload.plan.scenario, targetScenario: scenario, targetState: state,
        sourceVersion: payload.plan.version,
        ...(targetPlan ? { targetVersion: targetPlan.version } : {}),
        acquisitionId: null, preferredDevice: null,
        completionGoal: payload.plan.completionGoal, queueOrder: null,
        replaceCurrent: Boolean(replacing)
      }, `${game.nameZh}已移动到${playScenarioLabels[scenario]}${state === "PLAYING" ? "正在玩" : "队列"}`);
      return;
    }
    const existing = payload.kind === "PLAN"
      ? payload.plan
      : (data.scenarios[scenario].current?.gameId === game.id
        ? data.scenarios[scenario].current
        : data.scenarios[scenario].queue.find((plan) => plan.gameId === game.id) ?? null);
    await action({
      action: "SET_PLAN", gameId: game.id, scenario, state,
      acquisitionId: existing?.acquisitionId ?? null,
      preferredDevice: existing?.preferredDevice ?? null,
      completionGoal: existing?.completionGoal ?? "EXTRA",
      queueOrder: state === "QUEUED" ? existing?.queueOrder ?? null : null,
      ...(existing ? { version: existing.version } : {}),
      replaceCurrent: Boolean(replacing)
    }, `${game.nameZh}已放入${playScenarioLabels[scenario]}${state === "PLAYING" ? "正在玩" : "队列"}`);
  }

  return <>
    <header className="page-header play-planner-header"><div><span className="eyebrow">PLAY PLANNER</span><h1>游玩规划</h1><p>两条场景队列，各保留一个正在玩槽位；默认按会免、家庭、实体、自购排序。</p></div><a className="secondary-button compact" href="/games">管理完整游戏库</a></header>
    {message ? <div className={`inline-alert ${messageTone === "error" ? "error" : ""}`} role="status">{message}</div> : null}
    <section className="play-planner-summary" aria-label="游玩规划概览">
      <div><Gamepad2 size={18} /><span><strong>{data.counts.activeDistinct}/2</strong><small>正在玩</small></span></div>
      <div><Clock3 size={18} /><span><strong>{data.counts.queued}</strong><small>双场景候选</small></span></div>
      <div><HardDrive size={18} /><span><strong>{data.counts.missingChannel}</strong><small>渠道待标注</small></span></div>
      <div><Star size={18} /><span><strong>{data.counts.missingHltb}</strong><small>HLTB待补全</small></span></div>
    </section>
    <form className="play-budget-bar" onSubmit={saveBudgets}>
      <div><strong>每周时间预算</strong><small>用于估算剩余周数，不会覆盖你的队列选择。</small></div>
      <label>通勤<input type="number" min="0.5" max="168" step="0.5" value={commuteHours} onChange={(event) => setCommuteHours(event.target.value)} />小时</label>
      <label>固定<input type="number" min="0.5" max="168" step="0.5" value={fixedHours} onChange={(event) => setFixedHours(event.target.value)} />小时</label>
      <button className="secondary-button compact" disabled={busy}><Check size={14} />保存</button>
    </form>
    <div className="play-scenario-grid">
      {playScenarioValues.map((scenario) => <ScenarioPanel key={scenario} scenario={scenario} data={data} busy={busy} dragging={dragging} dragTarget={dragTarget} onDragTarget={setDragTarget} onDrop={dropInto} onBeginDrag={beginDrag} onDragEnd={() => { setDragging(null); setDragTarget(""); }} onTouchPointerDown={touchPointerDown} onTouchPointerMove={touchPointerMove} onTouchPointerEnd={touchPointerEnd} onTouchPointerCancel={touchPointerCancel} onOpenGame={openDetails} onOpenGameFromKeyboard={openDetailsFromKeyboard} onPause={pause} onArchive={archiveGame} onStart={start} onEdit={(plan) => openPlan(plan.game, scenario, plan, plan.state)} onRemove={removePlan} />)}
    </div>
    <section className="play-candidate-section">
      <header><div><span className="eyebrow">AVAILABLE POOL</span><h2>候玩池</h2><p>仅显示已有可用入手渠道、尚未通关且未进入游玩队列的游戏；拖动卡片即可规划。</p></div><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索中英文名、平台或渠道" /></label></header>
      <div className="play-candidate-grid">{visibleCandidates.map((game) => <article className="play-candidate-card play-interactive-card" key={game.id} role="group" tabIndex={0} aria-label={`查看并编辑${game.nameZh}`} onClick={() => openDetails(game)} onKeyDown={(event) => openDetailsFromKeyboard(event, game)}>
        <button type="button" className="play-drag-handle" title="拖动到通勤或固定队列；触屏长按后拖动" aria-label={`拖动${game.nameZh}`} draggable={!busy} onClick={(event) => event.stopPropagation()} onDragStart={(event) => beginDrag(event, { kind: "GAME", game })} onDragEnd={() => { setDragging(null); setDragTarget(""); }} onPointerDown={(event) => touchPointerDown(event, { kind: "GAME", game })} onPointerMove={touchPointerMove} onPointerUp={touchPointerEnd} onPointerCancel={touchPointerCancel}><GripVertical size={15} /></button>
        <GameCover src={game.coverUrl} />
        <div className="play-candidate-copy"><strong>{game.nameZh}</strong><small>{game.nameEn ?? platformLabel(game.platform)}</small><span>主线 {duration(game.estimatedHastilyMinutes)} · 主线+支线 {duration(game.estimatedNormallyMinutes)} · 全收集 {duration(game.estimatedCompletelyMinutes)}</span></div>
        <div className="play-acquisition-list">
          {game.acquisitions.length ? game.acquisitions.map((item) => <button type="button" className={item.channel ? `channel-${item.channel.toLowerCase()}` : "channel-unknown"} key={item.id} onClick={(event) => { event.stopPropagation(); openAcquisition(game, item); }}><Pencil size={11} />{item.channel ? acquisitionChannelLabels[item.channel] : "待标注"} · {platformLabel(item.platform)}{item.commuteEligible ? " · 可通勤" : " · 仅固定"}</button>) : <span>尚无入手渠道</span>}
          <button type="button" className="play-add-acquisition" onClick={(event) => { event.stopPropagation(); openAcquisition(game, null); }}><Plus size={11} />添加渠道</button>
        </div>
        <div className="play-candidate-actions">
          {playScenarioValues.map((scenario) => {
            const key = `${game.id}:${scenario}`;
            const existing = data.scenarios[scenario].current?.gameId === game.id ? data.scenarios[scenario].current : data.scenarios[scenario].queue.find((plan) => plan.gameId === game.id) ?? null;
            const eligible = gameSupportsScenario(game, scenario);
            return <button type="button" key={scenario} className={plannedKeys.has(key) ? "active" : ""} disabled={busy || !eligible} title={eligible ? undefined : "当前没有支持该场景的有效入手副本"} onClick={(event) => { event.stopPropagation(); openPlan(game, scenario, existing, existing?.state ?? "QUEUED"); }}>{scenario === "COMMUTE" ? <BriefcaseBusiness size={13} /> : <MonitorPlay size={13} />}{plannedKeys.has(key) ? `编辑${playScenarioLabels[scenario]}` : `加入${playScenarioLabels[scenario]}`}</button>;
          })}
        </div>
        <div className="play-terminal-actions"><button type="button" className="play-complete-button" disabled={busy} onClick={(event) => { event.stopPropagation(); void archiveGame(game, "COMPLETE"); }}><Trophy size={13} />标记通关</button><button type="button" className="play-abandon-button" disabled={busy} onClick={(event) => { event.stopPropagation(); void archiveGame(game, "ABANDON"); }}><Ban size={13} />弃坑</button></div>
      </article>)}</div>
      {!visibleCandidates.length ? <div className="home-empty compact">没有符合搜索条件的候选。</div> : null}
    </section>
    {touchDrag ? <div className="play-touch-ghost" style={{ transform: `translate3d(${touchDrag.x + 14}px, ${touchDrag.y + 14}px, 0)` }} aria-hidden="true"><GripVertical size={14} /><span>{touchDrag.payload.kind === "PLAN" ? touchDrag.payload.plan.game.nameZh : touchDrag.payload.game.nameZh}</span></div> : null}
    {detailGame ? <div className="play-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDetailGame(null); }}>
      <aside className="play-detail-drawer" role="dialog" aria-modal="true" aria-labelledby="play-detail-title">
        <header className="play-detail-hero">
          <GameCover src={detailGame.coverUrl} />
          <div><span className="eyebrow">GAME DETAILS</span><h2 id="play-detail-title">{detailGame.nameZh}</h2><p>{detailGame.nameEn ?? platformLabel(detailGame.platform)}</p><div className="play-detail-facts"><span>{platformLabel(detailGame.platform)}</span><span>已玩 {duration(detailGame.totalPlaytimeMinutes)}</span><span>进度 {detailGame.progressPercent ?? 0}%</span></div></div>
          <button type="button" className="icon-button" aria-label="关闭游戏详情" disabled={busy} onClick={() => setDetailGame(null)}><X size={18} /></button>
        </header>
        <div className="play-detail-scroll">
          <section className="play-detail-section"><header><div><span className="eyebrow">QUEUE</span><h3>游玩队列</h3></div><small>也可按住卡片拖拽</small></header><div className="play-detail-scenarios">
            {playScenarioValues.map((scenario) => {
              const plan = data.scenarios[scenario].current?.gameId === detailGame.id ? data.scenarios[scenario].current : data.scenarios[scenario].queue.find((item) => item.gameId === detailGame.id) ?? null;
              const eligible = gameSupportsScenario(detailGame, scenario);
              const Icon = scenario === "COMMUTE" ? BriefcaseBusiness : MonitorPlay;
              return <button type="button" key={scenario} disabled={busy || !eligible} className={plan ? "active" : ""} onClick={() => openPlan(detailGame, scenario, plan, plan?.state ?? "QUEUED")}><Icon size={17} /><span><strong>{playScenarioLabels[scenario]}</strong><small>{!eligible ? "当前副本不适用" : plan?.state === "PLAYING" ? "正在玩 · 点击调整" : plan ? "已在队列 · 点击调整" : "点击加入接下来玩"}</small></span></button>;
            })}
          </div></section>
          <section className="play-detail-section"><header><div><span className="eyebrow">ACCESS</span><h3>入手渠道</h3></div><button type="button" className="text-button" onClick={() => openAcquisition(detailGame, null)}><Plus size={14} />添加副本</button></header><div className="play-detail-acquisitions">
            {detailGame.acquisitions.length ? detailGame.acquisitions.map((item) => <button type="button" key={item.id} onClick={() => openAcquisition(detailGame, item)}><span className={item.channel ? `channel-${item.channel.toLowerCase()}` : "channel-unknown"}>{item.channel ? acquisitionChannelLabels[item.channel] : "待标注"}</span><strong>{platformLabel(item.platform)}</strong><small>{acquisitionAvailabilityLabels[item.availability]} · {item.commuteEligible ? "可通勤" : "仅固定"}</small><Pencil size={13} /></button>) : <p className="play-detail-empty">尚无入手渠道，添加后才能进入场景队列。</p>}
          </div></section>
          <section className="play-detail-section"><header><div><span className="eyebrow">ARCHIVE</span><h3>状态归档</h3></div><small>归档后自动移出所有游玩队列</small></header><div className="play-terminal-actions play-detail-terminal-actions"><button type="button" className="play-complete-button" disabled={busy} onClick={() => void archiveGame(detailGame, "COMPLETE")}><Trophy size={14} />标记通关</button><button type="button" className="play-abandon-button" disabled={busy} onClick={() => void archiveGame(detailGame, "ABANDON")}><Ban size={14} />弃坑</button></div></section>
          <section className="play-detail-section play-detail-hltb"><header><div><span className="eyebrow">HOW LONG TO BEAT</span><h3>预计时长</h3></div></header><div><span><small>主线</small><strong>{duration(detailGame.estimatedHastilyMinutes)}</strong></span><span><small>主线＋支线</small><strong>{duration(detailGame.estimatedNormallyMinutes)}</strong></span><span><small>全收集</small><strong>{duration(detailGame.estimatedCompletelyMinutes)}</strong></span></div></section>
          <form className="play-detail-form" onSubmit={saveGameDetails}><section className="play-detail-section"><header><div><span className="eyebrow">METADATA</span><h3>具体信息</h3></div></header><div className="form-grid">
            <label>中文名<input name="nameZh" required maxLength={200} defaultValue={detailGame.nameZh} /></label>
            <label>英文名<input name="nameEn" maxLength={200} defaultValue={detailGame.nameEn ?? ""} /></label>
            <label>平台<select name="platform" defaultValue={detailGame.platform ?? ""}><option value="">未设置</option>{Object.entries(platformLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label>发售日期<input type="date" name="releaseDate" defaultValue={detailGame.releaseDate ?? ""} /></label>
            <label>社区评分<input type="number" name="communityRating" min="0" max="100" step="0.1" defaultValue={detailGame.communityRating ?? ""} placeholder="0–100" /></label>
            <label>媒体评分<input type="number" name="criticRating" min="0" max="100" step="0.1" defaultValue={detailGame.criticRating ?? ""} placeholder="0–100" /></label>
            <label>完成进度<input type="number" name="progressPercent" min="0" max="100" step="1" defaultValue={detailGame.progressPercent ?? ""} placeholder="0–100" /></label>
            <label>手工游玩时长<input type="number" name="playtimeHours" min="0" step="0.1" defaultValue={detailGame.playtimeMinutesManual === null ? "" : Math.round(detailGame.playtimeMinutesManual / 6) / 10} placeholder="小时" /></label>
            <label className="full-width">备注<textarea name="notes" maxLength={5000} rows={4} defaultValue={detailGame.notes ?? ""} placeholder="记录版本、存档、游玩建议或其他信息" /></label>
          </div></section><footer><button type="button" className="secondary-button" disabled={busy} onClick={() => setDetailGame(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存游戏信息"}</button></footer></form>
        </div>
      </aside>
    </div> : null}
    {acquisitionEditor ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setAcquisitionEditor(null); }}><div className="modal-panel narrow" role="dialog" aria-modal="true"><header><div><span className="eyebrow">ACQUISITION</span><h2>{acquisitionEditor.game.nameZh}</h2><p>渠道属于平台副本；同一游戏可以保留多个版本。</p></div><button className="icon-button" disabled={busy} onClick={() => setAcquisitionEditor(null)}><X size={18} /></button></header><form onSubmit={saveAcquisition}><div className="form-grid">
      <label>入手渠道<select name="channel" defaultValue={acquisitionEditor.acquisition?.channel ?? "SELF_PURCHASED"}>{acquisitionChannelValues.map((value) => <option value={value} key={value}>{acquisitionChannelLabels[value]}</option>)}</select></label>
      <label>平台<select name="platform" defaultValue={acquisitionEditor.acquisition?.platform ?? acquisitionEditor.game.platform ?? ""}><option value="">未设置</option>{Object.entries(platformLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>权限状态<select name="availability" defaultValue={acquisitionEditor.acquisition?.availability ?? "AVAILABLE"}>{acquisitionAvailabilityValues.map((value) => <option value={value} key={value}>{acquisitionAvailabilityLabels[value]}</option>)}</select></label>
      <label className="checkbox-field"><input type="checkbox" name="offlineCapable" defaultChecked={acquisitionEditor.acquisition?.commuteEligible ?? false} /><span><strong>支持通勤离线原生运行</strong><small>Switch 默认开启、PlayStation 固定场所、Steam 默认双场景；保存后作为人工例外。</small></span></label>
    </div><footer><button type="button" className="secondary-button" onClick={() => setAcquisitionEditor(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存渠道"}</button></footer></form></div></div> : null}
    {planEditor ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPlanEditor(null); }}><div className="modal-panel narrow" role="dialog" aria-modal="true"><header><div><span className="eyebrow">{playScenarioLabels[planEditor.scenario]}</span><h2>{planEditor.game.nameZh}</h2><p>{planEditor.scenario === "COMMUTE" ? "Switch 默认通勤、Steam 默认可通勤；PlayStation 仅进入固定场景。" : "可使用本地设备或稳定网络串流。"}</p></div><button className="icon-button" disabled={busy} onClick={() => setPlanEditor(null)}><X size={18} /></button></header><form onSubmit={savePlan}><div className="form-grid">
      <label>入手副本<select name="acquisitionId" defaultValue={planEditor.plan?.acquisitionId ?? ""}><option value="">自动选最高优先渠道</option>{planEditor.game.acquisitions.filter((item) => item.availability === "AVAILABLE" && (planEditor.scenario === "COMMUTE" ? item.commuteEligible : item.fixedEligible)).map((item) => <option value={item.id} key={item.id}>{item.channel ? acquisitionChannelLabels[item.channel] : "待标注"} · {platformLabel(item.platform)}</option>)}</select></label>
      <label>设备方案<select name="preferredDevice" defaultValue={planEditor.plan?.preferredDevice ?? ""}><option value="">自动选择</option>{playDeviceProfiles.filter((item) => item.scenario === planEditor.scenario).map((item) => <option value={item.code} key={item.code}>{item.label}{item.hdr ? " · HDR" : " · 无HDR"}{item.stream ? " · 可串流" : ""}</option>)}</select></label>
      <label>完成目标<select name="completionGoal" defaultValue={planEditor.plan?.completionGoal ?? "EXTRA"}>{completionGoalValues.map((value) => <option value={value} key={value}>{completionGoalLabels[value]}</option>)}</select></label>
      <label>同渠道内手工顺序<input type="number" name="queueOrder" min="1" max="9999" placeholder="例如 10" defaultValue={planEditor.plan?.queueOrder ?? ""} /></label>
    </div><footer><button type="button" className="secondary-button" onClick={() => setPlanEditor(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : planEditor.state === "PLAYING" ? "保存正在玩" : "加入队列"}</button></footer></form></div></div> : null}
  </>;
}

function ScenarioPanel({ scenario, data, busy, dragging, dragTarget, onDragTarget, onDrop, onBeginDrag, onDragEnd, onTouchPointerDown, onTouchPointerMove, onTouchPointerEnd, onTouchPointerCancel, onOpenGame, onOpenGameFromKeyboard, onPause, onArchive, onStart, onEdit, onRemove }: {
  scenario: PlayScenario;
  data: PlayPlannerData;
  busy: boolean;
  dragging: PlannerDrag | null;
  dragTarget: string;
  onDragTarget: (value: string) => void;
  onDrop: (scenario: PlayScenario, state: PlannerDropState) => void;
  onBeginDrag: (event: DragEvent<HTMLElement>, payload: PlannerDrag) => void;
  onDragEnd: () => void;
  onTouchPointerDown: (event: ReactPointerEvent<HTMLElement>, payload: PlannerDrag) => void;
  onTouchPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onTouchPointerEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onTouchPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onOpenGame: (game: PlannerGame) => void;
  onOpenGameFromKeyboard: (event: KeyboardEvent<HTMLElement>, game: PlannerGame) => void;
  onPause: (plan: PlannerPlan) => void;
  onArchive: (game: PlannerGame, action: "COMPLETE" | "ABANDON") => void;
  onStart: (plan: PlannerPlan) => void;
  onEdit: (plan: PlannerPlan) => void;
  onRemove: (plan: PlannerPlan) => void;
}) {
  const section = data.scenarios[scenario];
  const current = section.current;
  const Icon = scenario === "COMMUTE" ? BriefcaseBusiness : MonitorPlay;
  const currentTarget = `${scenario}:PLAYING`;
  const queueTarget = `${scenario}:QUEUED`;
  const draggedGame = dragging?.kind === "PLAN" ? dragging.plan.game : dragging?.game;
  const acceptsDraggedGame = Boolean(draggedGame && gameSupportsScenario(draggedGame, scenario));
  const dropHandlers = (state: PlannerDropState) => ({
    "data-play-drop-target": `${scenario}:${state}`,
    onDragOver: (event: DragEvent<HTMLElement>) => { if (dragging && !busy && acceptsDraggedGame) { event.preventDefault(); event.dataTransfer.dropEffect = dragging.kind === "PLAN" ? "move" : "copy"; } },
    onDragEnter: (event: DragEvent<HTMLElement>) => { if (dragging && !busy) { event.preventDefault(); onDragTarget(acceptsDraggedGame ? `${scenario}:${state}` : `${scenario}:BLOCKED`); } },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragTarget(""); },
    onDrop: (event: DragEvent<HTMLElement>) => { event.preventDefault(); if (acceptsDraggedGame) void onDrop(scenario, state); }
  });
  const blocked = dragTarget === `${scenario}:BLOCKED`;
  return <section className={`play-scenario-panel scenario-${scenario.toLowerCase()}`}>
    <header><div><span className="play-scenario-icon"><Icon size={18} /></span><span><strong>{playScenarioLabels[scenario]}</strong><small>{scenario === "COMMUTE" ? "无稳定网络 · 原生离线" : "稳定网络 · 本地或串流"}</small></span></div><em>{section.weeklyBudgetMinutes / 60}h／周</em></header>
    <div className={`play-current-slot play-drop-zone ${dragTarget === currentTarget ? "is-drag-over" : ""} ${blocked ? "is-drop-blocked" : ""}`} {...dropHandlers("PLAYING")}>
      <span>正在玩槽位 {dragging ? blocked ? "· 当前副本不适用" : "· 松开放入" : ""}</span>
      {current ? <article className="play-interactive-card" role="group" tabIndex={0} aria-label={`查看并编辑${current.game.nameZh}`} onClick={() => onOpenGame(current.game)} onKeyDown={(event) => onOpenGameFromKeyboard(event, current.game)}><button type="button" className="play-drag-handle" title="拖动到另一场景或接下来玩；触屏长按后拖动" aria-label={`拖动${current.game.nameZh}`} draggable={!busy} onClick={(event) => event.stopPropagation()} onDragStart={(event) => onBeginDrag(event, { kind: "PLAN", plan: current })} onDragEnd={onDragEnd} onPointerDown={(event) => onTouchPointerDown(event, { kind: "PLAN", plan: current })} onPointerMove={onTouchPointerMove} onPointerUp={onTouchPointerEnd} onPointerCancel={onTouchPointerCancel}><GripVertical size={14} /></button><GameCover src={current.game.coverUrl} /><div><strong>{current.game.nameZh}</strong><small>{current.channel ? acquisitionChannelLabels[current.channel] : "渠道待标注"} · {completionGoalLabels[current.completionGoal]}</small><small>剩余 {duration(current.remainingMinutes)} · {weeks(current.expectedWeeks)}</small></div><div className="play-current-actions"><button title="编辑" disabled={busy} onClick={(event) => { event.stopPropagation(); onEdit(current); }}><Pencil size={13} />编辑</button><button disabled={busy} onClick={(event) => { event.stopPropagation(); onPause(current); }}><Square size={13} />暂停</button><button className="play-complete-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onArchive(current.game, "COMPLETE"); }}><Trophy size={13} />标记通关</button><button className="play-abandon-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onArchive(current.game, "ABANDON"); }}><Ban size={13} />弃坑</button></div></article> : <div className="play-empty-slot"><Icon size={18} /><span>{dragging ? "拖到这里开始游玩" : "当前空闲"}</span></div>}
    </div>
    <div className={`play-queue-list play-drop-zone ${dragTarget === queueTarget ? "is-drag-over" : ""} ${blocked ? "is-drop-blocked" : ""}`} {...dropHandlers("QUEUED")}><div className="play-queue-heading"><strong>接下来玩</strong><small>{dragging ? blocked ? "当前副本不适用此场景" : "松开放入队列" : "会免 ＞ 家庭 ＞ 实体 ＞ 自购"}</small></div>{section.queue.length ? section.queue.map((plan, index) => <article className="play-interactive-card" key={plan.id} role="group" tabIndex={0} aria-label={`查看并编辑${plan.game.nameZh}`} onClick={() => onOpenGame(plan.game)} onKeyDown={(event) => onOpenGameFromKeyboard(event, plan.game)}>
      <button type="button" className="play-drag-handle" title="拖动到另一场景或正在玩；触屏长按后拖动" aria-label={`拖动${plan.game.nameZh}`} draggable={!busy} onClick={(event) => event.stopPropagation()} onDragStart={(event) => onBeginDrag(event, { kind: "PLAN", plan })} onDragEnd={onDragEnd} onPointerDown={(event) => onTouchPointerDown(event, { kind: "PLAN", plan })} onPointerMove={onTouchPointerMove} onPointerUp={onTouchPointerEnd} onPointerCancel={onTouchPointerCancel}><GripVertical size={13} /></button><span className="play-queue-order">{String(index + 1).padStart(2, "0")}</span><div><strong>{plan.game.nameZh}</strong><small>{plan.channel ? acquisitionChannelLabels[plan.channel] : "渠道待标注"} · 剩余 {duration(plan.remainingMinutes)} · {weeks(plan.expectedWeeks)}</small></div><div className="play-queue-actions"><button title="编辑" aria-label={`编辑《${plan.game.nameZh}》`} disabled={busy} onClick={(event) => { event.stopPropagation(); onEdit(plan); }}><Pencil size={13} /></button><button title="开始" aria-label={`开始《${plan.game.nameZh}》`} disabled={busy} onClick={(event) => { event.stopPropagation(); onStart(plan); }}><Play size={13} /></button><button className="play-complete-button" title="标记通关" aria-label={`将《${plan.game.nameZh}》标记通关`} disabled={busy} onClick={(event) => { event.stopPropagation(); onArchive(plan.game, "COMPLETE"); }}><Trophy size={13} /></button><button className="play-abandon-button" title="弃坑" aria-label={`将《${plan.game.nameZh}》标记弃坑`} disabled={busy} onClick={(event) => { event.stopPropagation(); onArchive(plan.game, "ABANDON"); }}><Ban size={13} /></button><button title="移出" aria-label={`移出《${plan.game.nameZh}》`} disabled={busy} onClick={(event) => { event.stopPropagation(); onRemove(plan); }}><Trash2 size={13} /></button></div>
    </article>) : <div className="play-empty-queue">暂无候选</div>}</div>
  </section>;
}
