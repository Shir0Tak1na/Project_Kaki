/**
 * 投影监视（开发探针）。
 *
 * 它**不再是** Phase 0 的「回调总数 vs 有效数」——那件事已经固化：`markViewportChanged`
 * 在一次平移/缩放中会逐帧触发多次，调用方必须去重。现在它回答**当下**的问题：
 * 每一次有效变化，投影到底被判成什么样。
 *
 * 每次有效变化打印 `scale` / `origin` / `source`，以及来源是否发生了切换
 * （闭式 ↔ 采样）。真机上"闭式与采样确实不一致"（1.2.1 那条修复）在这个监视里应当看得见。
 */

import type { App } from 'obsidian'
import { activeCanvasHandle, buildProjection, watchViewportChanges, type ProjectionResult } from '../canvas/CanvasAdapter.ts'
import { projectionEquals, type ClientProjection } from '../core/projection.ts'
import type { Uninstaller } from '../util/patch.ts'

interface WatchState {
  stop: Uninstaller
  changedCount: number
  switchedCount: number
  lastProjection: ClientProjection | null
  lastSource: ProjectionResult['anchorSource'] | null
  canvasPath: string
  samples: string[]
}

let state: WatchState | null = null

export interface WatchStatus {
  active: boolean
  /** 补丁是否成功装上；false 表示必须降级到 rAF 轮询 */
  patched: boolean
  /** 投影确实发生变化（去重后）的次数 */
  changedCount: number
  /** 其中来源发生切换（closed-form ↔ posFromEvt）的次数 */
  switchedCount: number
  canvasPath: string | null
  /** 最近几次有效变化的标量摘要（最多 8 条） */
  samples: string[]
  /** 最近一次的投影来源 */
  lastSource: string | null
  message: string
}

function emptyStatus(message: string): WatchStatus {
  return { active: false, patched: false, changedCount: 0, switchedCount: 0, canvasPath: null, samples: [], lastSource: null, message }
}

function statusFrom(message: string): WatchStatus {
  if (!state) return emptyStatus(message)
  return {
    active: true,
    patched: true,
    changedCount: state.changedCount,
    switchedCount: state.switchedCount,
    canvasPath: state.canvasPath,
    samples: [...state.samples],
    lastSource: state.lastSource,
    message,
  }
}

export function getWatchStatus(): WatchStatus {
  return statusFrom(state ? '监视中' : '未监视')
}

/** 一行标量摘要：scale / origin / source / 是否切换 */
function describeSample(projection: ClientProjection, source: string, switched: boolean, index: number): string {
  const originX = projection.anchorClient.x - projection.anchorWorld.x * projection.scale
  const originY = projection.anchorClient.y - projection.anchorWorld.y * projection.scale
  return (
    '#' + index + ' scale=' + projection.scale.toFixed(6) +
    ' origin=(' + originX.toFixed(1) + ', ' + originY.toFixed(1) + ')' +
    ' source=' + source + ' 切换=' + (switched ? '是' : '否')
  )
}

/** 开始监视当前 Canvas（会先停掉已有的监视） */
export function startViewportWatch(app: App): WatchStatus {
  stopViewportWatch()

  const handle = activeCanvasHandle(app)
  if (!handle) return emptyStatus('没有已加载的 Canvas 视图')

  const canvasPath = handle.file?.path ?? '(未知路径)'
  const samples: string[] = []

  const stop = watchViewportChanges(handle.canvas, () => {
    if (!state) return
    const result = buildProjection(handle.canvas)
    const projection = result.projection
    if (projection === null) return
    // 事件会逐帧触发，只有投影真的变了才算一次"有效变化"
    if (state.lastProjection !== null && projectionEquals(state.lastProjection, projection)) return

    state.changedCount += 1
    const switched = state.lastSource !== null && state.lastSource !== result.anchorSource
    if (switched) state.switchedCount += 1
    state.lastProjection = projection
    state.lastSource = result.anchorSource
    if (state.samples.length < 8) {
      state.samples.push(describeSample(projection, result.anchorSource, switched, state.changedCount))
    }
  })

  if (!stop) {
    return { ...emptyStatus('markViewportChanged 无法包装，需要降级到 rAF 轮询'), canvasPath }
  }

  state = { stop, changedCount: 0, switchedCount: 0, lastProjection: null, lastSource: null, canvasPath, samples }
  return statusFrom('已在 ' + canvasPath + ' 上开始投影监视')
}

export function stopViewportWatch(): WatchStatus {
  if (!state) return getWatchStatus()
  const finalState = state
  state = null
  try {
    finalState.stop()
  } catch (err) {
    console.error('[project-kaki] 还原 markViewportChanged 补丁失败', err)
  }
  return {
    active: false,
    patched: true,
    changedCount: finalState.changedCount,
    switchedCount: finalState.switchedCount,
    canvasPath: finalState.canvasPath,
    samples: finalState.samples,
    lastSource: finalState.lastSource,
    message: '已停止监视：有效投影变化 ' + finalState.changedCount + ' 次，来源切换 ' + finalState.switchedCount + ' 次',
  }
}

/** onunload 用：确保不留下补丁 */
export function disposeViewportWatch(): void {
  stopViewportWatch()
}
