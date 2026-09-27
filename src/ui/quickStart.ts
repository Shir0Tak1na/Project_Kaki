/**
 * 「快速上手」清单的两份文案（**纯数据**，不 import obsidian，因此可单测）。
 *
 * ## 为什么是两份
 *
 * 用户连着两轮说"功能引导不清晰"。引导要落地，就得回答一个具体问题：**你现在站在哪。**
 * 站在设置页的人想知道"怎么开始画"；站在侧栏面板的人想知道"画的时候能干什么"。
 * 一份通用文案两边贴，等于哪边都没说清 —— 所以两处各有一份**各自讲各自入口**的清单。
 *
 * 边界：这里**只放文字与命令 id**，不放界面代码（渲染在 `SettingsTab` / `MapPanel` 里）。
 * 于是文案可以单测（每个 `commandId` 必须真在动作注册表里，防止指向已被删掉的命令）。
 */

export interface QuickStartItem {
  /** 一行说清"做什么" */
  title: string
  /** 补一句"怎么做 / 在哪找"，不写教程 */
  hint: string
  /**
   * 对应的命令 id（与 `main.ts` 的 `buildActions()` 对齐）。
   *
   * 有它就说明"这一步可以一键执行"；没有它表示这一步是**指路**（例如"去侧栏改单个对象"），
   * 没有对应命令可点。冒烟会断言这里出现的每个 id 都真在插件注册的命令里。
   */
  commandId?: string
}

/**
 * 设置页那份：从"还没开始"讲到"下一步该去哪"。
 *
 * 讲的是**入口**（面板在哪、地图怎么建），以及一条最重要的分工：
 * **改单个对象去侧栏，改默认值才来这里。**
 */
export const QUICK_START_SETTINGS: readonly QuickStartItem[] = [
  {
    title: '打开地图面板',
    hint: '右侧边栏的「地图」视图（左侧边栏也有图标）。绘制、导出、撤销都在那里。',
    commandId: 'open-map-panel',
  },
  {
    title: '创建地图并绑定到当前 Canvas',
    hint: '先打开一张 Canvas，再执行它 —— 生成的地图文件会记下这张 Canvas。',
    commandId: 'create-map',
  },
  {
    title: '启用地图层',
    hint: '地图层启用后画布才认得地图文件；工具条会出现在画布上。',
    commandId: 'toggle-map-layer',
  },
  {
    title: '进入绘制模式',
    hint: '按 D 或点工具条上的铅笔：左键绘制，Esc 退出。',
    commandId: 'toggle-edit-mode',
  },
  {
    title: '改**单个**对象 → 去侧栏',
    hint: '在画布上点一个对象，右侧面板会给出它的类型 / 位置 / 外观。下面这些设置只管**新画出来的**对象。',
  },
  {
    title: '新增 / 删除 / 改 ID 定义 → 去「地图定义…」',
    hint: '自定义地形、标记、路径类型、区域类型的增删改都搬到了侧栏面板 →「地图定义」→「管理地图定义…」。',
    commandId: 'manage-definitions',
  },
]

/**
 * 面板那份：讲"画的时候能干什么"。
 *
 * 这里**不再重复**"怎么建地图"（那是设置页第一屏的事），只讲手边这几个动作。
 */
export const QUICK_START_PANEL: readonly QuickStartItem[] = [
  {
    title: '按 D 进入绘制模式',
    hint: '再按一次（或 Esc）回到选择模式 —— 选择模式下点对象才是"选中"而不是"落笔"。',
    commandId: 'toggle-edit-mode',
  },
  {
    title: '画错了按 Ctrl+Z',
    hint: '地形、路径、区域、标记的编辑都进撤销栈，可连续撤销。',
    commandId: 'undo-map-edit',
  },
  {
    title: '点了对象就在下面改它',
    hint: '「选中的对象」一区会给出名称、链接，以及类型 / 位置 / 外观三组（默认收起）。改的是这一个对象，可撤销。',
  },
  {
    title: '导出这张地图',
    hint: '可选范围（全部内容 / 当前视口 / 某个区域）与格式（SVG / PNG）。',
    commandId: 'export-map',
  },
  {
    title: '把自定义定义带到别的库',
    hint: '「导出定义文件…」把自定义地形 / 标记 / 路径类型 / 区域类型打成一份 JSON；导入是只增不删的。',
    commandId: 'export-resource-bundle',
  },
]