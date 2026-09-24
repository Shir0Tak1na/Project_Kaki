/**
 * 库内图片清单 —— 给"从库里选一张图"用的纯函数模块（**不 import obsidian**）。
 *
 * 为什么需要它：
 * 1. 用户不想手打 `Assets/forest.png` 这种路径（记不住目录、也容易打错扩展名）；
 * 2. **Obsidian 没有暴露系统级文件选择对话框**，所以"选文件"只能是"从库里的文件挑"——
 *    这也符合插件的使用方式：图片放进库，地图文件里存**库内相对路径**，
 *    这样换台机器、把库同步过去，图片仍然找得到。用系统对话框选一个库外的文件，
 *    路径在别人机器上必然失效。
 *
 * 三条设计约束：
 * - **扩展名白名单与 `terrainCatalog` 同源**（`IMAGE_EXTENSIONS`）：列出来的必须都是校验会接受的，
 *   否则用户会遇到"选了却被拒"；
 * - **顺序必须确定**（否则每次打开弹窗顺序都在变，用户没法形成肌肉记忆，测试也没法钉住）；
 * - 纯函数、不碰 vault：谁去列文件由调用方决定，于是没有 Obsidian 也能测。
 */

import { IMAGE_EXTENSIONS } from '../render/terrainCatalog.ts'

/** 取小写扩展名（不含点）；没有扩展名时返回空串 */
export function imageExtensionOf(path: unknown): string {
  if (typeof path !== 'string') return ''
  const text = path.trim()
  const dot = text.lastIndexOf('.')
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  // 点在目录里（`Assets.v2/foo`）不算扩展名
  if (dot <= slash + 1 || dot === text.length - 1) return ''
  return text.slice(dot + 1).toLowerCase()
}

/** 是不是一张可用的图片路径（按扩展名白名单判断，大小写不敏感） */
export function isImagePath(path: unknown): boolean {
  const extension = imageExtensionOf(path)
  return extension.length > 0 && IMAGE_EXTENSIONS.includes(extension)
}

/** 文件名（不含目录） */
export function assetNameOf(path: string): string {
  const text = path.trim()
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return slash >= 0 ? text.slice(slash + 1) : text
}

/** 所在文件夹（根目录返回空串） */
export function assetFolderOf(path: string): string {
  const text = path.trim()
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return slash > 0 ? text.slice(0, slash) : ''
}

/**
 * 弹窗里那一行短标签：`forest.png · Assets/地形`
 *
 * 为什么把文件夹也带上：同一个 `icon.png` 在库里可能有好几份，
 * 只显示文件名会让用户在两行一模一样的条目里做选择。
 */
export function describeAssetChoice(path: string): string {
  const name = assetNameOf(path)
  const folder = assetFolderOf(path)
  return folder.length > 0 ? `${name} · ${folder}` : name
}

/**
 * 从"一串库内路径"里筛出可用的图片，去重并**确定排序**。
 *
 * 排序用码点比较（不用 `localeCompare`）：后者的结果取决于运行环境的语言与 ICU 版本，
 * 同一份库在不同机器上会排出不同顺序 —— 那正好毁掉"顺序确定"这条约束。
 */
export function listImagePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const unique = new Set<string>()
  for (const item of paths) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/\\/g, '/')
    if (!isImagePath(text)) continue
    unique.add(text)
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 库内没有可用图片时的可读提示。
 *
 * 放在这里而不是散在 UI 里：这句话要说清"为什么没有"和"我该做什么"，
 * 而且它同时会被设置页与（将来的）标记图标选择器用到 —— 一份文案，一个来源。
 */
export function emptyImageListHint(): string {
  return `库里没有找到图片文件（支持 ${IMAGE_EXTENSIONS.join(' / ')}）。先把图片拖进库（例如放进 Assets/），再回来选。`
}

/**
 * 定义文件的扩展名（唯一白名单）。
 *
 * 与图片那套一样：**列出来的必须都是校验会接受的**。定义文件就是 JSON，
 * 这里只认 `.json`，于是"选文件"这一步不需要用户理解格式。
 */
export const BUNDLE_EXTENSIONS: readonly string[] = ['json']

/** 是不是一份定义文件（按扩展名判断，大小写不敏感） */
export function isBundlePath(path: unknown): boolean {
  const extension = imageExtensionOf(path)
  return extension.length > 0 && BUNDLE_EXTENSIONS.includes(extension)
}

/**
 * 从"一串库内路径"里筛出定义文件，去重并确定排序。
 *
 * 排序规则与 `listImagePaths` 一致（码点比较，不用 `localeCompare`）：
 * 同一份库在不同机器上必须排出同样的顺序。
 */
export function listBundlePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const unique = new Set<string>()
  for (const item of paths) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/\\/g, '/')
    if (!isBundlePath(text)) continue
    unique.add(text)
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 库里没有定义文件时的可读提示（与 `emptyImageListHint` 同一套写法） */
export function emptyBundleListHint(): string {
  return `库里没有找到定义文件（${BUNDLE_EXTENSIONS.map((extension) => `.${extension}`).join(' / ')}）。先用「导出定义文件…」生成一份，或者把别人给你的定义文件放进库。`
}
