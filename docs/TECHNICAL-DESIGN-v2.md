# Project Kaki 技术方案 v2（修订版）

> 项目名为 Project Kaki（译名 Project 垣）。插件 ID 为 `project-kaki`；
> 但地图文档类型 `fictional-cartographer-map` 与 Base 视图 ID `fictional-map` 是写在用户文件里的
> 持久化标识，保持原样（README §5.8）。

> 本文档在 v1 设计方案基础上重写。所有关于 Obsidian 平台行为的断言都给出了可核查的来源；
> 凡是**没有**来源支持的推断，一律标 ⚠️ 并集中收录在 §11《待验证清单》，不得在实现中当作既定事实。
>
> 来源可信度分级：
> - **[官方]** Obsidian 官方 `obsidian.d.ts` / 官方文档 / 官方 JSON Canvas 规范
> - **[逆向]** 社区逆向类型包 `obsidian-typings`（其 README 自述"基于逆向，可能不准确或不稳定"）
> - **[实践]** 以真实发布插件的行为为证据（可运行即可信，但无契约保证）

---

## 0. 相对 v1 的修订摘要

| # | v1 的断言 | 核查结果 | 本方案的处置 |
|---|---|---|---|
| 1 | 「Obsidian 会保留 .canvas 未知字段」 | ✅ **成立，且有官方依据**：`canvas.d.ts` 的 `CanvasData` / `CanvasNodeData` / `CanvasEdgeData` 上都声明了 `[key: string]: any`，注释为 *"Support arbitrary keys for forward compatibility"* | 保留该能力，但**只用它承载"引用"而非"几何数据"**（见 §2 ADR-1） |
| 2 | 「.base 文件是 JSON，可用同样方式塞自定义字段」 | ❌ **错误**。`.base` 是 **YAML**（`filters` / `formulas` / `properties` / `summaries` / `views[]`） | Base 侧改为"视图选项指向地图文档"，几何数据不进 YAML（见 §7） |
| 3 | 「`canvasView.canvas` 访问底层 Canvas 实例」 | ⚠️ 存在但**非公开 API**，`obsidian.d.ts` 中没有任何 `Canvas` / `CanvasView` 类型 | 保留，但必须收敛进唯一的适配层 `CanvasAdapter`（见 §8） |
| 4 | 「Canvas 使用以视口中心为原点的坐标系」 | ❌ **描述错误**。Canvas 是普通无限世界平面；`tx/ty` 是世界空间中的**视口中心**，`tZoom = log2(scale)` | 统一以世界坐标建模，屏幕↔世界转换只走一个函数（见 §3） |
| 5 | 「通过 rAF 轮询获取缩放和偏移」 | 可行但次优。已发布插件用的是**补丁 `markViewportChanged` + 事件驱动** | 改为补丁驱动，rAF 仅作为补丁失败时的降级（见 §4.4） |
| 6 | 「地图数据写入 `.canvas` 自定义字段」 | 技术上可行（`draw-in-canvas` 就这么做，键名 `drawInCanvas`，走 `vault.read` → `JSON.parse` → `vault.modify`） | **默认不写 `.canvas`**：绑定关系写在**地图文档的 frontmatter**里，`.canvas` 保持零改动（见 §2 ADR-1） |
| 7 | Base 自定义视图注册"API 可能仍在完善中" | ✅ **API 已存在且有确定契约**（1.10.0 起）：`registerBasesView(id, {name, icon, factory, options})`；但选项子类型仍在变动（`shouldHide` 已于 1.10.2 变更签名） | Base 模式从"待定"升级为"可排期"，但仍需版本门禁与规避已知破坏点（见 §7） |
| 8 | 用 `canvas:node-creation` 之类事件挂钩 | ❌ 该事件**在逆向类型与 Advanced Canvas 中均不存在**。实际存在且仅有 4 个 `canvas:*` 事件 | 见 §1.4；不要引用未证实的事件名 |
| 9 | 地形以像素 `x/y + size` 存储 | 可行但脆弱：改网格尺寸即数据失配 | 地形量化为**六边形轴向坐标 `"q_r"`**（Hex Cartographer 同款做法），路径/区域保留世界坐标（见 §6） |
| 10 | 「Hex Cartographer 把地图数据以纯文本存储在 vault 中」 | ✅ 成立，但形态是**独立的 `.hexcartographer.md` 文件**（frontmatter + ` ```json ` 代码块） | 直接借鉴：本插件采用同构的 `.map.md` 地图文档（见 §2 ADR-2） |
| 11 | 「`zoom` 是缩放比例」 | ❌ **错误**（1.13.7 实测）：`zoom` 与 `tZoom` 数值逐位相同，是**别名**；线性比例在 `scale` 字段 | 一律用 `scale` 或变换矩阵的 `a` 分量 |
| 12 | 「中心公式可用于坐标换算」 | ❌ **实测不成立**：用它对照 `posFromEvt` 的偏差在世界尺度恒为 ~928（等于矩阵平移分量换算后）| 改为**锚点投影**（§3），原点不做任何推导 |
| 13 | 「挂载点 = 唯一带 transform 的元素」 | ❌ **判据错误**：卡片菜单与每个节点也带 transform | 判据改为"含 `.canvas-node` + 矩阵缩放匹配"（§4.1） |
| 14 | 「rAF 轮询 vs 补丁驱动」二选一 | ✅ 补丁可行，但**逐帧触发**：6 次手势 = 168 次回调 | 补丁驱动 + 逐帧合并 + 投影去重（§4.4） |
| 15 | 私有 API 是否够用 | ✅ 1.13.7 上**全部存在**，还多出 `setViewport` / `zoomToBbox` / `getViewportNodes` / `posFromClient` | 适配层能力齐备，Phase 1 可直接开工 |
| 16 | 「`posFromEvt` 是权威坐标来源」 | ⚠️ **需要限定**：它的输出被量化到 **1 个 CSS 像素**（实测量子 1.000001 CSS px，与 dpr 无关），无法提供亚像素精度 | 缩放取矩阵、原点多点标定、运行时用纯闭式原点（§3） |
| 17 | 「一次拖拽触发多次回调，必须逐帧去重」 | ❌ **解读错误**：回调是逐帧触发（每帧一次），有效变化占 89% | 性能要求改为"每帧重绘必须廉价"（§4.4） |

---

## 1. 已验证的平台事实（事实基线）

### 1.1 Canvas 视图与私有 Canvas 对象

来源：**[逆向]** [`CanvasView.d.ts`](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/canvas/CanvasView.d.ts)、[`CanvasViewCanvas.d.ts`](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/canvas/CanvasViewCanvas.d.ts)；**[实践]** [`@types/Canvas.d.ts`](https://raw.githubusercontent.com/Developer-Mike/obsidian-advanced-canvas/main/src/%40types/Canvas.d.ts)。

```ts
// 视图类型字符串字面量就是 "canvas"
const leaves = app.workspace.getLeavesOfType('canvas')
// 注意：延迟加载的叶子必须先排除，否则 view.canvas 不存在
const usable = leaves.filter(l => !requireApiVersion('1.7.2') || !l.isDeferred)
const view = usable[0].view as unknown as CanvasViewLike
const canvas = view.canvas   // 私有对象
```

`view.canvas` 上与本插件相关的成员（**均为逆向来源，非契约**）：

| 类别 | 成员 |
|---|---|
| 变换 | `tx`、`ty`、`tZoom`（`log2(scale)`）、`scale`（线性比例）、`zoom`（⚠️ **实测是 `tZoom` 的别名**，勿用） |
| DOM | `wrapperEl`、`canvasEl`、`moverEl`、`canvasRect`、`backgroundPatternEl`、`edgeContainerEl` |
| 数据 | `data`、`nodes: Map`、`edges: Map`、`nodeIndex` / `edgeIndex`（R-tree） |
| 生命周期 | `markViewportChanged()`、`requestFrame()`、`requestSave()`、`markDirty()`、`getViewportBBox()`、`getViewportNodes()` |
| 坐标 | `posFromEvt(event: MouseEvent): Position`、`posFromClient(pos: Position): Position`（**[实践]** 来源，签名来自 Advanced Canvas） |
| 视口操作 | `setViewport(tx, ty, tZoom)`、`zoomToBbox(bbox)`、`zoomToFit()` |

两处来源冲突，实现时**不得依赖**：`selection` 的类型（`Set<Selection>` vs `Set<CanvasElement>`）、`canvasRect` 的类型（自定义 `CanvasRectEx` vs `DOMRect`）。

### 1.2 `.canvas` 未知字段的保留性

**[官方]** [`canvas.d.ts`](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/canvas.d.ts) 在 `CanvasData`、`CanvasNodeData`、`CanvasEdgeData` 上都显式声明：

```ts
[key: string]: any;   // Support arbitrary keys for forward compatibility
```

这是本方案唯一需要的"官方许可"。但要注意三条边界：

1. **[官方]** [JSON Canvas 1.0 规范](https://raw.githubusercontent.com/obsidianmd/jsoncanvas/main/spec/1.0.md) 本身**没有**任何扩展性条款——可扩展性只写在 `canvas.d.ts` 里，不是格式规范的一部分。
2. **[实践]** Obsidian 的 Canvas 保存路径会**重新序列化**整个文档（不是原样回写）。
3. **[实践]** 这个重序列化曾经**写坏过文件**：当 file 节点的自定义属性值为对象/数组时，Obsidian 的自定义 stringifier 输出了尾随逗号导致 JSON 损坏，[论坛 #84698](https://forum.obsidian.md/t/canvas-file-corruption-if-file-node-has-custom-property-of-type-object-or-list/84698) / [advanced-canvas#82](https://github.com/Developer-Mike/obsidian-advanced-canvas/issues/82)，官方回复称 v1.7 修复。

**结论**：把"很重、很复杂"的几何数据放在一个已知会重写文件、且历史上写坏过文件的格式里，风险不对称。这直接导出了 ADR-1。

### 1.3 Bases 视图 API

**[官方]** [`obsidian.d.ts`](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)（`@since 1.10.0`）：

```ts
export abstract class BasesView extends Component {
  abstract type: string
  app: App
  config: BasesViewConfig
  allProperties: BasesPropertyId[]
  data: BasesQueryResult
  protected constructor(controller: QueryController)
  abstract onDataUpdated(): void
  createFileForView(baseFileName?: string, frontmatterProcessor?: (fm: any) => void): Promise<void>
}

export interface BasesViewRegistration {
  name: string
  icon: IconName
  factory: BasesViewFactory                       // (controller, containerEl) => BasesView
  options?: (config: BasesViewConfig) => BasesAllOptions[]
}

export class BasesQueryResult {
  data: BasesEntry[]                              // 已按用户排序/limit 处理
  get groupedData(): BasesEntryGroup[]
  get properties(): BasesPropertyId[]
}
export class BasesEntry { file: TFile; getValue(propertyId: BasesPropertyId): Value | null }
```

可用选项类型（`BasesAllOptions`）：`dropdown` / `file` / `folder` / `formula` / `multitext` / `property` / `slider` / `text` / `toggle`。`config.set(key, value)` 是视图级配置的持久化入口。

**[实践]** 真实插件 [`extended-base/src/main.ts`](https://raw.githubusercontent.com/lucytheboss/extended-base/main/src/main.ts) 的用法（注意返回值和降级守卫）：

```ts
async onload() {
  if (typeof this.registerBasesView !== 'function') {
    new Notice('需要 Obsidian 1.10.0+')
    return
  }
  const ok = this.registerBasesView('fictional-map', {
    name: 'Fictional Map',
    icon: 'map',
    factory: (controller, containerEl) => new MapBasesView(controller, containerEl),
    options: buildMapViewOptions,
  })
  if (!ok) new Notice('注册失败：Bases 核心插件未启用？')
}
```

**[实践]** 已知破坏性变更：`BasesOption#shouldHide` 的签名在 1.10.2 变更（[obsidian-block-view#1](https://github.com/TimoBechtel/obsidian-block-view/issues/1)）——**不要**在 `options` 里使用 `shouldHide`。

### 1.4 Canvas 工作区事件（仅 4 个）

**[逆向]** [`Workspace.d.ts`](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/augmentations/Workspace.d.ts)，全部标注 `@unofficial`：

- `canvas:node-menu (menu, node)`
- `canvas:selection-menu (menu, canvasView)`
- `canvas:edge-menu (menu, connection)`
- `canvas:node-connection-drop-menu (menu, originalNode, connection)`

⚠️ `canvas:node-creation` **不存在**（v1 及若干社区代码里流传的该事件名在逆向类型和 Advanced Canvas 中均无踪迹）。两个来源对回调签名也不一致（`canvasView: CanvasView` vs `canvas: Canvas`），实现时按鸭子类型取字段。

### 1.5 同类插件的存储先例

| 插件 | 存储形态 | 证据 |
|---|---|---|
| [draw-in-canvas](https://raw.githubusercontent.com/xRyul/draw-in-canvas/main/src/canvas-file.ts) | `.canvas` **顶层键** `drawInCanvas`，`version: 2`；整文档 read-modify-write（`app.vault.read` → `JSON.parse` → `vault.modify`），从不触碰 `nodes`；`minAppVersion: 1.5.0` | **[实践]** |
| [advanced-canvas](https://raw.githubusercontent.com/Developer-Mike/obsidian-advanced-canvas/main/assets/formats/advanced-json-canvas/spec/1.0-1.0.md) | `.canvas` 顶层 `metadata` + 每节点/每边扩展字段，自建"Advanced JSON Canvas"格式与版本号 | **[实践]** |
| [Hex Cartographer](https://raw.githubusercontent.com/JoelJansenD/Hex-Cartographer/main/src/data/serialization.ts) | **独立 markdown 文件**（`*.hexcartographer.md`）：frontmatter `type: hexcartographer` + ` ```json ` 代码块承载 `MapData`（`hexes` 以 `"q_r"` 为键、`rivers` / `roads` / `texts` / `borders` / `gridSize`）；地形用 SVG 符号库渲染 | **[实践]**（fork 源码；上游仓库只发布打包后的 `main.js`） |
| [jot](https://raw.githubusercontent.com/bverbeken/jot/main/src/jot-file.ts) | 旁挂文件 `.jot.json`，`adapter.write` + 250ms 防抖 + 空则删除 | **[实践]**（作用于 PDF，非 canvas） |

**没有任何已发现的插件在 `.canvas` 旁边放 sidecar 文件**——这是"证据缺失"而非"证明不存在"。

---

## 2. 架构决策

### ADR-1：地图几何数据不写入 `.canvas`

**决策**：地图的唯一真源是一份**地图文档**（`.map.md`，见 ADR-2）。`.canvas` 文件默认**零改动**；"哪张 canvas 用哪张地图"记录在**地图文档的 frontmatter** 里。

被否的三个方案：

| 方案 | 内容 | 否决理由 |
|---|---|---|
| A（v1 原案） | 完整几何写入 `.canvas` 顶层 `fictionalCartographer` 键 | 每次保存都要与 Canvas 自己的整文件重写竞争；数据越重，被重写/写坏的爆炸半径越大（§1.2 有实际损坏案例） |
| B | 完整几何写入旁挂 `World.canvas.map.json` | 多一个文件、与 base 模式无法共享、Obsidian 内不可读不可链接；且未找到任何同类先例 |
| C | 几何进 Obsidian 插件 `data.json` | 数据脱离 vault：无法随 Git 同步、换库即失、用户不可见不可编辑 —— 直接违背 v1"纯文本存于 vault"的设计原则 |

**采纳方案 D（文档侧绑定）的收益**：

1. **零竞态**：我们只写自己的 `.map.md`，Obsidian 只写 `.canvas`，两者永不同时写同一文件。
2. **零格式风险**：不再依赖 `[key: string]: any` 的"向前兼容"承诺来承载数据。
3. **天然共享**：同一张世界地图可被多个 canvas 与多个 Base 视图同时引用。
4. **Git 友好**：地图改动只出现在地图文档的 diff 里，不污染 canvas 文件。

**代价（如实记录）**：

- 单独把 `World.canvas` 分享给别人时，地图不会跟随。→ 缓解：`fc-export` 命令导出"自包含 canvas"（把几何临时内嵌进副本），作为后置特性。
- 用户需要一次"绑定"动作。→ 缓解：提供 `Bind map to this canvas` 命令；它通过 `vault.process()` **只写一个很小的引用键**（退化为方案 A 的轻量版，爆炸半径 = 一行键值），并可随时解绑。

**可选的便捷模式**：`.canvas` 顶层键的结构固定为极小对象，便于将来扩展：

```jsonc
// 仅当用户显式选择"内嵌引用"时写入；否则该键根本不存在
"fictionalCartographer": { "v": 1, "map": "Maps/World.map.md", "view": { "tx": 0, "ty": 0, "tZoom": 0 } }
```

写入一律走 `vault.process(file, fn)`（官方原子的 read-modify-write，[Vault/process](https://obsidian-developer-docs.pages.dev/Reference/TypeScript-API/Vault/process)），**不要**用 `vault.read` + `vault.modify`（`draw-in-canvas` 的做法存在丢更新窗口）。

### ADR-2：地图文档采用「Markdown + frontmatter + fenced JSON」

**决策**：地图文档是 vault 内的普通 markdown 文件，扩展名 `.map.md`。

- **frontmatter**：只放**可被 Obsidian 索引与 Base 查询**的标量与短列表（`type`、`name`、`fc-version`、绑定的 `canvases`）。
- **fenced ` ```json ` 代码块**：放全部几何数据（网格规格、地形、路径、区域、标记、文本）。

选型理由：
- 与 Hex Cartographer 同构（§1.5），有成功先例；
- 进入 Obsidian 的元数据缓存 → 可被搜索、可被双链、可被 Base 直接查询（`type == "fictional-cartographer-map"`）；
- 纯文本、Git diff 可读、损坏可手工修复；
- markdown 承载意味着用户误删代码块时是**可察觉的空白**，而不是 JSON 语法错误导致的整个文件解析失败。

**明确不采用**裸 `.json` 文件：Obsidian 不索引它，用户在库里看到的是不可读的一坨。

示例：

````markdown
---
type: fictional-cartographer-map
fc-version: 2
name: 艾尔登大陆
canvases:
  - "Maps/World.canvas"
---

# 艾尔登大陆

> [!info] 本文件由 Project Kaki 管理
> 下方的 JSON 块是地图数据。手工编辑请保持 JSON 合法；修改前建议先提交 Git。

```json
{
  "version": 2,
  "grid": { "kind": "hex", "orientation": "pointy", "size": 40, "origin": [0, 0] },
  "terrain": { "0_0": { "t": "mountain" }, "1_0": { "t": "mountain", "f": 1 }, "2_-1": { "t": "forest" } },
  "paths": [],
  "regions": [],
  "markers": [],
  "labels": []
}
```
````

### ADR-3：渲染分层——世界层用 Canvas，标注层用 DOM

| 层 | 载体 | 坐标系 | 尺寸是否随缩放 |
|---|---|---|---|
| 网格 | canvas（离屏缓存） | 世界 | 是 |
| 地形 | canvas（SVG 符号预渲染为精灵图集，`drawImage`） | 世界 | 是 |
| 路径 / 区域 | canvas（矢量绘制） | 世界 | 是（线宽可 clamp） |
| 标记 / 文本标注 | **DOM**（挂在适配层的覆盖容器内） | 屏幕 | 字号在 `[11, 28]` 区间 clamp |

理由：地形可能有上万格，只有 canvas 批量绘制能扛住（v1 §9 的判断正确）；而标记/标签需要 hover 提示、点击打开笔记、可访问性，DOM 天然具备，且避免自己实现命中测试与 tooltip。

---

## 3. 坐标系与变换（**已由 Phase 0 实测修正**）

> ⚠️ 本节曾是"推导"，现已被 Obsidian 1.13.7 的实测改写。
> 完整数据见 [PHASE-0-RESULTS.md](./PHASE-0-RESULTS.md) §2。

**[实践]** 来自 Advanced Canvas 的 `zoomToRealBbox` 与导出逻辑：

```ts
this.tZoom = Math.log2(zoom)
this.tx = (bbox.minX + bbox.maxX) / 2   // 视口中心的世界坐标（语义待确认，见下）
this.ty = (bbox.minY + bbox.maxY) / 2
// zoom 被 clamp 到 [2^-4, 2^1]，即 tZoom ∈ [-4, 1]
```

**[实测-1]** 字段语义（1.13.7）：`scale = 2^tZoom`（本次 0.44669732651951655），
而 **`zoom` 是 `tZoom` 的别名**，不是线性比例。一律用 `scale` 或变换矩阵的 `a` 分量。

**[实测-2]** 变换是**纯相似变换**：对五组实测样本计算隐含原点 `client − world × scale`，
散布仅 0.4 px，模型为

```
client = origin + scale × world
```

但 **`origin` 不能推导**。曾经的"中心公式"：

```
screen = (world - t) * s + (W/2, H/2)
world  = (screen - (W/2, H/2)) / s + t
```

用 `canvasEl.getBoundingClientRect()` 当屏幕基线时，因为 `.canvas` 是视口大小的盒子、
其内容被 transform 变换，`getBoundingClientRect()` 返回**变换后**的包围盒，
导致基线整体偏一段矩阵平移（本次 `(299.375, 287.988)` px），误差在世界尺度恒为 ~928。

**[实测-3]** 归纳出一条闭式关系（单次实测，仅作兜底）：

```
origin = wrapperRect.topLeft + matrix(e, f)      // 本次吻合到 0.03 px
```

**现行实现约束**：

1. 坐标转换一律经 `src/core/projection.ts` 的**锚点投影**：

   ```
   client = anchorClient + (world − anchorWorld) × scale
   ```

   锚点世界坐标来自 Obsidian 自己的 `posFromEvt`（语义已实测确认：接受 `clientX/clientY`），
   缩放来自变换矩阵的 `a` 分量。**不做任何原点推导**，因此对 `transform-origin` 等内部细节免疫。
2. **[实测-4]** `posFromEvt` 的输出被**量化到整整 1 个 CSS 像素**（第三轮 200 样本/方向实测：
   量子 = 1.000001 CSS px，横纵一致，与 `devicePixelRatio` 无关；噪声上界 0.707 CSS px）。
   而**变换矩阵与 `scale` 字段是精确的**。因此：
   - 缩放只取矩阵，**绝不**从 `posFromEvt` 采样反解（量化会让反解产生 ±1.5% 散布）；
   - 原点用**多点中位数标定**做校验（视口内 5×5 网格 + 留出样本），单点锚点最多会带上半个量子的误差；
   - **运行时原点 = 纯闭式**（`wrapperRect.topLeft + matrix(e,f)`，来自精确 CSS 值、无量化抖动），
     **不施加**标定测出的偏差修正 —— 实测该偏差 0.63 px < 噪声上界 0.707 px，
     不构成"闭式有偏"的证据，施加它等于注入噪声。只有多次运行都显示同向且超出上界的偏差时才考虑修正。
3. 兜底顺序：闭式 → 多点标定（诊断/地图激活时，仅作校验）→ 单点 `posFromEvt` → `posFromClient`。
4. 地图文档里**只存世界坐标**，永不存屏幕坐标或视口偏移。
5. 世界原点固定为地图文档的逻辑中心，不随视口变化。
6. `scale` / 投影只经由适配层读取，禁止在渲染代码里直接摸 `canvas.tZoom`。
7. ⚠️ `tx`/`ty` 是否等于视口中心的世界坐标仍未确认（实测在噪声内一致，但不足以断言）；
   运行时不依赖它，故不再阻塞。
8. 所有"是否一致"的判定阈值必须**噪声感知**（统一用 `quantumNoiseBound()`），不能用固定常量 ——
   实测中 0.8 px 的差异曾被误判为"关系不成立"，而它与量化噪声同量级。

---

## 4. 渲染架构

### 4.1 挂载点（**已由 Phase 0 实测确定**）

实测结构（1.13.7）：

```
wrapper (transform: none)
├── svg                                  背景图案
├── div.canvas-card-menu    matrix(1,0,0,1,-71.97,0)     ← 纯平移，易误判
├── div.canvas-controls     none
└── div.canvas              matrix(s,0,0,s,299.375,287.988)   ← 世界层 ★
    ├── svg
    ├── div.canvas-node     matrix(1,0,0,1,-420,-260)    ← 纯平移，易误判
    └── div.canvas-node     matrix(1,0,0,1,220,40)
```

**结论：采用策略 A，覆盖层挂到 `div.canvas` 内部**，坐标随 CSS 变换同步（含 `zoomToBbox` 等动画）。

**判据（首轮诊断在此处出错，务必按此实现）**：不能只看"有没有 transform"，
`canvas-card-menu` 与每个 `canvas-node` 都带 transform。正确的判定顺序是

1. **结构证据**：元素的子树包含 `.canvas-node`（与缩放无关，最可靠）；
2. **缩放证据**：矩阵的 `a`/`d` 分量等于当前 `scale`；
3. **反向排除**：类名含 `canvas-node` / `canvas-card-menu` / `canvas-control` 的扣分。

已实现于 `probeTransformCandidates()` + `pickWorldHost()`，并在冒烟测试中复刻上述真实 DOM，
把"不误选菜单/节点"固化为回归测试。

- **策略 B（降级）**：若上述探测失败（DOM 结构变化），覆盖层退回挂在 `wrapperEl` 下、
  `position: absolute; inset: 0`，自持 `translate/scale` 并在视口变化时重算。上层 API 不变。

### 4.2 覆盖层的指针策略

```ts
// 选择模式（默认）：完全让位给原生 Canvas
overlay.style.pointerEvents = 'none'
// 绘图模式：拦截指针
overlay.style.pointerEvents = 'auto'
```

与 v1 一致，这一点 v1 判断正确。补充两条：

- 绘图模式下**不要** `preventDefault` 掉 `wheel`：缩放应始终由原生 Canvas 处理，我们只跟随重绘。
- 绘图模式下需要临时屏蔽原生 Canvas 的选择框：通过 `canvas.deselectAll()` 在进入绘图模式时清空选择，而不是阻止事件冒泡（阻止会连带破坏缩放/平移）。

### 4.3 分层与缓存

```ts
class MapRenderer {
  private terrainChunks: Map<string, HTMLCanvasElement>  // 按 32×32 格分块缓存
  private spriteAtlas: HTMLCanvasElement                   // 地形 SVG 符号预渲染
  render(viewport: Viewport): void {
    const dirty = this.chunkIndex.visibleChunks(viewport.bbox)
    for (const chunk of dirty) this.blit(this.chunkCanvas(chunk), viewport)
    this.drawPaths(viewport); this.drawRegions(viewport)
    this.syncMarkers(viewport)   // 只更新 DOM 的 transform，不重建节点
  }
}
```

- 精灵图集在 `onload` 时由 SVG 字符串一次性预渲染（`new Image()` + `data:image/svg+xml`），避免每格创建 SVG 元素。
- `devicePixelRatio` 感知：位图尺寸 = CSS 尺寸 × `dpr`，仅在 `dpr` 或容器尺寸变化时重建。
- 地形数据以 `"q_r"` 字符串键存储，渲染时再解出 `(q, r)`，与 Hex Cartographer 的 `hexes` 键格式一致，便于互通与调试。

### 4.4 重绘触发：补丁驱动，而非轮询

**[实践]** Advanced Canvas 的隔离手法（[`patcher.ts`](https://raw.githubusercontent.com/Developer-Mike/obsidian-advanced-canvas/main/src/patchers/patcher.ts)、[`canvas-patcher.ts`](https://raw.githubusercontent.com/Developer-Mike/obsidian-advanced-canvas/main/src/patchers/canvas-patcher.ts)）：用 `monkey-around` 的 `around()` 包装目标方法，并用 `plugin.register(uninstaller)` 登记卸载器；补丁延迟到**首次请求该类型视图时**再打；在 `layout-change` 上重试；版本守卫 `requireApiVersion('1.7.2')` 配合 `leaf.isDeferred`。

本插件照搬该模式，包装两个方法：

- `markViewportChanged()` → 视口变化 → 重绘（合并到下一帧，去重）
- `requestSave()` / `markDirty()` → 用于感知外部修改

**[实测]** 三轮实测：

| 轮次 | 操作 | 事件总数 | 有效视口变化 | 解读 |
|---|---|---|---|---|
| 一 | 3 平移 + 3 缩放 + 1 移动贴纸 | 168 | 未统计 | 当时误读为"每帧多次，必须去重" |
| 三 | 1 平移 + 1 缩放（分开做） | 84 | 75（重复 11%） | 回调是**逐帧触发（每帧一次）** |

**因此正确的性能要求是：每帧一次的重绘必须廉价**（分块缓存 + 视口裁剪 + 精灵图集），
**不能**指望"把多次事件合并成一次"来省开销 —— 那最多省 11%。

仍要做两件事：

1. **rAF 合并**（防御性、几乎零成本，也能吸收同一帧内的重复回调）；
2. **投影去重**：判据必须是"投影是否真的变化"，而不是"回调是否发生" ——
   那 11% 的重复事件正说明该回调也会因非视口变化（如节点移动）触发。
   Phase 1 还应监听节点变化以决定是否重绘**标记层**。

**降级链**：补丁失败（方法不存在 / 版本漂移）→ 退回 `requestAnimationFrame` 轮询，但**仅在覆盖层可见时轮询**，并在设置里暴露开关与诊断提示。

⚠️ 不采用 v1 的 "监听 Canvas transform 事件"：没有这样的公开或逆向事件（§1.4 只有 4 个 `canvas:*` 菜单事件）。

---

## 5. 交互、工具与撤销

### 5.1 模式状态机

```
select ──(D / 工具栏铅笔)──> draw(tool)
   ^                            │
   └──────(Esc)─────────────────┘
```

- `select`：覆盖层 `pointer-events: none`，原生 Canvas 完全正常。
- `draw(tool)`：工具栏常驻显示当前 tool 与笔刷参数。
- **退出绘图时必须 flush 一次保存**，且清空未闭合的临时图形（未完成的区域/路径）。

### 5.2 快捷键映射（修订 v1）

| 键 | 功能 | 修订说明 |
|---|---|---|
| `D` | 切换 绘图/选择 | 保留 |
| `B` `M` `R` `P` `T` | 地形笔刷 / 标记 / 区域 / 路径 / 文字 | 保留 |
| `Esc` | 退出当前工具（再按回选择模式） | 保留 |
| `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z` | 撤销 / 重做 | **仅当覆盖层持有焦点时**绑定到本插件的作用域；否则让给 Canvas 与编辑器。v1 未区分，会与原生撤销打架 |
| `[` `]` | 笔刷大小 | 保留 |
| `1`–`9` | 地形类型 | 扩展到 9 种（v1 只列了 6 种却写了 `1-6`，而类型表有 9 个） |

### 5.3 撤销栈

- **操作型（op-based）栈**，不是整文档快照：每个 op 携带 `apply` / `invert`（如 `AddTerrain(q,r,type)` ↔ `RemoveTerrain(q,r)`、`MoveMarker(id, from, to)`）。
- 栈上限 100 步；一个"拖动笔刷的连续笔画"合并为一个 op（`beginStroke` / `endStroke`）。
- 使用 `Scope` + `Keymap`（`app.scope` / `app.keymap.pushScope`）实现焦点感知的键绑定，避免劫持全局快捷键。

---

## 6. 数据模型（修订版）

```ts
/** 地图文档 fenced JSON 的根对象 */
interface MapDocument {
  version: 2                                  // 必填；无版本号的文件一律拒绝加载并提示迁移
  grid: GridSpec
  terrain: Record<string, TerrainCell>        // 键 = `${q}_${r}`（轴向坐标）
  paths: MapPath[]
  regions: MapRegion[]
  markers: MapMarker[]
  labels: MapLabel[]
  settings?: { colorPalette?: Record<string, string> }
}

interface GridSpec {
  kind: 'hex'
  orientation: 'pointy' | 'flat'
  size: number                                // 外接圆半径，世界单位
  origin: [number, number]                    // 网格原点在世界坐标中的位置
}

interface TerrainCell {
  t: TerrainType
  f?: number                                  // 位标志：1=旋转，2=镜像，4=变体（替代 v1 的 rotation 字段，省体积）
  c?: string                                  // 覆盖默认颜色
}

type TerrainType = 'mountain' | 'forest' | 'water' | 'desert'
                 | 'plains' | 'swamp' | 'hills' | 'tundra' | 'volcanic'
```

**关键修订 1：地形量化为六边形坐标，而非像素 `x/y`。**
轴向坐标 → 世界坐标（pointy-top）：
```
x = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r)
y = size * (3 / 2 * r)
```
flat-top：
```
x = size * (3 / 2 * q)
y = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r)
```
（两个函数都必须有单元测试，含往返转换 `worldToAxial(axialToWorld(q,r)) ≈ (q,r)`。）
好处：改 `grid.size` 不破坏数据；天然支持"格"级去重与稀疏存储；与 Hex Cartographer 的 `"q_r"` 键格式一致。

**关键修订 2：标记与区域保留世界坐标**（它们本质是连续空间中的对象，量化到格会损失精度且在缩放时抖动）。

```ts
interface MapMarker {
  id: string
  label: string
  p: [number, number]                         // 世界坐标
  icon: MarkerIcon
  c?: string
  link?: string                               // vault 相对路径；点击时用 app.workspace.openLinkText 打开
  desc?: string
}

interface MapRegion {
  id: string
  label: string
  pts: [number, number][]
  color: string
  opacity: number
  borderColor?: string
  borderWidth?: number
  link?: string
}

interface MapPath {
  id: string
  type: 'river' | 'road' | 'trade-route' | 'border'
  pts: [number, number][]
  width: number
  color: string
  dash?: number[]                             // 与 v1 的 dashPattern 等义，缩短键名以控体积
  taper?: boolean                             // 河流末端变细
  smooth?: boolean                            // Catmull-Rom 平滑
}

interface MapLabel {
  id: string
  text: string
  p: [number, number]
  size?: number                               // 世界单位；渲染时 clamp 到 [11, 28] px
  color?: string
  bold?: boolean
  italic?: boolean
  rotation?: number
  link?: string
}
```

**体积策略**：数组点用两个数的元组、可选字段在序列化时省略、坐标取整到 0.1 世界单位。1 万格地形的 JSON 预计在 ~150–250 KB 量级，对 markdown 文件是可接受的（Hex Cartographer 走的是同一条路）。

**迁移**：`version` 字段 + 迁移函数链 `migrate(v1 → v2)`；加载时若 `version` 高于当前支持版本，**只读打开并提示**，绝不写回（防止新版本数据被旧版本砍掉字段）。

---

## 7. Base 模式契约

### 7.1 注册（`minAppVersion` 策略）

```ts
// manifest.json: "minAppVersion": "1.5.0"  ← Canvas 模式的最低要求（draw-in-canvas 同款）
async onload() {
  // Canvas 功能无条件启用
  this.registerCanvasFeatures()

  // Base 功能按版本门禁，运行时降级而不是硬性抬高 minAppVersion
  if (typeof this.registerBasesView !== 'function') {
    this.basesAvailable = false
    return
  }
  this.basesAvailable = this.registerBasesView('fictional-map', {
    name: 'Fictional Map',
    icon: 'map',
    factory: (controller, containerEl) => new MapBasesView(controller, containerEl),
    options: (config) => [
      // 用 file 选项指向地图文档 —— 几何数据留在 .map.md，不进 YAML
      { type: 'file', key: 'mapFile', displayName: '地图文档',
        placeholder: 'Maps/World.map.md', filter: f => f.extension === 'md' },
      { type: 'property', key: 'coordProperty', displayName: '坐标属性',
        default: 'note.coordinates' },
      { type: 'property', key: 'iconProperty', displayName: '标记图标属性',
        default: 'note.map-type' },
      { type: 'toggle', key: 'showGrid', displayName: '显示网格', default: true },
    ],
  })
}
```

**不使用 `shouldHide`**（§1.3 的破坏性变更）。

### 7.2 两种数据来源

| 来源 | 内容 | 取值方式 |
|---|---|---|
| 地图文档（`config.get('mapFile')`） | 网格、地形、路径、区域、静态标记 | `app.vault.getFileByPath()` → 解析 fenced JSON |
| Base 查询结果（`this.data.data: BasesEntry[]`） | **每个笔记**成为一个地图标记 | `entry.file` + `entry.getValue(propId)` |

笔记侧属性约定（与 v1 §4.2 一致，但明确类型）：

```yaml
---
coordinates: [320, -140]     # 世界坐标；也接受 {x: , y: } 或 "320,-140"
map-type: city               # 决定图标；缺省用 'town'
region: 北境王国              # 可选；用于分组/着色
---
```

`onDataUpdated()` 中：重建 `entry.file` → 标记的映射，保留上一次的图标/位置以支持过渡动画，然后重绘。

⚠️ `Value` → `number` 的取用方式（期望是 `ListValue.get(i)` 配合 `NumberValue.toValue?.()`）需在实现时以真实数据核对，见 §11。

### 7.3 嵌入代码块（Base API 不可用时的降级）

若 `registerBasesView` 不存在（< 1.10.0），提供 ` ```fictional-map ` 代码块（`registerMarkdownCodeBlockProcessor`），可写在 `.base` 之外的普通笔记里，也能覆盖 v1 §9 提到的"把地图以代码块形式嵌入"的退路。**但不要**试图把地图代码块写进 `.base` 文件——`.base` 是 YAML，代码块不是它的语法。

---

## 8. 私有 API 隔离层（唯一允许触碰内部对象的地方）

```ts
/** 全部私有 API 访问都收敛在这个接口的实现里；上层不得出现 canvas.tZoom 之类字样 */
interface CanvasAdapter {
  readonly available: boolean
  getViewport(): { tx: number; ty: number; tZoom: number; w: number; h: number } | null
  worldToScreen(p: Point): Point
  screenToWorld(p: Point): Point
  getOverlayHost(): HTMLElement | null
  onChange(cb: () => void): () => void        // 返回卸载函数
  dispose(): void
}
```

实现要点：

- 形状守卫：每次取用前检查 `typeof canvas.markViewportChanged === 'function'` 等，任一缺失即 `available = false` 并优雅停用（提示用户而不是抛异常）。
- 补丁用 `around()` 并**逐个** `register(uninstaller)`；`onunload` 时全部还原。
- 版本守卫：`requireApiVersion('1.7.2')` 用于排除延迟加载叶子；对 `tZoom` 的 clamp 区间（`[-4, 1]`）也做运行时校验而非硬编码假设。
- 诊断命令 `Project Kaki: 诊断当前 Canvas`：打印适配器可用性、各字段探测结果、补丁状态。这是版本漂移时唯一需要用户提供的信息。

---

## 9. 修订版路线图

### Phase 0：探针（1–2 天，**必须先做**，其产出决定后续实现）

| 探针 | 目的 | 验收标准 |
|---|---|---|
| P1 DOM 挂载点 | 确定 §4.1 走策略 A 还是 B | 明确写出"transform 非 none 的唯一元素"及其 class，并截图/日志存档 |
| P2 私有字段清单 | 确认 §1.1 表中字段在本机 Obsidian 版本上真实存在 | 诊断命令输出全部字段的 `typeof` |
| P3 视口事件 | 确认 `markViewportChanged` 可被 `around()` 包装且每次平移/缩放都触发 | 拖动画布时控制台按帧输出，无遗漏、无重复补丁 |
| P4 坐标往返 | 用 `posFromEvt` 与自研公式互验 | 20 个采样点误差 < 0.5 世界单位 |
| P5 未知键保留性 | 复现 §1.2 的结论（仅在走"内嵌引用"模式时需要） | 写入键 → 在 Canvas 里拖动节点保存 → 键仍在 |

**Phase 0 实测结果见 [PHASE-0-RESULTS.md](./PHASE-0-RESULTS.md)**（Obsidian 1.13.7）。
状态：**P1 / P2 / P3 / P4 / P6 全部完成并落地**；P5 未做且已不再需要（默认架构不写 `.canvas`）。

| 探针 | 实测结论 | 对设计的修订 |
|---|---|---|
| P1 | 世界层是 `div.canvas`；菜单与节点也带 transform | §4.1 判据改为"含 `.canvas-node` 结构证据 + 矩阵缩放匹配" |
| P2 | 1.13.7 上字段齐备；**`zoom` 是 `tZoom` 的别名** | §1.1 修正字段语义；一律用 `scale` 或矩阵 `a` |
| P3 | 回调**逐帧触发**（每帧一次）；去重收益仅 11% | §4.4 改为"每帧重绘必须廉价"，而非"合并事件省开销" |
| P4 | 轴对齐相似变换；矩阵精确、`posFromEvt` 有量化 | §3 改为闭式原点 + 多点标定校验；中心公式降级为兜底 |
| P6 | 量子 = **1 个 CSS 像素**（非设备像素），噪声上界 0.707 px | §3 判定阈值统一噪声感知；撤销"偏差修正" |

### 后续阶段

**进度（截至 Phase 1 第一轮）**：
Phase 1 的**地图文档格式与读写层**、**网格空间索引**、**创建/绑定/查看地图的命令**已完成，
实测数字与实施决定见 [PHASE-1-NOTES.md](./PHASE-1-NOTES.md)。
下一步是覆盖层挂载与地形渲染。

- **Phase 1（MVP）**：地图文档格式 + 读写的原子/防抖/flush + 六边形网格 + 地形笔刷（3 种地形）+ 标记放置与链接跳转 + 适配层 + 诊断命令。
- **Phase 2**：区域与路径工具、文字标注、op 型撤销栈、调色板、图层开关。
- **Phase 3**：Base 视图（§7 契约 + 笔记坐标驱动标记）、笔记属性约定、两种来源合并渲染。
- **Phase 4**：导出 PNG/SVG、图例、多图层（底图 + 标注层）、自包含 canvas 导出。
- **Phase 5**：移动端（触摸绘制、双指缩放走原生 Canvas）、手写笔压力（参考 draw-in-canvas 的 `points[].pressure`）。

相对 v1 的顺序调整：**撤销栈从 Phase 2 提前到与绘图工具同期落地**——先有 op 模型再堆工具，否则每种工具都要回补撤销逻辑。**导出从 Phase 4 提前到 Phase 3 之后**可选，因为它同时是最有效的验证手段（导出图能立刻暴露坐标/变换错误）。

---

## 10. 风险登记表

| 风险 | 触发条件 | 缓解 | 爆炸半径 |
|---|---|---|---|
| Canvas 私有 API 变更（最高风险） | Obsidian 升级 | 适配层 + 形状守卫 + 诊断命令 + 优雅停用 | 地图层不显示；**地图数据完好无损**（数据不在 canvas 里） |
| `.canvas` 重写破坏自定义键 | 仅"内嵌引用"模式 | 默认不写；只写极小键；`vault.process` 原子写 | 丢掉一行引用，重新绑定即可 |
| Bases API 破坏性变更 | Obsidian 升级 | 版本门禁 + 不用 `shouldHide` + 失败降级到代码块 | Base 视图不可用；Canvas 模式不受影响 |
| 地图文档过大导致编辑器卡顿 | 地形 > 2 万格 | 分块 + 视口裁剪；语法高亮下大 JSON 块仍是纯文本 | 性能退化，非数据损坏 |
| 与原生撤销/快捷键冲突 | 未做焦点感知 | `Scope` + `Keymap` 作用域绑定 | 用户误撤销掉笔记编辑 |
| 并发写入丢更新 | 多窗口同时编辑同一地图 | `vault.process` 原子 RMW + 写前比对 `mtime` + 冲突时提示 | 最后一次操作丢失 |

---

## 11. 待验证清单（实现前不得当作事实）

1. ✅ **已落地（1.13.7）**：§3 的推导公式被实测**否定**（偏差恒为矩阵平移分量）。已改为锚点投影，见 [PHASE-0-RESULTS.md](./PHASE-0-RESULTS.md) §2。
2. ✅ **部分落地**：`posFromEvt` 的参数语义已确认接受 `clientX/clientY`；`posFromClient` 与之一致性由 `crossCheckDelta` 持续校验；实现体仍未见到。
3. ⚠️ "Obsidian 自身保存时保留**顶层**未知键"没有官方文档保证（只有 `[key: string]: any` 的类型声明与插件实践）。P5 探针负责落地此结论（当前架构默认不写 `.canvas`，风险面已缩小）。
4. ✅ **已落地（1.13.7）**：字段清单实测**全部存在**，且比逆向类型记录的更多；但跨版本稳定性仍无保证，适配层继续做形状守卫。
5. ⚠️ `canvas:*` 事件的回调签名两个来源不一致（`canvasView: CanvasView` vs `canvas: Canvas`）。
6. ⚠️ Bases 的 `Value` → `number`/`string` 的可靠取用方式未确认（需以真实 `note.coordinates` 数据核对 `ListValue` / `NumberValue` 行为）。
7. ⚠️ Hex Cartographer 的证据来自第三方 fork 源码，未证明与上游发布版一致（上游仓库只发布打包产物）。
8. ⚠️ 未找到任何在 `.canvas` 旁使用 sidecar 的插件——"证据缺失"，不是"不存在"。
9. ⚠️ `Vault.process` 的存在性经搜索索引确认（官方文档站有该页），但其在 `.canvas` 上的行为（是否触发 Canvas 视图重载、是否与视图的保存队列冲突）未实测。

---

## 12. 主要来源

**官方**
- [obsidian.d.ts](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)（Bases API、`BasesViewRegistration`、`BasesQueryResult`、`Vault.process`）
- [canvas.d.ts](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/canvas.d.ts)（`[key: string]: any` 前向兼容声明）
- [JSON Canvas 1.0 规范](https://raw.githubusercontent.com/obsidianmd/jsoncanvas/main/spec/1.0.md)
- [Build a Bases view](https://docs.obsidian.md/plugins/guides/bases-view) · [Bases syntax](https://obsidian.md/help/bases/syntax)

**逆向类型**
- [obsidian-typings / CanvasView.d.ts](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/canvas/CanvasView.d.ts) · [CanvasViewCanvas.d.ts](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/canvas/CanvasViewCanvas.d.ts) · [Workspace.d.ts](https://raw.githubusercontent.com/Fevol/obsidian-typings/release/obsidian-public/1.13.7/src/obsidian/augmentations/Workspace.d.ts)

**同类插件**
- [draw-in-canvas](https://github.com/xRyul/draw-in-canvas)（`drawInCanvas` 顶层键、`vault.read`+`modify` 写法、`minAppVersion 1.5.0`）
- [obsidian-advanced-canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas)（`monkey-around` 补丁模式、Advanced JSON Canvas 格式规范、Canvas 事件类型）
- [Hex Cartographer（fork 源码）](https://github.com/JoelJansenD/Hex-Cartographer)（`*.hexcartographer.md` + ` ```json ` 代码块、`hexes` 以 `"q_r"` 为键、SVG 符号库）
- [extended-base](https://github.com/lucytheboss/extended-base)（`registerBasesView` 的真实用法与降级守卫）
- [jot](https://github.com/bverbeken/jot)（旁挂文件模式先例）

**破坏性变更记录**
- [Canvas 自定义对象属性导致文件损坏（论坛 #84698）](https://forum.obsidian.md/t/canvas-file-corruption-if-file-node-has-custom-property-of-type-object-or-list/84698)
- [advanced-canvas#82](https://github.com/Developer-Mike/obsidian-advanced-canvas/issues/82)
- [Bases `shouldHide` 签名变更](https://github.com/TimoBechtel/obsidian-block-view/issues/1)
