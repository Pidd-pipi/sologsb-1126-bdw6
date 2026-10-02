/**
 * DrillPlan（汛期演练占用单）—— 领队按同一营地凑帐篷数提交的占用记录。
 * 确认那一刻的容量口径随单落库；因子评估 / 风险否决变化会让已生效单立刻失效。
 */

/** 应急余量比例：营地总容量的两成不参与排营 */
export const RESERVE_RATIO = 0.2

/** 占用单状态 */
export type DrillPlanStatus = 'confirmed' | 'rejected' | 'invalidated' | 'pending-backfill'

export const PLAN_STATUS_LABELS: Record<DrillPlanStatus, string> = {
  confirmed: '已生效',
  rejected: '已拒绝',
  invalidated: '已失效',
  'pending-backfill': '待补录'
}

/** 容量口径快照：确认 / 重新确认那一刻的营地容量与已占情况 */
export interface CapacityCaliber {
  /** 营地总容量（各营位可容帐篷数之和） */
  totalCapacity: number
  /** 应急余量比例（两成 = 0.2） */
  reserveRatio: number
  /** 可订容量 = ⌊总容量 × (1 − 余量比例)⌋ */
  bookableCapacity: number
  /** 本单确认前该营地已占帐篷数 */
  occupiedBefore: number
  /** 快照时间 */
  snapshotAt: string
}

export interface DrillPlan {
  /** 主键，自增 */
  id?: number
  /** 占用单号，如 DP-0001 */
  planNo: string
  /** 领队 */
  leader: string
  /** 所属营地（与 Campsite.campName 对应） */
  campName: string
  /** 帐篷数 */
  tentCount: number
  status: DrillPlanStatus
  /** 拒绝 / 失效 / 待补的原因说明 */
  reason: string
  /** 容量口径快照；v5 之前的旧记录缺失，升级迁移时列为「待补录」 */
  capacity: CapacityCaliber | null
  createdAt: string
  updatedAt: string
}
