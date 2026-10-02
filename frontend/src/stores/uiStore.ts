/**
 * 界面状态：风险否决记录的读写、名次表筛选条件、评分页的临时权重。
 * 临时权重放在 store 里，拖权重条时首页与评分页共享同一份实时结果。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { RiskVeto } from '@/types/veto'
import type { FactorWeights, NormalizeMethod, GradeThresholds } from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'
import type { AccessMode, SurfaceType } from '@/types/campsite'
import { nowIso, todayIso } from '@/utils/format'
import { invalidatePlansForCamps } from '@/utils/drill'
import { useDrillStore } from '@/stores/drillStore'

export const useUiStore = defineStore('ui', () => {
  const vetos = ref<RiskVeto[]>([])
  const loadingVetos = ref(false)

  /** 名次表筛选条件 */
  const filterCamp = ref<string>('')
  const filterSurface = ref<SurfaceType | ''>('')
  const filterAccess = ref<AccessMode | ''>('')
  const keyword = ref<string>('')

  /** 评分页拖动中的临时权重（未保存前不落库） */
  const workingWeights = ref<FactorWeights>({ ...DEFAULT_WEIGHTS })
  const workingNormalize = ref<NormalizeMethod>('minmax')
  const workingThresholds = ref<GradeThresholds>({ gradeA: 78, gradeB: 58 })
  const workingSeason = ref<string>('四季通用')
  const dirty = ref(false)

  /** 地图页当前选中的营位 id */
  const focusedSiteId = ref<number | null>(null)

  async function loadVetos(): Promise<void> {
    loadingVetos.value = true
    try {
      vetos.value = await db.vetos.toArray()
    } finally {
      loadingVetos.value = false
    }
  }

  async function addVeto(input: RiskVeto): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      judgedAt: input.judgedAt || todayIso(),
      createdAt: now,
      updatedAt: now
    }) as RiskVeto
    delete record.id
    const id = await db.vetos.add(record)
    await loadVetos()
    // 风险否决变化 → 相关营地的生效占用单立刻失效
    const site = await db.sites.get(input.siteId)
    if (site) {
      const affected = await invalidatePlansForCamps(
        [site.campName],
        `营位 ${site.code} 登记风险否决（${input.type}），相关占用计划已失效，需重新确认`
      )
      if (affected > 0) await useDrillStore().load()
    }
    return id
  }

  async function removeVeto(id: number): Promise<void> {
    const veto = await db.vetos.get(id)
    await db.vetos.delete(id)
    await loadVetos()
    const site = veto ? await db.sites.get(veto.siteId) : null
    if (veto && site) {
      const affected = await invalidatePlansForCamps(
        [site.campName],
        `营位 ${site.code} 解除风险否决（${veto.type}），相关占用计划已失效，需重新确认`
      )
      if (affected > 0) await useDrillStore().load()
    }
  }

  /** 某营位命中的全部否决项 */
  function vetosOf(siteId: number | null | undefined): RiskVeto[] {
    if (siteId == null) return []
    return vetos.value.filter((v) => v.siteId === siteId)
  }

  function isVetoed(siteId: number | null | undefined): boolean {
    return vetosOf(siteId).length > 0
  }

  /** 命中否决的营位 id 集合，名次表与地图共用。 */
  const vetoedSiteIds = computed<number[]>(() =>
    Array.from(new Set(vetos.value.map((v) => v.siteId)))
  )

  /** 用启用方案覆盖临时权重。 */
  function syncFromProfile(
    weights: FactorWeights,
    normalize: NormalizeMethod,
    thresholds: GradeThresholds,
    season: string
  ): void {
    workingWeights.value = { ...DEFAULT_WEIGHTS, ...weights }
    workingNormalize.value = normalize
    workingThresholds.value = { ...thresholds }
    workingSeason.value = season
    dirty.value = false
  }

  function resetFilters(): void {
    filterCamp.value = ''
    filterSurface.value = ''
    filterAccess.value = ''
    keyword.value = ''
  }

  const vetoTotal = computed(() => vetos.value.length)

  return {
    vetos,
    loadingVetos,
    vetoTotal,
    filterCamp,
    filterSurface,
    filterAccess,
    keyword,
    workingWeights,
    workingNormalize,
    workingThresholds,
    workingSeason,
    dirty,
    focusedSiteId,
    vetoedSiteIds,
    loadVetos,
    addVeto,
    removeVeto,
    vetosOf,
    isVetoed,
    syncFromProfile,
    resetFilters
  }
})
