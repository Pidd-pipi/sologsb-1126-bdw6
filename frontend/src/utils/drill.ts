/**
 * 汛期演练排营的核心规则与并发控制。
 *
 * 容量口径：营地总容量 = 各营位可容帐篷数之和；两成留作应急余量，
 * 可订容量 = ⌊总容量 × (1 − 0.2)⌋。确认那一刻的口径随单落库（快照）。
 *
 * 并发：确认走单个 readwrite 事务（读口径 → 读已占 → 校验 → 写单），
 * IndexedDB 对同一 object store 的 readwrite 事务跨标签页串行执行，
 * 两个标签页同时提交时先落库的一单生效，后到的事务读到最新已占后被拒。
 * 写完成后经 BroadcastChannel 通知其他标签页刷新已占数量。
 */
import { db, toPlain } from '@/utils/db'
import { nextSerialNo, nowIso } from '@/utils/format'
import { RESERVE_RATIO, type CapacityCaliber, type DrillPlan } from '@/types/drill'

const CHANNEL_NAME = 'gbcampsite:drill'

/** 可订容量：总容量留下两成应急余量，向下取整 */
export function bookableOf(totalCapacity: number): number {
  return Math.max(0, Math.floor(totalCapacity * (1 - RESERVE_RATIO)))
}

/** 营地总容量：该营地全部营位可容帐篷数之和 */
export function totalCapacityOf(
  sites: Array<{ campName: string; tentCapacity: number }>,
  campName: string
): number {
  return sites
    .filter((s) => s.campName === campName)
    .reduce((sum, s) => sum + (Number.isFinite(s.tentCapacity) ? s.tentCapacity : 0), 0)
}

/** 某营地已占帐篷数（仅统计已生效的占用单） */
export function occupiedOf(plans: DrillPlan[], campName: string): number {
  return plans
    .filter((p) => p.campName === campName && p.status === 'confirmed')
    .reduce((sum, p) => sum + p.tentCount, 0)
}

export interface ConfirmInput {
  leader: string
  campName: string
  tentCount: number
}

export interface ConfirmOutcome {
  ok: boolean
  planNo: string
  /** 本次确认采用的容量口径快照 */
  caliber: CapacityCaliber
  /** 未通过时的原因（已通过为空串） */
  reason: string
}

interface JudgeResult {
  caliber: CapacityCaliber
  remaining: number
  pass: boolean
}

/** 事务内口径判定：现算总容量与已占，给出是否放行。须在 plans+sites 的 readwrite 事务里调用。 */
async function judgeCamp(campName: string, tentCount: number): Promise<JudgeResult> {
  const sites = await db.sites.toArray()
  const totalCapacity = totalCapacityOf(sites, campName)
  const plans = await db.plans.where('campName').equals(campName).toArray()
  const occupiedBefore = occupiedOf(plans, campName)
  const caliber: CapacityCaliber = {
    totalCapacity,
    reserveRatio: RESERVE_RATIO,
    bookableCapacity: bookableOf(totalCapacity),
    occupiedBefore,
    snapshotAt: nowIso()
  }
  const remaining = caliber.bookableCapacity - occupiedBefore
  return {
    caliber,
    remaining,
    pass: totalCapacity > 0 && tentCount >= 1 && tentCount <= remaining
  }
}

function rejectReason(remaining: number, tentCount: number): string {
  return remaining < 0
    ? `该营地已超占 ${-remaining} 帐，本单 ${tentCount} 帐无法安排`
    : `剩余可订 ${remaining} 帐，不足本单 ${tentCount} 帐`
}

/**
 * 新建占用单并尝试确认。容量足够即生效；不足则落一条「已拒绝」台账，
 * 调用方保留表单草稿，便于改小帐篷数后重提。
 */
export async function confirmPlanTx(input: ConfirmInput): Promise<ConfirmOutcome> {
  return db.transaction('rw', db.plans, db.sites, async () => {
    const now = nowIso()
    const { caliber, remaining, pass } = await judgeCamp(input.campName, input.tentCount)
    const all = await db.plans.toArray()
    const planNo = nextSerialNo('DP-', all.map((p) => p.planNo))
    const record: DrillPlan = {
      planNo,
      leader: input.leader,
      campName: input.campName,
      tentCount: input.tentCount,
      status: pass ? 'confirmed' : 'rejected',
      reason: pass ? '' : rejectReason(remaining, input.tentCount),
      capacity: caliber,
      createdAt: now,
      updatedAt: now
    }
    await db.plans.add(toPlain(record))
    return { ok: pass, planNo, caliber, reason: record.reason }
  })
}

/**
 * 重新确认：已失效 / 待补录的计划按当前口径重核。
 * 通过则重新生效并补写容量口径快照；不通过则转为「已拒绝」。
 */
export async function reconfirmPlanTx(id: number): Promise<ConfirmOutcome> {
  return db.transaction('rw', db.plans, db.sites, async () => {
    const plan = await db.plans.get(id)
    if (!plan) throw new Error('计划不存在，可能已被清理')
    if (plan.status !== 'invalidated' && plan.status !== 'pending-backfill') {
      throw new Error(`占用单 ${plan.planNo} 当前状态无需重新确认`)
    }
    const { caliber, remaining, pass } = await judgeCamp(plan.campName, plan.tentCount)
    const patch: Partial<DrillPlan> = {
      status: pass ? 'confirmed' : 'rejected',
      reason: pass ? '' : rejectReason(remaining, plan.tentCount),
      capacity: caliber,
      updatedAt: nowIso()
    }
    await db.plans.update(id, toPlain(patch))
    return { ok: pass, planNo: plan.planNo, caliber, reason: patch.reason ?? '' }
  })
}

/**
 * 因子评估 / 风险否决 / 营位容量变化后调用：
 * 相关营地「已生效」的占用单立刻失效，重新确认前不进入推荐名单。
 * 返回受影响的单数；有变化时广播通知其他标签页。
 */
export async function invalidatePlansForCamps(campNames: string[], reason: string): Promise<number> {
  const names = Array.from(new Set(campNames.filter((n) => !!n)))
  if (names.length === 0) return 0
  let affected = 0
  await db.transaction('rw', db.plans, async () => {
    await db.plans
      .where('status')
      .equals('confirmed')
      .modify((p) => {
        if (!names.includes(p.campName)) return
        p.status = 'invalidated'
        p.reason = reason
        p.updatedAt = nowIso()
        affected += 1
      })
  })
  if (affected > 0) broadcastPlansChanged()
  return affected
}

/** 通知其他标签页：占用单已变化，请刷新已占数量。 */
export function broadcastPlansChanged(): void {
  try {
    if (typeof BroadcastChannel === 'undefined') return
    const bc = new BroadcastChannel(CHANNEL_NAME)
    bc.postMessage({ type: 'plans-changed', at: Date.now() })
    bc.close()
  } catch {
    /* BroadcastChannel 不可用时静默，主流程不受影响 */
  }
}

/** 监听其他标签页的占用变化；返回解绑函数。 */
export function onPlansChanged(handler: () => void): () => void {
  try {
    if (typeof BroadcastChannel === 'undefined') return () => {}
    const bc = new BroadcastChannel(CHANNEL_NAME)
    bc.onmessage = (ev: MessageEvent) => {
      if ((ev.data as { type?: string } | null)?.type === 'plans-changed') handler()
    }
    return () => bc.close()
  } catch {
    return () => {}
  }
}
