/**
 * 汛期排营核心规则验证脚本（node + fake-indexeddb，不进构建、不做类型检查）。
 * 运行：npx tsx scripts/drill-test.ts
 * 覆盖：
 *  1. v4→v5 升级迁移：缺容量口径的旧计划列为「待补录」，且不被种子数据覆盖
 *  2. 两成应急余量与「剩余不足即拒单」
 *  3. 两单并发提交，先到先得、不超卖
 *  4. 失效联动（已占回落）与重新确认（补录容量口径）
 */
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'

Object.assign(globalThis, { indexedDB, IDBKeyRange })

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function main(): Promise<void> {
  const Dexie = (await import('dexie')).default

  // ==================== 阶段一：v4→v5 升级迁移 ====================
  // 准备 v4 时代的旧库：一张没有容量口径的占用单
  const legacy = new Dexie('gbcampsite-db')
  legacy.version(4).stores({
    sites: '++id, code, name, campName, surface, access, defaultProfileId, updatedAt',
    factors: '++id, siteId, assessedAt, assessor',
    profiles: '++id, name, season, active, updatedAt',
    vetos: '++id, siteId, type, judgedAt',
    plans: '++id, planNo, campName, status, createdAt'
  })
  await legacy.open()
  await legacy.table('plans').add({
    planNo: 'DP-0000',
    leader: '旧领队',
    campName: '云栖山谷营地',
    tentCount: 3,
    status: 'confirmed',
    reason: '',
    createdAt: '2024-04-01T00:00:00.000Z',
    updatedAt: '2024-04-01T00:00:00.000Z'
    // 注意：没有 capacity 字段 —— 模拟 v4 时代的旧记录
  })
  legacy.close()

  const { db, initDatabase } = await import('../src/utils/db')
  await initDatabase()

  console.log('■ v4→v5 升级迁移')
  const legacyPlan = await db.plans.where('planNo').equals('DP-0000').first()
  assert(legacyPlan?.status === 'pending-backfill', '缺容量口径的旧计划被列为「待补录」')
  assert(!!legacyPlan?.reason.includes('容量口径'), '待补录原因写明容量口径缺失')
  const seededDp1 = await db.plans.where('planNo').equals('DP-0001').first()
  assert(seededDp1 === undefined, '已有占用单时种子不覆盖 plans 表')

  // ==================== 阶段二：全新库，验证排营规则 ====================
  db.close()
  await Dexie.delete('gbcampsite-db')
  await initDatabase()

  const {
    bookableOf,
    totalCapacityOf,
    occupiedOf,
    confirmPlanTx,
    reconfirmPlanTx,
    invalidatePlansForCamps
  } = await import('../src/utils/drill')

  console.log('■ 两成应急余量')
  const sites = await db.sites.toArray()
  assert(totalCapacityOf(sites, '云栖山谷营地') === 10, '云栖山谷营地总容量 = 10 帐')
  assert(bookableOf(10) === 8, '总容量 10 → 可订 8（留下两成）')
  assert(bookableOf(15) === 12, '总容量 15 → 可订 12')

  console.log('■ 剩余不足即拒单')
  let plans = await db.plans.toArray()
  assert(occupiedOf(plans, '云栖山谷营地') === 8, '云栖已占 8 帐（待补录不计入已占）')
  const rej = await confirmPlanTx({ leader: '测试员', campName: '云栖山谷营地', tentCount: 1 })
  assert(!rej.ok, '云栖剩余 0，1 帐单被拒')
  assert(
    rej.caliber.bookableCapacity === 8 && rej.caliber.occupiedBefore === 8,
    '拒单快照：可订 8 / 占前已占 8'
  )
  plans = await db.plans.toArray()
  const rejRow = plans.find((p) => p.planNo === rej.planNo)
  assert(rejRow?.status === 'rejected' && rejRow.reason.includes('不足'), '拒单落台账并记录原因')

  console.log('■ 并发提交先到先得（北岭剩余 2 帐，两单各要 2 帐）')
  const [a, b] = await Promise.all([
    confirmPlanTx({ leader: '标签页A', campName: '北岭高地营地', tentCount: 2 }),
    confirmPlanTx({ leader: '标签页B', campName: '北岭高地营地', tentCount: 2 })
  ])
  assert(a.ok !== b.ok, '一单一成一败（先到先得）')
  plans = await db.plans.toArray()
  assert(occupiedOf(plans, '北岭高地营地') === 8, '北岭最终已占 8 帐 = 可订上限，未超卖')

  console.log('■ 失效联动与重新确认')
  const affected = await invalidatePlansForCamps(['云栖山谷营地'], '测试：因子变化')
  assert(affected === 1, '云栖 1 张生效单被失效')
  plans = await db.plans.toArray()
  assert(occupiedOf(plans, '云栖山谷营地') === 0, '失效后云栖已占回落为 0')

  const dp1 = plans.find((p) => p.planNo === 'DP-0001')
  const re1 = await reconfirmPlanTx(dp1?.id as number)
  assert(re1.ok && re1.caliber.occupiedBefore === 0, 'DP-0001 重新确认通过并补写快照')

  const dp3 = await db.plans.where('planNo').equals('DP-0003').first()
  const re3 = await reconfirmPlanTx(dp3?.id as number)
  assert(re3.ok, '待补录的 DP-0003 重新确认后生效')
  const dp3After = await db.plans.where('planNo').equals('DP-0003').first()
  assert(
    dp3After?.status === 'confirmed' && dp3After.capacity?.bookableCapacity === 12,
    'DP-0003 补录容量口径（杉木坪可订 12）'
  )

  const over = await confirmPlanTx({ leader: '超额单', campName: '杉木坪营地', tentCount: 12 })
  assert(!over.ok, '杉木坪已占 5、剩余 7，12 帐单被拒')

  console.log('\n全部断言通过 ✅')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
