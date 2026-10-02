/** 汛期演练占用单的响应式状态：本地读写 + 跨标签页变更同步。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { DrillPlan } from '@/types/drill'
import {
  broadcastPlansChanged,
  confirmPlanTx,
  onPlansChanged,
  reconfirmPlanTx,
  type ConfirmInput,
  type ConfirmOutcome
} from '@/utils/drill'

export const useDrillStore = defineStore('drill', () => {
  const plans = ref<DrillPlan[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      plans.value = await db.plans.orderBy('createdAt').reverse().toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 推荐名单：仅「已生效」的占用单可进入 */
  const confirmedPlans = computed(() => plans.value.filter((p) => p.status === 'confirmed'))

  /** 待处理：已失效 / 待补录 / 已拒绝 */
  const pendingPlans = computed(() => plans.value.filter((p) => p.status !== 'confirmed'))

  /** 某营地当前已占帐篷数（响应式，供表单与余量表实时显示） */
  function occupiedOfCamp(campName: string): number {
    return confirmedPlans.value
      .filter((p) => p.campName === campName)
      .reduce((sum, p) => sum + p.tentCount, 0)
  }

  /** 提交新占用单：事务内先到先得；被拒时调用方保留表单草稿 */
  async function submit(input: ConfirmInput): Promise<ConfirmOutcome> {
    const outcome = await confirmPlanTx(input)
    broadcastPlansChanged()
    await load()
    return outcome
  }

  /** 重新确认已失效 / 待补录的单：按当前容量口径重核并补写快照 */
  async function reconfirm(id: number): Promise<ConfirmOutcome> {
    const outcome = await reconfirmPlanTx(id)
    broadcastPlansChanged()
    await load()
    return outcome
  }

  // 其他标签页落库后本页立刻刷新：落空的页面能马上看到已占数量
  onPlansChanged(() => {
    void load()
  })

  return {
    plans,
    loading,
    loaded,
    confirmedPlans,
    pendingPlans,
    load,
    occupiedOfCamp,
    submit,
    reconfirm
  }
})
