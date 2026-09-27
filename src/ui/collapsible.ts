/**
 * 可折叠分组（`<details>` + `<summary>`）的唯一实现。
 *
 * 为什么抽出来：折叠这件事本轮要在**三处**用（设置页的「图层 / 新对象默认值」、
 * 「地图定义」弹窗的四组、侧栏检查器原有的三组）。三处各写一遍的话，
 * 迟早出现"某处忘了显式 `open = false`"——而假 DOM 里没有 `open` 属性，
 * 那种偏差在测试里表现为"默认收起"这条断言**静默失效**（见 `ENGINEERING-NOTES.md` §5.33）。
 *
 * 一条必须守住的细节：`open = false` 要**显式写**。`<details>` 在真实浏览器里默认就是收起，
 * 所以不写也能跑；但测试用的假 DOM 是一个普通对象，不显式赋值就没有这个成员 ——
 * 断言"默认收起"就成了空转。
 */

export interface CollapsibleGroupOptions {
  /** 标题（写在 `<summary>` 里，点击展开/收起） */
  title: string
  /** `<details>` 的 class（默认沿用侧栏检查器的 `fc-selection-group`） */
  cls?: string
  /** `<summary>` 的 class（默认 `fc-selection-group-title`） */
  titleCls?: string
  /**
   * 稳定标记（`dataset.fcGroup`）：自动化测试据此按角色定位某一组，
   * 不必依赖标题文字（文案会改，角色名不该改）。
   */
  role?: string
  /**
   * 初始是否展开（缺省收起）。
   *
   * 为什么要这个参数：面板**每次改完一个字段就整块重建**，重建出来的 `<details>` 一律收起 ——
   * 用户改一个值就要重新点开一次（真实库里的反馈）。所以重建前要把"哪些组是展开的"读回来，
   * 再从这里传进去（见 `MapPanel` 的 `captureOpenGroups`）。
   */
  open?: boolean
}

/** 建一个折叠组（默认收起），返回那个 `<details>`（往它里面继续建内容即可） */
export function createCollapsibleGroup(parent: HTMLElement, options: CollapsibleGroupOptions): HTMLDetailsElement {
  const details = parent.createEl('details', { cls: options.cls ?? 'fc-selection-group' })
  if (options.role !== undefined) details.dataset.fcGroup = options.role
  // 显式赋值：假 DOM 里没有 `open` 属性时，断言"默认收起"才有意义
  details.open = options.open ?? false
  details.createEl('summary', { cls: options.titleCls ?? 'fc-selection-group-title', text: options.title })
  return details
}