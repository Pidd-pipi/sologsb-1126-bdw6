<script setup lang="ts">
/**
 * `/occupancy` 营位占用 —— 汛期演练排营位：领队按同一营地凑帐篷数。
 * 营地总容量留两成应急余量，剩余容量不够就拒绝这一单；
 * 两个标签页同时提交时，先占到的一单生效，落空的一页保住草稿并看到已占数量。
 * 营位因子或风险否决变化后，相关计划立刻失效，重新确认前不进入推荐名单；
 * 旧计划没有容量口径的列为待补，不沿用原来的推荐结果。
 * 消费 OccupancyPlan、Campsite、FactorAssessment、RiskVeto、ScoreProfile。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useOccupancyStore, type CapacityBrief } from '@/stores/occupancyStore'
import { useRanking } from '@/hooks/useRanking'
import { useLocalDraft } from '@/hooks/useLocalDraft'
import { capacityInfo } from '@/utils/capacity'
import {
  EMERGENCY_RESERVE_RATIO,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TAG_TYPE,
  type OccupancyPlan,
  type PlanStatus,
  type RecommendationSite,
  type RecommendationSnapshot
} from '@/types/plan'
import { formatDateTime } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const occupancyStore = useOccupancyStore()

const { ranked } = useRanking({
  sites: () => siteStore.list,
  factorOf: (id: number) => siteStore.latestFactor(id),
  weights: () => profileStore.activeWeights,
  normalize: () => profileStore.activeProfile?.normalize ?? 'minmax',
  thresholds: () => profileStore.activeProfile?.thresholds ?? { gradeA: 78, gradeB: 58 },
  vetoedIds: () => uiStore.vetoedSiteIds
})

interface OccupancyForm {
  campName: string
  leader: string
  tents: number
  note: string
}

const form = ref<OccupancyForm>({
  campName: '',
  leader: '',
  tents: 4,
  note: ''
})

useLocalDraft<OccupancyForm>({
  key: 'occupancy-new',
  source: form,
  onRestore: () => ElMessage.info('已恢复未提交的占营草稿')
})

const submitting = ref(false)
/** 最近一单被拒绝的结果（落空页据此看到已占数量，草稿保留） */
const rejection = ref<{
  campName: string
  tents: number
  shortage: number
  capacity: CapacityBrief
} | null>(null)

/* ------------------------------- 容量口径 ------------------------------- */

const reservePercent = Math.round(EMERGENCY_RESERVE_RATIO * 100)

/** 选中营地的实时容量口径（随已生效计划与营位数据联动）。 */
const capacity = computed(() =>
  form.value.campName
    ? capacityInfo(siteStore.list, occupancyStore.plans, form.value.campName)
    : null
)

const capacityEnough = computed(() => {
  if (!capacity.value) return true
  return form.value.tents > 0 && form.value.tents <= capacity.value.remaining
})

/* ------------------------------- 推荐名单 ------------------------------- */

/** 某营地的推荐名单：名次表中属于该营地、未命中否决、A/B 级的营位。 */
function recommendationFor(campName: string): RecommendationSite[] {
  if (!campName) return []
  return ranked.value
    .filter((r) => r.site.campName === campName && !r.vetoed && r.grade !== 'C')
    .map((r) => ({
      siteId: r.siteId,
      code: r.site.code,
      name: r.site.name,
      grade: r.grade,
      total: r.total,
      vetoed: r.vetoed,
      tentCapacity: r.site.tentCapacity
    }))
}

/** 表单选中营地的推荐名单。 */
const recommendation = computed<RecommendationSite[]>(() => recommendationFor(form.value.campName))

function buildRecommendationSnapshot(campName: string): RecommendationSnapshot {
  return {
    sites: recommendationFor(campName),
    profileId: profileStore.activeProfile?.id ?? null,
    normalize: profileStore.activeProfile?.normalize ?? 'minmax',
    thresholds: { ...(profileStore.activeProfile?.thresholds ?? { gradeA: 78, gradeB: 58 }) },
    computedAt: new Date().toISOString()
  }
}

/* -------------------------------- 提交 -------------------------------- */

async function submit(): Promise<void> {
  if (!form.value.campName) {
    ElMessage.warning('请选择营地')
    return
  }
  if (!form.value.leader.trim()) {
    ElMessage.warning('请填写领队')
    return
  }
  if (!form.value.tents || form.value.tents <= 0) {
    ElMessage.warning('请填写帐篷数')
    return
  }
  submitting.value = true
  try {
    const res = await occupancyStore.confirmPlan({
      campName: form.value.campName,
      leader: form.value.leader,
      tents: form.value.tents,
      note: form.value.note,
      recommendation: buildRecommendationSnapshot(form.value.campName)
    })
    if (res.ok) {
      ElMessage.success(
        `已占 ${form.value.campName} ${form.value.tents} 帐（编号 ${res.plan?.code}），剩余容量 ${res.capacity.remaining} 帐`
      )
      // 生效后清空表单与草稿
      form.value.campName = ''
      form.value.leader = ''
      form.value.tents = 4
      form.value.note = ''
      rejection.value = null
    } else {
      // 落空：保留草稿，展示最新已占数量
      rejection.value = {
        campName: form.value.campName,
        tents: form.value.tents,
        shortage: res.shortage,
        capacity: res.capacity
      }
      ElMessage.warning('该营地剩余容量不足，本单未生效（草稿已保留）')
    }
  } catch (err) {
    ElMessage.error(`提交失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    submitting.value = false
  }
}

/* ----------------------------- 重新确认 / 删除 ----------------------------- */

async function reconfirm(plan: OccupancyPlan): Promise<void> {
  if (typeof plan.id !== 'number') return
  const res = await occupancyStore.reconfirmPlan(
    plan.id,
    buildRecommendationSnapshot(plan.campName)
  )
  if (res.ok) {
    ElMessage.success(`已重新确认 ${plan.code}，剩余容量 ${res.capacity.remaining} 帐`)
  } else {
    ElMessage.warning(
      `重新确认失败：${plan.campName} 剩余容量不足 ${res.shortage} 帐，请调整后再试`
    )
  }
}

async function removeOne(plan: OccupancyPlan): Promise<void> {
  if (typeof plan.id !== 'number') return
  await occupancyStore.removePlan(plan.id)
  ElMessage.success(`已删除计划 ${plan.code}`)
}

/* -------------------------------- 台账 -------------------------------- */

const activeTab = ref<'confirmed' | 'pending' | 'invalid'>('confirmed')

const stats = computed(() => ({
  confirmed: occupancyStore.confirmedPlans.length,
  pending: occupancyStore.pendingPlans.length,
  invalid: occupancyStore.invalidPlans.length,
  tents: occupancyStore.totalOccupiedTents
}))

const visiblePlans = computed<OccupancyPlan[]>(() => {
  if (activeTab.value === 'confirmed') return occupancyStore.confirmedPlans
  if (activeTab.value === 'pending') return occupancyStore.pendingPlans
  return occupancyStore.invalidPlans
})

function capacityText(plan: OccupancyPlan): string {
  if (!plan.capacity) return '待补容量口径'
  const c = plan.capacity
  return `总 ${c.totalCapacity} · 可用 ${c.usableCapacity} · 占前 ${c.occupiedBefore} · 占后 ${c.remainingAfter}`
}

function recommendationText(plan: OccupancyPlan): string {
  if (!plan.recommendation || plan.recommendation.sites.length === 0) return '—'
  return plan.recommendation.sites.map((s) => `${s.code}(${s.grade})`).join('、')
}

function planTime(plan: OccupancyPlan): string {
  if (plan.status === 'confirmed' && plan.confirmedAt) return formatDateTime(plan.confirmedAt)
  if (plan.status === 'invalid' && plan.invalidAt) return formatDateTime(plan.invalidAt)
  return formatDateTime(plan.createdAt)
}

/** 状态标签类型/文案：模板里 scoped slot 的 row 是 any，统一在此收窄类型。 */
function statusTagType(status: PlanStatus): 'success' | 'info' | 'warning' {
  return PLAN_STATUS_TAG_TYPE[status]
}

function statusLabel(status: PlanStatus): string {
  return PLAN_STATUS_LABELS[status]
}

function clearForm(): void {
  form.value.campName = ''
  form.value.leader = ''
  form.value.tents = 4
  form.value.note = ''
  rejection.value = null
}

onMounted(() => {
  occupancyStore.startSync()
})

onBeforeUnmount(() => {
  occupancyStore.stopSync()
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>营位占用</h1>
        <p>
          汛期演练排营位：领队按同一营地凑帐篷数，营地总容量留下{{ reservePercent }}%应急余量，
          剩余容量不够就拒绝这一单。两个标签页同时提交时先占到的一单生效，
          落空的一页保住草稿并看到已占数量。营位因子或风险否决发生变化，相关计划立刻失效，
          重新确认前不会进入推荐名单；旧计划没有容量口径的列为待补，不沿用原来的推荐结果。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="router.push('/veto')">风险否决</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="容量口径与并发规则"
      description="可用容量 = 营地总容量（各营位可容帐篷数之和）×（1 − 20% 应急余量），向下取整；已占仅计已生效计划。提交在浏览器本地事务内「读已占 → 校验 → 写入」，两个标签页同时提交时先提交的一单生效，落空的一页保留草稿并看到最新已占数量。"
    />

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">已生效计划</div>
        <div class="stat-card__value" data-testid="stat-confirmed">{{ stats.confirmed }}</div>
        <div class="stat-card__extra">共 {{ stats.tents }} 帐</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">待补容量口径</div>
        <div class="stat-card__value" :class="{ 'stat-warn': stats.pending }">{{ stats.pending }}</div>
        <div class="stat-card__extra">旧计划升级，需补录</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">已失效计划</div>
        <div class="stat-card__value" :class="{ 'stat-muted': !stats.invalid }">{{ stats.invalid }}</div>
        <div class="stat-card__extra">因子/否决变化导致</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">应急余量</div>
        <div class="stat-card__value">{{ reservePercent }}%</div>
        <div class="stat-card__extra">总容量留作应急</div>
      </div>
    </div>

    <div class="occupancy-layout">
      <section class="panel">
        <div class="panel__head">
          <h2>占营登记</h2>
        </div>
        <el-form label-width="92px" @submit.prevent>
          <el-form-item label="营地">
            <el-select v-model="form.campName" placeholder="选择同一营地" filterable style="width: 100%">
              <el-option v-for="c in siteStore.camps" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="领队">
            <el-input v-model="form.leader" placeholder="如 李营" />
          </el-form-item>
          <el-form-item label="帐篷数">
            <el-input-number v-model="form.tents" :min="1" :max="999" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选" />
          </el-form-item>

          <div v-if="capacity" class="capacity-box">
            <div class="capacity-box__row">
              <span>营地总容量</span>
              <strong>{{ capacity.totalCapacity }} 帐</strong>
            </div>
            <div class="capacity-box__row">
              <span>应急余量（{{ reservePercent }}%）</span>
              <strong>−{{ capacity.totalCapacity - capacity.usableCapacity }} 帐</strong>
            </div>
            <div class="capacity-box__row">
              <span>可用容量</span>
              <strong>{{ capacity.usableCapacity }} 帐</strong>
            </div>
            <div class="capacity-box__row">
              <span>已占数量</span>
              <strong>{{ capacity.occupied }} 帐</strong>
            </div>
            <div class="capacity-box__row capacity-box__row--strong">
              <span>剩余可用</span>
              <strong :class="{ 'capacity-ok': capacityEnough, 'capacity-no': !capacityEnough }">
                {{ capacity.remaining }} 帐
              </strong>
            </div>
            <p v-if="!capacityEnough" class="capacity-box__tip capacity-no">
              剩余容量不足：本单 {{ form.tents }} 帐，还差
              {{ form.tents - capacity.remaining }} 帐，提交将被拒绝。
            </p>
            <p v-else class="capacity-box__tip capacity-ok">
              容量充足，提交后剩余 {{ capacity.remaining - form.tents }} 帐。
            </p>
          </div>

          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="submit">确认占营</el-button>
            <el-button @click="clearForm">清空</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          v-if="rejection"
          type="error"
          :closable="false"
          show-icon
          class="rejection-alert"
          title="本单未生效（草稿已保留，可调整后重新提交）"
        >
          <div class="rejection-body">
            <p>
              营地 <strong>{{ rejection.campName }}</strong> 可用
              <strong>{{ rejection.capacity.usableCapacity }}</strong> 帐（总容量
              {{ rejection.capacity.totalCapacity }} ×（1 − {{ reservePercent }}%）），
              已被占用 <strong>{{ rejection.capacity.occupied }}</strong> 帐，剩余
              <strong>{{ rejection.capacity.remaining }}</strong> 帐；
              本单申报 {{ rejection.tents }} 帐，还缺
              <strong>{{ rejection.shortage }}</strong> 帐。
            </p>
            <p class="muted">
              若另一标签页随后提交了新计划，上方「已占数量」会自动刷新；草稿不会丢失。
            </p>
          </div>
        </el-alert>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2>推荐名单</h2>
          <span class="weight-note">
            {{ form.campName || '未选营地' }} · 当前方案 {{ profileStore.activeProfile?.name ?? '—' }}
          </span>
        </div>
        <template v-if="form.campName">
          <el-table v-if="recommendation.length" :data="recommendation" size="small" border stripe>
            <el-table-column label="营位" min-width="180">
              <template #default="{ row }">
                <el-link type="primary" underline="never" @click="router.push(`/sites/${row.siteId}`)">
                  {{ row.code }} · {{ row.name }}
                </el-link>
                <div class="cell-sub">容 {{ row.tentCapacity }} 帐</div>
              </template>
            </el-table-column>
            <el-table-column label="等级" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.grade === 'A' ? 'success' : 'warning'">
                  {{ row.grade }} 级
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="综合得分" width="110" align="right">
              <template #default="{ row }">
                <strong>{{ row.total.toFixed(1) }}</strong>
              </template>
            </el-table-column>
          </el-table>
          <el-alert
            v-else
            type="warning"
            :closable="false"
            show-icon
            title="该营地暂无 A/B 级可推荐营位"
            description="可能全部命中风险否决或等级为 C。容量口径仍按营地总容量计算，但建议先处理否决项或补录因子后再占营。"
          />
        </template>
        <p v-else class="panel__hint">
          请先在左侧选择营地，推荐名单按当前权重方案实时给出未命中否决的 A/B 级营位。
        </p>
      </section>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>占用台账</h2>
        <span class="weight-note">
          已生效 {{ stats.confirmed }} · 待补 {{ stats.pending }} · 已失效 {{ stats.invalid }}
        </span>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="已生效" name="confirmed" />
        <el-tab-pane label="待补容量口径" name="pending" />
        <el-tab-pane label="已失效" name="invalid" />
      </el-tabs>

      <el-table v-if="visiblePlans.length" :data="visiblePlans" size="small" border stripe>
        <el-table-column label="计划编号" width="110">
          <template #default="{ row }">{{ row.code }}</template>
        </el-table-column>
        <el-table-column label="营地" min-width="150">
          <template #default="{ row }">{{ row.campName }}</template>
        </el-table-column>
        <el-table-column label="领队" width="96">
          <template #default="{ row }">{{ row.leader }}</template>
        </el-table-column>
        <el-table-column label="帐篷数" width="86" align="right">
          <template #default="{ row }">{{ row.tents }} 帐</template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="容量口径" min-width="240">
          <template #default="{ row }">
            <span>{{ capacityText(row) }}</span>
            <div v-if="row.status === 'pending'" class="cell-sub">
              待补录后重新确认，不沿用原推荐结果
            </div>
          </template>
        </el-table-column>
        <el-table-column label="推荐名单" min-width="180">
          <template #default="{ row }">
            <span v-if="row.status === 'pending'" class="muted">待重新确认</span>
            <span v-else-if="recommendationText(row) === '—'" class="muted">—</span>
            <span v-else>{{ recommendationText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="失效原因" min-width="180">
          <template #default="{ row }">
            <span v-if="row.status === 'invalid'" class="invalid-reason">{{ row.invalidReason }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ planTime(row) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="168" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status !== 'confirmed'"
              size="small"
              type="primary"
              plain
              @click="reconfirm(row)"
            >
              重新确认
            </el-button>
            <el-button size="small" type="danger" text @click="removeOne(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="当前状态下暂无计划" />
    </section>
  </div>
</template>

<style scoped>
.occupancy-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1080px) {
  .occupancy-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.capacity-box {
  margin: 4px 0 14px;
  padding: 10px 12px;
  background: var(--gb-surface);
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.capacity-box__row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  color: var(--gb-muted);
}
.capacity-box__row strong {
  color: var(--gb-ink);
  font-variant-numeric: tabular-nums;
}
.capacity-box__row--strong {
  padding-top: 6px;
  border-top: 1px dashed var(--gb-line);
  font-weight: 650;
}
.capacity-box__row--strong strong {
  font-size: 15px;
}
.capacity-box__tip {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.capacity-ok {
  color: var(--gb-accent-strong);
}
.capacity-no {
  color: var(--gb-danger);
}
.rejection-alert {
  margin-top: 4px;
}
.rejection-body p {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
}
.cell-sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.invalid-reason {
  font-size: 12px;
  color: var(--gb-warn);
  line-height: 1.5;
}
.stat-warn {
  color: var(--gb-warn) !important;
}
.stat-muted {
  color: var(--gb-muted) !important;
}
</style>
