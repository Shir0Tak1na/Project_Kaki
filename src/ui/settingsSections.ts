/**
 * 设置页与侧栏面板**共用**的那几节控件渲染（施工文件 §F.2 那条代码纪律）。
 *
 * 为什么单独一个文件：数据层的参数（不透明度 / 色带 / 越界两端 / 显示方式 / 展示单位 /
 * 分类逐条颜色 / 恢复出厂色带）**既要在设置页出现，也要在侧栏面板出现** ——
 * 用户的诉求原话是「不想每次都去设置界面，尽可能利用侧边栏」。两处各写一遍，
 * 就必然出现"设置页改了色带、面板里还是旧控件"这类分叉（本项目最怕的那类缺陷，§5.9）。
 *
 * 三条边界：
 * - **不 import 插件**：读设置、写设置、重绘全部通过注入的 `host` ——
 *   于是这一层不认识 `main.ts`，可以脱离插件单测，也能被面板（它同样不认识插件）复用；
 * - **不在这一层做迁移或规范化**：`setOverlayStyle` 最终会走 `normalizeOverlayStyles`，
 *   "只存改过的那些""空表不留键"这些口径由那一处保证（一处实现，见 §5.12）；
 * - **文案与控件名与原来逐字一致**：这些字符串被冒烟精确匹配（改文案要连断言一起改）。
 */

import { Setting } from 'obsidian'
import {
  OVERLAY_MODES,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  OVERLAY_OPACITY_STEP,
  isCategoryField,
  overlayUnitOf,
  overlayUnitTitle,
  type CategoryOverlayFieldSpec,
  type OverlayFieldSpec,
  type OverlayMode,
  type OverlayStyle,
  type OverlayStyles,
} from '../render/overlayFields.ts'
import type { DepthDisplayUnit } from '../render/elevationUnits.ts'
import { DEFAULT_CONTOUR_LABEL_SPACING_FACTOR } from '../render/fieldPlan.ts'
import type { RampSpec } from '../render/colorRamp.ts'

/** 分类字段的一行"地图上用到过"的记录（设置页与侧栏面板共用这个形状） */
export interface CategoryUsageRow {
  id: string
  label: string
  color: string
  count: number
  known: boolean
}

/**
 * 这一节的宿主：所有"读 / 写 / 重绘"都从这里走。
 *
 * 写成注入而不是直接调插件，是为了让**设置页与面板共用同一份渲染** ——
 * 两者拿到的 `host` 不同（一个写插件设置并保住滚动位置，一个写设置并请求面板重绘），
 * 但控件本身一字不差。
 */
export interface OverlaySectionHost {
  /** 当前的数据层样式（**每次现读**：连续改两个锚点时用旧快照会把前一次改动覆盖掉） */
  getOverlayStyles: () => OverlayStyles
  /** 写某一层的样式（实现里会做规范化与落盘） */
  setOverlayStyle: (field: OverlayFieldSpec['id'], patch: Partial<OverlayStyle>) => void | Promise<void>
  /** 把某一层的色带恢复出厂（不动不透明度与"画数值"开关） */
  resetOverlayRamp: (field: OverlayFieldSpec['id']) => void | Promise<void>
  /** 给**分类字段**的某一条改颜色；空串 = 删掉这条覆盖（回到分类表里的颜色） */
  setOverlayCategoryColor: (field: OverlayFieldSpec['id'], categoryId: string, color: string) => void | Promise<void>
  /**
   * 分类字段：**当前地图上真的用到**的分类（设置页与面板都只列这些）。
   *
   * 为什么不在这里自己扫地图：这一层不认识"当前是哪张地图"（设置页拿不到活动文档），
   * 而且"用到了哪些群系"是插件层现算的（要读自定义目录）。缺省 = 空清单。
   */
  getCategoryUsage?: (spec: CategoryOverlayFieldSpec) => ReadonlyArray<CategoryUsageRow>
  /**
   * 需要重绘宿主界面（设置页保住滚动位置 / 面板请求重绘）。
   *
   * 只有"改了会影响后续控件"的那些项需要它：显示方式（连续场参数要不要出现）、
   * 展示单位（标题里的单位）、恢复色带（"当前就是出厂色带"那句话）。
   */
  requestRerender?: () => void
  /**
   * 要不要自己写小节标题（`h3`）。
   *
   * 设置页需要（它是一长条页面，靠 `h3` 分段）；面板**不需要** ——
   * 面板这一节已经挂在「数据层」折叠组下面，再写一个 `h3` 就是重复的标题。
   */
  heading?: boolean
}

/** 这一层的色带是否还是出厂值（只用来决定「恢复出厂色带」那行的说明怎么写） */
function rampEqualsDefault(ramp: RampSpec, spec: OverlayFieldSpec): boolean {
  return JSON.stringify(ramp) === JSON.stringify(spec.defaultStyle().ramp)
}

/**
 * 一个数据层字段的参数区（**分类字段走另一支**）。
 *
 * 加一个**数值**字段时这里一行都不用改：色带锚点数量、有没有展示单位、是不是自己写标题，
 * 全部由 `spec` 与 `host.heading` 决定。
 */
export function renderOverlayFieldSection(
  containerEl: HTMLElement,
  spec: OverlayFieldSpec,
  host: OverlaySectionHost,
): void {
  if (isCategoryField(spec)) {
    renderCategoryFieldSection(containerEl, spec, host)
    return
  }
  const style = host.getOverlayStyles()[spec.id]
  const stops = style.ramp.stops
  const lowest = stops[0]
  const highest = stops[stops.length - 1]

  if (host.heading !== false) {
    containerEl.createEl('h3', {
      text: `${spec.label}（${spec.units ? overlayUnitTitle(spec, style) : spec.unit || '无量纲'}）`,
    })
  }

  /** 现读当前色带 —— 见 `OverlaySectionHost.getOverlayStyles` 的说明 */
  const liveRamp = (): RampSpec => host.getOverlayStyles()[spec.id].ramp
  const rerender = (): void => host.requestRerender?.()

  // 有展示单位的字段（深度）：米 / 千米 / 相对值是**读法**，所以它是设置项、不进地图文件。
  // 相对值需要地图已标定，这里只说明去哪儿设置 —— 设置页拿不到"当前是哪张地图"。
  if (spec.units) {
    const units = spec.units
    new Setting(containerEl)
      .setName(`${spec.label}的展示单位`)
      .setDesc(
        '只换"怎么读"，一格都没改地图文件：米 / 千米直接换算；相对值（0–1）需要这张地图先设置' +
          '海拔标定（侧栏面板或命令面板里的「设置海拔标定…」）。色带锚点始终按文件里的米填写。',
      )
      .addDropdown((dropdown) => {
        for (const unit of units.options) dropdown.addOption(unit, units.titleOf(unit))
        dropdown.setValue(overlayUnitOf(spec, style) ?? units.defaultUnit)
        dropdown.onChange((value) => {
          void Promise.resolve(
            host.setOverlayStyle(spec.id, { unit: value as DepthDisplayUnit }),
          ).then(rerender)
        })
      })
  }

  new Setting(containerEl)
    .setName(`${spec.label}层的不透明度`)
    .setDesc('色块压在地形之上：调低一点可以同时看清地形与颜色。这一层的开关在「图层」一组里。')
    .addSlider((slider) =>
      slider
        .setLimits(OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX, OVERLAY_OPACITY_STEP)
        .setValue(style.opacity)
        .setDynamicTooltip()
        .onChange((value) => {
          void host.setOverlayStyle(spec.id, { opacity: value })
        }),
    )

  // 显示方式：逐格（局限在六边形里）/ 连续场（插值 + 等值线）。
  // 连续场的参数**只在选了连续场时才出现** —— 用户抱怨过设置页太挤（§5.31/A3）。
  new Setting(containerEl)
    .setName(`${spec.label}的显示方式`)
    .setDesc(
      '逐格上色：每格一块颜色，局限在六边形里。连续场：把格心值插成连续面并画出等值线' +
        '（温度的等温线 / 深度的等高线），不局限于六边形格。两种方式共用同一份几何，导出里也是同一份。',
    )
    .addDropdown((dropdown) => {
      for (const option of OVERLAY_MODES) dropdown.addOption(option.value, option.label)
      dropdown.setValue(style.mode)
      dropdown.onChange((value) => {
        void Promise.resolve(host.setOverlayStyle(spec.id, { mode: value as OverlayMode })).then(rerender)
      })
    })

  if (style.mode === 'field') {
    new Setting(containerEl)
      .setName(`${spec.label}的等值线间距`)
      .setDesc(
        '留空 = 直接用色带锚点（"5 个体感分类"就是现成的 5 条线）。填一个正数则按"间隔的整数倍"取线' +
          `（例如填 10 表示 0、±10、±20…，单位与色带锚点相同：${spec.unit}）。`,
      )
      .addText((text) =>
        text
          .setPlaceholder('留空 = 用色带锚点')
          .setValue(style.contourInterval === null ? '' : String(style.contourInterval))
          .onChange((value) => {
            const trimmed = value.trim()
            // 空 = 回到"用色带锚点"；非正的数**不写**（与设置页其它数字输入同一口径：拒绝而不是悄悄夹取）
            const next = trimmed.length === 0 ? null : Number(trimmed)
            if (next !== null && (!Number.isFinite(next) || next <= 0)) return
            void host.setOverlayStyle(spec.id, { contourInterval: next })
          }),
      )

    // 等值线数字的重复间隔：用户追加要求"每隔多少距离重复一次数字"。
    // 单位是**格**（= 格半径的倍数），于是"调小"在任何缩放下都是同样的地图距离。
    new Setting(containerEl)
      .setName(`${spec.label}等值线数字的重复间隔`)
      .setDesc('沿等值线每隔多远放一个数字（单位：格）。调小变密、调大变疏；留空 = 回到出厂 6。')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_CONTOUR_LABEL_SPACING_FACTOR))
          .setValue(String(style.contourLabelSpacing))
          .onChange((value) => {
            const trimmed = value.trim()
            // 空 = 回到出厂值；非正的数**不写**（与设置页其它数字输入同一口径：拒绝而不是悄悄夹取）
            const next = trimmed.length === 0 ? DEFAULT_CONTOUR_LABEL_SPACING_FACTOR : Number(trimmed)
            if (!Number.isFinite(next) || next <= 0) return
            void host.setOverlayStyle(spec.id, { contourLabelSpacing: next })
          }),
      )
  }

  const setStop = (index: number, patch: { value?: number; color?: string }): void => {
    const ramp = liveRamp()
    const nextStops = ramp.stops.map((stop, position) => (position === index ? { ...stop, ...patch } : stop))
    void host.setOverlayStyle(spec.id, { ramp: { ...ramp, stops: nextStops } })
  }

  stops.forEach((stop, index) => {
    const isLowest = index === 0
    const isHighest = index === stops.length - 1
    const hint = isLowest
      ? `色带的最低端。比 ${stop.value} 更低的值用下面的「低于下限」颜色画。`
      : isHighest
        ? `色带的最高端。比 ${stop.value} 更高的值用下面的「高于上限」颜色画。`
        : '中间锚点：它与左右邻居之间按 Oklab 插值，锚点越密渐变越"分段"。'
    new Setting(containerEl)
      .setName(`${spec.label}色带锚点 ${index + 1}${isLowest ? '（最低）' : isHighest ? '（最高）' : ''}`)
      .setDesc(hint)
      .addText((text) =>
        text.setValue(String(stop.value)).onChange((value) => {
          const parsed = Number(value.trim())
          // 非数字不写：与设置页其它数字输入同一口径（拒绝而不是悄悄夹到边界）
          if (value.trim().length > 0 && Number.isFinite(parsed)) setStop(index, { value: parsed })
        }),
      )
      .addColorPicker((picker) => picker.setValue(stop.color).onChange((value) => setStop(index, { color: value })))
  })

  new Setting(containerEl)
    .setName(`低于下限（< ${lowest?.value ?? 0}${spec.unit}）的颜色`)
    .setDesc(
      '越界是合法数据（-60 ℃ 就是一个温度），不会被丢掉、也不会被截断成端点色 —— ' +
        '用纯色画更醒目，并在格上写出数值（出厂纯蓝底白字）。',
    )
    .addColorPicker((picker) =>
      picker.setValue(style.ramp.under.color).onChange((value) => {
        const ramp = liveRamp()
        void host.setOverlayStyle(spec.id, { ramp: { ...ramp, under: { ...ramp.under, color: value } } })
      }),
    )

  new Setting(containerEl)
    .setName(`高于上限（> ${highest?.value ?? 0}${spec.unit}）的颜色`)
    .setDesc('同上，另一端（出厂纯红底白字）。')
    .addColorPicker((picker) =>
      picker.setValue(style.ramp.over.color).onChange((value) => {
        const ramp = liveRamp()
        void host.setOverlayStyle(spec.id, { ramp: { ...ramp, over: { ...ramp.over, color: value } } })
      }),
    )

  new Setting(containerEl)
    .setName('在每个格上写出数值')
    .setDesc(
      '默认关：密铺时数字比颜色吵。打开后所有格都写出数值；越界格（纯蓝 / 纯红）总是写数值，' +
        '因为它到底是多少只能靠读。',
    )
    .addToggle((toggle) =>
      toggle.setValue(style.showValues).onChange((value) => {
        void Promise.resolve(host.setOverlayStyle(spec.id, { showValues: value })).then(rerender)
      }),
    )

  const changed = !rampEqualsDefault(style.ramp, spec)
  new Setting(containerEl)
    .setName('恢复出厂色带')
    .setDesc(
      changed
        ? '把这一层的锚点与越界颜色恢复成出厂值（不透明度与"画数值"开关不动）。'
        : '当前就是出厂色带。',
    )
    .addButton((button) =>
      button.setButtonText('恢复默认').onClick(() => {
        void Promise.resolve(host.resetOverlayRamp(spec.id)).then(rerender)
      }),
    )
}

/**
 * **分类字段**（生物群系）的那一节：不透明度 + 逐条配色（每条一个输入框，可改回目录色）。
 *
 * 为什么不给色带：分类值之间没有高低，一条渐变**说不通**；
 * 颜色属于目录里的每一条（`BIOMES.md` §3 决定三），所以这里列的是"每条一行"。
 *
 * 覆盖只存**改过的那些**（`style.categoryColors`）：把一条改回目录色 = 删掉那个键，
 * 于是"换一份分类表 = 换一批默认色"这件事仍然成立。
 */
export function renderCategoryFieldSection(
  containerEl: HTMLElement,
  spec: CategoryOverlayFieldSpec,
  host: OverlaySectionHost,
): void {
  const style = host.getOverlayStyles()[spec.id]
  new Setting(containerEl)
    .setName(`${spec.label}层的不透明度`)
    .setDesc('色块压在地形之上：调低一点可以同时看清地形与分类配色。这一层的开关在「图层」一组里。')
    .addSlider((slider) =>
      slider
        .setLimits(OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX, OVERLAY_OPACITY_STEP)
        .setValue(style.opacity)
        .setDynamicTooltip()
        .onChange((value) => {
          void host.setOverlayStyle(spec.id, { opacity: value })
        }),
    )

  new Setting(containerEl)
    .setName(`${spec.label}的逐条颜色`)
    .setDesc(
      '每条自带颜色（改这里只改**画法**，不进地图文件）。' +
        '地图上出现的才会列出来 —— 你还没用到的分类不在这里占位置；清空输入框就回到分类表里的颜色。',
    )

  const usage = host.getCategoryUsage?.(spec) ?? []
  if (usage.length === 0) {
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text: '当前地图上还没有格填了生物群系。用「生物群系」笔刷刷一片，或在侧栏选中一格后填「生物群系（ID）」。',
    })
    return
  }
  for (const row of usage) {
    const override = style.categoryColors?.[row.id]
    new Setting(containerEl)
      .setName(`${row.label}（${row.count} 格）`)
      .setDesc(row.known ? `ID：${row.id}` : `ID：${row.id} —— 本机没有这个分类定义，按中性灰画出来`)
      .addText((text) => {
        text.setPlaceholder(row.color)
        text.setValue(typeof override === 'string' ? override : '')
        text.inputEl.dataset.fcBiomeColor = row.id
        text.onChange((value) => {
          // 空串 = **删掉这条覆盖**（回到目录色），不是写一个空颜色
          void host.setOverlayCategoryColor(spec.id, row.id, value.trim())
        })
      })
  }
}