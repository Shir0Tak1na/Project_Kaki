/**
 * 地形精灵图集。
 *
 * 每种地形预渲染成一张位图（六边形底色 + 描边 + 字形），绘制一格就是一次
 * `drawImage` —— 这是设计文档 §4.3「每帧重绘必须廉价」的核心手段：
 * 实测 `markViewportChanged` 逐帧触发，因此每帧要能画完可见区所有格。
 *
 * 图集分辨率取「最大缩放 × devicePixelRatio 下的屏幕半径」：
 * 当前 clamp 的最大 scale 为 2，dpr 常见 1–2，取 128 px 半径即可覆盖
 * （40 世界单位 × 2 × 1.65 ≈ 132 px，误差 3%，肉眼不可见）。
 * 图集是**按网格朝向**构建的，朝向变化时重建。
 */

import { hexCorners, type GridSpec, type HexOrientation } from '../core/hex.ts'
import type { GlyphShape } from './terrainStyle.ts'
import { listResolvedTerrainStyles, type ResolvedTerrainStyle } from './terrainCatalog.ts'

export interface AtlasSprite {
  index: number
  x: number
  y: number
  size: number
  /** 这一格是画图片还是画颜色 + 字形（供测试与诊断，不必去解析像素） */
  kind: 'glyph' | 'image'
}

export interface TerrainAtlas {
  canvas: HTMLCanvasElement
  orientation: HexOrientation
  spriteRadius: number
  sprites: Map<string, AtlasSprite>
  /** 供测试与诊断：实际绘制调用次数 */
  buildCalls: number
  /** 本次构建时用上了图片的地形 ID（其余走颜色 + 字形回退） */
  imageIds: string[]
}

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement

/**
 * 默认精灵半径（位图像素）。
 *
 * 取「最大缩放 × devicePixelRatio 下的屏幕半径」：当前 clamp 的最大 scale 为 2，
 * dpr 常见 1–2，128 px 即可覆盖（40 世界单位 × 2 × 1.65 ≈ 132 px，误差 3%，肉眼不可见）。
 * 之所以单独导出：调用方要用它参与"图集缓存签名"，写死两处必然有一天不同步。
 */
export const DEFAULT_SPRITE_RADIUS = 128

export const defaultCanvasFactory: CanvasFactory = (width, height) => {
  const canvas = activeDocument().createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function activeDocument(): Document {
  const win = typeof window !== 'undefined' ? window : undefined
  return win?.document ?? globalThis.document
}

export interface BuildAtlasOptions {
  orientation: HexOrientation
  /** 精灵的位图半径（像素）。默认 128 */
  spriteRadius?: number
  factory?: CanvasFactory
  /**
   * 要画哪些地形。默认只画内置 9 种。
   *
   * 传"已解析的样式"而不是原始设置：解析里含校验与三级回退（`terrainCatalog.ts`），
   * 图集只负责光栅化，不该重复判断"这个 ID 是什么"。
   */
  styles?: readonly ResolvedTerrainStyle[]
  /**
   * 已经加载好的图片（键 = 地形 ID）。
   *
   * 图片在**图集构建时**就缩放贴合进这一格的位图里，之后每格仍然只是一次 `drawImage`——
   * 每格现算几何会让每帧的绘制量随图片数量增长（这个项目的核心性能约束）。
   * 加载是异步的，所以"还没加载好"的那一帧会退化成颜色 + 字形，而不是空着。
   */
  images?: ReadonlyMap<string, CanvasImageSource>
}

function pathHexagon(ctx: CanvasRenderingContext2D, orientation: HexOrientation, cx: number, cy: number, radius: number): void {
  // 复用 core/hex.ts 的顶点计算，保证与格几何完全一致（尺寸/朝向不会写两遍）
  const grid: GridSpec = { kind: 'hex', orientation, size: radius, origin: [cx, cy] }
  const corners = hexCorners(grid, 0, 0)
  ctx.beginPath()
  corners.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath()
}

function drawGlyph(ctx: CanvasRenderingContext2D, shape: GlyphShape, cx: number, cy: number, radius: number): void {
  const px = (value: number): number => cx + value * radius
  const py = (value: number): number => cy + value * radius

  switch (shape.kind) {
    case 'polygon': {
      ctx.beginPath()
      shape.points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(px(x), py(y))
        else ctx.lineTo(px(x), py(y))
      })
      ctx.closePath()
      if (shape.fill) {
        ctx.fillStyle = shape.fill
        ctx.fill()
      }
      if (shape.stroke) {
        ctx.strokeStyle = shape.stroke
        ctx.lineWidth = (shape.width ?? 0.06) * radius
        ctx.stroke()
      }
      return
    }
    case 'circle': {
      ctx.beginPath()
      ctx.arc(px(shape.center[0]), py(shape.center[1]), shape.radius * radius, 0, Math.PI * 2)
      if (shape.fill) {
        ctx.fillStyle = shape.fill
        ctx.fill()
      }
      if (shape.stroke) {
        ctx.strokeStyle = shape.stroke
        ctx.lineWidth = (shape.width ?? 0.06) * radius
        ctx.stroke()
      }
      return
    }
    case 'line': {
      ctx.beginPath()
      ctx.moveTo(px(shape.from[0]), py(shape.from[1]))
      ctx.lineTo(px(shape.to[0]), py(shape.to[1]))
      ctx.strokeStyle = shape.stroke
      ctx.lineWidth = shape.width * radius
      ctx.lineCap = 'round'
      ctx.stroke()
      return
    }
    case 'arc': {
      ctx.beginPath()
      ctx.arc(px(shape.center[0]), py(shape.center[1]), shape.radius * radius, shape.from, shape.to)
      ctx.strokeStyle = shape.stroke
      ctx.lineWidth = shape.width * radius
      ctx.lineCap = 'round'
      ctx.stroke()
      return
    }
  }
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  style: ResolvedTerrainStyle,
  orientation: HexOrientation,
  cx: number,
  cy: number,
  radius: number,
  image: CanvasImageSource | undefined,
): 'glyph' | 'image' {
  pathHexagon(ctx, orientation, cx, cy, radius)
  // 底色先铺：图片可能带透明通道，没有底色的话格子会漏出画布背景
  ctx.fillStyle = style.base
  ctx.fill()

  let usedImage = false
  if (image !== undefined) {
    try {
      // 裁剪在六边形内，避免图片的方角溢出到相邻格
      ctx.save()
      pathHexagon(ctx, orientation, cx, cy, radius * 0.98)
      ctx.clip()
      drawImageCover(ctx, image, cx, cy, radius)
      ctx.restore()
      usedImage = true
    } catch {
      // drawImage 对"还没解码完 / 跨域 / 尺寸为 0"的源会抛错；
      // 单张图失败不应该让整帧绘制挂掉 —— 退回颜色 + 字形。
      usedImage = false
    }
  }

  if (!usedImage) {
    // 字形裁剪在六边形内，避免溢出到相邻格
    ctx.save()
    pathHexagon(ctx, orientation, cx, cy, radius * 0.98)
    ctx.clip()
    for (const shape of style.glyph) drawGlyph(ctx, shape, cx, cy, radius)
    ctx.restore()
  }

  // 描边始终画在最上层：无论有没有图片，格子边界都要看得见
  pathHexagon(ctx, orientation, cx, cy, radius)
  ctx.strokeStyle = style.outline
  ctx.lineWidth = Math.max(1, radius * 0.03)
  ctx.stroke()
  return usedImage ? 'image' : 'glyph'
}

/**
 * 把图片按「等比覆盖」贴进这一格。
 *
 * 用覆盖（cover）而不是拉伸：用户给的地形图片很少正好是六边形的外接正方形，
 * 拉伸会把人脸/树形压扁，而覆盖只会裁掉边缘。这个项目里"形状被变形"已经出过一次事故
 * （Base 缩略图曾被长宽比拉伸），所以这里宁可裁，不变形。
 */
function drawImageCover(ctx: CanvasRenderingContext2D, image: CanvasImageSource, cx: number, cy: number, radius: number): void {
  const box = radius * 2
  const record = image as { width?: unknown; height?: unknown; naturalWidth?: unknown; naturalHeight?: unknown }
  const toNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const naturalWidth = toNumber(record.naturalWidth) || toNumber(record.width)
  const naturalHeight = toNumber(record.naturalHeight) || toNumber(record.height)
  if (naturalWidth === 0 || naturalHeight === 0) {
    // 尺寸未知（尚未解码完）：让浏览器按 9 参数形式自己缩放是没法定比例的，
    // 直接画一个包住整格的方框即可 —— 下一帧图集重建后就会变成正确比例。
    ctx.drawImage(image, cx - radius, cy - radius, box, box)
    return
  }
  const scale = Math.max(box / naturalWidth, box / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  ctx.drawImage(image, cx - width / 2, cy - height / 2, width, height)
}

/**
 * 构建图集。返回的 canvas 是离屏位图，调用方负责缓存与在朝向/地形目录/图片就绪时重建。
 */
export function buildTerrainAtlas(options: BuildAtlasOptions): TerrainAtlas | null {
  const radius = options.spriteRadius ?? DEFAULT_SPRITE_RADIUS
  const styles = options.styles ?? listResolvedTerrainStyles()
  if (styles.length === 0 || radius <= 0) return null

  const cell = radius * 2 + 4
  const width = cell * styles.length
  const height = cell
  const factory = options.factory ?? defaultCanvasFactory

  let canvas: HTMLCanvasElement
  try {
    canvas = factory(width, height)
  } catch {
    return null
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const sprites = new Map<string, AtlasSprite>()
  const imageIds: string[] = []
  let buildCalls = 0

  styles.forEach((style, index) => {
    const cx = index * cell + cell / 2
    const cy = cell / 2
    const image = style.imagePath.length > 0 ? options.images?.get(style.id) : undefined
    const kind = drawSprite(ctx, style, options.orientation, cx, cy, radius, image)
    if (kind === 'image') imageIds.push(style.id)
    buildCalls += 1
    sprites.set(style.id, { index, x: cx, y: cy, size: cell, kind })
  })

  return { canvas, orientation: options.orientation, spriteRadius: radius, sprites, buildCalls, imageIds }
}

/** 在离屏画布上画一格：把精灵按目标边长缩放贴合 */
export function drawTerrainCell(
  ctx: CanvasRenderingContext2D,
  atlas: TerrainAtlas,
  id: string,
  centerX: number,
  centerY: number,
  targetRadius: number,
): boolean {
  const sprite = atlas.sprites.get(id)
  if (!sprite) return false
  const half = targetRadius * (sprite.size / (atlas.spriteRadius * 2))
  ctx.drawImage(
    atlas.canvas,
    sprite.x - sprite.size / 2,
    sprite.y - sprite.size / 2,
    sprite.size,
    sprite.size,
    centerX - half,
    centerY - half,
    half * 2,
    half * 2,
  )
  return true
}
