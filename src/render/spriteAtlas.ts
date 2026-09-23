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
import { listTerrainStyles, type GlyphShape, type TerrainStyle } from './terrainStyle.ts'
import type { TerrainType } from '../data/mapDocument.ts'

export interface AtlasSprite {
  index: number
  x: number
  y: number
  size: number
}

export interface TerrainAtlas {
  canvas: HTMLCanvasElement
  orientation: HexOrientation
  spriteRadius: number
  sprites: Map<TerrainType, AtlasSprite>
  /** 供测试与诊断：实际绘制调用次数 */
  buildCalls: number
}

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement

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
  /** 需要哪些地形；默认全部 */
  types?: TerrainType[]
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

function drawSprite(ctx: CanvasRenderingContext2D, style: TerrainStyle, orientation: HexOrientation, cx: number, cy: number, radius: number): void {
  pathHexagon(ctx, orientation, cx, cy, radius)
  ctx.fillStyle = style.base
  ctx.fill()
  ctx.strokeStyle = style.outline
  ctx.lineWidth = Math.max(1, radius * 0.03)
  ctx.stroke()

  // 字形裁剪在六边形内，避免溢出到相邻格
  ctx.save()
  pathHexagon(ctx, orientation, cx, cy, radius * 0.98)
  ctx.clip()
  for (const shape of style.glyph) drawGlyph(ctx, shape, cx, cy, radius)
  ctx.restore()
}

/**
 * 构建图集。返回的 canvas 是离屏位图，调用方负责缓存与在朝向变化时重建。
 */
export function buildTerrainAtlas(options: BuildAtlasOptions): TerrainAtlas | null {
  const radius = options.spriteRadius ?? 128
  const styles = listTerrainStyles().filter((style) => options.types === undefined || options.types.includes(style.type))
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

  const sprites = new Map<TerrainType, AtlasSprite>()
  let buildCalls = 0

  styles.forEach((style, index) => {
    const cx = index * cell + cell / 2
    const cy = cell / 2
    drawSprite(ctx, style, options.orientation, cx, cy, radius)
    buildCalls += 1
    sprites.set(style.type, { index, x: cx, y: cy, size: cell })
  })

  return { canvas, orientation: options.orientation, spriteRadius: radius, sprites, buildCalls }
}

/** 在离屏画布上画一格：把精灵按目标边长缩放贴合 */
export function drawTerrainCell(
  ctx: CanvasRenderingContext2D,
  atlas: TerrainAtlas,
  type: TerrainType,
  centerX: number,
  centerY: number,
  targetRadius: number,
): boolean {
  const sprite = atlas.sprites.get(type)
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
