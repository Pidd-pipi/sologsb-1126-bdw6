# 露营营地选址评估器（gbcampsite）

面向营地规划者与户外领队：把候选营位的地形、补给与隐患折算成综合得分。地图选点登记营位，录入坡度、水源距离、风向、信号等因子，配置权重后实时重排名次并给出 A/B/C 等级。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

内置「汛期演练排营」：领队按同一营地凑帐篷数提交占用单，营地总容量的两成留作应急余量，剩余可订不足即拒单；多标签页并发提交先到先得，因子或否决变化时相关计划立刻失效。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21826>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21826 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`siteStore` / `profileStore` / `uiStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`），未配置时自动降级为本地 SVG 网格视图 |
| 本地数据 | IndexedDB（Dexie，`gbcampsite-db`，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Campsite 营位 | `frontend/src/types/campsite.ts` | 营位编号、名称、所属营地、经纬度、海拔、坡度、坡向、地表类型、可容帐篷数、平整度评分、进出方式、默认方案 |
| FactorAssessment 因子评估 | `frontend/src/types/factor.ts` | 所属营位、水源距离、风向与风力等级、信号强度、日照时长、落石落枝风险、植被遮蔽度、离车距离、离步道距离、评估人、评估日期 |
| ScoreProfile 权重方案 | `frontend/src/types/score.ts` | 方案名、各因子权重（0-100）、归一化方式（极差归一 / 阈值分段）、A/B/C 等级阈值、适用季节、是否启用 |
| RiskVeto 风险否决项 | `frontend/src/types/veto.ts` | 营位 id、否决类型（河道内 / 山洪沟 / 孤树下 / 崖底落石区 / 陡坡）、说明、判定人、判定日期 |
| DrillPlan 演练占用单 | `frontend/src/types/drill.ts` | 单号、领队、所属营地、帐篷数、状态（已生效 / 已拒绝 / 已失效 / 待补录）、原因、容量口径快照（总容量、两成余量、可订量、占前已占） |

### IndexedDB 版本与升级迁移

库名 `gbcampsite-db`（Dexie），共 5 张表：`sites`、`factors`、`profiles`、`vetos`、`plans`。

- **v1**：建立 `sites`（营位）与 `factors`（因子评估）两张表。
- **v2**：新增 `profiles`（权重方案）表，并为 `factors` 补 `siteId` 索引，让「按营位取因子」走索引；同时为存量因子补齐 `shade`、`distanceToCar`、`distanceToTrail` 缺省值。
- **v3**：新增 `vetos`（风险否决）表，并为存量营位回填 `defaultProfileId`（取当前启用方案的 id）与新增字段缺省值。
- **v4**：新增 `plans`（汛期演练占用单）表。
- **v5**：`plans` 结构不变（容量口径为非索引字段），仅迁移存量数据——缺少容量口径快照的旧计划一律列为「待补录」，重新确认前不得沿用原推荐结果、不计入已占数量。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 营位名次表（按综合得分降序，展示坡度、水源距离、信号与等级，可按营地/地表/进出方式筛选，命中否决项整行标红） | Campsite、FactorAssessment、RiskVeto |
| `/sites/new` | 新增营位（地图点选或手填经纬度，录入海拔、坡度、坡向与容量，支持草稿保存） | Campsite、FactorAssessment |
| `/sites/:id` | 营位详情（上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核） | 四个模型 |
| `/scoring` | 权重与评分（拖动各因子权重条，名次实时刷新，可另存为季节方案） | ScoreProfile、Campsite |
| `/map` | 营位地图（高德 JS API 标记按等级着色，未配置 `VITE_AMAP_KEY` 时退化为本地 SVG 网格视图） | Campsite、RiskVeto |
| `/veto` | 风险否决登记（选营位与否决类型、填说明，提交后名次表与地图同步更新） | RiskVeto、Campsite |
| `/drill` | 汛期演练排营（按营地凑帐篷数提交占用单，两成应急余量，先到先得；推荐名单 / 待处理台账） | DrillPlan、Campsite |

### 汛期排营规则

- **容量口径**：营地总容量 = 各营位可容帐篷数之和；两成（20%）留作应急余量，可订容量 = ⌊总容量 × 0.8⌋。确认那一刻的口径随单落库（快照），后续复核以快照为准。
- **拒单**：已占 + 本单帐篷数 > 可订容量即拒绝，落一条「已拒绝」台账；表单草稿保留，可改小数量重提。
- **并发先到先得**：确认走单个 IndexedDB readwrite 事务（读口径 → 读已占 → 校验 → 写单），跨标签页串行执行；写完成后经 `BroadcastChannel` 通知其他标签页刷新已占数量，落空的页面保住草稿并看到最新已占。
- **失效联动**：营位因子评估、风险否决或营位容量一旦变化，相关营地的已生效单立刻转为「已失效」，重新确认前不进入推荐名单、不计入已占。
- **升级迁移**：v5 迁移把缺少容量口径的旧计划列为「待补录」，重新确认（按当前口径重核并补写快照）前不得沿用原推荐结果。

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `MapPanel.vue`（高德 + SVG 网格双模式）、`FactorScoreBar.vue`（原始值 / 归一化得分 / 权重占比）、`GradeBadge.vue`（A/B/C 等级与得分气泡）、`EmptyState.vue`（空态与新建入口）、`WeightEditor.vue`（权重条编辑器）
- hooks：`frontend/src/hooks/useAmapLoader.ts`（按需注入高德 JS API，key 缺省或加载失败返回降级标记）、`useRanking.ts`（归一化得分与名次）、`useLocalDraft.ts`（表单草稿）
- utils：`frontend/src/utils/score.ts`（极差归一、阈值分段、加权求和、等级阈值、否决短路）、`geo.ts`（经纬度距离与网格坐标换算）、`format.ts`（数值与日期格式化、流水编号）、`db.ts`（Dexie 封装与样例数据）、`draft.ts`（localStorage 草稿）、`drill.ts`（排营容量口径、事务式确认、失效联动与跨标签页广播）

## 六、地图降级说明

`VITE_AMAP_KEY` 为空时，`useAmapLoader()` **不会**请求 `webapi.amap.com`，而是立即返回降级标记；
`MapPanel` 随即渲染本地 SVG 网格视图（可点选、可查看详情），因此**构建与运行都不依赖该 key**。
若配置了 key，则注入脚本时带 `onerror` 与 8 秒超时双兜底，失败同样降级，不会产生 console error。

## 七、目录结构

```
sologsb-1126/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{campsite,factor,score,veto,drill}.ts
        ├── stores/{siteStore,profileStore,uiStore,drillStore}.ts
        ├── components/common/{MapPanel,FactorScoreBar,GradeBadge,EmptyState,WeightEditor}.vue
        ├── hooks/{useAmapLoader,useRanking,useLocalDraft}.ts
        ├── pages/{Ranking,SiteNew,SiteDetail,Scoring,MapView,Veto,Drill}.vue
        ├── router/index.ts
        ├── utils/{score,geo,format,db,draft,drill}.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- 全部数据只存在浏览器本地：营位、因子评估、权重方案、否决记录、演练占用单存 **IndexedDB**（Dexie，库名 `gbcampsite-db`）。
- 表单草稿（新增营位、否决登记、演练占用单）存 **localStorage**，键前缀 `gbcampsite:draft:`，刷新或误关页面后可恢复。
- 多标签页之间通过 **BroadcastChannel**（`gbcampsite:drill`）同步占用单变化，另一标签页提交后本页已占数量立即刷新。
- 容器完全无状态：不使用数据库服务、不挂载命名卷，清除浏览器站点数据即回到首次运行的样例营地。

## 九、规则验证脚本

`frontend/scripts/drill-test.ts` 用 `fake-indexeddb` 在 Node 里验证排营核心规则（升级迁移、两成余量、拒单、并发先到先得、失效与重新确认）：

```bash
cd frontend
npm install --no-save tsx fake-indexeddb
npx tsx scripts/drill-test.ts
```
