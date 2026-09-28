# 生物群系分类（设定来源：真实库 · 世界设定集）

> **来源**：`D:\TOS\万千旅路｜Thousands of Sands\世界设定集\大地勘探\地理概述.md`（**只读引用**）
> 与其中引向的 `[[生物群系志]]`。**设定文件不归插件管**：插件只消费"有哪些分类"，不改写它。
>
> **这份文件的作用**：给 `DATA-LAYER-PLAN-v5.md` §D（生物群系）提供**已确定的分类表**、
> **稳定 ID** 与**标签**，并说明命名与筛选器怎么配合（§3，参照 Minecraft 的成熟做法）。

---

## 1. 分类表（共 37 条；「待定 3 条」不入目录）

> `标签` 一列是**筛选器与配色的依据**（一个群系可以有多个标签，见 §3）。
> 标签分四类：**层位**（surface / underground / sky）· **气候**（polar / boreal / temperate /
> mediterranean / subtropical / tropical / arid / alpine）· **植被**（forest / grassland / shrub /
> desert / wetland）· **特殊**（artificial / aquatic / nether / ore / mountain / dry / wet）。

### 1.1 地表（18 条）

| # | 显示名 | 稳定 ID | 标签 |
|---|---|---|---|
| 1 | 冰盖及极地荒漠 | `ice-cap` | surface · polar · desert |
| 2 | 冻原 | `tundra` | surface · polar · grassland |
| 3 | 针叶林 | `conifer` | surface · boreal · forest |
| 4 | 温带阔叶林 | `temperate-broadleaf` | surface · temperate · forest |
| 5 | 温带草原 | `temperate-grassland` | surface · temperate · grassland |
| 6 | 地中海硬叶林 | `mediterranean-sclerophyll` | surface · mediterranean · shrub |
| 7 | 山地森林 | `montane-forest` | surface · temperate · forest · mountain |
| 8 | 高山苔原 | `alpine-tundra` | surface · alpine · grassland |
| 9 | 亚热带雨林 | `subtropical-rainforest` | surface · subtropical · forest · wet |
| 10 | 亚热带干燥林 | `subtropical-dry-forest` | surface · subtropical · forest · dry |
| 11 | 季风雨林 | `monsoon-forest` | surface · subtropical · forest · wet |
| 12 | 热带雨林 | `tropical-rainforest` | surface · tropical · forest · wet |
| 13 | 稀树草原 | `savanna` | surface · tropical · grassland |
| 14 | 多树草原 | `tree-savanna` | surface · tropical · grassland · forest |
| 15 | 沙漠 | `desert` | surface · arid · desert |
| 16 | 近沙漠 | `near-desert` | surface · arid · desert |
| 17 | 半干旱沙漠 | `semi-arid-desert` | surface · arid · desert |
| 18 | 干旱草原 | `arid-grassland` | surface · arid · grassland |

### 1.2 地下（12 条）

| # | 显示名 | 稳定 ID | 标签 |
|---|---|---|---|
| 1 | 地下洞穴 | `under-cave` | underground |
| 2 | 地下苔穴 | `under-moss-cave` | underground · wet |
| 3 | 地下特殊岩石群系 | `under-special-rock` | underground |
| 4 | 地下矿脉 | `under-ore-vein` | underground · ore |
| 5 | 地下城 | `under-city` | underground · artificial |
| 6 | 古地下城 | `under-ancient-city` | underground · artificial |
| 7 | 地下径流 | `under-runoff` | underground · aquatic |
| 8 | 地下湖 | `under-lake` | underground · aquatic |
| 9 | 地下微光湖 | `under-glimmer-lake` | underground · aquatic · wet |
| 10 | 近地狱灰烬带 | `under-hell-ash` | underground · nether |
| 11 | 地狱 | `under-hell` | underground · nether |
| 12 | 地狱城 | `under-hell-city` | underground · nether · artificial |

> 设定里地下**分层一直分到 12000 km 深**。本插件目前只有**一层** `biome` 字段，所以地下各条暂时平铺；
> 将来做"深度分层"时，这些条目正好可以按深度带上色 —— 本轮不做。

### 1.3 高空（4 条）

| # | 显示名 | 稳定 ID | 标签 |
|---|---|---|---|
| 1 | 空岛 | `sky-island` | sky |
| 2 | 云岛 | `sky-cloud-island` | sky |
| 3 | 乌云岛 | `sky-dark-cloud-island` | sky · wet |
| 4 | 特殊生物驻扎地 | `sky-special-station` | sky · artificial |

### 1.4 待定（**本轮不入目录**）

| 显示名 | 建议 ID | 为什么先不入 |
|---|---|---|
| 海洋 | `ocean` | 设定明确"按温度区分"⇒ 需要子类型（热带海 / 温带海 / 极地海…），先等细分 |
| 复合型湿地 | `compound-wetland` | 设定标注"可能未被描述"，尚无逐条说明 |
| 特殊地貌 | `special-landform` | 同上；且与"地物"边界不清 |

**处理方式**：这三条**不注册进分类表**（否则笔刷/筛选器/图例会把它们当成已定分类）。

---

## 2. 不属于生物群系（**不要**加进目录）

设定明确：**地物不是生物群系** —— 「失乐园」「砂时间」「微光海」一类另有条目
（`地理概述.md` 末段原文即如此界定）。实现上的含义：目录里**只放** §1 的分类；
地物将来若要做，走**另一类对象**，不要塞进 `biome`。

---

## 3. 命名与筛选器（参照 Minecraft；**这一节回答"ID 要不要带 biome"**）

### 3.1 Minecraft 是怎么做的（[Biome definition (Java Edition)](https://minecraft.wiki/w/Biome_definition_(Java_Edition))）

- 群系存放于 `data/<namespace>/worldgen/biome` ⇒ ID 形如 **`minecraft:snowy_plains`**（命名空间 + snake_case）；
- 数据包可以添加**同名的其它命名空间**群系，所以命名空间是**全局唯一性**的需要；
- 群系 JSON 的字段：`has_precipitation`、`temperature`、`temperature_modifier`、`downfall`、
  `effects`（`water_color`（必填）、`foliage_color`、`dry_foliage_color`、`grass_color`、
  `grass_color_modifier`）、`carvers`、`features`、`attributes`；
- **关键历史**：`1.19`（22w11a）**删除了群系的 `category` 字段，功能整体移到"群系标签"**；
  `1.19.4` 把 `precipitation` 改名并收敛为布尔 `has_precipitation`；
  `1.21.11` 把 `sky_color` / `fog_color` 等从 `effects` 里**移出**（移到环境属性）。

**从这三条能学到的**：① 分类**不要做成群系上的一个枚举字段**（一个群系常同时属于多个组：
「山地森林」既是 temperate 又是 forest 又是 mountain）；② 用**标签**表达可多选的归类；
③ 颜色这类"每条自带"的数据要保持**小而明确**，不要堆成大杂烩。

### 3.2 我们的决定

**决定一：内置 ID 不加 `biome:` 前缀**（保持 `ice-cap` 这样的裸 slug）。

理由：
1. 筛选器的**键**已经携带字段语义（`biome` 与 `terrain` / `temp` / `depth` 平级），
   值再加前缀就成了 `"biome": "biome:ice-cap"` 这样的双重命名；
2. 与仓库既有约定一致：内置地形/标记/路径类型/区域类型都是**裸 ID**，
   只有**用户自定义**才带 `custom:` 前缀；
3. 用户自定义生物群系照样用 `custom:xxx` ⇒ 现成的"未知值原样保留"与"改 ID 并迁移引用"
   两套机制**不用改一行**就能复用；
4. 命名空间解决的是"全局 id 空间撞名"，而我们的 `biome` 值空间**只属于这一个字段**，不撞。

> 如果将来要做"统一的资源选择器"（跨字段共享值空间、能选地形也能选群系），
> 那时再加命名空间也不迟：**未知值一律保留**这条纪律保证了老文件不会因此坏掉。

**决定二：真正照顾筛选器的是「标签」，不是前缀。**

实现照 Minecraft 的 tags：
- 目录里每条 biome 带一个**标签集**（§1 的 `标签` 列）；
- 筛选器的**规则登记表**（`DATA-LAYER-PLAN-v5.md` §C.2）加**两条**生物群系规则：
  - `biome`：精确匹配（`in [...]`，枚举多选，值 = §1 的 34 个 ID）；
  - `biomeTag`：按标签匹配（`in [forest, polar, ...]`）；
- 效果：34 个值逐个勾 → 变成 **8 组（层位/气候/植被/特殊）** 里挑几个，
  而且允许**一对多**（"所有森林类"= `biomeTag in [forest]`，一次命中 7 条）。

**决定三：配色改成"每条自带颜色 + 组内默认"。**

Minecraft 让每个群系自带 `grass_color` / `foliage_color` / `water_color`，
而不是"由大类推颜色"。我们照做：
- 目录条目自带一个颜色（写在地图文件之外的**目录**里，不进 `biome` 值本身）；
- §4 的分组只提供**默认值**，用户可逐条覆盖；
- 这样"分类表可整表替换"才真正成立：换一份分类表 = 换一批条目（含颜色），不需要改代码。

---

## 4. 配色分组（作为"每条自带颜色"的默认值）

| 组 | 成员 | 默认色相建议 |
|---|---|---|
| 极地 / 寒带 | `ice-cap` `tundra` `conifer` | 冷白 → 蓝灰 → 深青 |
| 温带 | `temperate-broadleaf` `temperate-grassland` `mediterranean-sclerophyll` `montane-forest` | 中绿 → 黄绿 → 橄榄 → 深绿 |
| 高山 | `alpine-tundra` | 灰紫（与寒带区分） |
| 亚热带 / 季风 | `subtropical-rainforest` `subtropical-dry-forest` `monsoon-forest` | 青绿 → 黄褐 → 深青绿 |
| 热带 | `tropical-rainforest` `savanna` `tree-savanna` | 浓绿 → 金黄 → 橙绿 |
| 干旱 | `desert` `near-desert` `semi-arid-desert` `arid-grassland` | 沙黄 → 浅沙 → 土黄 → 暗金 |
| 地下 | 12 条 | 暗冷色系，**按 ID 顺序逐渐加深**（洞穴 → 湖 → 地狱） |
| 高空 | 4 条 | 亮浅色系（天蓝 → 云白 → 铅灰 → 亮青） |

---

## 5. 实现要点（与本仓库既有纪律对齐）

1. **数据**：`TerrainCell.biome?: string`；必须同时进 `KNOWN_CELL_KEYS`
   （`src/data/mapDocument.ts:402`）与 `cellToJson` 的**固定顺序**，
   否则会被当成"未知格字段"原样保留却**不参与渲染与统计**。
2. **未知 ID 一律保留**（§5.11）：别的库/别的版本写下的 biome 不许改写，渲染走回退。
3. **稳定 ID 不可改**：以上 ID 一旦发出去就写进用户的 `.map.md`；要改名只能"加新 ID + 迁移"
   （迁移机制已存在：「改 ID 并迁移引用」）。
4. **目录工厂**：与自定义地形/标记同一套工厂；**内置集 = §1 的 34 条**（18 + 12 + 4），
   每条带 `标签[]` 与 `颜色`；设置页注明"**分类表可整表替换**"。
5. **加一条分类 = 加一行**（与"加一个数据层字段 = 加两行"同一纪律）；
   **加一个标签 = 改一行**。
6. **不做**：不定义气候模型、不按纬度自动分配 biome（那是玩法，不是列表）；
   **不引入 Minecraft 的 `carvers` / `features` 那套生成管线**（我们只做视觉与筛选）。

---

## 6. 与本插件其它部分的关系

- **温度 / 深度**：设定给了行星参数（6 S⊕、自转 24 h、公转 540 天、轴倾角约 23.5°、
  3 颗卫星潮汐 9/15/40 天、恒星「元」F8V）。这是将来"按纬度带推温度"的素材，**本轮不用**。
- **图例**：用现有的"按类型计数"条目（`kind: 'types'`）。
- **笔刷**：枚举型 → 只有「设为某个 ID」。

---

## 7. 需要你确认的两点（不阻塞实现）

1. **海洋要不要现在细分？** 设定说"按温度区分"但没给子类名。给出（例如 极地海 / 温带海 /
   亚热带海 / 热带海）我就加 4 行；不给就维持"不入目录"。
2. **ID 拼写：保持 kebab（`ice-cap`，与仓库其它 ID 一致）还是照 Minecraft 的 snake（`ice_cap`）？**
   功能上无差别；**现在是唯一零成本切换的时刻**（还没有任何地图文件写过 biome 值）。
   我建议保持 kebab：本仓库的地形/自定义 ID 都是 kebab，一致性比"像 Minecraft"更值钱。
