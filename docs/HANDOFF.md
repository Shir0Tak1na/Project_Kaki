> **这份文件是交接入口，不是排期**：只保留「当前状态 / 已完成能力 / 关键文件 / 交接注意」。
> **当前排期看 `PLAN.md`**；**已完成流水看 `DEVLOG.md`**；
> **2026-09-24 ～ 09-28 的逐轮交接叙事已移到 `archive/ARCHIVE-HANDOFF.md`**（原文保留，只读）。
> ⚠️ 本文件**不再维护基线数字**（避免两处各写一遍）：基线以 `PLAN.md` §2 与四道门实测为准。


# Project Kaki：Agent 交接说明

更新时间：2026-09-30

这份文档给下一位开发 agent 使用。项目名是 **Project Kaki**（译名 Project 垣，只在第一次出现时标注即可），
插件 ID 已改为 `project-kaki`（`scripts/deploy.mjs` 会自动迁移旧目录的旧 ID 设置与启用项）。

> ⚠️ 但地图文档类型 `fictional-cartographer-map`、Base 视图 ID `fictional-map`、面板视图 ID
> `fictional-cartographer-panel` **不要改**：它们写在用户的 `.map.md` frontmatter、`.base` 文件和
> `.obsidian/workspace.json` 里，改了等于让用户已有的地图、Base 和侧栏布局失效
> （详见 [`ENGINEERING-NOTES.md`](./ENGINEERING-NOTES.md) §5.8）。
> 一句话判断法：**标识出现在用户文件里 → 不动；只出现在插件自己的注册调用里 → 可以改。**

## 当前基线

- 工作区：`E:\ObsidianPulgins\fictional-cartographer`（**目录名仍是历史名，未改**；插件 ID 才是 `project-kaki`）
- 默认测试库：`E:\ObsidianPulgins\test-vault`（插件目录为 `plugins\project-kaki`）
- 正式库：`D:\TOS\万千旅路｜Thousands of Sands`，未经用户明确要求不要部署。
- 代码仓库：`https://github.com/Shir0Tak1na/Project_Kaki`（Apache-2.0，`origin` / `main`）
- 最近一次部署：`node scripts/deploy.mjs`
- 单元测试：695 个通过
- 冒烟测试：52 个场景、1583 条断言全部通过
- 类型检查必须为 0 错（`node node_modules/typescript/bin/tsc --noEmit`）
- **最新一轮（ISSUE-005：绘制模式拆出「自由绘制」，2026-09-30）**：路径/区域的绘制模式从三个变四个 ——
  新增 `free`（按指针轨迹落点、**屏幕 4px** 最小间距、无锚点、抬手一次性提交、不叠平滑），
  `interior`「沿格心连接」语义不变；老数据 `mode: 'interior'` **不迁移、不改写**。
  侧栏 `GEOMETRY_OPTIONS` 四项，模式名与 ≤20 字 hint 的**单一来源**是 `src/ui/strings.ts`，
  浮窗文案读同一份，`drawDraft` 按 `draft.mode` 决定画不画顶点手柄。
  单测 694 → **695** · 冒烟 1566 → **1583** · 构建 **91 模块 / 1592.9 KiB**；破坏性验证 2 处（`DEVLOG.md` §六）。
- **上一轮（数据层 UI W2 + W3，2026-09-30）**：色带从「每个锚点一行」改成**一条轴**（可拖动锚点、两端端帽、
  新建 / 删除、检视行精确输入）；出厂数值类（不透明度 / 显示方式 / 单位 / 等值线 / 写数值）**搬进设置页**；
  单测 675 → **687** · 冒烟 1556 → **1565** · 构建 **90 模块 / 1575.3 KiB**。
- **上一轮（发版 `1.1.0` · 代号 **Ru**，2026-09-30）**：把 1.0.0 之后这一整周期的改动作为 **1.1.0** 发布 ——
  UI 全量整理 W1–W4（侧栏按 §2.4 重排 · 选择三形态 · 导出路径浏览器 · 地图定义重做 · 地图文件 v2 定义随图 ·
  视图偏好按地图分份 · 资源包降级为搬运工具）＋ 文案 19 处星号修缺陷。
  版本号与 git tag 都是 **`1.1.0`**（`scripts/release.mjs` 只接受 `x.y.z`），型号「Ru」写在 CHANGELOG 标题与发布说明里。
- **最新一轮（存储轮 W4-3：资源包降级为"搬运工具" —— 导当前地图定义集 + 同名冲突逐条可覆盖）** ——
  W4-1 / W4-2 让参数变成"每张地图各自一份"，于是定义文件这件事的**性质**也变了：
  它从"给库级设置做备份"变成**跨地图搬参数的工具**。三处改动：
  ① **导出**：源改成**当前地图的定义集**（没有地图时导「新建地图的模板」那一份，**提示里写明**），
  守门判据从"四类都空"换成 `isFactoryDefinitionSet`（跟出厂一模一样就等于什么都没带）；
  ② **内置项也进文件**：`pathTypes` / `regionTypes` 两段从此是**整套目录**（内置 4 / 6 种 + 自定义）
  —— 用户调得最勤的恰恰是内置那几种的线宽与填充，不带着它们，跨地图搬运就只剩空的自定义类型；
  代价是导入时每一条内置项都是同名冲突、**默认跳过**；
  ③ **冲突策略从"默认保护"改成"默认跳过 + 逐条可覆盖"**：`mergeById` / `mergePathTypes` /
  `mergeRegionTypes` 收 `overwrite(id)`，覆盖 = **在原位换成文件里那一条**（顺序不动）；
  `planBundleImport` 新增 `conflicts`（两侧各一句人话）与 `replacedCount`，对话框给每条冲突画一行
  + 一个「覆盖」开关 + 一个「全部设为覆盖」动作按钮，勾选变了就**重算整份计划**
  （正文 / 按钮状态 / 落盘三处同一次计算）；`mutateDefinitions` 新增第三参数 ——
  **"导入到哪张图"先说后做**，提交时不再重新解析目标。
  ⚠️ 途中抓到一个**真缺陷**：`mergePathTypes` / `mergeRegionTypes` 只把新增记进"给用户看的清单"
  （`added`），**忘了进最终目录**（`base`）⇒ 对话框说"将新增 1 条"、落盘一条没进；
  单测当时是绿的（它们手工拼 `after`），**冒烟场景 36 当场红**。补了两条断言钉住。
  单测 672 → **675** · 冒烟 1541 → **1556**（场景 36 改口径 5 条 + 新增 15 条）。
  四道门：构建 **89 模块 / 1555.9 KiB** · `tsc` 0 错 · 单测 **675** · 冒烟 **1556** 全过。
  流水见 `DEVLOG.md` §2v，判据见 `ENGINEERING-NOTES.md` §5.75。
- **上一轮（存储轮 W4-2：视图偏好按地图分份 —— 色带 / 图层开关 / 图例）** ——
  W4-1 把一组"按地图分份"的东西做完了（定义）；这一批把**渲染层设置**也按同一模式做了一遍：
  ① 新增 `settings.mapViews[地图路径] = { overlays?, layers?, showLegend? }`（三个字段都可选、
  **按字段回落**）；库级那三份的语义降级为**"默认值 / 新建地图的初值"**，写入时**两处一起更新（镜像）**；
  ② `main.ts` 新增 `activeViewMapPath()`（活动画布，给侧栏 / 设置页 / 报告用）与
  `mapPathForCanvas(canvasPath)`（任意画布，给画布上的覆盖层 / 工具条 / 图例用，**刻意与前者不同**：
  画布上的东西属于"它自己那张图"，不许看"谁是活动画布"），以及 `overlaysFor` / `layersFor` /
  `showLegendFor`（每帧现读，只查表不规范化）与唯一写入口 `commitViewSettings`；
  ③ 写入口：`setOverlayStyle` / `resetOverlayRamp` / `setOverlayCategoryColor` / `setLayerVisible` /
  `setShowLegend`，并给画布侧加了 `setLayerVisibleFor` / `setShowLegendFor`（同一份实现的薄包装）；
  ④ `MapLayerManagerDeps` 的 `getLayers` / `getOverlayStyles` / `getShowLegend` 加 **canvasPath**，
  `BasesViewDeps` 的同名两个加 **mapPath**；顺手删掉两个**从来没人调用**的 setter deps；
  ⑤ **老配置迁移不需要写一行代码**：老 `data.json` 只有库级那三份 ⇒ `mapViews` 是空的 ⇒
  每张图都用模板 ⇒ 迁移前后视觉完全一致，而且**不给现有地图各复制一条记录**。
  单测 668 → **672** · 冒烟 1534 → **1541**（新增场景 52 共 7 条；**老断言几乎没改** —— 镜像写入让
  `getSettings().overlays/.layers` 仍等于最近一次写入的值，这是"粒度升级不该改老断言"的信号）。
  四道门：构建 **89 模块 / 1538.9 KiB** · `tsc` 0 错 · 单测 **672** · 冒烟 **1541** 全过。
  设计定稿见 `UI-REORG-PLAN.md` §5.1b，流水见 `DEVLOG.md` §2u，判据见 `ENGINEERING-NOTES.md` §5.74。
  （当时资源包仍是库级搬运 —— 那一半已在 **W4-3** 做完，见上。）
- **上一轮（存储轮 W4-1b：定义随图的接线 —— 定义读写全部落到当前地图）** ——
  W4-1a 把 `definitions` 落进了文件但**读取仍走库级设置**（那一段是惰性的）；这一批把它接上：
  ① **读**：五个定义访问器（`getCustomTerrains` / `getCustomMarkers` / `getCustomBiomes` /
  `getPathTypes` / `getRegionTypes`）改成**按文档解析**（多参数 `document`，`main.ts#definitionsOf`：
  文件里有 `definitions` 就以它为准，没有才退回库级快照），`MapLayerManager` 的每处调用点传
  **这张画布持有的那份文档**（多画布同开是硬约束 ⇒ 没有插件级单例）；Base 视图传它自己加载的那份；
  ② **写**：所有定义写入口（增删改 / 改 ID / 恢复出厂参数）收口到 `main.ts#mutateDefinitions`，
  改动写进**当前地图**的 `definitions` 段（有地图层就走 `MapEditor.setDefinitions` ⇒ **可撤销**，
  没有地图层就直接读改写盘），同时**镜像**库级那一份（它从此只是"新建地图的模板"+ v1 老图的迁移快照）；
  ③ **「地图定义」弹窗**读写当前地图，并新增**路径 / 区域类型的参数编辑**（内置 4 种 / 6 种也给入口）；
  ④ 设置页「新对象默认值」里那两节整节撤掉（只留名称字体族 + 一行指路）；
  ⑤ **数据层修正**：`definitions` 段五类**都写**（空的写 `[]`）—— 否则"删掉最后一个自定义地形"
  会被库级快照顶回来（`definitionsBlockOf` / `serializeDefinitions` 各一处 + 新单测钉住）；
  收尾补两处：**定义编辑一律按 ID 定位**（弹窗显示的那份与"点下去那一刻的活动地图"未必同一份，
  按下标会改错条目）+ `definitionDocCache` 跟着 vault `modify` 失效。
  单测 666 → **668** · 冒烟 1520 → **1534**（新增场景 51 共 8 条 + 场景 23 / 34 / 37 / 40 改写）。
  四道门：构建 **89 模块 / 1529.1 KiB** · `tsc` 0 错 · 单测 **668** · 冒烟 **1534** 全过。
  流水见 `DEVLOG.md` §2t，判据见 `ENGINEERING-NOTES.md` §5.73。
  ⚠️ 本轮**有意**没有动 UI / 渲染层设置的粒度 —— `overlays` / `layers` 按地图分键是 **W4-2**；
  资源包（定义文件导入导出）仍是库级搬运，降级为"搬运工具"是 **W4-3**。
- **上一轮（存储轮 W4-1a：地图文件 v2 —— `definitions` 块 + 新建地图写定义）** ——
  用户 m01845 裁定走**方案 B**（"需要按照B做修改，这是不得不做的"）：定义随地图文件走，
  分享一张图对方就能拿到完整定义。这一批**只落数据层**，读取路径留给 W4-1b：
  `MAP_DOCUMENT_VERSION` 1 → **2**，顶层新增 `definitions`（五类：terrain / marker / biome /
  pathType / regionType，**不重复存颜色覆盖表** —— `pathColors`/`regionColors` 是上一代的只读兼容字段）；
  新增 `src/data/mapDefinitions.ts`（`definitionSetFromLibrary` / `definitionSetFromDocument` /
  `definitionsBlockOf`，纯函数、不 import obsidian）；`MapDocumentStore.createMap` 接受
  `definitions` 并写进新文件，`main.ts#libraryDefinitionsBlock()` 从库级设置拍快照。
  **老图一个字节都不动**（没有 `definitions` 就不写这个键；迁移是"读时用库级设置做内存快照、
  只有用户真的改了定义才回写升版"）。单测 654 → **666**（新增 `tests/mapDefinitions.test.ts` 12 条）·
  冒烟 1516 → **1520**（场景 6 +4）。四道门：构建 **89 模块 / 1508.8 KiB** · `tsc` 0 错 ·
  单测 **666** · 冒烟 **1520** 全过（已部署 test-vault）。流水见 `DEVLOG.md` §2s，
  判据见 `ENGINEERING-NOTES.md` §5.72。
  ⚠️ **写在文件里的那一段目前是惰性的**（读取仍走库级设置），所以**用户还看不到"定义随图"生效** ——
  **下一批 W4-1b** 才是把 `getCustomTerrains` 等访问器改成"按画布 / 按地图解析"（签名要加 canvasPath，
  多画布同开是硬约束）+ 定义写入口改到地图文件 + 「地图定义」弹窗读写当前地图。
- **上一轮（UI 整理 W3-2：地图定义重做——自带 / 自定义分区 + 每条收成一行 + 文案重写）** ——
  用户口径（§5 第 3 条）：「自定义的和本身自带的混在一起，阅读量大且无用。其次新建和编辑定义的
  功能描述非常难懂，而且到现在都没有选择文件的功能，全靠手输」。改法：`ui/DefinitionManagerModal.ts`
  每节分 `自定义（N）`（可增删改）/ `内置（N，只读）`（**纯文本行、默认收起**，从根上没有了"空按钮"）；
  地形 / 标记每条自定义定义收成一个 `<details>`（标题行 = 序号 + 显示名 + ID，点开才编辑），
  **展开状态跨重建保留**；四段节说明压到一句话，「新增」那一大段 ID 规则挪进输入框悬停提示；
  区域 / 路径类型的自定义行去掉多余的「（自定义）」后缀（已分区）；地形那行「显示方式」改名「图片排版」
  （与"模式"不再撞词）。**「补文件选择」早已具备**（图片那一栏一直有「从库中选择…」），本轮只把措辞说清。
  冒烟 1509 → **1516**（场景 47 新增 6 条 + 内置行断言改写）；单测仍是 **654**。
  四道门：构建 88 模块 / 1496.7 KiB · `tsc` 0 错 · 单测 **654** · 冒烟 **1516** 全过（已部署 test-vault）。
  流水见 `DEVLOG.md` §2r，判据见 `ENGINEERING-NOTES.md` §5.71。
  **W3 两块都已完成（W3-1 导出路径浏览 · W3-2 地图定义重做）；下一批按 §0 是 W4（存储轮）。**
- **上一轮（UI 整理 W3-1：导出加"文件浏览器"——保存位置 + 文件名）** ——
  用户口径「导出的时候应该有个文件资源管理器一样的浏览功能」：以前路径是**推导**出来的
  （`Maps/World-北境领.svg`），既看不到也改不了。现在「导出地图…」对话框多了
  **「保存位置」（可填 / 可「浏览…」从库内文件夹里挑）+「文件名」**两行，
  摘要实时显示最终路径，非法时把按钮变灰；`settings.exportFolder` 记住上次**成功**用过的目录
  （插件设置，不进地图文件）。新增纯函数 `joinExportTarget` / `exportTargetProblem` /
  `stripExportExtension`（`base/exportBounds.ts`）与 `listFolderPaths` / `describeFolderChoice`
  （`base/assetFiles.ts`，选择器新增 `kind: 'folder'`）；守门在**导出那一侧**也做一次
  （命令面板与两条快捷命令都绕过对话框）。单测 647 → **654** · 冒烟 1490 → **1509**
  （场景 32 新增 19 条）。四道门：构建 88 模块 / 1494.6 KiB · `tsc` 0 错 · 单测 **654** ·
  冒烟 **1509** 全过（已部署 test-vault）。流水见 `DEVLOG.md` §2q，判据见 `ENGINEERING-NOTES.md` §5.70。
  **W3 还剩「地图定义重做」**（下一轮做）。
- **上一轮（修用户当场报的回归：W2-3 那份统计没有真的收进侧栏）** ——
  用户验收 W2-3 第 2 条没过：「**并没有收进侧栏里。**」：卡片降级成"抬手就收起"之后，
  §C.4 那份统计（坐标范围 / 温度众数 / 温度平均 / 缺数据与兜底格 / 生物群系清单 / 已不存在）
  **哪儿都没有**（侧栏只加了一行地形摘要）。修法：① `render/selectionCard.ts` 抽出
  `selectionStatRows()`（**卡片与侧栏共用**），`main.ts#batchEditInfo` 塞进 `details`、
  `MapPanel.renderBatchEdit` 渲染成 `.fc-batch-detail-row`；② `MapEditor.endCellDrag()` 补
  `onStateChanged?.()`（卡片的"进行中"判据就是 `isCellDragging()`，抬手不通知则侧栏不重绘）。
  单测 647 → **647** · 冒烟 1486 → **1490**。四道门：构建 88 模块 / 1476.1 KiB · `tsc` 0 错 ·
  单测 **647** · 冒烟 **1490** 全过（已部署 test-vault）。流水见 `DEVLOG.md` §2p，
  判据陷阱（那 5 条断言此前靠 stale DOM 假绿）见 `ENGINEERING-NOTES.md` §5.69。
  **下一批是 W3（导出加路径浏览 + 地图定义重做）。**
- **上一轮（UI 整理 W2-3：悬停读数 + 画布信息卡降级）** ——
  ① 选择模式下 `pointermove` → `MapEditor.probeHoverAt()`（走**与点击同一套**命中测试）
  ⇒ **命中对象报对象名**、否则报格读数；指针移出画布报 `none`；② 信息卡**只做进行中的事**：
  `refresh()` 只把"框选拖动中"的格选择交给卡片，其余显示**悬停读数**，两样都没有就整张收起
  （已确定的选择归侧栏）；③ 卡片上那个「清空选择」按钮**删掉**（W2-1 起它长在侧栏标题行上）。
  单测 643 → **647**（`tests/selectionCard.test.ts` +4）· 冒烟 1484 → **1486**
  （场景 48/49/50 的卡片断言改成**指针悬停驱动**）。四道门：构建 88 模块 / 1476.1 KiB · `tsc` 0 错 ·
  单测 **647** · 冒烟 **1486** 全过（已部署 test-vault）。流水见 `DEVLOG.md` §2o。
  **W2 三块全部完成；下一批是 W3（导出加路径浏览 + 地图定义重做）。**
- **上一轮（UI 整理 W2-2：多对象选择（同类多选）+ 侧栏第 3 形态）** ——
  ① `MapEditor` 的对象选择从单值变成**数组**（真相 = `objectSelection`，`getSelection()` 是它的第一项）；
  ② Shift / Alt **单击先问对象**（命中就并入 / 移出），没命中才回退到"这一格加选 / 取消"；
  ③ 侧栏第 3 形态：`已选 3 个标记` + 逐项一行（名称 · 位置 · 「移除」）+ 公共字段（类型 / 链接 / 删除这 N 个），
  混合时留空并写明「各不相同」；④ 新增 `setObjectsField` / `setObjectsType` / `setObjectsLink` / `removeObjects`
  （**一次提交 = 一条历史**，校验与 op 构造复用新抽出的 `fieldOpFor`）；⑤ 覆盖层高亮**逐个画**。
  四道门：构建 88 模块 / 1476.1 KiB · `tsc` 0 错 · 单测 **647** · 冒烟 **1484** 全过（已部署 test-vault）。
  流水见 `DEVLOG.md` §2n。**W2 剩下的：悬停读数 + 信息卡降级（成对做）。**
- **上一轮（UI 整理 W2-1：侧栏成为「选择」的唯一家）** ——
  ① 单选一格时，「数据显示」在 ID 下面**直接列出温度 / 深度 / 生物群系三行读数**（按展示单位格式化，
  不用展开折叠组就能看见值）；② 读数**只算一份**：新抽 `describeCellReadings`（`src/render/selectionSet.ts`），
  `describeCellDetails` 改为组合它 ⇒ 侧栏与画布信息卡同一个格式化函数；③ 「清空选择」升到「数据显示」标题行
  （没选择时灰掉），整批编辑那一块里原来那个**删掉**（一个控件只有一个家）；
  ④ 用户验收时追加「多选模式，侧栏里稍微加一行显示，不要裸着」⇒ 整批编辑标题下加一行摘要
  `水域 2 · 森林 1 · 1 格没有数据`（`main.ts#batchSummaryLine`：地形按格数降序、最多 3 种，
  "没有数据"= 温度/深度/生物群系一个都没有的格数）。
  四道门：构建 88 模块 / 1476.1 KiB · `tsc` 0 错 · 单测 **647** · 冒烟 **1469** 全过（已部署 test-vault）。
  流水见 `DEVLOG.md` §2m。
  **W2 剩下的：多对象选择（同类多选）+ 侧栏第 3 形态 + 悬停读数与信息卡降级（有意成对做）。**
- **上一轮（UI 整理 W1 ④ · 侧栏按 §2.4 定稿顺序重排）** ——
  用户 m01932 今天："暂且搁置功能开发，完成 UI 重构"。动手前发现 §2.4 第 2 / 第 4 项指向同一批控件（自相矛盾），
  问过用户后定下两条口径：**「视图」= 保留「底图 / 地物」二分、整体折进一个「视图」折叠组**；
  **数据层的「画法」跟着它那一层走**（不再有独立的「数据层参数」组）。改了什么：
  `src/ui/MapPanel.ts` 的 `render()` 重排为 **数据显示面板 → 编辑 → 视图 → 动作组**（`renderActionGroup` /
  `renderEditSection` / `renderViewSection` / `renderLayerDraw` 是新增的四个私有方法，删掉了 `renderDisplay` /
  `renderDataParams`）；数据显示面板常驻置顶、内容区 `.fc-selection-body` 有固定最小高度（不再随选择上下缩动）；
  「编辑」= 工具 → 笔刷 → 选择方式 → 「编辑」动作组；`src/main.ts` 的 `filter-selection` 组 `map` → `edit`
  （用户："筛选错误的放进了地图层里面，这个应该是编辑工具"）；`src/render/layerVisibility.ts` 的 `LayerSpec`
  补上 `displayGroup`；`styles.css` 换成 `.fc-layer-row` / `.fc-layer-draw-*`（删掉 `.fc-panel-data` /
  `.fc-panel-field-title`）；场景 50 重写。
  四道门：构建 88 模块 / 1437.3 KiB · `tsc` 0 错 · 单测 **647** · 冒烟 **1455** 全过（已部署 test-vault）。
  流水见 `DEVLOG.md` §2l。**W1 四件全部做完；下一步按施工文件 §0 的 W2（选择与批量编辑三形态）。**
- **上一轮（UI 整理 W1 ①②③）** ——
  ① 删掉多余的撤销路径（侧栏「本次选中已改 N 处 · 撤销这些改动」整行 + 管道：6 个文件，
  `MapEditor` 的 `selectionUndoBaseline` / `editsSinceSelection()` / `undoEditsSinceSelection()` 一并删）；
  ② 修「打开地图面板」在面板里点必然没反应（该动作加 `panelHidden: true`，命令面板与 ribbon 保留）；
  ③ 图层开关只留侧栏（设置页整组「图层」9 开关 + 「显示图例」移除，侧栏「视图 · 底图」「视图 · 地物」是唯一家）。
  流水见 `DEVLOG.md` §2k。
- **再往前一轮（数据层色带模型：越界两端渐变到极色 + 深度改黑→白 —— 用户 m01430 规格的第一块）** ——
  `src/render/colorRamp.ts` 的 `RangeStyle`（:40）新增**必填** `farColor` / `farTextColor`
  （"远远低于 / 远远高于限度"渐变到的极色 + 它上面的字色；`farColor === color` = 这一侧不渐变，
  老设置里没有这两个键 ⇒ 回退成"不渐变"，升级后画面不变）；越界值改成**按"越出去多远 ÷ 一个跨度"渐变**
  （`t = clamp(distance / span, 0, 1)`，超过一个跨度饱和在极色；`t <= 0` / `t >= 1` 逐字返回端色 / 极色，不经 Oklab）；
  温度出厂 = 低温蓝底白字 → 极白底深字 / 高温红底白字 → 极黑底白字；**深度出厂改成 低 → 高 = 纯黑 → 纯白**；
  新增 `rampBounds()` / `positionForValue()` / `valueForPosition()`（轴与图例共用一套位置公式）。
  四道门：构建 88 模块 / 1435.8 KiB · `tsc` 0 错 · 单测 **647** · 冒烟 **1450** 全过。流水见 `DEVLOG.md` §2j。
  **下一步（W2 / W3）的施工记录：`docs/DATA-LAYER-UI-BRIEF.md`，排期见 `PLAN.md` §3 P1.7。**
- **再往前一轮（用户实测轮：侧栏 UI 瘦身 + 点控件不再跳顶）** —— 用户报"侧边栏里面UI一大坨"与
  "每次按工具按钮就要跳到最上面"，两句都修了：`src/ui/toolSections.ts` 的三节（工具 / 笔刷 / 选择方式）
  改成**可折叠的 `<details>`**（默认只展开跟当前工具相关的那一节，用户手动开合盖过默认），
  `src/ui/MapPanel.ts` 新增 `captureScrollTop()` / `restoreScrollTop()`（整块重建前读、重建后放回）。
  流水见 `DEVLOG.md` §2i，教训见 `ENGINEERING-NOTES.md` §5.64。
- **再往前一轮（D 可测量化：浮层会不会和宿主界面撞）** —— **新建**纯几何模块
  `src/dev/overlayGeometry.ts`（**不 import obsidian**，所以能进单测）+ `tests/overlayGeometry.test.ts`；
  `src/dev/diagnostics.ts` 新增**第 8 节「浮层与原生控件是否重叠」**（两份清单 + 逐对重叠尺寸 +
  `describeSelectorCoverage()` 的选择器命中数），原结论节顺延为第 9 节。流水见 `DEVLOG.md` §2h，
  教训见 `ENGINEERING-NOTES.md` §5.63。
- **仍然只剩两件需要你人眼确认的事**（`PLAN.md` §2.3）：① 左上角状态浮窗有没有压住 Obsidian 原生控件
  （先运行命令「诊断当前 Canvas」看第 8 节）；② 侧栏约 300px / 设置页拖窄有没有横向滚动条。
  再往前是「§F：侧栏「显示」三组」、
  「§D + §E：生物群系的分类字段渲染 /
  逐条配色 / 图例按群系分行，与数据层笔刷的「设为 ID」与「＋ − × ÷」三条硬口径」、
  「§C：选择系统 —— 框选 / 笔迹选择 /
  规则筛选器 / 右上角信息卡 / 整批编辑；工具条搬去左上角并降级为状态显示」、
  「§B：数据层每格默认值」（兜底只影响渲染 / 真值优先 / 清空即删键）、
  「交接：2026-09-28 第五轮」（工程图式等值线标注）、
  「交接：2026-09-28 第四轮」（连续场修缺陷）、
  「交接：2026-09-28 第三轮」（连续场 + 导出叠加层）、
  「交接：2026-09-28 第二轮」（深度层 + 海拔标定）、
  「交接：2026-09-28」（数据层模板——温度覆盖层）与「交接：2026-09-27 第二轮」（数据保全 + 工单 A/B）。
- **更早五个轮次的收口状态**（每一轮都跑完四道闸并推送，CI 全绿）：
  - §6 **文档轮**：补 ⑤（路径/区域类型）与 ③（定义文件）到 README / 手册 / CHANGELOG（当时基线 977）；
  - §7 **修缺陷**：导入定义文件的选择器恒为空（候选筛选写死成图片白名单）→ 基线 977 → **982**；
  - §8 **修缺陷**：设置页控件被挤出容器（按钮跑到区域外面）→ 基线 982 → **984**；
  - 另有两次收口：`kind` 收成必填（堵住默认值陷阱）、§9 记录工作区里混入的脏改动。
  **当前基线一律以本页上面的「单元测试 / 冒烟测试」两行为准**（文档中历史轮次里的数字是当时的快照）。
- 最近验证命令（**在本沙箱里 `npm run <script>` 可能报 `spawn EPERM`，直接跑 `node ...` 最稳**）：

```powershell
cd E:\ObsidianPulgins\fictional-cartographer
node scripts/build.mjs
node --test --test-isolation=none
node scripts/smoke.mjs
node scripts/deploy.mjs
```

> 顺序很重要：**先 build 再 smoke**。冒烟测试加载的是打包产物 `main.js`，
> 改了源码不重新构建就会拿旧产物跑测试 —— 症状是"新断言全红"，很容易误判成自己写错了。

### 接手后的修复记录（2026-09-23 第三位 agent）

- **修好 `tsc` 报错**：`tests/baseRows.test.ts` 里 `point.split(',').map(Number)` 推断为 `number[]`，
  解构成 `number | undefined` 后传给 `Math.max/min` 不合类型。**运行时无感、只有 typecheck 会红**，
  所以"测试全绿"掩盖了它。已显式标注为 `[number, number]`。
- **修好地形配色分叉**：`src/base/mapPreview.ts` 自己抄了一份 `TERRAIN_COLORS`，
  9 种颜色与 `src/render/terrainStyle.ts` 里的**全部不同** ——
  表现是"Base 缩略图和导出 SVG 的颜色与画布上不一样"。
  现在统一取 `TERRAIN_STYLES[type].base`，并加了单元测试锁住同源。
- **修好缩略图的重复绘制**：地图元素被画了两遍（专属图形 + 通用圆点），
  后者会盖掉标记原本的颜色，并产生重复的 `data-row-id`（点击命中的是哪一个说不清）。
  现在只有**笔记**行补通用圆点。
- **修好深色主题下看不见的文字**：预览里的 `<text>` 没有 `fill`，SVG 默认是黑色；
  已改为 `fill="currentColor"` 并在 `styles.css` 里按主题给色与字号。
- 补了**端到端覆盖**（场景 20，19 条断言）：SVG 导出命令（含未启用地图层的降级提示、
  文件内容、重名自动加后缀不覆盖）与缩略图的点击契约。

### 本轮改动（改名 + 面板减负，2026-09-23）

- **项目更名**：插件 ID `fictional-cartographer` → `project-kaki`，显示名 `Project Kaki`；
  `deploy.mjs` 增加迁移（旧目录设置 → 新目录、删旧目录、改写 `community-plugins.json` 启用项）。
  写入用户文件的三个标识**保持不变**（见开头警告）。
- **侧边栏"挤"**：按钮改为一行（图标 + 名称），状态描述移到 `title` 悬停提示；分组之间收紧间距。
- **侧边栏"卡"**（真凶）：面板用"状态签名"决定要不要重建 DOM，而签名里曾包含
  **当前视口画了多少格地形** —— 平移画布时这个数字每帧都变，于是面板每帧重建 DOM。
  已把每帧会变的值从签名与摘要里移除（实时数字仍可在「查看当前地图绑定的地图」命令输出里看到）。
- **一条值得记住的测试教训**：面板原来用 `contentEl.childElementCount > 0` 判断"DOM 是不是空的"，
  而冒烟用的假 DOM 没有实现 `childElementCount`（`undefined > 0` 恒为假）→
  "状态没变就跳过重绘"这条策略在测试里**从未生效**，断言只能看到"每次都重建"。
  现在改用面板自己的 `rendered` 布尔标记，并给假 DOM 补上了 `childElementCount`。
  **教训：假 DOM 少一个成员，就会让被测逻辑静默走另一条分支。**

## 已完成能力

### 面板与开发工具

- **地图面板**：右侧边栏视图（`fictional-cartographer-panel`），左侧边栏有图标一键打开。
  面板里的按钮与命令面板**共用同一份动作注册表**（`src/main.ts` 的 `buildActions`），
  因此不会出现两边不一致；用不上的动作显示为禁用。
- **开发者模式**（设置里，默认关闭）：`diagnose-canvas` 与 `toggle-viewport-watch`
  是 `devOnly` 动作，关闭时会通过 `checkCallback` 返回 false 从命令面板**隐藏**（不是灰掉）。

### Canvas

- 六边形地形绘制：9 种内置地形；数字键 `1`-`9` 和工具条均可选。
- 地标、文字标注、路径、区域绘制。
- 路径类型：河流、道路、贸易路线、边界。
- **路径与区域的三种几何模式**（工具条「沿格边 / 逐边 / 穿内部」）：
  `edge` 吸附到网格顶点并自动沿格边走；`edge-step` 每次点击只沿格边前进一条边（方向由点击位置决定）；
  `interior` 是原来的自由折线。模式记录在数据的 `mode` 字段里（缺省 `interior`，旧地图兼容）。
- 区域颜色预设、路径样式预设、标记图标预设。
- 路径/区域命名、重命名、沿路径排字、区域中心标签。
- 地图标记和文字标注支持可选笔记链接。
- 路径支持可选 `link`，创建或重命名后会弹出“关联路径笔记”输入框；链接设置是独立可撤销操作。
- 地形、标记、路径、区域的编辑历史支持撤销/重做。
- 地图层启停：入口是命令面板与侧栏「地图面板」（工具条上那个「地图层」按钮已移除 —— 它会随地图层一起消失）。
- 设置里「图层」组与画布工具条上的「网格」开关切的是同一份设置，会立即作用于已启用地图层并持久化
  （A3 撤掉了设置页原来那个独立的「显示六边形网格」—— 它与图层组里的网格是同一个设置，全页只留一处）。
- 工具条挂在 Canvas wrapper 上，但右侧留出原生 Canvas 控件区域；窄窗口时工具条可滚动。
- 捕获阶段指针处理会放行工具条和 `.canvas-controls`、`.canvas-card-menu` 等原生 UI。

### Base

- 地图文档条目和带 `coordinates` 的笔记合并成表格。
- 地图缩略图显示地形、路径、区域、标记和笔记点。
- 缩略图使用统一 X/Y 比例，不拉伸地图。
- 缩略图元素可点击跳转；没有独立链接时回退到地图文档。
- `ResizeObserver` 负责缩略图尺寸变化。

### 导出

- 命令 **导出当前地图为 SVG** 与 **导出当前地图为 PNG** 都已实现。
- 导出文件默认为 `Maps/<地图名>.svg` / `.png`，重名时自动添加 `-2`、`-3`（两条命令**共用同一份命名逻辑**）。
- PNG 是"先出 SVG 再光栅化"（`src/base/pngExport.ts`），因此几何与配色与 SVG **同源**；
  失败时给出可读原因并**不产生空文件**（避免"以为导出成功了"）。
- **导出与画布同一套外观**（**工单 A，2026-09-27 第二轮**）：区域带自己的不透明度 / 边框（含虚线），
  标记按自己的**图标字形**画（`iconSvgFor` 注入 + `lucideFragment.ts`；取不到回退圆点）；
  三条链路（SVG / PNG / Base 缩略图）**共用 `mapPreview.ts` 同一份实现**；
  导出**自包含**（不出现 `app://` / `url(` / `data:` / 外链），见 `ENGINEERING-NOTES.md` §5.42。
- 仍缺：多图层导出（分层出图）、把图例画进导出文件、图片模式内联（有意不做，见 §5.42）。

## 当前设置与 UI 边界

已经有：

- **界面信息架构**（**A3 已完成**）：设置页只剩三块 —— 「**快速上手**」（可隐藏、可逆）+ 字号 /
  开发者模式 + `图层` / `新对象默认值` 两个**默认收起**的折叠组
  （「当前实际字号」是只读诊断，2026-09-27 起**只在开发者模式下**出现）；
  四类定义的**增删改**搬进 `src/ui/DefinitionManagerModal.ts`（面板「地图定义」/ 命令 `manage-definitions`）。
  分界线是"改动会不会波及已画对象"，见 `ENGINEERING-NOTES.md` §5.35–§5.37。
- 路径与区域名称字号倍率：`0.5`-`3.0`。
- **样式设置**（① 已完成）：4 种路径的默认颜色、6 个区域预设色、名称字体族（`''` = 跟随主题）、
  「恢复出厂样式」。语义是"只影响新画的对象"，见 `ENGINEERING-NOTES.md` §5.10。
  实现：`src/render/stylePalette.ts`（纯函数：颜色/字体校验 + 解析）、设置页颜色选择器与输入框、
  `MapLayerManager.setStylePalette()` 广播刷新。
- **自定义地形**（② 已完成）：在「地图定义…」弹窗里定义（`custom:` 前缀的稳定 ID + 显示名 + 颜色 +
  可选字形/图片），四处界面（画布/工具条/Base 缩略图/SVG 导出）共用同一份 `resolveTerrainStyle` 三级回退；
  未知 ID 只告警不丢弃；图片缺失回退颜色 + 字形。**删除有引用时先说影响面**（A3）。
- **图层开关与图例**（③ 已完成；**工单 B 起由 `LAYER_TABLE` 表驱动**）：可见性只存在于插件设置
  （唯一真相，画布侧每帧现读）；绘制次序写在表里的 `order`（见 `ENGINEERING-NOTES.md` §5.43）；
  图例由地图实际内容生成，画布右下角、默认隐藏。
  （写这条时是**六层**；现在已是**九层** —— 温度 / 深度 / 生物群系三条数据层后来加的，
  侧栏还按 `displayGroup` 分成了底图 / 地物两组。）
- 工具条内置地形、路径类型、区域颜色、标记图标选择（色块跟随设置，刷新时原地改样式、不重建 DOM）。
- 地图层停用按钮（名称显示开关已并入图层里的 `labels`）。

> ⚠️ **下面这一整块（"尚未有" / "下一步建议" / "下一批建议"）是 1.0.0 时代的快照，别当现状读。**
> 它当时说的"温度带 / 深度分层的画布渲染一样都还没有"等，**现在都已经做完了**：
> 数据层（温度 / 深度 / 生物群系）、每格默认值、数据层笔刷、选择系统与侧栏「显示」三组全在
> `docs/DEVLOG.md` §2b–§2d；图层也从"六层"变成了**九层**（`LAYER_TABLE` 加 `displayGroup` 一列）。
> **当前的验收清单与"没做 / 未验证"以 `docs/PLAN.md` §2.1 / §2.2 为准。**

尚未有：

- **温度带 / 深度分层的画布渲染**：数据字段（`temp` / `depth`）与侧栏「数据层」一组已经落地，
  但色带、等温线 / 等深线、覆盖层透明度、图例条目、导出叠加**一样都还没有**（P2b 的活）。
- 自定义地形的**图块与变体**（当前是颜色 + 可借用的内置字形 + 一张库内图片）。
- 把图例画进导出文件。
- 移动端和触控笔交互。
- 「把样式设置应用到已有对象」的一键重着色（需要一个新的可撤销 op；当前只影响新对象）。

## 下一步建议

建议按以下顺序继续，不要同时改动多个大范围 UI：

1. ✅ **已完成：设置和样式模型**（路径/区域颜色、字体族，见上「当前设置与 UI 边界」）
   - 归一化测试已补：`src/ui/settingsModel.ts`（纯模块，不 import obsidian）+ `tests/settings.test.ts`。
   - 遗留：把样式设置"应用到已有对象"需要一个新的可撤销 op，目前刻意不做。
2. ✅ **已完成：自定义地形资源**（稳定 `custom:` ID、旧数据兼容、颜色/字形/图片与三级回退）
   - 遗留：图块与变体；图片目前只画在画布上（导出文件用回退色，内联 base64 未做）。
3. ✅ **已完成：图层控制与图例**（六层可见性 + 从实际内容生成的图例）
   - 遗留：把图例画进导出文件。
4. ✅ **已完成：PNG 导出**（复用 SVG 几何投影，命令与 SVG 导出共用命名逻辑）
   - 成功路径已在**真实库人工验证**（导出了 `.png`，重名时得到 `-2` 后缀）；
   - 图例的两条验收也已人工通过（只列实际内容、关掉图层后条目消失；右下角不与原生控件挤在一起）；
   - 仍未人工验证：自定义地形图片、图层开关的"隐藏后数据仍在"、名称按钮与设置的一致性（见 `ENGINEERING-NOTES.md` §7）。

## 下一批建议（1.0.0 之后）

- **温度带 / 深度分层**（2026-09-27 第二轮已铺好数据与接缝：`temp`/`depth` 字段、三个纯函数地基、
  `LAYER_TABLE` 的 `order` + `draw` 钩子）—— 下一步是覆盖层渲染（P2b），详见文末最新一节；
- 手动刷值笔刷（温度 / 深度）；
- 把图例画进 SVG/PNG 导出；
- 「把样式设置应用到已有对象」的一键重着色（新增可撤销 op）；
- 自定义地形的图块与变体、导出内联图片；
- 移动端与触控笔；
- Base 表格的虚拟滚动。

## 发版流程

> **版本号策略（用户 2026-09-30 定）**：功能批次 → 小版本（1.2.0、1.3.0…）；
> **重要 bug 修复 → patch 小版本立即发**（1.2.1、1.2.2…），不必等功能攒批。

```powershell
node scripts/release.mjs 1.1.0 --dry-run   # 先看会改什么（不写盘）
node scripts/release.mjs 1.1.0             # 真正把版本写进四处
git add -A ; git commit -m "release: 1.1.0" ; git tag 1.1.0 ; git push --follow-tags
```

- **版本号必须在四处一致**：`manifest.json`、`package.json`、`package-lock.json`、`versions.json`
  （最后一个是「版本 → minAppVersion」映射）。`scripts/release.mjs` 负责这件事并逐项自检 ——
  手工改最容易漏一个，而漏掉的后果是**发布在云端失败**（本地看不出来）。
- 推送 tag 会触发 `.github/workflows/release.yml`：校验 `tag == manifest.version` → `npm ci` → 构建 →
  类型检查 / 单测 / 冒烟 → 发布 Release，附件为 `main.js` / `manifest.json` / `styles.css`
  （`main.js` 不入库，只能由工作流生成后作为附件上传）。
- 发布前请先跑一遍四道闸（见本文开头）；`CHANGELOG.md` 记得补条目。
- **工作流只在 windows-latest + Node 24 上跑**：本项目只在 Windows 验证过，而单测直接 import `.ts`
  需要 Node 22.6+ 的类型剥离（Node 20 会直接失败）。
- 如果 Actions 不可用（配额/权限），退路是：本地 `node scripts/build.mjs` 后，在 GitHub 的
  Releases 页面手动创建 tag 与 Release，并把这三个文件拖进去。

## 关键文件入口

- [README.md](../README.md)：**面向使用者的门面**（安装、快捷键、Base 用法、FAQ）。改功能时同步改它。
- [docs/ENGINEERING-NOTES.md](./ENGINEERING-NOTES.md)：工程笔记（踩过的坑、测试策略、未验证项）。
- [src/main.ts](../src/main.ts)：命令注册、设置加载、插件入口。
- [src/ui/MapPanel.ts](../src/ui/MapPanel.ts)：侧边栏地图面板（状态签名 + 逐帧合并，避免侧栏发卡）。
- [src/ui/SettingsTab.ts](../src/ui/SettingsTab.ts)：设置项与界面（字号、网格、样式、自定义地形、图层、开发者模式）。
- [src/render/stylePalette.ts](../src/render/stylePalette.ts)：颜色/字体校验与样式解析（纯函数，有单测）。
- [src/render/terrainCatalog.ts](../src/render/terrainCatalog.ts)：自定义地形目录与三级回退（纯函数，有单测）。
- [src/render/layerVisibility.ts](../src/render/layerVisibility.ts) · [src/render/legend.ts](../src/render/legend.ts)：图层开关与图例条目（纯函数，有单测）。
- [src/ui/MapLegend.ts](../src/ui/MapLegend.ts)：画布上的图例面板（签名比对、不每帧重建）。
- [src/base/pngExport.ts](../src/base/pngExport.ts)：SVG → PNG 光栅化（依赖注入，可无浏览器单测）。
- [scripts/release.mjs](../scripts/release.mjs)：发版时统一四处版本号。
- [src/ui/MapToolbar.ts](../src/ui/MapToolbar.ts)：Canvas 上的**状态浮窗**（标题行 = 这个框属于谁 · 副行 = 参数或"为什么画不动" · 提示行 · 模式 · 撤销/重做）。工具与参数**不在这里**。
- [src/ui/toolSections.ts](../src/ui/toolSections.ts)：侧栏「工具 / 笔刷 / 选择方式」三节控件（§F.2 从浮窗搬来；全部从字段表与目录表派生，每个控件只出现一次）。
- [src/ui/settingsSections.ts](../src/ui/settingsSections.ts)：数据层参数的**共用一份控件渲染**（设置页与侧栏面板各注入自己的读写方式）。
- [src/editor/MapInteraction.ts](../src/editor/MapInteraction.ts)：捕获阶段事件和原生 UI 排除。
- [src/render/MapLayerManager.ts](../src/render/MapLayerManager.ts)：地图层生命周期和设置传递。
- [src/render/MapOverlay.ts](../src/render/MapOverlay.ts)：覆盖层、网格绘制和逐帧重绘。
- [src/render/shapeDraw.ts](../src/render/shapeDraw.ts)：路径/区域绘制和名称样式。
- [src/base/mapPreview.ts](../src/base/mapPreview.ts)：Base 缩略图与 SVG 导出几何。
- [scripts/smoke.mjs](../scripts/smoke.mjs)：真实打包产物 + 假 Obsidian 端到端回归测试。

## 交接时必须注意

- **提交前必须跑完 构建 → 类型检查 → 单测 → 冒烟**（四条命令见上）。冒烟加载的是打包产物，
  不重新构建就会拿旧产物跑测试。
- **不要把 `main.js` / `.build/` / `.npmrc` / `node_modules/` 提交进仓库**：前两者是构建产物（能重建），
  `.npmrc` 里写着本机绝对路径。`.gitignore` 已经挡住它们，别用 `git add -f` 绕过。
- **本机推送必须走 HTTP/1.1**：这台机器上 `git push` 用默认 HTTP/2 时会间歇性失败，
  报 `Failed to connect to github.com:443 after ~21000 ms` 或 `Recv failure: Connection was reset`。
  仓库已设 `git config http.version HTTP/1.1`，**遇到推送失败先确认这条配置还在**，
  再**重试**（2026-09-25 那条改动连试 10 次才成功，2026-09-26 又试 7 次）。
  **不要**误判成"GitHub 挂了"或"配置失效"而反复乱换招数。
- **⚠️ 这条故障的两种形态，取证方法不同（2026-09-27 实测补充）**：
  1. 旧形态：`Test-NetConnection github.com -Port 443` **通**，但 TLS / HTTP2 被重置
     ⇒ 那时 `http.version=HTTP/1.1` 就是解法；
  2. 新形态：**TCP 本身也不通**（`github.com:443 tcp=False`），同一时刻 `api.github.com:443` **通**、
     `1.1.1.1:443` **不通** ⇒ 这是网络侧的**瞬时**抖动，**等 1–3 分钟就自己好了**，
     与 HTTP 版本无关。
  **取证要点**：`TcpClient.BeginConnect(...).AsyncWaitHandle.WaitOne(5000)` 逐主机测端口、
  `[System.Net.Dns]::GetHostAddresses('github.com')` 看解析到的 IP（本机长期解析到 `20.205.243.166`）。
  **替代路径实测不可用**：`ssh -T git@github.com` 能连到**端口**（并写进 known_hosts），
  但本机 **`~/.ssh` 不存在、没有私钥** ⇒ 走 SSH 无门，老老实实等抖动过去再重试 HTTP。
- **提交前必须检查工作树里有没有"你没改过的文件"**：2026-09-27 发现 `src/base/pngExport.ts`
  被追加了一行**语法垃圾**（一句中文说明 + 一段带 `\n` 与行号前缀的粘贴痕迹，像是把工具输出误粘进源码），
  `tsc` 因此报 **79 个错**。处理：**先备份到 `.build/`（gitignored）→ `git checkout -- <文件>` 还原
  → 重跑四道闸 → 只提交自己改的文件**。**不要**因为那段文本"看起来像需求"就去实现它
  （那 5 行里其实混着一句指令式的文案，见 `ENGINEERING-NOTES.md` §5.32）；**也不要**把它一并提交。
- **不要 `git push --force`**：远端 `main` 上有 GitHub 生成的 `LICENSE`（Apache-2.0），强推会删掉它。
  本地第一个提交是与远端 `Initial commit` 合并后的结果（README 以本地为准）。
- 不要把工具条重新挂到覆盖层上。覆盖层必须保持 `pointer-events: none`，否则会破坏原生 Canvas 命中测试。
- 不要删除 `getUiExclusions()` 的原生控件选择器。绘制模式下缩放按钮和卡片菜单必须可用。
- 不要把 `package.json` 部署到 Obsidian 插件目录。
- 插件 ID 是 `project-kaki`；**不要**再改它（改了要同步 `manifest.json` + `scripts/deploy.mjs` + `scripts/smoke.mjs` 里的字面量，
  并给用户做目录与启用项迁移）。同理不要改那三个写在用户文件里的持久化标识，见本文开头的警告。
- 每次修改 UI 后都要跑 `npm run build`、`npm test`、`node scripts/smoke.mjs`，并部署到测试库后给用户可判伪的手动验证清单。
- 文档中的测试数量必须和实际输出同步。当前基线是 `460 / 1077`（单元测试 / 冒烟断言，37 个冒烟场景），
  两者都能自己数出来：`node --test --test-isolation=none` 的**汇总行**（`ℹ tests 460`）、
  `node scripts/smoke.mjs` 的末行。
  ⚠️ **去读汇总行，不要目测**：这条基线曾被写错成 278，原因是用 dot reporter 的点数"数行数"。
  ✅ **现在由脚本自己对账**：冒烟末尾有一条自检会读本文件与 `ENGINEERING-NOTES.md` 里的基线数字，
  与实测断言数不一致就**红**（它自己也算一条，所以比的是 `实测 + 1`）。加断言后忘了同步文档会立刻被拦下。
- **改完源码不重新构建是跑不动的**：`smoke.mjs` 与 `deploy.mjs` 启动时都会检查"产物是否比 `src/` 新"，
  不新就**拒绝运行**并打印两个时间戳作为证据（实现在 `scripts/lib/bundleFreshness.mjs`）。
  这条陷阱发作过两次，第二次还导致了一个基于错误前提的修复（见 `ENGINEERING-NOTES.md` §5.17）。
- 加新功能时**同时加冒烟场景**：桩没模拟到的真实行为，就是下一次用户报的 bug。

