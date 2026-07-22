/** 兼容再导出层：游玩活动 / 购入状态派生已收敛至 game-state-engine（V0.32.0 需求四 B）。 */
export {
  activityStateValues,
  activityStateLabels,
  visibleActivityState,
  deriveActivityState,
  purchaseStateLabels,
  derivePurchaseState,
  type ActivityState,
  type PurchaseState
} from "@/lib/game-state-engine";
