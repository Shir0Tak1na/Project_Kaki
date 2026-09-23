/**
 * 地形样式 —— 纯数据模块。
 *
 * 每个地形由「六边形底色 + 若干字形图元」定义，图元坐标归一化到 -1..1
 * （1 = 六边形外接圆半径），因此与网格尺寸、缩放、朝向都无关：
 * 光栅化在 spriteAtlas 里做一次，之后每格只是一次 drawImage。
 *
 * 把字形定义成**数据**而不是绘制代码，是为了能单元测试（比如"每种地形都必须有字形"、
 * "图元坐标必须在 -1..1 内"），也让将来换成 SVG 符号库时只改这一个文件。
 */

import { TERRAIN_TYPES, type TerrainType } from '../data/mapDocument.ts'

export type GlyphShape =
  | { kind: 'polygon'; points: Array<[number, number]>; fill?: string; stroke?: string; width?: number }
  | { kind: 'circle'; center: [number, number]; radius: number; fill?: string; stroke?: string; width?: number }
  | { kind: 'line'; from: [number, number]; to: [number, number]; stroke: string; width: number }
  | { kind: 'arc'; center: [number, number]; radius: number; from: number; to: number; stroke: string; width: number }

export interface TerrainStyle {
  type: TerrainType
  /** 中文名，用于工具栏、图例与状态报告 */
  label: string
  /** 六边形底色 */
  base: string
  /** 六边形描边 */
  outline: string
  /** 字形图元（归一化坐标） */
  glyph: GlyphShape[]
}

const OUTLINE = 'rgba(0, 0, 0, 0.28)'
const SNOW = 'rgba(255, 255, 255, 0.92)'
const INK = 'rgba(20, 24, 28, 0.72)'

export const TERRAIN_STYLES: Record<TerrainType, TerrainStyle> = {
  plains: {
    type: 'plains',
    label: '平原',
    base: '#9dc06c',
    outline: OUTLINE,
    glyph: [
      { kind: 'line', from: [-0.34, 0.32], to: [-0.24, 0.06], stroke: INK, width: 0.07 },
      { kind: 'line', from: [-0.04, 0.38], to: [0.06, 0.1], stroke: INK, width: 0.07 },
      { kind: 'line', from: [0.26, 0.3], to: [0.36, 0.04], stroke: INK, width: 0.07 },
    ],
  },
  forest: {
    type: 'forest',
    label: '森林',
    base: '#6d9c57',
    outline: OUTLINE,
    glyph: [
      { kind: 'polygon', points: [[-0.42, 0.34], [-0.18, -0.05], [0.06, 0.34]], fill: '#2f5d34' },
      { kind: 'polygon', points: [[-0.14, 0.36], [0.12, -0.18], [0.38, 0.36]], fill: '#3d7440' },
      { kind: 'polygon', points: [[0.1, 0.38], [0.34, 0.0], [0.58, 0.38]], fill: '#2f5d34' },
    ],
  },
  hills: {
    type: 'hills',
    label: '丘陵',
    base: '#b3b478',
    outline: OUTLINE,
    glyph: [
      { kind: 'arc', center: [-0.22, 0.3], radius: 0.3, from: Math.PI, to: 0, stroke: '#6f6f45', width: 0.09 },
      { kind: 'arc', center: [0.24, 0.32], radius: 0.36, from: Math.PI, to: 0, stroke: '#6f6f45', width: 0.09 },
    ],
  },
  mountain: {
    type: 'mountain',
    label: '山脉',
    base: '#a9a49a',
    outline: OUTLINE,
    glyph: [
      { kind: 'polygon', points: [[-0.62, 0.36], [-0.24, -0.34], [0.14, 0.36]], fill: '#6f6a63' },
      { kind: 'polygon', points: [[-0.36, -0.12], [-0.24, -0.34], [-0.12, -0.12]], fill: SNOW },
      { kind: 'polygon', points: [[0.0, 0.4], [0.36, -0.22], [0.72, 0.4]], fill: '#7d776f' },
      { kind: 'polygon', points: [[0.24, 0.02], [0.36, -0.22], [0.48, 0.02]], fill: SNOW },
    ],
  },
  water: {
    type: 'water',
    label: '水域',
    base: '#5b9bd5',
    outline: OUTLINE,
    glyph: [
      { kind: 'arc', center: [-0.3, -0.08], radius: 0.24, from: Math.PI, to: 2 * Math.PI, stroke: 'rgba(255,255,255,0.85)', width: 0.07 },
      { kind: 'arc', center: [0.16, 0.02], radius: 0.26, from: Math.PI, to: 2 * Math.PI, stroke: 'rgba(255,255,255,0.85)', width: 0.07 },
      { kind: 'arc', center: [-0.06, 0.34], radius: 0.22, from: Math.PI, to: 2 * Math.PI, stroke: 'rgba(255,255,255,0.7)', width: 0.07 },
    ],
  },
  swamp: {
    type: 'swamp',
    label: '沼泽',
    base: '#6f8a63',
    outline: OUTLINE,
    glyph: [
      { kind: 'line', from: [-0.44, -0.16], to: [-0.06, -0.16], stroke: '#39492f', width: 0.08 },
      { kind: 'line', from: [0.06, -0.02], to: [0.46, -0.02], stroke: '#39492f', width: 0.08 },
      { kind: 'line', from: [-0.3, 0.16], to: [0.08, 0.16], stroke: '#39492f', width: 0.08 },
      { kind: 'circle', center: [0.24, 0.34], radius: 0.1, fill: '#4d6444' },
      { kind: 'circle', center: [-0.18, 0.38], radius: 0.08, fill: '#4d6444' },
    ],
  },
  desert: {
    type: 'desert',
    label: '沙漠',
    base: '#ddc684',
    outline: OUTLINE,
    glyph: [
      { kind: 'arc', center: [-0.18, 0.22], radius: 0.34, from: Math.PI, to: 2 * Math.PI, stroke: '#b09048', width: 0.08 },
      { kind: 'arc', center: [0.3, 0.34], radius: 0.26, from: Math.PI, to: 2 * Math.PI, stroke: '#b09048', width: 0.08 },
      { kind: 'circle', center: [-0.34, -0.24], radius: 0.06, fill: '#b09048' },
      { kind: 'circle', center: [0.12, -0.12], radius: 0.05, fill: '#b09048' },
    ],
  },
  tundra: {
    type: 'tundra',
    label: '冻原',
    base: '#cbd8dd',
    outline: OUTLINE,
    glyph: [
      { kind: 'line', from: [-0.4, 0.1], to: [0.4, 0.1], stroke: 'rgba(120,150,170,0.75)', width: 0.06 },
      { kind: 'circle', center: [-0.24, -0.18], radius: 0.07, fill: 'rgba(120,150,170,0.6)' },
      { kind: 'circle', center: [0.04, -0.34], radius: 0.05, fill: 'rgba(120,150,170,0.6)' },
      { kind: 'circle', center: [0.3, -0.12], radius: 0.06, fill: 'rgba(120,150,170,0.6)' },
    ],
  },
  volcanic: {
    type: 'volcanic',
    label: '火山',
    base: '#6b5b55',
    outline: OUTLINE,
    glyph: [
      { kind: 'polygon', points: [[-0.56, 0.4], [0.0, -0.38], [0.56, 0.4]], fill: '#3f3630' },
      { kind: 'polygon', points: [[-0.16, 0.4], [0.0, 0.06], [0.16, 0.4]], fill: '#c8462f' },
      { kind: 'circle', center: [0.0, -0.1], radius: 0.09, fill: '#f0a03c' },
    ],
  },
}

export function getTerrainStyle(type: TerrainType): TerrainStyle {
  return TERRAIN_STYLES[type]
}

/** 地形类型 → 中文名（图例与状态报告用） */
export function terrainLabel(type: TerrainType): string {
  return TERRAIN_STYLES[type].label
}

/** 图例数据：按固定顺序列出全部地形，供工具栏与导出使用 */
export function listTerrainStyles(): TerrainStyle[] {
  return TERRAIN_TYPES.map((type) => TERRAIN_STYLES[type])
}
