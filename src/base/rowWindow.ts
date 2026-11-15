/**
 * Base 表格的**分批显示**窗口计算（纯函数，可单测）。
 *
 * 起因：`README.md` 的「兼容性与已知限制」自己写着「Base 表格一次性建表，未做虚拟滚动（几百行会变慢）」。
 * 真做滚动虚拟化要自己接管滚动容器 + 固定行高，而 Base 视图的滚动归 Obsidian 管；
 * 这里选**分批追加**：先画 100 行，底部给一个「再显示 100 条」的按钮 —— 首屏恒定、点一次多 100 行，
 * 没有固定行高的假设，也不会和宿主的滚动打架。
 *
 * 这个函数只算「这一批画到第几行、还剩几行」，不碰 DOM ——
 * 于是「会不会漏行 / 会不会重复画」这类最容易出错的地方能被单测钉死。
 */

/** 一批画多少行（首屏与每次追加都是它） */
export const BASE_ROW_CHUNK = 100

export interface RowWindow {
  /** 这一批画完之后，已经显示的**行数**（也就是下一批的起点） */
  shown: number
  /** 这一次新画的行区间 [start, end) */
  start: number
  end: number
  /** 还剩多少行没画（0 = 画完了，不该再给按钮） */
  remaining: number
}

export function nextRowWindow(
  total: number,
  shown: number,
  chunk: number = BASE_ROW_CHUNK,
): RowWindow {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const safeChunk = Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : BASE_ROW_CHUNK
  const safeShown = Math.min(Math.max(Number.isFinite(shown) ? Math.floor(shown) : 0, 0), safeTotal)
  const end = Math.min(safeTotal, safeShown + safeChunk)
  return { start: safeShown, end, shown: end, remaining: safeTotal - end }
}
