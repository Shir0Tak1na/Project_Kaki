/**
 * 「浮层会不会压住 Obsidian 原生控件」的**纯几何**部分。
 *
 * 为什么单独成文件：`src/dev/diagnostics.ts` 顶部 import 了 obsidian，
 * 而单测跑在 Node 的 ESM + 类型剥离下**没有 obsidian 模块**（`tests/quickStart.test.ts` 里记过这条），
 * 所以判定逻辑必须住在不依赖宿主的模块里，才能被单测钉死。
 *
 * 这条线要回答的是 `ISSUES.md` ISSUE-004 §4 第 5 条：
 * 「窄窗口下浮框不遮挡 Obsidian 原生控件（左上角需实机确认）」—— 把目测换成可读的数字。
 */

export interface ElementRect {
  /** 报告里显示的名字，通常就是选择器（例如 `.fc-toolbar`） */
  name: string
  left: number
  top: number
  right: number
  bottom: number
}

/** 两个矩形是否**真的**重叠：重叠面积 > 0 才算（只是贴边不算） */
export function rectsOverlap(a: ElementRect, b: ElementRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface BoundsLike {
  left?: unknown
  top?: unknown
  right?: unknown
  bottom?: unknown
  width?: unknown
  height?: unknown
}

/**
 * 从 `getBoundingClientRect()` 的返回值取矩形。
 *
 * 兼容只有 `width` / `height`（没有 `right` / `bottom`）的桩 —— 冒烟测试里的假元素就是这样。
 * `left` / `top` 缺失时返回 null（宁可不报，也不要报一个 (0,0) 的假矩形）。
 */
export function rectFromBounds(name: string, raw: BoundsLike | null | undefined): ElementRect | null {
  if (!raw) return null
  const left = readNumber(raw.left)
  const top = readNumber(raw.top)
  if (left === null || top === null) return null
  const width = readNumber(raw.width) ?? 0
  const height = readNumber(raw.height) ?? 0
  return {
    name,
    left,
    top,
    right: readNumber(raw.right) ?? left + width,
    bottom: readNumber(raw.bottom) ?? top + height,
  }
}

function describeRect(rect: ElementRect): string {
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  return '`' + rect.name + '` ' + width.toFixed(0) + '×' + height.toFixed(0) + ' @ (' + rect.left.toFixed(0) + ', ' + rect.top.toFixed(0) + ')'
}

/**
 * 逐对比较浮层与原生控件，返回可直接贴进报告的行。
 *
 * 判定口径（可判伪）：
 * - 有重叠 ⇒ ⚠️ 并列出每一对的重叠尺寸（宽 × 高，px）；
 * - 全不重叠 ⇒ ✅ 并写明**比了多少组** —— 否则「一个元素都没找到」会被误读成「没有重叠」；
 * - 浮层为空（地图层没启用 / 这个视图没有浮层）与原生控件为空（类名变了）**分开报**。
 */
export function describeOverlayCollisions(overlays: ElementRect[], natives: ElementRect[]): string[] {
  const visible = (list: ElementRect[]) => list.filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
  const ours = visible(overlays)
  const theirs = visible(natives)
  if (ours.length === 0) return ['- 没有可测量的浮层（地图层未启用，或这个视图里没有浮层）']
  const lines = ['- 我方浮层（' + ours.length + '）：' + ours.map(describeRect).join(' · ')]
  if (theirs.length === 0) {
    lines.push('- ⚠️ 没有找到 Obsidian 画布原生控件（类名可能随版本变化）—— 需要人工确认左上角')
    return lines
  }
  lines.push('- 原生控件（' + theirs.length + '）：' + theirs.map(describeRect).join(' · '))
  const overlaps: string[] = []
  for (const over of ours) {
    for (const native of theirs) {
      if (!rectsOverlap(over, native)) continue
      const width = Math.min(over.right, native.right) - Math.max(over.left, native.left)
      const height = Math.min(over.bottom, native.bottom) - Math.max(over.top, native.top)
      overlaps.push('`' + over.name + '` × `' + native.name + '` = ' + width.toFixed(0) + '×' + height.toFixed(0) + ' px')
    }
  }
  lines.push(
    overlaps.length === 0
      ? '- ✅ 逐对比较 ' + ours.length * theirs.length + ' 组，没有一组重叠 —— 浮层没有压住原生控件'
      : '- ⚠️ ' + overlaps.length + ' 组重叠：' + overlaps.join('；'),
  )
  return lines
}
