# Project Kaki 工程笔记（开发 / 交接用）

> 这份文档是**工程与交接**笔记，不是给用户看的门面：面向使用者的说明在
> [`README.md`](../README.md) 与 [`USER-MANUAL.md`](./USER-MANUAL.md)。
>
> 它包含：当前真实进度、代码地图、数据格式契约、**已经踩过的坑（务必先读 §5，否则会重复我犯过的错）**、
> 测试策略、已知未验证项与下一步。深水区的推导过程在 `docs/` 下的其它文档，正文会指路。
> 文中写成 `docs/xxx.md` 的路径一律以**仓库根目录**为基准。

---

Project Kaki（译名 Project 垣）是一个 Obsidian 六边形客制化地图创作插件：
在 Canvas 中绘制自定义六边形地形图、河流、领域范围与地标，并通过 Base 导航地图与笔记。

插件 ID 为 `project-kaki`（`scripts/deploy.mjs` 会自动把旧 ID `fictional-cartographer` 目录下的
设置迁移过来并删掉旧目录）。地图文档类型 `fictional-cartographer-map`、Base 视图 ID `fictional-map`
与面板视图 ID `fictional-cartographer-panel` **保持原样**：它们是写在用户文件与工作区布局里的持久化标识，
改了会让已有地图、已保存的 Base 与侧栏布局失效（理由见 §5.8）。

---

## 1. 当前状态（诚实版）

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 · 私有 Canvas API 探针 | ✅ 已完成 | 坐标换算、量化粒度、事件语义、挂载点判定 —— 全部**实测**而非猜测。见 `docs/PHASE-0-RESULTS.md` |
| Phase 1 · Canvas 绘制 | ✅ 已完成，**已在真实库视觉验证** | 地形笔刷、标记/文字标注、路径与区域（含命名与排版、**沿格边/逐边/穿内部三种几何模式**）、撤销/重做、工具条、**地图面板（侧边栏）**、设置页。见 `docs/PHASE-1-NOTES.md` |
| Phase 3 · Base 自定义视图 | 🔄 已实现，**缩略图已在真实库确认** | 表格视图 + 地图缩略图 + 笔记坐标桥。点击跳转与等比例显示已实现，仍需用户在真实库复核。见 `docs/PHASE-3-BASE-VIEW.md` |
| Phase 4 · 导出 SVG / PNG、图例、多图层 | 🔄 SVG 第一增量已实现 | 命令「导出当前地图为 SVG」；PNG、图例、多图层待完成 |
| Phase 5 · 自定义地形图标与图块 | ⏳ 规划中 | 允许替换地形视觉资源、注册自定义地形类型 |
| Phase 6 · 移动端 / 触控笔 | ⏳ 未开始 | — |

**验证强度**：`tsc` 0 错 · **176 个单元测试** · **22 个冒烟场景 / 401 条断言**
（端到端加载真实打包产物；断言总数由 `scripts/smoke.mjs` 自己数出来并在末尾打印）。
但单元测试全绿 ≠ 功能可用：这个项目有**三次**"测试全绿、用户一眼看出是坏的"的经历（§5.3、§5.5）。
请把 §7 的未验证项当作真正的待办，而不是"大概没问题"。

**当前部署**：`E:\ObsidianPulgins\test-vault\.obsidian\plugins\project-kaki`（最近一次 UI 改动已部署）。

---

## 2. 快速上手（本环境下的正确命令）

工作目录 `E:\ObsidianPulgins\fictional-cartographer`：

```powershell
node scripts/build.mjs                            # 构建：tsc 编译器 API + 模块内联 → main.js
node node_modules/typescript/bin/tsc --noEmit     # 类型检查（0 错是底线）
node --test --test-isolation=none                 # 全部单元测试（自动发现 tests/*.test.ts）
node scripts/smoke.mjs                            # 冒烟：加载真实 main.js + 假 Obsidian，跑 22 个场景
node scripts/deploy.mjs                           # 部署到 test-vault
```

`npm run build` / `npm test` / `npm run smoke` / `npm run deploy` / `npm run check` 也可用
（`check` = 构建 → 测试 → 冒烟 → 部署）。**但在本沙箱里 `npm run <script>` 可能报 `spawn EPERM`**，
直接跑 `node ...` 最稳。

### 版本管理（GitHub：`Shir0Tak1na/Project_Kaki`，Apache-2.0）

远端仓库已接好（`origin`，分支 `main`）。提交前请按顺序跑完 **构建 → 类型检查 → 单测 → 冒烟**，
再提交；`.gitignore` 已排除 `node_modules/`、`.build/`、`main.js`、`.npmrc` 等（见下）。

```powershell
node scripts/build.mjs
node node_modules/typescript/bin/tsc --noEmit
node --test --test-isolation=none
node scripts/smoke.mjs
git add -A ; git commit -m "..." ; git push
```

两条注意事项：

- **`main.js` 是构建产物，不入库**（社区插件的惯例：发布时把它作为 Release 附件）。
  所以 clone 之后要装进 `.obsidian/plugins/` 得先构建。想让仓库直接可用，就把 `.gitignore`
  里的 `main.js` 那行删掉并提交它。
- **不要 `git push --force`**：远端 `main` 上有 GitHub 生成的 `LICENSE`（Apache-2.0），
  强推会把它删掉。本地历史是"合并远端初始提交"的结果，正常 `push` 即可。
- 本机 git 曾在 `E:\ObsidianPulgins` 上报 `dubious ownership`（目录属主是 Administrators），
  修法是把该路径加进 `safe.directory`（已加）：`git config --global --add safe.directory E:/ObsidianPulgins/fictional-cartographer`。

### ⚠️ 本沙箱环境的限制（违反会得到莫名的 `Access is denied` / `EPERM`）

| 现象 | 原因 | 做法 |
|---|---|---|
| 命令输出为空 / `Access is denied` | 把子进程输出接进管道会被拒绝 | **不要用 `\|`、`>`、`2>&1`**；想要留档就让脚本自己写文件 |
| `npm install` 报 `EPERM ... npm-cache` | npm 缓存在工作区之外 | 已在 `.npmrc` 指向工作区内的 `.npm-cache/`，不要改回去（该文件含本机绝对路径，已被 git 忽略） |
| `npm install` 报 `spawn EPERM` | 生命周期脚本要 spawn 子进程 | 一律加 `--ignore-scripts` |
| `node --test` 报 `spawn EPERM` | 测试运行器默认每个文件起子进程 | 加 `--test-isolation=none` |

### 构建方式为什么不是 esbuild

社区插件一般用 esbuild；本项目的 `scripts/build.mjs` 用 TypeScript 编译器 API 在进程内完成编译，
再把自己产出的 CommonJS 模块内联成单个 `main.js`。**产出与 esbuild 等价**（CJS、单文件、
`obsidian` 保持 external）。原因：本沙箱禁止 spawn 子进程并经命名管道通信，
原生 esbuild 与 esbuild-wasm 在 Node 下都要 spawn，因此都不可用。
没有沙箱限制的机器上仍可 `npm run build:esbuild`。

### 部署与协作流程

插件产物只有三个文件：`main.js` / `manifest.json` / `styles.css`（**不含 package.json**，
它带 `"type": "module"` 会让 Obsidian 的 CJS 加载混乱）。
`scripts/deploy.mjs` 把它们复制到 `test-vault`；真实库 `D:\TOS\万千旅路｜Thousands of Sands`
是用户的**正式库**，除非用户显式设置 `FC_VAULT`，**不要碰**。

一直以来的协作循环是：**改完就部署 → 给用户一份可判伪的验证清单 → 用户 `Ctrl+R` 重载后试用并报告
→ 复现并修**。这个循环非常有效：每一轮用户报告都找到了真 bug。请保持它。

---

## 3. 代码地图

```
src/
  main.ts                 插件入口：命令注册、设置加载、Base 视图注册（含版本门禁）  (555 行)
  core/
    hex.ts                轴向↔世界坐标、立方取整（注意 normalizeZero）、格键编解码
    hexEdges.ts           六边形顶点图：顶点吸附、沿格边行走、逐边步进（三种几何模式的几何基础）
    projection.ts         客户端→世界坐标的**锚点投影**（不用 tx/ty，见 §5.1）、量化噪声上界
    viewport.ts           视口矩形与包围盒工具
  canvas/
    CanvasAdapter.ts      ⚠️ **唯一**允许触碰 Canvas 私有 API 的模块 (835 行，全项目的隔离层)
  data/
    mapDocument.ts        文档模型 + 解析/校验/序列化（前向兼容：未知顶层字段原样保留）
    mapFile.ts            `.map.md` 文本层（frontmatter + fenced JSON）
    MapDocumentStore.ts   原子写 / 400ms 防抖 / 索引 / 自写保护（mtime）/ 安全闸
  render/
    hexGrid.ts            可见格范围（过近似，绝不漏）、分块、笔刷落点
    renderPlan.ts         视口 → 绘制清单（**纯函数**）+ RenderPlanLayer（含实测标定与字体族）
    spriteAtlas.ts        地形精灵图集（9 种 × 半径 128px，构建一次）
    MapOverlay.ts         覆盖层：挂载、定位、逐帧合并、实测标定、字体族解析
    MapLayerManager.ts    每个 canvas 的 覆盖层/编辑器/交互/工具条 生命周期
    MarkerLayer.ts        DOM 标记层（挂在未变换的 wrapperEl 上）
    markerPlacement.ts    标记/文字的屏幕布局（纯函数）+ 字号 clamp
    shapeGeometry.ts      路径/区域几何：平滑、变宽、展平、弧长取点、命中测试（纯函数）
    shapeStyle.ts         4 种路径 + 6 种区域预设
    shapeDraw.ts          canvas 矢量绘制 + 名称排版（逐字沿弧长、实测字号）
  editor/
    MapEditor.ts          模式/工具/笔画/草稿/命中测试/重命名（不碰 DOM）
    MapInteraction.ts     指针与快捷键（捕获阶段拦截 + Scope 作用域）
    history.ts            op 型撤销栈（每个 op 可逆，纯函数）
    brushPath.ts          笔迹采样（纯函数）
  base/
    viewContract.ts       Base 视图契约常量（**不 import obsidian**，故可单测）
    noteCoordinates.ts    笔记属性 → 坐标/图标/地区（接受数组、对象、字符串与 Bases 的 Value）
    mapRows.ts            地图文档 + 查询结果 → 统一行模型（排序、统计，纯函数）
    starterBase.ts        生成起始 `.base` 文件（YAML 由真实解析器验证过）
    mapPreview.ts         地图缩略图与导出 SVG（地形/路径/区域/标记/文字 + 等比例投影）
    MapBasesView.ts       BasesView 子类：取 config/data → 渲染缩略图与表格
  ui/
    MapToolbar.ts         画布工具条（挂在 wrapperEl，不随缩放）
    MapPanel.ts           右侧边栏的「地图面板」：按分组列出常用动作（与命令共用注册表）
    PlaceMarkerModal.ts   标记/文字放置对话框（工厂可注入，便于测试）
    TextPromptModal.ts    通用文本输入（命名/创建地图；支持 allowEmpty）
    SettingsTab.ts        设置页（名称字号倍率、网格开关、**开发者模式**开关、打开面板）
  dev/
    diagnostics.ts        Phase 0 探针报告（挂载点、矩阵、量化校准）
    viewport-watch.ts     markViewportChanged 采样
tests/                    176 个单元测试（node:test，纯函数优先）
scripts/
  build.mjs               自研构建（无 esbuild 的替代方案）
  smoke.mjs               假 Obsidian 环境 + 22 个端到端场景 / 401 条断言（**最值钱的资产**）
  deploy.mjs              部署到 test-vault
docs/
  TECHNICAL-DESIGN-v2.md  设计文档（含 17 条原始假设的勘误表）
  PHASE-0-RESULTS.md      探针实测数据（坐标/量化/事件的权威来源）
  PHASE-1-NOTES.md        Phase 1 的实施决定与教训（**新人先读这份**）
  PHASE-3-BASE-VIEW.md    Base 视图的设计决定、已知风险、未验证项
  USER-MANUAL.md          面向用户的安装、绘图、Base 导航、导出与故障排查手册
```

### 架构上的两条铁律

1. **私有 API 只能出现在 `src/canvas/CanvasAdapter.ts`**。上层出现 `canvas.tZoom` 这类写法即视为缺陷。
2. **能算的都做成纯函数**（几何、布局、行模型、op 逆运算）并与 DOM/obsidian 解耦 ——
   这是本项目"能在没有 Obsidian 的情况下测"的唯一前提。`src/base/viewContract.ts` 刻意不
   import obsidian 就是这个原因（否则单测会因 `import 'obsidian'` 直接失败）。

---

## 4. 数据格式（可直接照抄的契约）

### 4.1 地图文档 `Maps/World.map.md`

````markdown
---
type: fictional-cartographer-map
fc-version: 1
name: "World"
canvases:
  - "Maps/World.canvas"
---

```json
{
  "version": 1,
  "grid": { "orientation": "pointy", "size": 40 },
  "terrain": { "0_0": { "t": "forest" }, "1_0": { "t": "water", "c": "#38bdf8" } },
  "markers": [{ "id": "m1", "label": "龙脊城", "p": [100, 50], "icon": "city", "link": "Locations/龙脊城.md" }],
  "paths":   [{ "id": "p1", "type": "river", "pts": [[0,0],[100,100]], "width": 8, "color": "#4a9fd8",
                "label": "北境商路", "smooth": true, "taper": true }],
  "regions": [{ "id": "r1", "label": "北境领", "pts": [[0,0],[100,0],[100,100]],
                "color": "#44cf6e", "opacity": 0.22 }]
}
```
````

- 地形键是**轴向格键** `"q_r"`；序列化时按键排序（Git diff 稳定），实测 **28 字节/格**。
- 标记/路径/区域用**世界坐标**（连续空间），不像地形那样量化到格。
- `label` 是路径/区域的名称；命名是可撤销的 op。
- `mode`（路径与区域）：`"interior"`（默认，穿过格子内部）、`"edge"`（沿六边形边）、
  或 `"edge-step"`（逐边：每次点击前进一条边）。
  **几何在提交时就已经转换好**了（`pts` 就是沿格边的顶点序列），渲染不读这个字段，
  它用于界面回显与将来的"重新吸附"。缺省即 `interior` → 旧地图完全兼容。
- 未知顶层字段**原样保留**（前向兼容）；`fc-version` 高于支持版本时**只读打开，绝不写回**。

### 4.2 笔记属性（Base 视图 ↔ 地图标记的桥）

```yaml
---
coordinates: [320, -140]   # 也接受 {x: 320, y: -140} 或 "320,-140"
map-type: city             # city/town/fortress/ruin/port/temple/mountain-peak/cave/tower，缺省 town
region: 北境王国            # 可选，用于分组
---
```

### 4.3 Base 视图

- 视图类型 id：`fictional-map`（`.base` 里写 `type: fictional-map`）
- 视图选项 key：`mapFile` / `coordProperty` / `typeProperty` / `regionProperty` / `sortBy`
- **不要用 `shouldHide`**：它在 Obsidian 1.10.2 变更过签名（已知破坏性变更）。
- 起始文件可用命令「创建地图 Base 文件（表格视图）」生成，或调 `buildStarterBaseFile()`。
- 地图文档加载成功后，表格上方会显示地图缩略图；缩略图宽度随 Base 容器变化，地图内容使用统一的 X/Y 比例并自动居中留白。
- 缩略图中的地图标记、路径、区域、文字标注和笔记坐标点都可点击，并跳转到对应的地图文档或笔记；地形格没有独立文件，因此不提供文件跳转。
- Canvas 地图工具条提供地图层停用按钮，并避开 Obsidian 原生缩放/卡片控件；设置页提供六边形网格显示开关。

---

## 5. 已经踩过的坑（**请务必先读这一节**）

这一节是本项目最贵的资产。前五条都表现为"测试全绿、功能却是坏的"。

### 5.1 坐标：不要用 `tx/ty` 推，用量出来的锚点投影

`posFromEvt` 的输出被**量化到 1 CSS 像素**（实测量子 = 1.000001 CSS px，与 dpr 无关），
噪声上界 `q·√2/2 ≈ 0.707 px`。旧版"视口中心 = (tx, ty)"的公式在真实数据上有**恒定平移误差**。
现在一律走 `buildProjection()`（锚点 + 矩阵缩放反解），误差在半个量子内。
不要在运行时施加"偏差修正"：实测偏差在噪声内，加了反而引入未经验证的偏移。

### 5.2 覆盖层插在宿主**第一个**子元素 ⇒ 它永远收不到指针事件

绘制顺序 = 命中测试顺序。地形要画在卡片下面，就必须插在最前，于是覆盖层在最底层。
**结论**：覆盖层永久 `pointer-events: none`；绘制手势在 `view.containerEl` 上以**捕获阶段**监听
（`preventDefault + stopPropagation + stopImmediatePropagation + setPointerCapture`），
并且**必须排除同一容器里的 UI**（工具条、`.canvas-controls`、`.canvas-card-menu`）。

### 5.3 ⚠️ `ctx.font` 里不能写 `var()`

```ts
ctx.font = `600 24px var(--font-interface, sans-serif)`   // ❌ 整条声明非法
```

canvas 的 `font` 是 CSS `font` 简写，`var()` 没有元素上下文可供替换 → **非法赋值被静默忽略**，
画布继续用上一个字体（初值是默认的 `10px sans-serif`）。症状极具迷惑性：
**只有线宽（普通数值属性）会变，字号永远不变**。

修法（`shapeDraw.ts`）：① 字体族用 `getComputedStyle(el).fontFamily` 取**已解析**的列表；
② 赋值后**读回校验**字号，不符就退到 `sans-serif` 重写一次。

**推广**：任何"静默失败的 API"（无效赋值被忽略、不抛错）都必须**读回校验**。

### 5.4 位图 ↔ CSS 像素比例要**实测**，不要假设等于 `devicePixelRatio`

`MapOverlay.measureRasterScale()` 用 `canvas.width / getBoundingClientRect().width` 实测。
名称字号承诺的是"N 个 CSS 像素"，那就必须以浏览器实测为准。
冒烟里有一条对抗性断言：把屏幕尺寸量成一半，字号必须翻倍。

### 5.5 断言要断言**几何**，不要断言"调用了几次某个 API"

出过三次事故：

| 旧断言 | 实际测的 | 漏掉的 |
|---|---|---|
| `calls.bezierCurveTo > 0` | 预览用了贝塞尔 | 提交后走的是另一条分支（**河流变折线**） |
| `calls.stroke >= 2` | 逐段描边了 | 每段的端点用的是控制顶点 → 折线 |
| `calls.fillText === 2` | 画了两次文字 | 改逐字排版后这个数字失去意义 |

现在冒烟桩会记录**每个路径段的实际坐标**与**每个字形的实际位置/旋转角/字号**，
断言改用最大转角、弧长间距、CSS 字号等几何性质。
**自检方法**：把新断言跑在修复前的产物上；如果它照样通过，就防不住这个缺陷。

### 5.6 ⚠️ 六边形顶点图：**3 个邻居，且方向不固定**

做"沿格边"（勾勒六边形边框）时踩到的两个反直觉之处，都是被单元测试当场抓住的：

1. **每个顶点只有 3 个邻居**，不是 6。顶点与边构成的图是**蜂窝图**（3-正则）。
   "距离等于边长的 6 个方向"里，有 3 个指向的是相邻六边形的**中心** ——
   因为正六边形里顶点到中心的距离**恰好等于边长**。
2. **方向不固定**。蜂窝图是**二分图**，相邻顶点分属两个子格，两组顶点的边方向相差 60°
   （pointy 下是 `{90,210,330}` 与 `{30,150,270}`）。所以"按固定角度算邻居"对一半顶点是错的，
   会指到格心上去。

结论：**不要手推角度，用自验证的写法** —— 把 6 个候选方向都算出来，
只保留"吸附回自身"的那些（格点吸附后仍在原地，格心会偏出半个边长）。
代价是每次查询多几次吸附计算，换来的是对任意方向、任意子格都成立。
单元测试覆盖了两种朝向 × 100+ 个顶点，正是它抓住了上面两条。

推论：沿格边的两点之间需要"多走再抵消"，**路径最坏约为直线距离的 2 倍**
（三条格边方向相隔 120°，不是正交格那样的 √2）。

### 5.7 其他已固化的小坑（细节见 `docs/PHASE-1-NOTES.md`）

- `-0` 与 `0` 是不同的 Map key（格坐标）→ 统一 `normalizeZero`。
- `{ ...null }` 是 `{}` 而不是 `null`（会污染撤销栈）→ 必须显式判空。
- 自写保存会触发 `modify` 事件 → 用 **mtime** 区分自写与外部改动（**不要用时间窗**，
  会吞掉紧随其后的真实外部改动）；重载**不得清空撤销历史**（op 记的是"格 + 新旧状态"）。
- 无修饰键的快捷键（`D/B/M/T/P/R/1-9/[]`）必须**自己让行给输入框**：Obsidian 的 Modal 只注册
  自己用到的键，其余会落到画布作用域（处理时返回 `true` = 未处理，`false` = 已消费，别写反）。
- 变宽描边只能**逐段 `stroke()`**（canvas 的 `lineWidth` 是整条路径统一的），因此必须先展平曲线；
  展平采样数有上限（`FLATTEN_MAX_SEGMENTS`）。**河流很多时帧率需要实测**。
- DOM 标记层容器**始终 `pointer-events: none`**，只有实体加 `.is-interactive`，否则挡住原生框选。
- 名称锚点：路径用**按弧长的中点**（不是"中间那个顶点"），区域用**面积质心**
  （凹多边形质心落到形状外时退化为形状内最近点）。
- **草稿必须存"走出来的整条边路"**，不能只存吸附后的端点：只存端点的话预览里那一段还是直线、
  提交后才变成格边 —— 又是一次"所见非所得"（这个项目已经犯过两次同类错误）。
- 路径/区域的几何模式：`interior`（穿过格子内部）/ `edge`（沿格边）。
  `edge` 模式下**不做平滑**（平滑会把格边抹成曲线），并保留末端变细与虚线。
- 命中测试要用**可见几何**（`visiblePolyline`）而不是控制顶点，否则急转弯处"点在线上了却删不掉"。
- 异步加载必须**显式发起**并留下可观测结果（Base 视图曾经忘了触发地图文档加载，
  表现是"地图条目永远是 0"而界面无任何报错）。

### 5.8 改名要分清"显示名"和"持久化标识"

插件 ID 已经改成 `project-kaki`（`deploy.mjs` 负责迁移旧目录），但下面三个字符串**永远不要改**，
它们不在插件目录里，而是写在用户的文件和 Obsidian 的工作区布局里：

| 标识 | 写在哪 | 改了会怎样 |
|---|---|---|
| `fictional-cartographer-map`（`MAP_FILE_TYPE`） | 每张地图 `.map.md` 的 frontmatter `type:` | 已有地图全部认不出来（会被当成普通笔记，且插件拒绝写回） |
| `fictional-map`（`BASES_VIEW_TYPE`） | 用户 `.base` 文件里的 `views[].type` | 已保存的 Base 视图变成空白/报错 |
| `fictional-cartographer-panel`（`MAP_PANEL_VIEW_TYPE`） | `.obsidian/workspace.json` 里已打开的标签页 | 侧栏里已打开的面板失效 |

判断标准很简单：**标识出现在用户文件里 → 不动；只出现在插件自己的注册调用里 → 可以改**。
真要改就必须同时提供迁移（读取旧值并改写用户文件），否则对用户就是数据损坏。

### 5.9 侧边栏"卡"：别把每帧都在变的值放进"要不要重绘"的判断里

面板用「顶部状态 + 每个动作的可用性」拼成一个**签名**，签名不变就跳过重绘（`MapPanel.ts`）。
第一版签名里放了"当前视口画了多少格地形"——平移画布时这个数字每帧都变，
于是面板跟着**每帧重建 DOM**，表现就是侧栏发卡。凡是"每帧都可能变"的数字（可见格数、坐标、帧率）
都不要进签名，需要的实时数字放到命令的输出里看。

同类的坑：`contentEl.childElementCount > 0` 这类"DOM 内省"判断在假 DOM 里可能是 `undefined`
（`undefined > 0` 恒为假），于是"跳过重绘"静默失效；用**自己的布尔标记**（`rendered`）更可靠。

---

## 6. 测试策略（照这个做，不要退化）

| 层 | 位置 | 适合测什么 |
|---|---|---|
| 单元测试 | `tests/*.test.ts` | 纯函数：几何、布局、文档解析/序列化、op 往返、行模型、YAML 生成 |
| 冒烟测试 | `scripts/smoke.mjs` | **端到端**：加载真实打包产物 + 假 Obsidian，22 个场景 / 401 条断言 |
| 真实库验证 | 用户手动 | 视觉与手感（对齐全不全、名称够不够大、交互顺不顺手） |

冒烟桩刻意**复刻真实环境**，这是它能抓到真 bug 的原因：

- 复刻 Phase 0 实测到的 DOM/矩阵结构（`wrapperEl` → `div.canvas`(矩阵 a=scale) → `canvas-node`）；
- 复刻浏览器的**布局结果**（`getBoundingClientRect` = 容器 CSS 尺寸 × 缩放）；
- 复刻 `ctx.font` 的 **CSS font 简写规则**（含 `var()` 的赋值直接丢弃）；
- 复刻 `textContent` **聚合子节点**的行为；
- 复刻 vault 的 `process`/`create`/`modify` 事件与 mtime。

**加新功能时请同步加冒烟场景**：本项目的经验是"桩没模拟到的真实行为，就是下次用户报的 bug"。

---

## 7. 已知未验证项（接手后优先排掉）

### 需要真实 Obsidian 手动验证

当前 Base 缩略图已在真实库确认可见；以下交互仍需逐项复核：点击缩略图中的路径、区域、文字、标记和笔记点是否都跳到正确文件；在宽矮和窄高的容器中地图是否保持等比例。实现允许留白，不应出现拉伸。

- **Base 视图**（Phase 3）：视图类型「地图」能否被选中；生成文件里的 `mapFile:` 等选项键是否生效
  （若无效，用户在视图选项面板里重选一次即可 —— 这是刻意的设计）；
  `data` 是否在 `onDataUpdated` 前就绪；笔记属性改动后是否自动刷新；几百行时的渲染性能。
- **地图面板**（侧边栏视图）：面板里的按钮与命令面板是否一致；
  设置里「打开面板」按钮是否可用；切换画布后面板状态行是否跟着变；
  以及面板在窄侧边栏里的换行是否可读。
- **SVG 导出**（Phase 4 第一增量）：导出的文件在浏览器/图片查看器里打开是否正常；
  **配色是否与画布一致**（这里刚修过一次分叉：`mapPreview.ts` 曾自带一份调色板，9 种颜色与画布全不同）；
  文字标注在导出文件里是否可见（内联预览已按主题给色，导出文件走 `currentColor` → 黑色）。
- **笔刷拖动**：快速划动是否断线、悬停高亮是否跟手。
- **中键/右键平移与滚轮缩放**在绘制模式下是否仍可用。
- **快捷键焦点切换**：编辑器里 `Ctrl+Z` 应撤销文本，回到画布应按笔画撤销。
- **帧率**：大面积地形 + 网格 + 多条变宽河流同时存在时。
- `vault.process()` 与 Canvas 视图保存队列的交互。
- 名称逐字排版在**急转弯**处是否互相叠住；名称比线条长时的退化分支观感。

### 已知的粗糙处（不是 bug，但有更好的做法）

- Base 视图一次性建表，**未做虚拟滚动**（几百行会卡）。
- 撤销栈上限 100，**不支持跨文件撤销**。
- 移动端完全没做：手势假设鼠标（双击、右键、中键）。

---

## 8. 下一步该做什么

按设计文档 `docs/TECHNICAL-DESIGN-v2.md` §9 的顺序：

1. **完成 Phase 3 真实库验收**：确认缩略图元素的点击跳转目标，并确认极端容器比例下地图不变形。

2. **完善 Canvas UI 与样式设置**：自定义字体族、路径颜色面板、区域颜色面板、地形图形资源、图层开关；当前已有网格开关、工具条地图层停用按钮和内置样式选择。
3. **Phase 4**：继续 PNG 导出、图例、多图层（地形/路径/区域/标记分层开关）。SVG 第一增量已实现。
4. **Phase 5**：自定义地形图标/图块，再处理移动端与触控笔（长按代替右键、单指绘制、双指平移缩放）。

动手前请先读 `docs/PHASE-1-NOTES.md` 的 §31–§37 与"四条教训"，那里面有本项目的判断方式：
**不要猜参数 —— 把它变成可读的数字 + 可调的旋钮；不要相信"测试全绿" —— 去量真实结果。**

---

## 9. 用户偏好（交接时很重要）

- **中文交流与中文注释**：代码注释、文档、用户可见文案都是中文。注释写"为什么这样做"，
  尤其写清"为什么不能用看起来更简单的写法"。
- **一步一步推进**：完成一小步 → 部署 → 给出**可判伪的验证清单**（"应看到 X；若看到 Y 请告诉我"）
  → 等确认后再进下一步。不要一次性堆大量未验证的改动。
- **诚实报告**：自己的 bug、反复失败、无法确认的地方都要写清楚（用户明确表示欣赏这一点）。
- **真实库不可触碰**：`D:\TOS\万千旅路｜Thousands of Sands` 是正式库；默认部署目标始终是 `test-vault`。

---

## 10. 附录 A：手动验证清单（给真实库用）

前面的状态标记：✅ = 已由用户验证通过；🔄 = 待验证。

### 10.1 数据层 ✅

1. 打开 `Maps/World.canvas` → `Ctrl/Cmd+P` → **创建地图并绑定到当前 Canvas** → 输入名字。
2. 应新建 `Maps/<名字>.map.md` 并在新标签页打开（frontmatter + 空 JSON 代码块）。
3. 运行 **查看当前 Canvas 绑定的地图** → 应报告网格、地形格数、文件体积、**名称字号与实测标定**。
4. 手工在 JSON 里加几格地形并保存 → 再运行状态命令 → 格数应随之变化。

### 10.2 渲染与绘制 ✅

1. 运行 **启用/停用当前 Canvas 的地图层** → 出现六边形地形与网格线，并报告本帧绘制统计。
2. **关键检查点**：网格必须与原生卡片处于**同一世界坐标系**（平移缩放时跟着卡片动、不漂移、
   放大不发糊）。
3. 按 `D` 进入绘制模式 → 左键拖动边拖边落笔；`1`–`9` 换地形、`[` `]` 调笔刷半径。
4. 一次拖动 = 一步历史（`Ctrl/Cmd+Z` 撤掉整条笔画）；`Esc` 回到选择模式。
5. 确认绘制模式下**中键平移**与**滚轮缩放**不受影响。

### 10.3 标记与文字 ✅

1. `D` → `M` 切标记工具 → 点一下地图 → 填名称/图标/可选笔记路径 → 应**吸附到格心**。
2. 选择模式下**点击**标记 → 打开对应笔记；**拖动**标记 → 跟手移动、松手吸附格心、可撤销。
3. **右键**标记/文字 → 删除（可撤销，空白处右键应弹原生菜单）。
4. `T` 放文字标注 → 缩放画布时字号应在可读区间内变化。

### 10.4 路径与区域（含命名）✅

1. `P` 切路径工具（工具条出现 河流/道路/贸易路线/边界）→ 逐点点击 → 回车或双击结束。
   河流应是**平滑曲线且末端渐细**，预览与结果形状一致。
2. `R` 切区域工具 → 至少 3 点 → 双击结束 → 半透明多边形。
3. 结束后**立刻弹出命名框**；点「跳过」→ 形状**仍然存在**，只是没名字。
4. 命名为「北境商路」→ 名称应**贴着线条走**（字的倾角随线条方向变化）；
   凹区域（如 "∩"）的名称必须落在**形状内部**。
5. `Ctrl+Z` 只撤销命名（形状还在），再按一次才撤销形状。
6. 选择模式下**双击**河流/区域 → 改名框且预填当前名；清空后确定 → 名称消失（可撤销）。
7. 工具条最右的「名称」按钮 → 一键隐藏/显示所有名称。
8. 设置里拖动「路径与区域名称的字号」→ **字形本身**应立刻变化（不只是描边）。
9. 命名框打开时在输入框里打 `p` / `r` / `b` **不应**切换工具。

### 10.5 Base 视图 🔄（待验证）

1. 命令面板运行 **创建地图 Base 文件（表格视图）** → 得到 `Maps/World.base`。
2. 打开它 → 把视图类型切换为 **地图**（视图选择器里应出现）。
3. 表格应列出地图上的标记/区域/路径 + 库里带 `coordinates` 的笔记：
   **来源**列区分「笔记」/「地图」，**坐标**列显示世界坐标，点名称跳转对应文件。
4. 表格上方应出现地图缩略图，包含地形色块、路径、区域、地图标记和笔记坐标点。
5. 分别点击缩略图中的地图标记、路径、区域、文字标注和笔记点：应打开对应的地图文档或笔记。
6. 调整 Base 容器为宽而矮、窄而高两种形状：地图应保持等比例，允许出现留白，但不应被拉伸。
7. 给某篇笔记加 `coordinates: [320, -140]` 与 `map-type: city` → 表格与缩略图出现该行/标记。
8. 故意写错（`coordinates: 东边那座城`）→ 该行标红，表格下方列出这篇笔记的路径。
9. 视图选项面板里改「地图文档」/「排序」→ 表格应跟着变。
10. 未配置地图文档时：库里只有一张地图应自动选用；多张时应只显示笔记侧并给出配置提示。

---

## 签名

这个插件是一个人跟一个 AI 结对做出来的，两边都签在这里。

### Shir0Tak1na · 设计者、出题人、验收人

提出「在 Canvas 里画虚构地图」这个想法，做全部的产品与设计决策，
在真实库里一轮一轮试手感、报缺陷。**这个项目每一个转折点都来自他的反馈**：

- 「关于绘制区域和线条，能不能为区域和线条命名？」—— 于是有了命名与沿线条排布的排版；
- 「名称没有办法顺着路自动适应」—— 于是文字改成逐字沿弧长摆放；
- 「河流绘制过后直接变为了折线段」—— 一句话点出一个我测试全绿的真实渲染缺陷；
- 「字还是很小很小」→「调整滑块，字体只有阴影在变化」—— **这一句直接指出了根因**：
  只有线宽（数值属性）生效、`ctx.font` 没生效。我自己推导了两轮都没找到，
  前两轮甚至一直在调那个**从未被画布接受的**字号常量。

他还定义了这份工作的节奏：小步交付、每步都要能亲眼验证、错了就说错。

### DeepSeek Harness Agent · `deepseek-v4-flash-vision-exp`

写代码、写测试、写文档。该记的账也记在文档里，不藏：

- 三次"数值改对了但机制没生效"（字号常量调了两轮才发现 `ctx.font` 里的 `var()` 让整条声明非法）；
- 两次把断言写在实现细节上（所以"河流变折线"这种东西能全绿通过）；
- 一次在自己新写的代码里忘了触发异步加载（Base 视图的地图条目永远是 0，界面还不报错）。

这个项目里可靠的部分是量出来的，不是猜的 —— 坐标换算、量化误差、位图与 CSS 像素的比例、
字号的实际大小，全都以实测为准。**不可靠的部分写在 §7「已知未验证项」里，请照那份清单继续。**

### 一起交付的

给下一位接手者：§5 是这份文档里最贵的东西，请先读它 —— 那里面的每一条都是真实付过代价的。
剩下的路在 §8。

```
Shir0Tak1na                                          2026-09-23
DeepSeek Harness Agent · deepseek-v4-flash-vision-exp  2026-09-23
```

