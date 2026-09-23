/**
 * 视口变化监视（Phase 0 的 P3 探针）。
 *
 * 用 around() 包装 markViewportChanged 统计触发情况。首轮实测（Obsidian 1.13.7）：
 * 3 次平移 + 3 次缩放触发 168 次回调，说明它在动画期间逐帧触发。
 * 因此这里同时统计两个数：
 *   - 事件总数：回调被调用的次数
 *   - 有效变化数：投影（锚点 + 缩放）确实发生变化的次数
 * 两者之比就是 Phase 1 必须做去重的依据。
 */

import type { App } from 'obsidian'
import { activeCanvasHandle, buildProjection, watchViewportChanges } from '../canvas/CanvasAdapter.ts'
import { projectionEquals, type ClientProjection } from '../core/projection.ts'
import type { Uninstaller } from '../util/patch.ts'

interface WatchState {
  stop: Uninstaller
  totalCount: number
  effectiveCount: number
  lastProjection: ClientProjection | null
  canvasPath: string
  samples: string[]
}

let state: WatchState | null = null

export interface WatchStatus {
  active: boolean
  /** 补丁是否成功装上；false 表示必须降级到 rAF 轮询 */
  patched: boolean
  totalCount: number
  effectiveCount: number
  canvasPath: string | null
  samples: string[]
  message: string
}

function statusFrom(message: string): WatchStatus {
  if (!state) {
    return { active: false, patched: false, totalCount: 0, effectiveCount: 0, canvasPath: null, samples: [], message }
  }
  return {
    active: true,
    patched: true,
    totalCount: state.totalCount,
    effectiveCount: state.effectiveCount,
    canvasPath: state.canvasPath,
    samples: [...state.samples],
    message,
  }
}

export function getWatchStatus(): WatchStatus {
  return statusFrom(state ? '监视中' : '未监视')
}

/** 开始监视当前 Canvas（会先停掉已有的监视） */
export function startViewportWatch(app: App): WatchStatus {
  stopViewportWatch()

  const handle = activeCanvasHandle(app)
  if (!handle) {
    return {
      active: false,
      patched: false,
      totalCount: 0,
      effectiveCount: 0,
      canvasPath: null,
      samples: [],
      message: '没有已加载的 Canvas 视图',
    }
  }

  const canvasPath = handle.file?.path ?? '(未知路径)'
  const samples: string[] = []

  const stop = watchViewportChanges(handle.canvas, () => {
    if (!state) return
    state.totalCount += 1

    const result = buildProjection(handle.canvas)
    const projection = result.projection
    const changed = projection !== null && (state.lastProjection === null || !projectionEquals(state.lastProjection, projection))
    if (changed) {
      state.effectiveCount += 1
      state.lastProjection = projection
    }

    if (state.samples.length < 6) {
      state.samples.push(
        projection
          ? `#${state.totalCount} ${changed ? '变化' : '重复'} scale=${projection.scale.toFixed(6)} origin=(${(
              projection.anchorClient.x - projection.anchorWorld.x * projection.scale
            ).toFixed(1)}, ${(projection.anchorClient.y - projection.anchorWorld.y * projection.scale).toFixed(1)})`
          : `#${state.totalCount} 投影不可用`,
      )
    }
  })

  if (!stop) {
    return {
      active: false,
      patched: false,
      totalCount: 0,
      effectiveCount: 0,
      canvasPath,
      samples: [],
      message: 'markViewportChanged 无法包装，需要降级到 rAF 轮询',
    }
  }

  state = { stop, totalCount: 0, effectiveCount: 0, lastProjection: null, canvasPath, samples }
  return statusFrom(`已在 ${canvasPath} 上开始监视`)
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
    totalCount: finalState.totalCount,
    effectiveCount: finalState.effectiveCount,
    canvasPath: finalState.canvasPath,
    samples: finalState.samples,
    message: `已停止监视：事件 ${finalState.totalCount} 次，其中有效视口变化 ${finalState.effectiveCount} 次`,
  }
}

/** onunload 用：确保不留下补丁 */
export function disposeViewportWatch(): void {
  stopViewportWatch()
}
