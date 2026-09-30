/**
 * 数值图层配色的**轴**（W2）：一条横向渐变配色 + 可拖动的锚点 + 两端端帽。
 *
 * 用户口径（m01702，逐字）：常规数轴方向（低端在左）；**界面上不画刻度**（刻度只是程序算渐变率的内部量）；
 * **两端的锚点可以拖动改值，但拖动不改端点的颜色**。
 *
 * 三条实现边界：
 * - 只画 DOM 与手势，**不认识插件**：读 / 写配色都走注入的 `getRamp` / `setRamp`（于是设置页与侧栏共用同一份）；
 * - 位置换算、夹取、增删全部走 `src/render/colorRamp.ts` 的纯函数 —— 这一层不重算一遍（两处算法必然分叉）；
 * - 拖动过程中**只动 DOM**，抬手才落盘（一次拖动 = 一次设置写入，不会每移一像素就写一次）。
 */

import {
  RAMP_MIN_STOPS,
  canAddStop,
  canRemoveStop,
  clampStopValue,
  colorForValue,
  describeRampProblem,
  positionForValue,
  rampBounds,
  rampStripGradientCss,
  rangeCapGradientCss,
  valueForPosition,
  widestGapValue,
  withStopColor,
  withStopInserted,
  withStopRemoved,
  withStopValue,
  type ColorStop,
  type RampSpec,
} from '../render/colorRamp.ts'
import { RAMP_AXIS_LABELS } from './strings.ts'

export interface RampAxisOptions {
  /** 稳定标记（冒烟用）：如 `temperature` / `depth` */
  axisId: string
  /** 人话标题（如「温度配色」） */
  label: string
  /** 数值单位（`℃` / `m`）：只在提示与标题里出现，**不上轴** */
  unit?: string
  /** 现读当前配色（拖动过程中会连续读，不能缓存） */
  getRamp: () => RampSpec
  /** 写回整条配色（调用方负责规范化与落盘） */
  setRamp: (ramp: RampSpec) => void
  /** 结构性变化（增删锚点）之后请宿主重绘（「恢复出厂配色」那行的说明会跟着变） */
  requestRerender?: () => void
}

type AxisSelection = { kind: 'stop'; index: number } | { kind: 'under' } | { kind: 'over' } | null

/** 值的人话写法：整数不带小数点，其余最多两位（与设置页其它数字输入同一观感） */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

export function renderRampAxis(containerEl: HTMLElement, options: RampAxisOptions): void {
  let selection: AxisSelection = null
  const unitSuffix = options.unit ?? ''

  const rerender = (): void => {
    containerEl.empty()
    build()
  }

  const writeStops = (stops: ColorStop[], structural = false): void => {
    options.setRamp({ ...options.getRamp(), stops })
    rerender()
    if (structural) options.requestRerender?.()
  }

  const writeRamp = (ramp: RampSpec, structural = false): void => {
    options.setRamp(ramp)
    rerender()
    if (structural) options.requestRerender?.()
  }

  /** `clientX` → 值；容器没有尺寸时返回 null（假 DOM / 隐藏面板里就是这样，别硬算） */
  const valueAtClientX = (track: HTMLElement, clientX: number): number | null => {
    const rect = track.getBoundingClientRect()
    if (rect === undefined || rect === null || !(rect.width > 0)) return null
    const bounds = rampBounds(options.getRamp().stops)
    const ratio = (clientX - rect.left) / rect.width
    return valueForPosition(Math.min(1, Math.max(0, ratio)), bounds)
  }

  /**
   * 拖动一条锚点：按下 → 捕获指针 → 只动这一条的位置 → 抬手才写设置。
   *
   * 为什么监听挂在这个元素上而不是 `document`：指针被 `setPointerCapture` 捕获之后，
   * 后续事件本来就会重定向到它 —— 挂 document 反而要在多处清理监听（漏一处就泄漏）。
   */
  const attachDrag = (handle: HTMLElement, track: HTMLElement, index: number): void => {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      event?.stopPropagation?.()
      const start = options.getRamp().stops[index]
      if (start === undefined) return
      let latest = start.value
      let moved = false
      const onMove = (moveEvent: PointerEvent): void => {
        const value = valueAtClientX(track, moveEvent?.clientX ?? 0)
        if (value === null) return
        const stops = options.getRamp().stops
        const clamped = clampStopValue(stops, index, value)
        const bounds = rampBounds(stops)
        moved = true
        latest = clamped
        handle.style.left = (positionForValue(clamped, bounds) * 100).toFixed(2) + '%'
        handle.title = `锚点 ${index + 1}：${formatValue(clamped)}${unitSuffix}`
      }
      const detach = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
      }
      const onUp = (): void => {
        detach()
        if (!moved) return
        writeStops(withStopValue(options.getRamp().stops, index, latest))
      }
      handle.setPointerCapture?.(event?.pointerId ?? 1)
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    })
  }

  const renderInspector = (box: HTMLElement, ramp: RampSpec, stops: readonly ColorStop[]): void => {
    const emptyHint = (): void => {
      box.createEl('span', { cls: 'fc-ramp-note', text: '点轴上的锚点或两端的端帽来改它' })
    }
    if (selection === null) return emptyHint()
    if (selection.kind === 'stop') {
      const index = selection.index
      const stop = stops[index]
      if (stop === undefined) return emptyHint()
      box.createEl('span', { cls: 'fc-ramp-who', text: `锚点 ${index + 1} / ${stops.length}` })
      const valueInput = box.createEl('input', { cls: 'fc-ramp-input' })
      valueInput.type = 'text'
      valueInput.dataset.fcRampValue = '1'
      valueInput.value = String(stop.value)
      valueInput.addEventListener('change', () => {
        const parsed = Number(valueInput.value.trim())
        if (!Number.isFinite(parsed)) {
          valueInput.value = String(stop.value)
          return
        }
        writeStops(withStopValue(stops, index, parsed))
      })
      const colorInput = box.createEl('input', { cls: 'fc-ramp-color' })
      colorInput.type = 'color'
      colorInput.dataset.fcRampColor = '1'
      colorInput.value = stop.color
      colorInput.addEventListener('change', () => { writeStops(withStopColor(stops, index, colorInput.value)) })
      const remove = box.createEl('button', { cls: 'fc-panel-button fc-ramp-delete' })
      remove.dataset.fcRampDelete = '1'
      remove.setText('删除这条锚点')
      remove.disabled = !canRemoveStop(stops)
      if (remove.disabled) remove.title = `至少要留 ${RAMP_MIN_STOPS} 条锚点（少于两条就没有渐变可言）`
      remove.addEventListener('click', () => {
        const next = withStopRemoved(stops, index)
        if (next === stops) return
        selection = null
        writeStops(next, true)
      })
      return
    }
    const side = selection.kind
    const style = side === 'under' ? ramp.under : ramp.over
    const edgeIndex = side === 'under' ? 0 : stops.length - 1
    const edge = stops[edgeIndex]
    if (edge === undefined) return emptyHint()
    box.createEl('span', { cls: 'fc-ramp-who', text: side === 'under' ? RAMP_AXIS_LABELS.underMin : RAMP_AXIS_LABELS.overMax })
    const limitInput = box.createEl('input', { cls: 'fc-ramp-input' })
    limitInput.type = 'text'
    limitInput.dataset.fcRampLimit = side
    limitInput.value = String(edge.value)
    limitInput.addEventListener('change', () => {
      const parsed = Number(limitInput.value.trim())
      if (!Number.isFinite(parsed)) {
        limitInput.value = String(edge.value)
        return
      }
      writeStops(withStopValue(stops, edgeIndex, parsed))
    })
    const capColor = box.createEl('input', { cls: 'fc-ramp-color' })
    capColor.type = 'color'
    capColor.dataset.fcRampCapColor = side
    capColor.value = style.color
    capColor.addEventListener('change', () => {
      if (side === 'under') writeRamp({ ...ramp, under: { ...ramp.under, color: capColor.value } })
      else writeRamp({ ...ramp, over: { ...ramp.over, color: capColor.value } })
    })
    const farColor = box.createEl('input', { cls: 'fc-ramp-color' })
    farColor.type = 'color'
    farColor.dataset.fcRampFarColor = side
    farColor.value = style.farColor
    farColor.addEventListener('change', () => {
      if (side === 'under') writeRamp({ ...ramp, under: { ...ramp.under, farColor: farColor.value } })
      else writeRamp({ ...ramp, over: { ...ramp.over, farColor: farColor.value } })
    })
  }

  const build = (): void => {
    const ramp = options.getRamp()
    const stops = ramp.stops
    const bounds = rampBounds(stops)
    const lowest = stops[0]
    const highest = stops[stops.length - 1]

    const root = containerEl.createEl('div', { cls: 'fc-ramp' })
    root.dataset.fcRampAxis = options.axisId

    const head = root.createEl('div', { cls: 'fc-ramp-head' })
    head.createEl('span', { cls: 'fc-ramp-title', text: options.label })
    head.createEl('span', { cls: 'fc-ramp-hint', text: '拖动锚点改数值；两端只改限度值，不改颜色' })

    const row = root.createEl('div', { cls: 'fc-ramp-row' })
    const under = row.createEl('button', { cls: 'fc-ramp-cap fc-ramp-cap-under' })
    under.dataset.fcRampCap = 'under'
    under.title = `低于最低限度（${formatValue(lowest?.value ?? 0)}${unitSuffix}）：刚出界是 ${ramp.under.color}，远远更低渐变成 ${ramp.under.farColor}`
    under.style.backgroundImage = rangeCapGradientCss(ramp.under, 'under')
    under.addEventListener('click', () => {
      selection = { kind: 'under' }
      rerender()
    })

    const track = row.createEl('div', { cls: 'fc-ramp-track' })
    track.dataset.fcRampTrack = '1'
    track.style.backgroundImage = rampStripGradientCss(ramp)
    stops.forEach((stop, index) => {
      const handle = track.createEl('button', { cls: 'fc-ramp-handle' })
      handle.dataset.fcRampStop = String(index)
      handle.title = `锚点 ${index + 1}：${formatValue(stop.value)}${unitSuffix}`
      handle.style.left = (positionForValue(stop.value, bounds) * 100).toFixed(2) + '%'
      handle.style.background = stop.color
      handle.addEventListener('click', () => {
        selection = { kind: 'stop', index }
        rerender()
      })
      attachDrag(handle, track, index)
    })

    const over = row.createEl('button', { cls: 'fc-ramp-cap fc-ramp-cap-over' })
    over.dataset.fcRampCap = 'over'
    over.title = `高于最高限度（${formatValue(highest?.value ?? 0)}${unitSuffix}）：刚出界是 ${ramp.over.color}，远远更高渐变成 ${ramp.over.farColor}`
    over.style.backgroundImage = rangeCapGradientCss(ramp.over, 'over')
    over.addEventListener('click', () => {
      selection = { kind: 'over' }
      rerender()
    })

    const actions = root.createEl('div', { cls: 'fc-ramp-actions' })
    const add = actions.createEl('button', { cls: 'fc-panel-button fc-ramp-add' })
    add.dataset.fcRampAdd = '1'
    add.setText('＋ 新建锚点')
    add.disabled = !canAddStop(stops)
    add.addEventListener('click', () => {
      const value = widestGapValue(stops)
      if (value === null) return
      const color = colorForValue(value, ramp)?.color ?? stops[0]?.color ?? '#808080'
      const next = withStopInserted(stops, value, color)
      if (next === stops) return
      const index = next.findIndex((stop) => stop.value === value)
      selection = { kind: 'stop', index: index < 0 ? 0 : index }
      writeStops(next, true)
    })
    actions.createEl('span', {
      cls: 'fc-ramp-count',
      text: `${stops.length} 条锚点 · ${Math.max(0, stops.length - 1)} 段渐变`,
    })

    const problem = describeRampProblem(ramp)
    if (problem !== null) root.createEl('div', { cls: 'fc-ramp-problem', text: problem })

    const inspector = root.createEl('div', { cls: 'fc-ramp-inspector' })
    inspector.dataset.fcRampInspector = '1'
    renderInspector(inspector, ramp, stops)
  }

  build()
}
