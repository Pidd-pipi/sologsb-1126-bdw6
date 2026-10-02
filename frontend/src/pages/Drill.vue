<script setup lang="ts">
/**
 * `/drill` 汛期演练排营 —— 领队按同一营地凑帐篷数提交占用单。
 * 营地总容量的两成留作应急余量，剩余可订不足即拒单（落台账）；
 * 多标签页并发提交时事务串行、先到先得，落空的页面保住草稿并看到最新已占数量。
 * 消费 DrillPlan、Campsite；复用 <EmptyState>。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import EmptyState from '@/components/common/EmptyState.vue'
import { useSiteStore } from '@/stores/siteStore'
import { useDrillStore } from '@/stores/drillStore'
import { useLocalDraft } from '@/hooks/useLocalDraft'
import { PLAN_STATUS_LABELS, RESERVE_RATIO } from '@/types/drill'
import type { DrillPlan, DrillPlanStatus } from '@/types/drill'
import { bookableOf, totalCapacityOf } from '@/utils/drill'
import { formatDateTime, formatPercent } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const drillStore = useDrillStore()

interface DrillForm {
  leader: string
  campName: string
  tentCount: number
}

function defaultForm(): DrillForm {
  return { leader: '', campName: '', tentCount: 1 }
}

const form = ref<DrillForm>(defaultForm())
const submitting = ref(false)
const reconfirmingId = ref<number | null>(null)

/** 表单草稿：拒单或误关页面后可恢复；只有确认生效才清除 */
const {
  savedAtText: draftSavedAtText,
  restore: restoreDraft,
  clear: clearDraft
} = useLocalDraft<DrillForm>({
  key: 'drill-new',
  source: form,
  delay: 400,
  onRestore: () => {
    ElMessage.info('已恢复上次未提交的占用单草稿')
  }
})
// 进入页面即尝试恢复草稿（拒单重进 / 误关重开都能接着填）
restoreDraft()

/** 营地选项：附实时余量，方便领队挑营地 */
const campOptions = computed(() =>
  siteStore.camps.map((name) => {
    const total = totalCapacityOf(siteStore.list, name)
    const bookable = bookableOf(total)
    const occupied = drillStore.occupiedOfCamp(name)
    return { name, total, bookable, occupied, remaining: bookable - occupied }
  })
)

/** 当前选中营地的容量口径预览 */
const caliberPreview = computed(() => {
  const name = form.value.campName
  if (!name) return null
  return campOptions.value.find((c) => c.name === name) ?? null
})

const enough = computed(
  () =>
    caliberPreview.value != null &&
    form.value.tentCount >= 1 &&
    form.value.tentCount <= caliberPreview.value.remaining
)

const stats = computed(() => ({
  camps: siteStore.camps.length,
  confirmed: drillStore.confirmedPlans.length,
  occupiedTents: drillStore.confirmedPlans.reduce((s, p) => s + p.tentCount, 0),
  pending: drillStore.pendingPlans.length
}))

function siteCountOf(campName: string): number {
  return siteStore.list.filter((s) => s.campName === campName).length
}

function statusTagType(status: DrillPlanStatus): 'success' | 'danger' | 'warning' | 'info' {
  switch (status) {
    case 'confirmed':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'invalidated':
      return 'warning'
    default:
      return 'info'
  }
}

function caliberText(plan: DrillPlan): string {
  const c = plan.capacity
  if (!c) return '缺容量口径快照'
  return `总容量 ${c.totalCapacity} · 余量 ${formatPercent(c.reserveRatio)} · 可订 ${c.bookableCapacity} · 占前已占 ${c.occupiedBefore}`
}

function resetForm(): void {
  form.value = defaultForm()
}

async function submit(): Promise<void> {
  const leader = form.value.leader.trim()
  if (!leader) {
    ElMessage.warning('请填写领队姓名')
    return
  }
  if (!form.value.campName) {
    ElMessage.warning('请选择营地')
    return
  }
  if (form.value.tentCount < 1) {
    ElMessage.warning('帐篷数至少为 1')
    return
  }
  submitting.value = true
  try {
    const outcome = await drillStore.submit({
      leader,
      campName: form.value.campName,
      tentCount: form.value.tentCount
    })
    if (outcome.ok) {
      ElMessage.success(`占用单 ${outcome.planNo} 已生效，进入推荐名单`)
      clearDraft()
      form.value = { leader, campName: form.value.campName, tentCount: 1 }
    } else {
      // 拒单：草稿保留在表单与 localStorage，页面同步展示最新已占数量
      ElMessage.error(
        `占用单 ${outcome.planNo} 被拒：${outcome.reason}；${form.value.campName} 当前已占 ${outcome.caliber.occupiedBefore} 帐`
      )
    }
  } catch (err) {
    ElMessage.error(`提交失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    submitting.value = false
  }
}

async function reconfirm(row: DrillPlan): Promise<void> {
  if (typeof row.id !== 'number') return
  reconfirmingId.value = row.id
  try {
    const outcome = await drillStore.reconfirm(row.id)
    if (outcome.ok) {
      ElMessage.success(`占用单 ${outcome.planNo} 已重新确认，补录容量口径后回到推荐名单`)
    } else {
      ElMessage.error(
        `占用单 ${outcome.planNo} 重新确认未通过：${outcome.reason}；当前已占 ${outcome.caliber.occupiedBefore} 帐`
      )
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    reconfirmingId.value = null
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>汛期演练排营</h1>
        <p>
          领队按同一营地凑帐篷数提交占用单；营地总容量的两成留作应急余量，剩余可订不足即拒单。
          两个标签页同时提交时先占到的一单生效，落空的页面保住草稿并能看到最新已占数量。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="router.push('/veto')">风险否决</el-button>
      </div>
    </div>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      :title="`应急余量 ${formatPercent(RESERVE_RATIO)}：可订容量 = ⌊营地总容量 × 0.8⌋，向下取整`"
      description="营位因子评估或风险否决一旦变化，相关营地的已生效占用单立刻失效，重新确认前不会进入推荐名单；缺少容量口径的旧计划在升级时列为「待补录」，不得沿用原推荐结果。"
    />

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">营地数</div>
        <div class="stat-card__value">{{ stats.camps }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">生效占用单</div>
        <div class="stat-card__value">{{ stats.confirmed }}</div>
        <div class="stat-card__extra">推荐名单在列</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">已占帐篷</div>
        <div class="stat-card__value">{{ stats.occupiedTents }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">待处理单</div>
        <div class="stat-card__value">{{ stats.pending }}</div>
        <div class="stat-card__extra">失效 / 待补录 / 已拒绝</div>
      </div>
    </div>

    <div class="drill-layout">
      <section class="panel">
        <div class="panel__head">
          <h2>新建占用单</h2>
          <span v-if="draftSavedAtText" class="weight-note">草稿 {{ draftSavedAtText }}</span>
        </div>
        <el-form label-width="90px" @submit.prevent>
          <el-form-item label="领队">
            <el-input id="drill-leader" v-model="form.leader" placeholder="领队姓名，如 林舟" />
          </el-form-item>
          <el-form-item label="营地">
            <el-select
              id="drill-camp"
              v-model="form.campName"
              placeholder="选择营地（同一营地凑帐篷数）"
              style="width: 100%"
            >
              <el-option
                v-for="opt in campOptions"
                :key="opt.name"
                :label="`${opt.name}（剩余可订 ${opt.remaining} 帐）`"
                :value="opt.name"
              >
                <span>{{ opt.name }}</span>
                <span
                  class="camp-remaining"
                  :class="{ 'text-danger': opt.remaining <= 0 }"
                >
                  剩余 {{ opt.remaining }} / 可订 {{ opt.bookable }}
                </span>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="帐篷数">
            <el-input-number
              id="drill-tents"
              v-model="form.tentCount"
              :min="1"
              :max="99"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="submit">提交占用单</el-button>
            <el-button @click="resetForm">清空</el-button>
          </el-form-item>
        </el-form>

        <template v-if="caliberPreview">
          <el-divider content-position="left">容量口径（实时）</el-divider>
          <div class="preview-list">
            <div class="preview-item">
              <span>营地总容量</span>
              <strong>{{ caliberPreview.total }} 帐</strong>
            </div>
            <div class="preview-item">
              <span>应急余量（两成）</span>
              <strong>{{ caliberPreview.total - caliberPreview.bookable }} 帐</strong>
            </div>
            <div class="preview-item">
              <span>可订容量</span>
              <strong>{{ caliberPreview.bookable }} 帐</strong>
            </div>
            <div class="preview-item">
              <span>当前已占</span>
              <strong>{{ caliberPreview.occupied }} 帐</strong>
            </div>
            <div class="preview-item">
              <span>剩余可订</span>
              <strong :class="{ 'text-danger': caliberPreview.remaining < form.tentCount }">
                {{ caliberPreview.remaining }} 帐
              </strong>
            </div>
          </div>
          <p v-if="!enough" class="panel__hint text-danger">
            本单 {{ form.tentCount }} 帐超出剩余可订，提交将被拒绝并记入台账，草稿会保留。
          </p>
        </template>
        <p v-else class="panel__hint">
          选择营地后显示实时容量口径；提交那一刻的口径会随单落库，作为后续复核依据。
        </p>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2>营地余量一览</h2>
          <span class="weight-note">两成应急余量不参与排营</span>
        </div>
        <el-table :data="campOptions" size="small" border stripe>
          <el-table-column prop="name" label="营地" min-width="130" />
          <el-table-column label="营位数" width="76" align="center">
            <template #default="{ row }">{{ siteCountOf(row.name) }}</template>
          </el-table-column>
          <el-table-column label="总容量" width="82" align="center">
            <template #default="{ row }">{{ row.total }} 帐</template>
          </el-table-column>
          <el-table-column label="应急余量" width="88" align="center">
            <template #default="{ row }">{{ row.total - row.bookable }} 帐</template>
          </el-table-column>
          <el-table-column label="可订" width="76" align="center">
            <template #default="{ row }">{{ row.bookable }} 帐</template>
          </el-table-column>
          <el-table-column label="已占" width="76" align="center">
            <template #default="{ row }">{{ row.occupied }} 帐</template>
          </el-table-column>
          <el-table-column label="剩余" width="76" align="center">
            <template #default="{ row }">
              <strong :class="{ 'text-danger': row.remaining <= 0 }">{{ row.remaining }} 帐</strong>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="86" align="center">
            <template #default="{ row }">
              <el-tag :type="row.remaining > 0 ? 'success' : 'danger'" size="small">
                {{ row.remaining > 0 ? '可订' : '已满' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>推荐名单（生效中的占用）</h2>
        <span class="weight-note">仅「已生效」单在列；失效 / 待补录须重新确认后才会回到名单</span>
      </div>
      <el-table
        v-if="drillStore.confirmedPlans.length"
        :data="drillStore.confirmedPlans"
        size="small"
        border
        stripe
      >
        <el-table-column prop="planNo" label="单号" width="100" />
        <el-table-column prop="leader" label="领队" width="110" />
        <el-table-column prop="campName" label="营地" min-width="140" />
        <el-table-column label="帐篷数" width="86" align="center">
          <template #default="{ row }">{{ row.tentCount }} 帐</template>
        </el-table-column>
        <el-table-column label="容量口径快照" min-width="260">
          <template #default="{ row }">{{ caliberText(row) }}</template>
        </el-table-column>
        <el-table-column label="确认时间" width="150">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
      </el-table>
      <EmptyState
        v-else
        title="推荐名单为空"
        description="还没有生效的占用单，从左侧提交第一单。"
        hint="失效或待补录的单须重新确认后才会回到名单"
      />
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>待处理</h2>
        <span class="weight-note">共 {{ drillStore.pendingPlans.length }} 单</span>
      </div>
      <el-table
        v-if="drillStore.pendingPlans.length"
        :data="drillStore.pendingPlans"
        size="small"
        border
        stripe
      >
        <el-table-column prop="planNo" label="单号" width="100" />
        <el-table-column prop="leader" label="领队" width="110" />
        <el-table-column prop="campName" label="营地" min-width="130" />
        <el-table-column label="帐篷数" width="86" align="center">
          <template #default="{ row }">{{ row.tentCount }} 帐</template>
        </el-table-column>
        <el-table-column label="状态" width="96" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ PLAN_STATUS_LABELS[row.status as DrillPlanStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="250">
          <template #default="{ row }">{{ row.reason || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'invalidated' || row.status === 'pending-backfill'"
              size="small"
              type="primary"
              plain
              :loading="reconfirmingId === row.id"
              @click="reconfirm(row)"
            >
              重新确认
            </el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">
        暂无待处理单。因子评估或风险否决变化时，相关生效单会立刻失效并出现在这里。
      </p>
    </section>
  </div>
</template>

<style scoped>
.drill-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1080px) {
  .drill-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.preview-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  font-size: 13px;
  background: var(--gb-surface);
  border-radius: 8px;
}
.preview-item span {
  color: var(--gb-muted);
}
.camp-remaining {
  float: right;
  font-size: 12px;
  color: var(--gb-accent-strong);
}
.text-danger {
  color: var(--gb-danger);
}
</style>
