/**
 * PNG 导出：把"地图导出 SVG"的结果光栅化成 PNG 字节。
 *
 * 设计上**不重新实现一遍几何**：PNG 与 SVG 共用同一条路径 ——
 * 先由 `buildMapExportSvg()` 生成 SVG（Base 缩略图也用同一份），再把这张 SVG 画进位图。
 * 于是"导出的图与画布上看到的一致"这条承诺只需要维护一处。
 *
 * 为什么把 DOM 依赖做成**注入**的：
 * 1. 光栅化只有在真实浏览器里才成立（要 `Image`、`canvas.toBlob`），
 *    而这一整套逻辑里真正容易出错的部分是**纯逻辑**——data URL 的正确编码、
 *    "图片已经缓存完成"这个分支、以及各种失败路径的措辞。
 *    把这些做成可注入的依赖，就能在没有浏览器的环境下把它们全部测掉。
 * 2. 本项目已经有过一次教训：把"能不能测"寄托在环境上，最后就变成"没测"。
 *
 * ⚠️ 已知边界（诚实写在这里）：`canvas.toBlob` 在移动端的某些 WebView 上可能没有，
 * 我们不做 polyfill，只在缺能力时明确报错，不让用户面对一张空白图。
 */

/**
 * 只声明**我们真正用到**的那几个成员，而不是直接要求 `HTMLImageElement` / `HTMLCanvasElement`。
 *
 * 两个理由：
 * 1. 于是单测可以注入普通对象替身，不需要 `as any` 掩盖类型 —— 一旦用了 `as any`，
 *    替身和真实对象之间的差异就没人再检查了；
 * 2. 真实浏览器对象结构上天然满足这些接口，调用方不需要适配层。
 */
export interface RasterImageLike {
  src: string
  complete?: boolean
  naturalWidth?: number
  onload: (() => void) | null
  onerror: (() => void) | null
}

export interface RasterContextLike {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
}

export interface RasterCanvasLike {
  width: number
  height: number
  getContext(type: '2d'): RasterContextLike | null
}

/** 只需要能取出字节：`Blob` 满足它，替身也不必是真正的 Blob */
export interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>
}

/** 光栅化用到的环境能力（都可注入；缺省时从全局取） */
export interface PngRasterDeps {
  /** 创建一个图片对象（缺省用 `document.createElement('img')`） */
  createImage?: () => RasterImageLike | null
  /** 创建画布（缺省用 `document.createElement('canvas')`） */
  createCanvas?: (width: number, height: number) => RasterCanvasLike | null
  /** 取 PNG 数据（缺省把 `canvas.toBlob` 包成 Promise） */
  toBlob?: (canvas: RasterCanvasLike, type: string) => Promise<BlobLike | null>
  /** 等待图片加载完成（缺省监听 onload/onerror，并处理"已经缓存完成"的情况） */
  waitForImage?: (image: RasterImageLike) => Promise<boolean>
}

export type RasterizeResult =
  | { ok: true; blob: BlobLike; width: number; height: number }
  | { ok: false; reason: string }

/**
 * 把地图路径换算成"导出文件的基础名"。
 *
 * `Maps/World.map.md` → `Maps/World`（PNG 与 SVG 共用同一个基础名，
 * 于是两个导出命令的重名规则完全一致）。
 */
export function exportBasePathFor(mapPath: string): string {
  return mapPath.replace(/\.map\.md$/i, '')
}

/**
 * 在基础名上加扩展名，并在**已存在**时依次尝试 `-2`、`-3`……
 *
 * `exists` 传进来而不是直接用 vault：这样重名规则是纯函数，可以单测
 * （真实调用方传 `(path) => vault.getAbstractFileByPath(path) !== null`）。
 * 不在循环里做上限保护也没关系 —— 但这里仍设了上限，避免"exists 永远为真"时静默死循环。
 */
export function uniqueExportPath(basePath: string, extension: string, exists: (path: string) => boolean): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  if (!exists(`${basePath}${ext}`)) return `${basePath}${ext}`
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${basePath}-${suffix}${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${basePath}-1000${ext}`
}

/**
 * SVG → data URL。
 *
 * **不要用 `btoa`**：它只接受 Latin-1，地图里的中文名称（"北境领"）会让它抛
 * `InvalidCharacterError` —— 而地图上几乎一定有中文。用百分号编码既避开这个坑，
 * 又顺手把 `#`（颜色）、`<`、`>`、换行都变成合法字符，不需要再手工替换。
 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function defaultWaitForImage(image: RasterImageLike): Promise<boolean> {
  return new Promise((resolve) => {
    // 命中缓存时浏览器**不会**再触发 load 事件，但 complete 已经是 true。
    // 只挂 onload 的话这种情况会永远等下去（"图明明在，导出却卡住"）。
    if (image.complete === true && (image.naturalWidth ?? 0) > 0) {
      resolve(true)
      return
    }
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
  })
}

function defaultToBlob(canvas: RasterCanvasLike, type: string): Promise<BlobLike | null> {
  const target = canvas as unknown as HTMLCanvasElement
  if (typeof target.toBlob !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    target.toBlob((blob) => resolve(blob), type)
  })
}

function globalDeps(): PngRasterDeps {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || typeof doc.createElement !== 'function') return {}
  return {
    createImage: () => doc.createElement('img') as unknown as RasterImageLike,
    createCanvas: (width, height) => {
      const canvas = doc.createElement('canvas') as unknown as HTMLCanvasElement
      canvas.width = width
      canvas.height = height
      return canvas as unknown as RasterCanvasLike
    },
    toBlob: defaultToBlob,
  }
}

/**
 * 把 SVG 字符串画成 PNG。
 *
 * **不抛异常**：所有失败都变成 `{ ok: false, reason }`，调用方据此给用户一句人话。
 * 理由与渲染层一致 —— 导出是用户按一下按钮，报错要靠提示，而不是靠控制台堆栈。
 */
export async function rasterizeSvgToPng(
  svg: string,
  size: { width: number; height: number },
  deps: PngRasterDeps = {},
): Promise<RasterizeResult> {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  if (svg.trim().length === 0) return { ok: false, reason: '地图是空的，没有可导出的内容。' }

  const resolved = { ...globalDeps(), ...deps }
  const createImage = resolved.createImage
  const createCanvas = resolved.createCanvas
  const toBlob = resolved.toBlob
  const waitForImage = resolved.waitForImage ?? defaultWaitForImage
  if (!createImage || !createCanvas || !toBlob) {
    return { ok: false, reason: '当前环境不支持把 SVG 转成 PNG（缺少 Image 或 canvas.toBlob）。请改用「导出为 SVG」。' }
  }

  const image = createImage()
  if (!image) return { ok: false, reason: '无法创建图片对象，导出 PNG 失败。' }
  image.src = svgToDataUrl(svg)
  const loaded = await waitForImage(image)
  if (!loaded) {
    return { ok: false, reason: '导出的 SVG 无法被浏览器解码（data URL 被拒绝），请改用「导出为 SVG」。' }
  }

  const canvas = createCanvas(width, height)
  if (!canvas) return { ok: false, reason: '无法创建画布，导出 PNG 失败。' }
  const context = canvas.getContext('2d')
  if (!context) return { ok: false, reason: '无法取得 2D 绘图上下文，导出 PNG 失败。' }
  context.drawImage(image, 0, 0, width, height)

  const blob = await toBlob(canvas, 'image/png')
  if (!blob) return { ok: false, reason: '画布没有输出 PNG 数据（toBlob 返回空）。' }
  return { ok: true, blob, width, height }
}
