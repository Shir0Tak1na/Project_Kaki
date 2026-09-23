/**
 * 六边形网格与轴向坐标 —— 纯函数模块。
 *
 * 设计约束（见设计文档 §6「关键修订 1」）：
 * 地形以轴向坐标 (q, r) 存储，而不是像素坐标；渲染时才换算为世界坐标。
 * 这里不 import 'obsidian'，因此可以被 `node --test` 直接运行（Node 24 原生剥离类型）。
 */

export type HexOrientation = 'pointy' | 'flat'

export interface GridSpec {
  kind: 'hex'
  orientation: HexOrientation
  /** 外接圆半径（世界单位） */
  size: number
  /** 网格原点在世界坐标中的位置 */
  origin: [number, number]
}

export interface Axial {
  q: number
  r: number
}

export interface Point {
  x: number
  y: number
}

const SQRT3 = Math.sqrt(3)

/**
 * 轴向坐标 → 世界坐标。
 * pointy-top：x = s·(√3·q + √3/2·r), y = s·3/2·r
 * flat-top  ：x = s·3/2·q,          y = s·(√3/2·q + √3·r)
 */
export function axialToWorld(grid: GridSpec, q: number, r: number): Point {
  const s = grid.size
  const ox = grid.origin[0]
  const oy = grid.origin[1]
  if (grid.orientation === 'pointy') {
    return { x: ox + s * (SQRT3 * q + (SQRT3 / 2) * r), y: oy + s * 1.5 * r }
  }
  return { x: ox + s * 1.5 * q, y: oy + s * ((SQRT3 / 2) * q + SQRT3 * r) }
}

/** 世界坐标 → 最近的轴向坐标（含立方坐标取整） */
export function worldToAxial(grid: GridSpec, p: Point): Axial {
  const s = grid.size
  const x = (p.x - grid.origin[0]) / s
  const y = (p.y - grid.origin[1]) / s
  if (grid.orientation === 'pointy') {
    return axialRound((SQRT3 / 3) * x - (1 / 3) * y, (2 / 3) * y)
  }
  return axialRound((2 / 3) * x, -(1 / 3) * x + (SQRT3 / 3) * y)
}

/**
 * 立方坐标取整：把分数轴向坐标吸附到最近的真实格。
 * 做法是先各自四舍五入，再把差值最大的那个分量用 x+y+z=0 约束修正。
 */
export function axialRound(fq: number, fr: number): Axial {
  const fx = fq
  const fz = fr
  const fy = -fx - fz

  let rx = Math.round(fx)
  let ry = Math.round(fy)
  let rz = Math.round(fz)

  const dx = Math.abs(rx - fx)
  const dy = Math.abs(ry - fy)
  const dz = Math.abs(rz - fz)

  if (dx > dy && dx > dz) {
    rx = -ry - rz
  } else if (dy > dz) {
    ry = -rx - rz
  } else {
    rz = -rx - ry
  }

  // 归一化 -0：否则 (3, -0) 与 (3, 0) 会在 deepEqual / Object.is 比较中不等，
  // 而生成了看起来相同的地形键，留下难以排查的稀疏数据。
  return { q: normalizeZero(rx), r: normalizeZero(rz) }
}

/** 把 -0 归一成 0：格坐标必须唯一表示，否则比较与日志会出现"看起来相同的两个值" */
export function normalizeZero(n: number): number {
  return n === 0 ? 0 : n
}

/** 地图数据里的地形键格式：`${q}_${r}`（与 Hex Cartographer 的 hexes 键格式一致） */
export function cellKey(q: number, r: number): string {
  return `${q}_${r}`
}

export function parseCellKey(key: string): Axial | null {
  const at = key.indexOf('_')
  if (at <= 0) return null
  const q = Number(key.slice(0, at))
  const r = Number(key.slice(at + 1))
  if (!Number.isInteger(q) || !Number.isInteger(r)) return null
  return { q, r }
}

/** 六边形的 6 个顶点（世界坐标），用于描边、命中测试与导出 SVG */
export function hexCorners(grid: GridSpec, q: number, r: number): Point[] {
  const center = axialToWorld(grid, q, r)
  const points: Point[] = []
  for (let i = 0; i < 6; i++) {
    const deg = grid.orientation === 'pointy' ? 60 * i - 30 : 60 * i
    const rad = (Math.PI / 180) * deg
    points.push({
      x: center.x + grid.size * Math.cos(rad),
      y: center.y + grid.size * Math.sin(rad),
    })
  }
  return points
}

/** 两格之间的六边形距离 */
export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

/** 以 (0,0) 为中心、半径为 radius 的全部格（含边界），用于笔刷落点计算 */
export function cellsInRadius(radius: number): Axial[] {
  const out: Axial[] = []
  const r0 = Math.max(0, Math.floor(radius))
  for (let q = -r0; q <= r0; q++) {
    for (let r = Math.max(-r0, -q - r0); r <= Math.min(r0, -q + r0); r++) {
      if (hexDistance({ q, r }, { q: 0, r: 0 }) <= radius) out.push({ q, r })
    }
  }
  return out
}
