/**
 * 把自定义标记的库内图片**派生**成一张小的、有上限的 data URL —— 只给导出用。
 *
 * 为什么不在导出里直接用原图：
 * - 导出文件必须能**脱离库单独打开**，所以不能写 `app://…`（那只是库内地址）；
 * - 也不能把原图整个内联 —— 用户完全可能挂一张几 MB 的照片当图标，SVG / PNG 会跟着变得不可用。
 * 于是这里先等比缩到 ≤`MARKER_IMAGE_MAX_EDGE`，再编码成 PNG，并对单张与总量都封顶；
 * 超限或取不到的那张**不内联**，调用方回退字形（与画布"图片加载失败回退字形"同一条链）。
 *
 * 不 import obsidian：图片与画布能力都注入，缺省从全局取 —— 与 `pngExport.ts` 同一套路。
 */

/** 派生图的最长边（画布上的标记图标只有 18px，64 已经够清楚） */
export const MARKER_IMAGE_MAX_EDGE = 64
/** 单张 data URL 的字符上限（含 `data:image/png;base64,` 前缀） */
export const MARKER_IMAGE_MAX_CHARS = 48 * 1024
/** 一次导出的总量上限：图片再多，导出文件也不会失控 */
export const MARKER_IMAGE_TOTAL_MAX_CHARS = 384 * 1024

/**
 * 只声明我们**真正用到**的成员，单测可以注入普通对象替身；
 * 真实浏览器的 `HTMLImageElement` / `HTMLCanvasElement` 结构上天然满足。
 */
export interface MarkerImageLike {
  src: string
  complete?: boolean
  naturalWidth?: number
  naturalHeight?: number
  onload: (() => void) | null
  onerror: (() => void) | null
}

export interface MarkerCanvasContextLike {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
}

export interface MarkerCanvasLike {
  width: number
  height: number
  getContext(type: '2d'): MarkerCanvasContextLike | null
  /** 缺省环境可能没有（例如非浏览器）—— 调用方检查后回退字形 */
  toDataURL?: (type?: string) => string
}

export interface MarkerImageDeps {
  /** 创建一个图片对象（缺省用 `document.createElement('img')`） */
  createImage?: () => MarkerImageLike | null
  /** 创建画布（缺省用 `document.createElement('canvas')`） */
  createCanvas?: (width: number, height: number) => MarkerCanvasLike | null
  /** 等待图片加载完成（缺省监听 onload/onerror，并处理"已经缓存完成"的情况） */
  waitForImage?: (image: MarkerImageLike) => Promise<boolean>
}

function defaultWaitForImage(image: MarkerImageLike): Promise<boolean> {
  return new Promise((resolve) => {
    // 命中缓存时浏览器**不会**再触发 load 事件，但 complete 已经是 true。
    // 只挂 onload 的话这种情况会永远等下去。`complete` 也包含"解码失败"，
    // 所以这里按 naturalWidth 决定成败 —— 由调用方的尺寸检查统一回退，不在这里抛。
    if (image.complete === true) {
      resolve((image.naturalWidth ?? 0) > 0)
      return
    }
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
  })
}

function globalDeps(): MarkerImageDeps {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || typeof doc.createElement !== 'function') return {}
  return {
    createImage: () => doc.createElement('img') as unknown as MarkerImageLike,
    createCanvas: (width, height) => {
      const canvas = doc.createElement('canvas') as unknown as HTMLCanvasElement
      canvas.width = width
      canvas.height = height
      return canvas as unknown as MarkerCanvasLike
    },
  }
}

/**
 * 等比缩进一个方块：与画布上 `object-fit: contain` 同一条口径。
 * 尺寸非法返回 `null`（“解不开的图”不该产生 0×0 画布）。
 */
export function fitInsideBox(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const limit = Math.max(1, Math.floor(maxEdge))
  const ratio = Math.min(1, limit / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/** 把一张图派生（缩放 + 重编码）成 PNG data URL；任何一步不成立都返回 `null`，绝不抛异常 */
export async function deriveMarkerImageDataUrl(source: string, deps: MarkerImageDeps = {}): Promise<string | null> {
  if (source.trim().length === 0) return null
  const resolved = { ...globalDeps(), ...deps }
  const createImage = resolved.createImage
  const createCanvas = resolved.createCanvas
  const waitForImage = resolved.waitForImage ?? defaultWaitForImage
  if (!createImage || !createCanvas) return null

  const image = createImage()
  if (!image) return null
  image.src = source
  if (!(await waitForImage(image))) return null

  const box = fitInsideBox(image.naturalWidth ?? 0, image.naturalHeight ?? 0, MARKER_IMAGE_MAX_EDGE)
  if (box === null) return null

  const canvas = createCanvas(box.width, box.height)
  if (!canvas) return null
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image, 0, 0, box.width, box.height)

  if (typeof canvas.toDataURL !== 'function') return null
  const dataUrl = canvas.toDataURL('image/png')
  // 只接受真正的图片 data URL：别的字符串内联进 SVG 只会产生一张坏图
  if (!dataUrl.startsWith('data:image/')) return null
  return dataUrl.length <= MARKER_IMAGE_MAX_CHARS ? dataUrl : null
}

/**
 * 批量派生。返回 `Map<库内路径, data URL>`；**查不到就是没内联**，调用方回退字形。
 *
 * `resolveUrl` 由调用方注入（Obsidian 的库资源地址），纯模块不认识 vault。
 * 同一路径只处理一次；单张与总量都有上限。
 */
export async function inlineMarkerImages(
  paths: readonly string[],
  resolveUrl: (path: string) => string,
  deps: MarkerImageDeps = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  let total = 0
  for (const path of new Set(paths)) {
    if (path.trim().length === 0) continue
    const url = resolveUrl(path)
    if (url.trim().length === 0) continue
    const dataUrl = await deriveMarkerImageDataUrl(url, deps)
    if (dataUrl === null) continue
    if (total + dataUrl.length > MARKER_IMAGE_TOTAL_MAX_CHARS) continue
    total += dataUrl.length
    result.set(path, dataUrl)
  }
  return result
}
