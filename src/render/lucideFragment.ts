/**
 * 把 **Lucide 图标名** 变成一段可内联进导出 SVG 的片段（`<path …/>` 之类）。
 *
 * 为什么单独一个模块：需要它的地方有**三条链路** —— SVG 导出、PNG 导出（同一份 SVG 再光栅化）、
 * Base 缩略图。各写一遍的话，迟早出现"缩略图里有字形、导出里还是小圆点"这种只有用户会发现
 * 的偏差（本项目已经因为"抄一份调色板"出过一次真事故，见 `mapPreview.ts` 的注释）。
 *
 * 它 import obsidian（`getIcon`），所以与 `MarkerLayer` 同类：**不纯**，只做这一件小事。
 * 纯几何那一侧（`mapPreview.ts`）通过 `iconSvgFor` 注入来用它，于是导出逻辑本身仍可单测。
 */

import { getIcon } from 'obsidian'

/**
 * `getIcon()` 返回的是一个完整的 `<svg>` 元素（含 Obsidian 自己的 class / 尺寸）。
 *
 * 导出只需要它**里面的图形**：外层 `<svg>` 带进去没有意义，它的 class 还可能撞上宿主主题的
 * CSS（那一份 CSS 在导出文件里并不存在）。所以只取子元素、拼成片段。
 *
 * 取不到图标（名字不存在、或这个版本没有这个图标）返回 `null` —— 调用方据此**回退成兜底圆点**，
 * 而不是留下一个空洞（"对象消失"比"形状不对"严重得多）。
 */
export function lucideIconFragment(iconName: string): string | null {
  if (typeof iconName !== 'string' || iconName.length === 0) return null
  const icon = getIcon(iconName)
  if (icon === null || icon === undefined) return null
  const parts: string[] = []
  for (const child of Array.from(icon.children)) parts.push(child.outerHTML)
  return parts.length > 0 ? parts.join('') : null
}