/**
 * 数值图层笔刷的**逐格算法**（施工文件 §E 那张表的唯一实现）。
 *
 * 为什么从 `MapEditor` 里搬出来：这一段没有任何宿主依赖（不需要 Canvas、不需要 Obsidian），
 * 却是"深度 / 温度笔刷为什么不动"这类问题的**全部答案**；留在 2000 行的编辑器里，
 * 就只能靠冒烟场景间接碰到，没法单独判对错（`FEATURE-AUDIT.md` §2 记的"深度笔刷无专测"就是这条）。
 *
 * 两张表：
 * - `applyBrushOp`：**算式**（这一格算出来是多少，`undefined` = 算不出来）；
 * - `brushCellValue`：**这一格到底动不动**（算式 + "值相同就不动"）。
 *
 * 调用方拿到的 `undefined` 一律表示**这一格笔刷不碰它**：不进历史、不算"划过"、
 * 也不触发"这一笔没有改变任何格"之外的任何反馈。
 */

/** 数值图层笔刷的算法（施工文件 §E）。`set` 也用于**分类字段**（生物群系设成某个 ID） */
export type BrushOp = 'set' | '+' | '-' | '×' | '÷'

/**
 * 这一格按算式应该是多少；`undefined` = **算不出来**（三种情况）：
 *
 * - `× / ÷` 遇到没有值的格（拿"没量过"去乘没有意义）；
 * - 结果不是有限数（`÷ 0` 已在 `brushReadiness` 整笔拦下，这里是最后一道保险）；
 * - `set` 的输入本身不是有限数。
 *
 * `+ / −` 的**无值格从 `fallback`（每格默认值）起算，没有就 0**：
 * 这是刻意行为（§E 写明"会把默认值固化进这一格"），所以 UI 上必须说明 —— 见 `MapPanel` / 工具条。
 */
export function applyBrushOp(
  op: BrushOp,
  previous: number | undefined,
  value: number,
  fallback: number | undefined,
): number | undefined {
  if (op === 'set') return Number.isFinite(value) ? value : undefined
  if (op === '×' || op === '÷') {
    if (previous === undefined) return undefined
    const next = op === '×' ? previous * value : previous / value
    return Number.isFinite(next) ? next : undefined
  }
  const base = previous ?? fallback ?? 0
  const next = op === '+' ? base + value : base - value
  return Number.isFinite(next) ? next : undefined
}

/**
 * 这一格**写进去什么值**；`undefined` = **这一格不动**。
 *
 * 比 `applyBrushOp` 多一条判据：**值相同就不动**。否则"重刷一遍同样的温度/深度"
 * 会产生一大堆没有变化的历史条目（撤销一次却什么都没变），而用户也看不见任何反馈。
 *
 * 注意 `previous === undefined` 时**不算相同**：`set 5` 落到没有值的格上是一次真实写入。
 */
export function brushCellValue(
  op: BrushOp,
  previous: number | undefined,
  value: number,
  fallback: number | undefined,
): number | undefined {
  const next = applyBrushOp(op, previous, value, fallback)
  if (next === undefined) return undefined
  if (previous !== undefined && previous === next) return undefined
  return next
}
