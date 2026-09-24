/**
 * 「库内图片路径 → 资源地址」的**唯一实现**。
 *
 * 为什么单独一个模块：这条逻辑现在有两个调用方 ——
 * - 绘制层要把自定义标记的图片放进 `<img src>`（`MapLayerManager` 注入给标记层与工具条）；
 * - 设置页要在图标旁边画一张预览，让用户改完立刻看到长什么样。
 *
 * 两处各写一遍的后果很具体：会出现"设置页看得到预览、画布上却是破图"这种没法解释的差异
 * （两边的 API 顺序或回退条件只要差一点就会这样）。所以取值顺序只在这里写一次。
 *
 * ⚠️ 它必须是**同步**的：`<img src>` 在赋值当场就要地址，没有等待的余地。
 * 因此"取不到"只能表达成空串，由调用方回退（标记回退字形、预览不画图）。
 * 绝不要为了"能返回点什么"而编一个地址出来 —— 那会变成一张破图，比回退更难看也难查。
 */

import type { App, TFile } from 'obsidian'

/**
 * 取所需 API。
 *
 * 两个方法都比 obsidian 的类型声明宽，而且都**可能不存在**：
 * `Vault.getResourcePath` 是官方 API，`adapter.getResourcePath` 是 1.5 之前的老写法；
 * 移动端与非文件系统适配器上两者都可能缺失。所以这里全标可选，由调用方决定回退。
 */
interface ResourceVault {
  getAbstractFileByPath?: (path: string) => unknown
  getResourcePath?: (file: TFile) => string
  adapter?: { getResourcePath?: (path: string) => string }
}

export function resolveVaultResourceUrl(app: App | undefined, path: string): string {
  if (path.length === 0) return ''
  const vault = app?.vault as (App['vault'] & ResourceVault) | undefined
  if (!vault) return ''
  try {
    // 优先官方 API：先按路径拿到文件对象，再取它的资源地址
    const file = vault.getAbstractFileByPath?.(path)
    if (file !== undefined && file !== null && typeof vault.getResourcePath === 'function') {
      return vault.getResourcePath(file as TFile)
    }
    // 退回老写法（1.5 之前）：直接按路径取
    if (typeof vault.adapter?.getResourcePath === 'function') return vault.adapter.getResourcePath(path)
  } catch (error) {
    console.warn(`[project-kaki] 无法取得 ${path} 的资源地址，已按"这张图现在不可用"处理`, error)
  }
  return ''
}
