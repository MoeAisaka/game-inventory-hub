"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  Ban,
  BriefcaseBusiness,
  Clock3,
  Eye,
  EyeOff,
  Gamepad2,
  Heart,
  MonitorPlay,
  Play,
  ShoppingBag,
  Square,
  Trophy
} from "lucide-react";
import { useRouter } from "next/navigation";
import { GameCover } from "@/components/game-cover";
import type { HomeData, HomeQueuePreferences } from "@/lib/home";
import {
  acquisitionChannelLabels,
  completionGoalLabels,
  playScenarioLabels,
  type PlannerGame,
  type PlannerPlan
} from "@/lib/play-planning";

const platformLabels: Record<string, string> = {
  STEAM: "Steam", PLAYSTATION: "PlayStation", NINTENDO_SWITCH: "Switch",
  NINTENDO_SWITCH_2: "Switch 2", NINTENDO_SWITCH_FAMILY: "Switch",
  XBOX_GAME_PASS: "XGP", PC_OTHER: "PC", IOS: "iOS"
};

function platforms(value: string | null) {
  if (!value) return "平台待补全";
  return value.split(/\s*\/\s*/).map((item) => platformLabels[item] ?? item).join(" / ");
}

function hours(minutes: number | null) {
  if (minutes === null) return "时长待补全";
  return `剩余 ${Math.round(minutes / 6) / 10}h`;
}

function expectedWeeks(value: number | null) {
  if (value === null) return "周期待补全";
  return value < 1 ? "预计 1 周内" : `预计 ${value} 周`;
}

export function ActionHomeClient({ data, queuePreferences }: { data: HomeData; queuePreferences: HomeQueuePreferences }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [showCandidatePool, setShowCandidatePool] = useState(queuePreferences.showCandidatePool);

  async function toggleCandidatePool() {
    const next = !showCandidatePool;
    setShowCandidatePool(next);
    try {
      const response = await fetch("/api/v1/preferences/home-queue", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ showCandidatePool: next })
      });
      if (!response.ok) throw new Error("候玩池显示偏好保存失败");
    } catch (error) {
      setShowCandidatePool(!next);
      setMessageTone("error"); setMessage(error instanceof Error ? error.message : "候玩池显示偏好保存失败");
    }
  }

  async function plannerAction(plan: PlannerPlan, state: "QUEUED" | "PLAYING") {
    const current = data.playScenarios[plan.scenario].current;
    const replacing = state === "PLAYING" && current && current.gameId !== plan.gameId;
    if (replacing && !window.confirm(`确认暂停《${current.game.nameZh}》并开始《${plan.game.nameZh}》吗？`)) return;
    setBusy(`${plan.id}:${state}`); setMessage("");
    try {
      const response = await fetch("/api/v1/play-planner/action", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          action: "SET_PLAN", gameId: plan.gameId, scenario: plan.scenario, state,
          acquisitionId: plan.acquisitionId, preferredDevice: plan.preferredDevice,
          completionGoal: plan.completionGoal, queueOrder: state === "QUEUED" ? plan.queueOrder : null,
          version: plan.version, replaceCurrent: Boolean(replacing)
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "游玩规划更新失败");
      setMessageTone("success");
      setMessage(state === "PLAYING" ? `已开始《${plan.game.nameZh}》` : `《${plan.game.nameZh}》已暂停并返回队列`);
      router.refresh();
    } catch (error) {
      setMessageTone("error"); setMessage(error instanceof Error ? error.message : "游玩规划更新失败");
    } finally { setBusy(null); }
  }

  async function quickArchive(game: Pick<PlannerGame, "id" | "nameZh" | "version">, action: "COMPLETE" | "ABANDON") {
    if (action === "ABANDON" && !window.confirm(`确认将《${game.nameZh}》标记为弃坑并移出所有游玩队列吗？`)) return;
    setBusy(`${game.id}:${action}`); setMessage("");
    try {
      const response = await fetch(`/api/v1/games/${game.id}/quick-status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, version: game.version })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "快捷操作失败");
      setMessageTone("success");
      setMessage(action === "COMPLETE"
        ? `《${game.nameZh}》已标记通关并归档`
        : `《${game.nameZh}》已标记弃坑并归档`);
      router.refresh();
    } catch (error) {
      setMessageTone("error"); setMessage(error instanceof Error ? error.message : "快捷操作失败");
    } finally { setBusy(null); }
  }

  return <>
    <header className="page-header home-header"><div><span className="eyebrow">TODAY</span><h1>今日</h1><p>集中查看和管理正在玩、接下来玩、候玩池与心愿单。</p></div><div className="heading-actions"><Link className="secondary-button compact" href="/play"><Gamepad2 size={14} />完整游玩规划</Link><Link className="secondary-button compact" href="/wishlist"><Heart size={14} />心愿与发售</Link></div></header>
    {message ? <div className={`inline-alert ${messageTone === "error" ? "error" : ""}`} role="status">{message}</div> : null}
    <section className="home-queue-summary" aria-label="队列概览">
      <div><Gamepad2 size={18} /><span><small>正在玩</small><strong>{data.metrics.activeCount}<i> / 2</i></strong></span></div>
      <div><Clock3 size={18} /><span><small>接下来玩</small><strong>{data.metrics.plannedCount}</strong></span></div>
      <div><ShoppingBag size={18} /><span><small>心愿单</small><strong>{data.metrics.purchaseCount}</strong></span></div>
    </section>

    <section className="content-section home-queue-section home-current-section">
      <div className="home-queue-heading"><div><span>01</span><div><h2>正在玩</h2><p>通勤便携与固定／串流各一个槽位，最多并行两款。</p></div></div><Link href="/play">调整槽位<ArrowRight size={14} /></Link></div>
      <div className="home-current-grid">
        {(["COMMUTE", "FIXED"] as const).map((scenario) => {
          const plan = data.playScenarios[scenario].current;
          const Icon = scenario === "COMMUTE" ? BriefcaseBusiness : MonitorPlay;
          if (!plan) return <article className="home-current-card empty" key={scenario}><Icon size={22} /><span>{playScenarioLabels[scenario]}</span><strong>当前槽位空闲</strong><Link href="/play">从队列选择</Link></article>;
          return <article className="home-current-card" key={scenario}>
            <GameCover src={plan.game.coverUrl} alt={`${plan.game.nameZh}封面`} />
            <div className="home-current-copy"><span><Icon size={13} />{playScenarioLabels[scenario]}</span><h3>{plan.game.nameZh}</h3><p>{plan.channel ? acquisitionChannelLabels[plan.channel] : "渠道待标注"} · {completionGoalLabels[plan.completionGoal]}</p><small>{hours(plan.remainingMinutes)} · {expectedWeeks(plan.expectedWeeks)}</small></div>
            <div className="home-current-actions"><button disabled={busy !== null} onClick={() => plannerAction(plan, "QUEUED")}><Square size={13} />暂停</button><button className="complete" disabled={busy !== null} onClick={() => quickArchive(plan.game, "COMPLETE")}><Trophy size={13} />标记通关</button><button className="abandon" disabled={busy !== null} onClick={() => quickArchive(plan.game, "ABANDON")}><Ban size={13} />弃坑</button></div>
          </article>;
        })}
      </div>
    </section>

    <section className="content-section home-queue-section">
      <div className="home-queue-heading"><div><span>02</span><div><h2>接下来玩</h2><p>跨场景统一按会免 ＞ 家庭 ＞ 实体 ＞ 自购排序。</p></div></div><Link href="/play">管理完整队列<ArrowRight size={14} /></Link></div>
      {data.nextQueue.length ? <div className="home-next-list">{data.nextQueue.slice(0, 8).map((plan, index) => <article key={plan.id}>
        <span className="home-next-order">{String(index + 1).padStart(2, "0")}</span><GameCover src={plan.game.coverUrl} alt={`${plan.game.nameZh}封面`} /><div><strong>{plan.game.nameZh}</strong><small>{playScenarioLabels[plan.scenario]} · {plan.channel ? acquisitionChannelLabels[plan.channel] : "渠道待标注"} · {hours(plan.remainingMinutes)}</small></div><div className="home-terminal-actions"><button title="开始" aria-label={`开始《${plan.game.nameZh}》`} disabled={busy !== null} onClick={() => plannerAction(plan, "PLAYING")}><Play size={13} />开始</button><button className="complete" title="标记通关" aria-label={`将《${plan.game.nameZh}》标记通关`} disabled={busy !== null} onClick={() => quickArchive(plan.game, "COMPLETE")}><Trophy size={13} />通关</button><button className="abandon" title="弃坑" aria-label={`将《${plan.game.nameZh}》标记弃坑`} disabled={busy !== null} onClick={() => quickArchive(plan.game, "ABANDON")}><Ban size={13} />弃坑</button></div>
      </article>)}</div> : <div className="home-empty compact">暂无接下来玩的游戏</div>}
    </section>

    <section className="content-section home-queue-section">
      <div className="home-queue-heading"><div><span>03</span><div><h2>候玩池</h2><p>已有可用入手渠道、尚未通关且未加入通勤或固定队列的游戏。</p></div></div><div className="heading-actions"><button type="button" className="secondary-button compact" aria-pressed={showCandidatePool} onClick={toggleCandidatePool}>{showCandidatePool ? <EyeOff size={14} /> : <Eye size={14} />}{showCandidatePool ? "隐藏候玩池" : `显示候玩池（${data.metrics.candidateCount}）`}</button><Link href="/play">管理候玩池<ArrowRight size={14} /></Link></div></div>
      {!showCandidatePool ? <div className="home-empty compact">候玩池已隐藏，共 {data.metrics.candidateCount} 款；今日页聚焦“正在玩＋接下来玩”。</div>
        : data.candidatePool.length ? <div className="home-purchase-grid home-candidate-grid">{data.candidatePool.slice(0, 8).map((game) => <article key={game.id}><GameCover src={game.coverUrl} alt={`${game.nameZh}封面`} /><div><span>{platforms(game.platform)}</span><strong>{game.nameZh}</strong><small>{game.acquisitions.length ? `${game.acquisitions.length} 个可用渠道` : "渠道待确认"}</small></div><div className="home-terminal-actions"><Link href="/play">规划</Link><button className="complete" disabled={busy !== null} onClick={() => quickArchive(game, "COMPLETE")}><Trophy size={13} />通关</button><button className="abandon" disabled={busy !== null} onClick={() => quickArchive(game, "ABANDON")}><Ban size={13} />弃坑</button></div></article>)}</div> : <div className="home-empty compact">候玩池为空</div>}
    </section>

    <section className="content-section home-queue-section">
      <div className="home-queue-heading"><div><span>04</span><div><h2>心愿单</h2><p>尚未获得访问权的作品；选择具体平台和入手渠道后自动排入“接下来玩”队尾。</p></div></div><Link href="/wishlist">管理心愿与发售<ArrowRight size={14} /></Link></div>
      {data.purchaseQueue.length ? <div className="home-purchase-grid">{data.purchaseQueue.slice(0, 8).map((item) => <article key={`${item.kind}:${item.id}`}><GameCover src={item.coverUrl} alt={`${item.nameZh}封面`} /><div><span>{item.sourceLabel} · {platforms(item.platform)}</span><strong>{item.nameZh}</strong><small>{item.releaseDate ? `发售 ${item.releaseDate}` : "发售日期待补全"}</small></div>{item.storeUrl ? <a href={item.storeUrl} target="_blank" rel="noreferrer">商店</a> : <Link href="/wishlist">查看</Link>}</article>)}</div> : <div className="home-empty compact">选购清单为空</div>}
    </section>
  </>;
}
