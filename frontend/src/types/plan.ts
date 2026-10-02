/**
 * OccupancyPlan（营位占用计划）—— 汛期演练排营位：领队按同一营地凑帐篷数的一单占用。
 * 容量口径：营地总容量（该营地各营位可容帐篷数之和）留两成应急余量后为可用容量；
 * 可用容量 = floor(总容量 × (1 − 余量比例))；剩余容量 = 可用容量 − 已生效计划帐篷数之和。
 * 剩余容量不足时拒绝该单。
 */
import type { GradeThresholds } from '@/types/score'

/** 计划状态：confirmed 已生效 / invalid 已失效 / pending 待补（旧计划升级后缺容量口径） */
export type PlanStatus = 'confirmed' | 'invalid' | 'pending'

/** 推荐等级（与评分 Grade 一致，此处独立定义避免类型层耦合） */
export type RecommendationGrade = 'A' | 'B' | 'C'

/** 应急余量比例：营地总容量留下两成应急余量 */
export const EMERGENCY_RESERVE_RATIO = 0.2

/** 容量口径快照：一单占用被接受时的容量计算依据，也是「容量口径」的落库记录 */
export interface CapacitySnapshot {
  /** 营地总容量（帐）= 该营地各营位 tentCapacity 之和 */
  totalCapacity: number
  /** 应急余量比例（默认 0.2） */
  reserveRatio: number
  /** 可用容量（帐）= floor(totalCapacity × (1 − reserveRatio)) */
  usableCapacity: number
  /** 本单提交前已占用（帐，仅计已生效计划） */
  occupiedBefore: number
  /** 本单提交后剩余可用（帐）= usableCapacity − occupiedBefore − tents */
  remainingAfter: number
  /** 参与容量汇总的营位 id（口径依据） */
  siteIds: number[]
  /** 口径计算时间（ISO） */
  computedAt: string
}

/** 推荐名单中的一个营位 */
export interface RecommendationSite {
  siteId: number
  code: string
  name: string
  grade: RecommendationGrade
  total: number
  vetoed: boolean
  tentCapacity: number
}

/** 推荐名单快照：确认那一刻的推荐结果，因子/否决变化后不得沿用 */
export interface RecommendationSnapshot {
  /** 推荐名单：按综合得分降序、未命中否决、A/B 级的营位 */
  sites: RecommendationSite[]
  /** 推荐时采用的权重方案 id */
  profileId: number | null
  /** 推荐时采用的归一化方式 */
  normalize: string
  /** 推荐时采用的等级阈值 */
  thresholds: GradeThresholds
  /** 推荐名单生成时间（ISO） */
  computedAt: string
}

export interface OccupancyPlan {
  /** 主键，自增 */
  id?: number
  /** 计划编号，如 ZY-0001 */
  code: string
  /** 营地名称（同一营地凑帐篷数） */
  campName: string
  /** 领队 */
  leader: string
  /** 申报帐篷数 */
  tents: number
  /** 状态 */
  status: PlanStatus
  /** 容量口径快照；pending（待补）计划为 null，且不得沿用旧推荐结果 */
  capacity: CapacitySnapshot | null
  /** 推荐名单快照；pending 计划为 null */
  recommendation: RecommendationSnapshot | null
  /** 失效原因（status=invalid 时记录是什么变化导致失效） */
  invalidReason: string
  /** 失效时间（ISO） */
  invalidAt: string | null
  /** 确认（生效）时间（ISO） */
  confirmedAt: string | null
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  confirmed: '已生效',
  invalid: '已失效',
  pending: '待补'
}

export const PLAN_STATUS_TAG_TYPE: Record<PlanStatus, 'success' | 'info' | 'warning'> = {
  confirmed: 'success',
  invalid: 'info',
  pending: 'warning'
}
