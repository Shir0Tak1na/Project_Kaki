# Project Kaki：Agent 交接说明

更新时间：2026-09-23

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
- 单元测试：278 个通过
- 冒烟测试：28 个场景、587 条断言全部通过
- 类型检查必须为 0 错（`node node_modules/typescript/bin/tsc --noEmit`）
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
- 地图层启停：命令面板和 Canvas 工具条的“地图层”按钮都可停用当前层。
- 设置页的“显示六边形网格”会立即作用于已启用地图层并持久化。
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
- 仍缺：多图层导出（分层出图）、把图例画进导出文件。

## 当前设置与 UI 边界

已经有：

- 路径与区域名称字号倍率：`0.5`-`3.0`。
- **样式设置**（① 已完成）：4 种路径的默认颜色、6 个区域预设色、名称字体族（`''` = 跟随主题）、
  「恢复出厂样式」。语义是"只影响新画的对象"，见 `ENGINEERING-NOTES.md` §5.10。
  实现：`src/render/stylePalette.ts`（纯函数：颜色/字体校验 + 解析）、设置页颜色选择器与输入框、
  `MapLayerManager.setStylePalette()` 广播刷新。
- **自定义地形**（② 已完成）：设置里定义（`custom:` 前缀的稳定 ID + 显示名 + 颜色 + 可选字形/图片），
  四处界面（画布/工具条/Base 缩略图/SVG 导出）共用同一份 `resolveTerrainStyle` 三级回退；
  未知 ID 只告警不丢弃；图片缺失回退颜色 + 字形。
- **图层开关与图例**（③ 已完成）：六层可见性只存在于插件设置（唯一真相，画布侧每帧现读）；
  图例由地图实际内容生成，画布右下角、默认隐藏。
- 工具条内置地形、路径类型、区域颜色、标记图标选择（色块跟随设置，刷新时原地改样式、不重建 DOM）。
- 地图层停用按钮（名称显示开关已并入图层里的 `labels`）。

尚未有：

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

- 把图例画进 SVG/PNG 导出；
- 「把样式设置应用到已有对象」的一键重着色（新增可撤销 op）；
- 自定义地形的图块与变体、导出内联图片；
- 移动端与触控笔；
- Base 表格的虚拟滚动。

## 发版流程

```powershell
node scripts/release.mjs 1.0.0 --dry-run   # 先看会改什么（不写盘）
node scripts/release.mjs 1.0.0             # 真正把版本写进四处
git add -A ; git commit -m "release: 1.0.0" ; git tag 1.0.0 ; git push --follow-tags
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
- [src/ui/MapToolbar.ts](../src/ui/MapToolbar.ts)：Canvas 工具条和地图层停用按钮。
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
- **不要 `git push --force`**：远端 `main` 上有 GitHub 生成的 `LICENSE`（Apache-2.0），强推会删掉它。
  本地第一个提交是与远端 `Initial commit` 合并后的结果（README 以本地为准）。
- 不要把工具条重新挂到覆盖层上。覆盖层必须保持 `pointer-events: none`，否则会破坏原生 Canvas 命中测试。
- 不要删除 `getUiExclusions()` 的原生控件选择器。绘制模式下缩放按钮和卡片菜单必须可用。
- 不要把 `package.json` 部署到 Obsidian 插件目录。
- 插件 ID 是 `project-kaki`；**不要**再改它（改了要同步 `manifest.json` + `scripts/deploy.mjs` + `scripts/smoke.mjs` 里的字面量，
  并给用户做目录与启用项迁移）。同理不要改那三个写在用户文件里的持久化标识，见本文开头的警告。
- 每次修改 UI 后都要跑 `npm run build`、`npm test`、`node scripts/smoke.mjs`，并部署到测试库后给用户可判伪的手动验证清单。
- 文档中的测试数量必须和实际输出同步。当前基线是 `278 / 587`（单元测试 / 冒烟断言，28 个冒烟场景），
  两者都能自己数出来：`node --test --test-isolation=none` 的末行、`node scripts/smoke.mjs` 的末行。
- 加新功能时**同时加冒烟场景**：桩没模拟到的真实行为，就是下一次用户报的 bug。
