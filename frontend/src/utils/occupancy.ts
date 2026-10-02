/**
 * 推荐名单纯函数：由营位/因子/否决/权重直接算出某营地的推荐名单快照。
 * 口径与页面 useRanking 一致（极差归一 / 阈值分段 + 加权求和 + 等级阈值 + 否决短路），
 * 供无 Vue 环境的 seed 使用；页面展示仍走 useRanking，快照口径保持同源。
 */
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { RiskVeto } from '@/types/veto'
import type { FactorKey, FactorWeights, GradeThresholds, NormalizeMethod } from '@/types/score'
import {
  buildNormalizedMatrix,
  gradeOf,
  rawValuesOf,
  weightedTotal
} from '@/utils/score'
import type { RecommendationSite, RecommendationSnapshot } from '@/types/plan'

export interface RecommendationInput {
  campName: string
  sites: Campsite[]
  factors: FactorAssessment[]
  vetos: RiskVeto[]
  weights: FactorWeights
  normalize: NormalizeMethod
  thresholds: GradeThresholds
  profileId: number | null
}

export function buildRecommendationSnapshot(input: RecommendationInput): RecommendationSnapshot {
  const { campName, sites, factors, vetos, weights, normalize, thresholds, profileId } = input
  const vetoed = new Set(vetos.map((v) => v.siteId))
  const list = sites.filter(
    (s): s is Campsite & { id: number } => typeof s.id === 'number' && s.campName === campName
  )
  const factorOf = (siteId: number): FactorAssessment | null =>
    factors
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))[0] ?? null

  const entries = list.map((site) => ({
    siteId: site.id,
    values: rawValuesOf(site, factorOf(site.id))
  }))
  const matrix = buildNormalizedMatrix(entries, normalize)

  const recs: RecommendationSite[] = []
  list.forEach((site, idx) => {
    const normalized = matrix.get(site.id) ?? ({} as Record<FactorKey, number>)
    const total = weightedTotal(normalized, weights)
    const isVetoed = vetoed.has(site.id)
    const grade = gradeOf(total, thresholds, isVetoed)
    // 推荐名单：未命中否决、A/B 级；C 级不进推荐名单
    if (isVetoed || grade === 'C') return
    recs.push({
      siteId: site.id,
      code: site.code,
      name: site.name,
      grade,
      total: Math.round(total * 10) / 10,
      vetoed: false,
      tentCapacity: site.tentCapacity
    })
  })
  recs.sort((a, b) => b.total - a.total)

  return {
    sites: recs,
    profileId,
    normalize,
    thresholds: { ...thresholds },
    computedAt: new Date().toISOString()
  }
}
