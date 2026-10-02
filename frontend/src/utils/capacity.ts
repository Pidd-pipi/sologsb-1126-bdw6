/**
 * 容量口径工具：营地总容量、应急余量、已占/剩余容量的纯函数计算。
 * 营地总容量 = 该营地各营位可容帐篷数之和；留两成应急余量后为可用容量；
 * 可用容量 = floor(总容量 × (1 − 0.2))；剩余容量 = 可用 − 已生效计划帐篷数之和。
 */
import type { Campsite } from '@/types/campsite'
import {
  EMERGENCY_RESERVE_RATIO,
  type CapacitySnapshot,
  type OccupancyPlan
} from '@/types/plan'

export interface CapacityInfo {
  campName: string
  /** 营地总容量（帐） */
  totalCapacity: number
  /** 应急余量比例 */
  reserveRatio: number
  /** 可用容量（帐） */
  usableCapacity: number
  /** 已占用（帐，仅计已生效计划） */
  occupied: number
  /** 剩余可用（帐）= usable − occupied */
  remaining: number
  /** 参与容量汇总的营位 id */
  siteIds: number[]
}

/** 营地总容量与参与汇总的营位 id。 */
export function campCapacity(
  sites: Campsite[],
  campName: string
): { total: number; siteIds: number[] } {
  let total = 0
  const siteIds: number[] = []
  for (const s of sites) {
    if (s.campName !== campName) continue
    total += Number(s.tentCapacity) || 0
    if (typeof s.id === 'number') siteIds.push(s.id)
  }
  return { total, siteIds }
}

/** 可用容量 = floor(总容量 × (1 − 应急余量比例))，保守取整。 */
export function usableCapacityOf(
  totalCapacity: number,
  ratio: number = EMERGENCY_RESERVE_RATIO
): number {
  return Math.floor(totalCapacity * (1 - ratio))
}

/** 某营地已占用帐篷数（仅计已生效计划；失效/待补不占容量）。excludeId 用于重新确认时排除自身。 */
export function occupiedOf(
  plans: OccupancyPlan[],
  campName: string,
  excludeId?: number
): number {
  let n = 0
  for (const p of plans) {
    if (p.status !== 'confirmed') continue
    if (p.campName !== campName) continue
    if (excludeId != null && p.id === excludeId) continue
    n += Number(p.tents) || 0
  }
  return n
}

/** 汇总某营地的容量口径。 */
export function capacityInfo(
  sites: Campsite[],
  plans: OccupancyPlan[],
  campName: string,
  excludeId?: number
): CapacityInfo {
  const { total, siteIds } = campCapacity(sites, campName)
  const usable = usableCapacityOf(total)
  const occupied = occupiedOf(plans, campName, excludeId)
  return {
    campName,
    totalCapacity: total,
    reserveRatio: EMERGENCY_RESERVE_RATIO,
    usableCapacity: usable,
    occupied,
    remaining: usable - occupied,
    siteIds
  }
}

/** 判定一单是否可被接受：剩余容量是否足够；不足时返回缺口。 */
export function checkCapacity(
  sites: Campsite[],
  plans: OccupancyPlan[],
  campName: string,
  tents: number,
  excludeId?: number
): { ok: boolean; info: CapacityInfo; shortage: number } {
  const info = capacityInfo(sites, plans, campName, excludeId)
  const shortage = Math.max(0, tents - info.remaining)
  return { ok: shortage <= 0, info, shortage }
}

/** 生成容量口径快照（提交后）。 */
export function buildCapacitySnapshot(
  sites: Campsite[],
  plans: OccupancyPlan[],
  campName: string,
  tents: number,
  excludeId?: number
): CapacitySnapshot {
  const info = capacityInfo(sites, plans, campName, excludeId)
  return {
    totalCapacity: info.totalCapacity,
    reserveRatio: info.reserveRatio,
    usableCapacity: info.usableCapacity,
    occupiedBefore: info.occupied,
    remainingAfter: info.usableCapacity - info.occupied - tents,
    siteIds: info.siteIds,
    computedAt: new Date().toISOString()
  }
}
