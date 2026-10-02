/** 营位与因子评估的本地读写。写库前统一脱掉响应式 Proxy，避免 DataCloneError。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import { nextSerialNo, nowIso, todayIso } from '@/utils/format'
import { invalidatePlansForCamps } from '@/utils/drill'
import { useDrillStore } from '@/stores/drillStore'

/** 因子 / 营位容量变化后，让相关营地的生效占用单立刻失效并刷新本页占用状态。 */
async function expireDrillPlans(campNames: string[], reason: string): Promise<void> {
  const affected = await invalidatePlansForCamps(campNames, reason)
  if (affected > 0) await useDrillStore().load()
}

export const useSiteStore = defineStore('site', () => {
  const list = ref<Campsite[]>([])
  const factors = ref<FactorAssessment[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.sites.orderBy('code').toArray()
      factors.value = await db.factors.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个营位编号，如 CS-0007。 */
  function nextCode(): string {
    return nextSerialNo('CS-', list.value.map((s) => s.code))
  }

  async function createSite(input: Campsite): Promise<number> {
    const now = nowIso()
    const record = toPlain({ ...input, createdAt: now, updatedAt: now }) as Campsite
    delete record.id
    const id = await db.sites.add(record)
    await load()
    return id
  }

  async function updateSite(id: number, patch: Partial<Campsite>): Promise<void> {
    const before = list.value.find((s) => s.id === id) ?? null
    await db.sites.update(id, toPlain({ ...patch, updatedAt: nowIso() }))
    await load()
    // 容量或所属营地变化会让既有容量口径失真，相关生效单立刻失效
    const camps = new Set<string>()
    if (before && patch.tentCapacity !== undefined && patch.tentCapacity !== before.tentCapacity) {
      camps.add(before.campName)
    }
    if (before && patch.campName !== undefined && patch.campName !== before.campName) {
      camps.add(before.campName)
      camps.add(patch.campName)
    }
    if (camps.size > 0) {
      await expireDrillPlans(
        Array.from(camps),
        `营位 ${before?.code ?? id} 容量口径变化，相关占用计划已失效，需重新确认`
      )
    }
  }

  async function removeSite(id: number): Promise<void> {
    const target = list.value.find((s) => s.id === id) ?? null
    await db.sites.delete(id)
    const own = factors.value.filter((f) => f.siteId === id)
    await db.factors.bulkDelete(
      own.map((f) => f.id).filter((v): v is number => typeof v === 'number')
    )
    const vetoIds = (await db.vetos.where('siteId').equals(id).toArray())
      .map((v) => v.id)
      .filter((v): v is number => typeof v === 'number')
    await db.vetos.bulkDelete(vetoIds)
    await load()
    if (target) {
      await expireDrillPlans(
        [target.campName],
        `营位 ${target.code} 已删除，相关占用计划已失效，需重新确认`
      )
    }
  }

  async function addFactor(input: FactorAssessment): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      assessedAt: input.assessedAt || todayIso(),
      createdAt: now,
      updatedAt: now
    }) as FactorAssessment
    delete record.id
    const id = await db.factors.add(record)
    await load()
    const site = byId(input.siteId)
    if (site) {
      await expireDrillPlans(
        [site.campName],
        `营位 ${site.code} 新增因子评估，相关占用计划已失效，需重新确认`
      )
    }
    return id
  }

  async function removeFactor(id: number): Promise<void> {
    const factor = factors.value.find((f) => f.id === id) ?? null
    await db.factors.delete(id)
    await load()
    const site = factor ? byId(factor.siteId) : null
    if (site) {
      await expireDrillPlans(
        [site.campName],
        `营位 ${site.code} 因子评估被删除，相关占用计划已失效，需重新确认`
      )
    }
  }

  function byId(id: number | null | undefined): Campsite | null {
    if (id == null || Number.isNaN(id)) return null
    return list.value.find((s) => s.id === id) ?? null
  }

  /** 取某营位最新一条因子评估（按评估日期倒序）。 */
  function latestFactor(siteId: number | null | undefined): FactorAssessment | null {
    if (siteId == null) return null
    const rows = factors.value
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))
    return rows[0] ?? null
  }

  /** 取某营位全部因子评估（多轮复核对比用）。 */
  function factorsOf(siteId: number | null | undefined): FactorAssessment[] {
    if (siteId == null) return []
    return factors.value
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))
  }

  const camps = computed(() => Array.from(new Set(list.value.map((s) => s.campName))))
  const total = computed(() => list.value.length)

  return {
    list,
    factors,
    loading,
    loaded,
    total,
    camps,
    load,
    nextCode,
    createSite,
    updateSite,
    removeSite,
    addFactor,
    removeFactor,
    byId,
    latestFactor,
    factorsOf
  }
})
