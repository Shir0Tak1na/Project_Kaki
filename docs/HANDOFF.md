# Project Kaki：Agent 交接说明

更新时间：2026-09-25

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
- 单元测试：404 个通过
- 冒烟测试：37 个场景、977 条断言全部通过
- 类型检查必须为 0 错（`node node_modules/typescript/bin/tsc --noEmit`）
- **文档轮（⑤ 路径/区域类型 + ③ 定义文件）已于 2026-09-25 补完**，详见文末「暂停点交接」§6；
  该轮只改 Markdown，改完四道闸复核仍是 0 错 / 404 / 977
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
- **本机推送必须走 HTTP/1.1**：这台机器上 `git push` 用默认 HTTP/2 时会间歇性失败，
  报 `Failed to connect to github.com:443 after ~21000 ms` 或 `Recv failure: Connection was reset`，
  而同一时刻 `Test-NetConnection github.com -Port 443` 是**通的**（TCP 能连、TLS/HTTP2 被重置）。
  仓库已设 `git config http.version HTTP/1.1`，此后再推即成功。遇到推送失败先确认这条配置还在，
  **不要**误判成"GitHub 挂了"或反复瞎重试。
- **不要 `git push --force`**：远端 `main` 上有 GitHub 生成的 `LICENSE`（Apache-2.0），强推会删掉它。
  本地第一个提交是与远端 `Initial commit` 合并后的结果（README 以本地为准）。
- 不要把工具条重新挂到覆盖层上。覆盖层必须保持 `pointer-events: none`，否则会破坏原生 Canvas 命中测试。
- 不要删除 `getUiExclusions()` 的原生控件选择器。绘制模式下缩放按钮和卡片菜单必须可用。
- 不要把 `package.json` 部署到 Obsidian 插件目录。
- 插件 ID 是 `project-kaki`；**不要**再改它（改了要同步 `manifest.json` + `scripts/deploy.mjs` + `scripts/smoke.mjs` 里的字面量，
  并给用户做目录与启用项迁移）。同理不要改那三个写在用户文件里的持久化标识，见本文开头的警告。
- 每次修改 UI 后都要跑 `npm run build`、`npm test`、`node scripts/smoke.mjs`，并部署到测试库后给用户可判伪的手动验证清单。
- 文档中的测试数量必须和实际输出同步。当前基线是 `404 / 977`（单元测试 / 冒烟断言，37 个冒烟场景），
  两者都能自己数出来：`node --test --test-isolation=none` 的**汇总行**（`ℹ tests 404`）、
  `node scripts/smoke.mjs` 的末行。
  ⚠️ **去读汇总行，不要目测**：这条基线曾被写错成 278，原因是用 dot reporter 的点数"数行数"。
- **改完源码不重新构建是跑不动的**：`smoke.mjs` 与 `deploy.mjs` 启动时都会检查"产物是否比 `src/` 新"，
  不新就**拒绝运行**并打印两个时间戳作为证据（实现在 `scripts/lib/bundleFreshness.mjs`）。
  这条陷阱发作过两次，第二次还导致了一个基于错误前提的修复（见 `ENGINEERING-NOTES.md` §5.17）。
- 加新功能时**同时加冒烟场景**：桩没模拟到的真实行为，就是下一次用户报的 bug。

## 暂停点交接（2026-09-24 深夜 · 用户余额耗尽，`/pause`）

这一节是**为"下一位接手的 agent"写的**：先说清哪些已经验证到哪一步，再说清哪些是**没做完**的。
凡本节没写的，以仓库里的代码与测试为准；凡本节说"未验证"的，**不要**当成已完成。

### 1. HEAD 与远端

- `main` 与 `origin/main` **完全同步**（`cfba4ef`），CI（`ci.yml`，push 到 main 触发）此前每个提交都绿。
- 本次暂停前最后 7 个提交，全部经过四道门（构建 / `tsc` / 单测 / 冒烟）：

  | 提交 | 内容 |
  |---|---|
  | `84591f3` | ④ 自定义标记图标（含修数据保全缺陷：未知 `icon` 不再被改写成 `town`） |
  | `abcb487` | ④ 文档轮（README / 手册 §5.3 / CHANGELOG / 工程笔记 §5.26 + 基线） |
  | `3e0e31e` | 文档修正：手册里已过时的「还不能」与已实现项错位（含 §4 与 §10 自相矛盾） |
  | `7077f99` | 交接笔记：本机 `git push` 必须走 HTTP/1.1 |
  | `9507f51` | ⑤-1 路径类型可扩展：**未知 `type` 以前会丢掉整条路径**（数据保全）+ 工具条下拉 + 设置页参数编辑 |
  | `0c74e62` | ③ 定义文件导入/导出：面板按钮 + 两个命令（同一份实现），格式升到 v2 |
  | `892424d` | 修掉工具条下拉缺陷：收起菜单的那一击不再顺手在画布上落一个顶点 |
  | `a96cf69` | ⑤-2 区域类型统一：6 个内置区域预设变成可扩展的类型目录 + 区域下拉 + 设置页区域类型区 |
  | `cfba4ef` | ③ 收尾：区域类型纳入定义文件（四类定义齐了） |

### 2. 已完成的验证强度（**我自己跑过，不是采信 subagent 自报**）

- `node scripts/build.mjs` → **59 个模块 / 859.9 KiB**
- `node node_modules/typescript/bin/tsc --noEmit` → **0 错**
- `node --test --test-isolation=none` → **`ℹ tests 404` / `fail 0`**
- `node scripts/smoke.mjs` → **977 条断言 0 失败**（场景编号到 **37**；块数比它多，见下）

另外我写了三份**独立复核脚本**（在 `.build/`，已被 gitignore，可重跑）：
`verify-5-1.mjs`（未知路径类型不丢数据 / 迁移幂等）、`verify-3.mjs`（定义文件四段 / 幂等 / 段缺失 / 同 ID 保留 / 区域类型往返）、
`verify-5-2.mjs`（旧区域按颜色取名、落盘不补 `type`、未知区域类型保全）。
它们的价值在于**不经过 subagent 的冒烟脚本**，直接调真实源模块 —— 下次改动后重跑，能快速看出有没有回归。

### 3. 明确没做完的（下一轮的起点，按建议优先级）

1. ~~**文档轮只做了一半（本轮最要紧的欠账）**~~ —— **已于 2026-09-25 补完（见本节 §6）**。
   原先的状态是：`docs/ENGINEERING-NOTES.md` 已更新到新基线并新增 §5.27 / §5.28 / §5.29，
   `README.md` 与 `docs/HANDOFF.md` 的基线数字也已同步，但 `README.md` 的功能列表、
   `docs/USER-MANUAL.md`、`CHANGELOG.md` 都还没写 ⑤（路径类型 / 区域类型）与 ③（定义文件四类导入导出）。
2. **标记图标不参与导出**：导出 SVG/PNG 与 Base 缩略图里，标记一律是固定小圆点。
3. **区域类型的不透明度与边框不进导出侧**：`mapPreview` 画区域仍用固定 0.28 透明度、不画边框虚线。
4. **没有开版的待发内容**：④⑤①⑤②③ 加三处缺陷修复都还在 `[未发布]`，用户尚未决定是否切 `1.1.0`
   （`scripts/release.mjs` 会把版本写进 4 个文件、打带注释的 tag 并触发 GitHub Release）。
5. **`taper` / `smooth` 在路径类型目录里存着、但设置页没有开关**（参数集合当初只要求显示名/颜色/线宽/虚线/端点/连接）。
6. **图块与变体**：每种地形只有一套视觉，没有多图块 / 旋转 / 镜像变体。
7. 真实 Obsidian 观感一律未验证（下拉浮层定位与遮挡、窄窗口、触摸/移动端、`ctx.lineCap`/`setLineDash` 的真实观感）；
   `styles.css` **没有任何自动断言**。用户手上还有几份**可判伪清单**没跑（④ 八条、③ 十三条、⑤① 九条、⑤② 十条）。

### 4. 用户手上待跑的验收项（下一位 agent 应该先问这几条的结果）

- **④**：第 6 条最关键 —— 源码模式把某标记 `icon` 写成不存在的名字，保存重开后**必须仍是那个名字**（旧版会改写成 `town`）。
- **③**：第 6 条幂等回归（刚导出的文件立刻再导入 = 0 新增）；第 11 条 v1 老文件导入**不许清空**现有标记/路径类型定义。
- **⑤①**：第 6 条 —— 手改某条路径 `type` 为 `"spaceship-lane"`，它**必须还在、还画得出来**，保存重开仍在。
- **⑤②**：回归项① 旧地图（区域没有 `type`）图例名字与升级前一致、落盘**不补** `type` 字段；
  回归项② 区域下拉展开时点画布收起，**不许**多出一个区域顶点。

### 5. 这一周期的三条新教训（细节见 `ENGINEERING-NOTES.md` §5.27–§5.29）

- **白名单/类型联合会把用户数据改坏**：未知 `icon` 被改写成 `town`（改一个字段）、未知路径 `type` 让**整条路径消失**（丢一个对象）。
  已统一口径：未知 ID **原样保留 + 告警「已保留」**，回退视觉归绘制层。**这是文档里的稳定承诺，别再退回白名单。**
- **假 DOM 的保真度直接决定断言真假**：不模拟事件传播 ⇒「点画布收起下拉」那条断言**工具条什么都不做也照样绿**。
  新增断言前先问：**破坏实现，它会红吗？**（本轮至少抓到 5 条空转断言，全是这么抓出来的。）
- **"没红"也是一种结果，要如实报告**：定义文件里 `has('section')` 那道守卫今天**不可观测**
  （解析侧给空数组 + 合并只增不删），破坏它一条断言都不会红；保留它（作为"有人把合并改成替换语义"时的第二道防线），
  并在注释里写明它今天不管事 —— 而不是换个能红的断言来充数。

### 6. 文档轮收尾（2026-09-25 · 本轮）

§3 第 1 条点名的那笔欠账（⑤ 路径/区域类型 与 ③ 定义文件没写进面向使用者的三份文件）**已经补完**。
改动**全是 Markdown，没有碰源码**；改完重跑四道闸：**0 类型错误 / 404 单测 / 977 冒烟断言**，
与文档里记的基线一致。

写了什么（可逐条核对）：

- **`README.md`**：特性表补「自定义路径类型 / 自定义区域类型 / 定义文件导入 / 导出」三行，
  并把「SVG 导出」扩成「SVG / PNG 导出」（含可选范围）；新增三节 ——
  `### 自定义路径类型`、`### 自定义区域类型`、`### 定义文件：把自定义定义带到别的库`；
  设置表把过时的「路径颜色（4 种）」「区域颜色（6 个预设）」换成「路径类型」「区域类型」；
  「数据与文件」由两类变三类（多了定义文件）；「兼容性与已知限制」补两条
  （区域类型的不透明度与边框不进导出、定义文件只装自定义类型）。
- **`docs/USER-MANUAL.md`**：§1 能力清单补三条；§1.1 面板分组名从**错的**「地图文件与导出」
  改成代码里真实的「**文件与导出**」并补齐动作；§6.1 路径改为"在类型下拉里选"；
  **顺手修掉两个小节都编号 `6.2` 的重号**（区域改为 `6.3`）；新增 `### 6.4 自定义路径类型与区域类型`；
  §9 命令表补两条命令并新增 `### 9.2 定义文件`；§10「当前设置」重写为类型目录口径。
- **`CHANGELOG.md`**：`[未发布]` →「新增」补 **⑤-1 自定义路径类型**（含"未知 `type` 以前会丢整条路径"的
  数据保全修复）、**⑤-2 自定义区域类型**（含旧地图不补 `type`、图例按颜色回查）、
  **③ 定义文件四类导入导出**、**工具条类型下拉缺陷**（收起下拉的那一击不再顺手落一个顶点）、
  **"调色模式下看不到图片入口"缺陷**；「变更」补"路径与区域的样式设置改成按类型定义"。

口径提醒（写给下一位）：文档里所有类型名与参数范围都是**从源码取出来的**
（内置区域类型是「王国 / 帝国 / 公国 / 教区 / 荒原 / 海域」，来自 `shapeStyle.REGION_PRESETS`），
**不要凭印象写**。仍留在文档之外的：⑤ 下拉浮层的真实观感、`styles.css` 无自动断言、
导出侧缺口（标记图标 / 区域参数）—— 都记在 `ENGINEERING-NOTES.md` §7。

