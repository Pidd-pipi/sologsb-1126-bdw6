/**
 * 营位占用计划的本地读写与跨标签页协同。
 *
 * 容量口径：营地总容量留两成应急余量，剩余容量不足则拒绝（纯计算见 utils/capacity）。
 * 并发：确认 / 重新确认在 Dexie 读写事务内完成「读已占 → 容量校验 → 写入」。
 * IndexedDB 对同一对象仓库的读写事务串行化，两个标签页同时提交时先提交的一单生效，
 * 落空的一页保住草稿并看到最新已占数量。
 * 失效：营位因子或风险否决变化时，相关营地的已生效计划立即失效，重新确认前不进入推荐名单。
 * 跨标签页：BroadcastChannel 广播计划变更，其他标签页收到后重载；窗口重新聚焦也会补拉一次。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type {
  CapacitySnapshot,
  OccupancyPlan,
  PlanStatus,
  RecommendationSnapshot
} from '@/types/plan'
import { buildCapacitySnapshot, checkCapacity, occupiedOf } from '@/utils/capacity'
import { nextSerialNo, nowIso } from '@/utils/format'

const CHANNEL_NAME = 'gbcampsite-plans'
const FOCUS_RELOAD_THROTTLE = 1500

export interface CapacityBrief {
  totalCapacity: number
  usableCapacity: number
  occupied: number
  remaining: number
}

export interface ConfirmResult {
  ok: boolean
  plan?: OccupancyPlan
  capacity: CapacityBrief
  shortage: number
}

export const useOccupancyStore = defineStore('occupancy', () => {
  const plans = ref<OccupancyPlan[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  let channel: BroadcastChannel | null = null
  let lastFocusReload = 0

  async function load(): Promise<void> {
    loading.value = true
    try {
      plans.value = await db.plans.orderBy('id').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function nextCode(): string {
    return nextSerialNo('ZY-', plans.value.map((p) => p.code))
  }

  /** 广播计划变更；BroadcastChannel 不可用时静默（窗口聚焦补拉兜底）。 */
  function broadcastChange(): void {
    try {
      channel?.postMessage({ type: 'plans-changed', at: nowIso() })
    } catch {
      /* ignore */
    }
  }

  function onFocus(): void {
    const now = Date.now()
    if (now - lastFocusReload < FOCUS_RELOAD_THROTTLE) return
    lastFocusReload = now
    void load()
  }

  /** 订阅跨标签页变更 + 窗口聚焦补拉。 */
  function startSync(): void {
    if (channel) return
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = (ev: MessageEvent) => {
        if (ev?.data?.type === 'plans-changed') void load()
      }
    } catch {
      channel = null
    }
    window.addEventListener('focus', onFocus)
  }

  function stopSync(): void {
    try {
      channel?.close()
    } catch {
      /* ignore */
    }
    channel = null
    window.removeEventListener('focus', onFocus)
  }

  /**
   * 确认一单占用：在读写事务内完成「读已占 → 容量校验 → 写入」，保证多标签页并发时先到先得。
   * 容量不足时不写入，返回 ok=false 与最新容量口径，由页面保住草稿并展示已占数量。
   */
  async function confirmPlan(input: {
    campName: string
    leader: string
    tents: number
    note: string
    recommendation: RecommendationSnapshot
  }): Promise<ConfirmResult> {
    const now = nowIso()
    let result!: ConfirmResult
    await db.transaction('rw', db.plans, db.sites, async () => {
      const sites = await db.sites.toArray()
      const existing = await db.plans.toArray()
      const { ok, info, shortage } = checkCapacity(sites, existing, input.campName, input.tents)
      if (!ok) {
        result = {
          ok: false,
          capacity: {
            totalCapacity: info.totalCapacity,
            usableCapacity: info.usableCapacity,
            occupied: info.occupied,
            remaining: info.remaining
          },
          shortage
        }
        return
      }
      const capacity: CapacitySnapshot = buildCapacitySnapshot(
        sites,
        existing,
        input.campName,
        input.tents
      )
      const record = toPlain({
        code: nextSerialNo('ZY-', existing.map((p) => p.code)),
        campName: input.campName,
        leader: input.leader.trim() || '未署名',
        tents: input.tents,
        status: 'confirmed' as PlanStatus,
        capacity,
        recommendation: input.recommendation,
        invalidReason: '',
        invalidAt: null,
        confirmedAt: now,
        note: input.note.trim(),
        createdAt: now,
        updatedAt: now
      }) as OccupancyPlan
      delete record.id
      const id = await db.plans.add(record)
      result = {
        ok: true,
        plan: { ...record, id },
        capacity: {
          totalCapacity: info.totalCapacity,
          usableCapacity: info.usableCapacity,
          occupied: info.occupied + input.tents,
          remaining: info.remaining - input.tents
        },
        shortage: 0
      }
    })
    await load()
    broadcastChange()
    return result
  }

  /**
   * 重新确认一单（失效 / 待补计划）：重新计算推荐名单与容量口径，容量足够则恢复已生效。
   * 待补计划没有容量口径，重新确认时补齐，且一律重新生成推荐名单、不沿用旧结果。
   */
  async function reconfirmPlan(
    id: number,
    recommendation: RecommendationSnapshot
  ): Promise<ConfirmResult> {
    const now = nowIso()
    let result!: ConfirmResult
    await db.transaction('rw', db.plans, db.sites, async () => {
      const sites = await db.sites.toArray()
      const existing = await db.plans.toArray()
      const plan = existing.find((p) => p.id === id)
      if (!plan) {
        result = {
          ok: false,
          capacity: { totalCapacity: 0, usableCapacity: 0, occupied: 0, remaining: 0 },
          shortage: 0
        }
        return
      }
      const { ok, info, shortage } = checkCapacity(
        sites,
        existing,
        plan.campName,
        plan.tents,
        id
      )
      if (!ok) {
        result = {
          ok: false,
          capacity: {
            totalCapacity: info.totalCapacity,
            usableCapacity: info.usableCapacity,
            occupied: info.occupied,
            remaining: info.remaining
          },
          shortage
        }
        return
      }
      const capacity = buildCapacitySnapshot(sites, existing, plan.campName, plan.tents, id)
      await db.plans.update(id, {
        status: 'confirmed',
        capacity,
        recommendation,
        invalidReason: '',
        invalidAt: null,
        confirmedAt: now,
        updatedAt: now
      })
      result = {
        ok: true,
        capacity: {
          totalCapacity: info.totalCapacity,
          usableCapacity: info.usableCapacity,
          occupied: info.occupied + plan.tents,
          remaining: info.remaining - plan.tents
        },
        shortage: 0
      }
    })
    await load()
    broadcastChange()
    return result
  }

  /** 某营位因子评估或风险否决变化后，相关营地的已生效计划立即失效。 */
  async function invalidateForSite(siteId: number, reason: string): Promise<void> {
    const site = await db.sites.get(siteId)
    if (!site?.campName) return
    await invalidateForCamp(site.campName, reason)
  }

  async function invalidateForCamp(campName: string, reason: string): Promise<void> {
    const now = nowIso()
    let changed = false
    await db.transaction('rw', db.plans, async () => {
      const rows = await db.plans.where('campName').equals(campName).toArray()
      for (const p of rows) {
        if (p.status !== 'confirmed') continue
        if (typeof p.id !== 'number') continue
        await db.plans.update(p.id, {
          status: 'invalid',
          invalidReason: reason,
          invalidAt: now,
          updatedAt: now
        })
        changed = true
      }
    })
    if (changed) {
      await load()
      broadcastChange()
    }
  }

  async function removePlan(id: number): Promise<void> {
    await db.plans.delete(id)
    await load()
    broadcastChange()
  }

  /** 某营地已占用帐篷数（仅已生效计划）。 */
  function occupiedOfCamp(campName: string, excludeId?: number): number {
    return occupiedOf(plans.value, campName, excludeId)
  }

  const confirmedPlans = computed(() => plans.value.filter((p) => p.status === 'confirmed'))
  const invalidPlans = computed(() => plans.value.filter((p) => p.status === 'invalid'))
  const pendingPlans = computed(() => plans.value.filter((p) => p.status === 'pending'))
  const totalOccupiedTents = computed(() =>
    confirmedPlans.value.reduce((acc, p) => acc + (Number(p.tents) || 0), 0)
  )

  return {
    plans,
    loading,
    loaded,
    confirmedPlans,
    invalidPlans,
    pendingPlans,
    totalOccupiedTents,
    load,
    nextCode,
    startSync,
    stopSync,
    confirmPlan,
    reconfirmPlan,
    invalidateForSite,
    invalidateForCamp,
    removePlan,
    occupiedOfCamp
  }
})
