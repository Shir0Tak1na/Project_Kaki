/**
 * 界面文案的**单一来源**（施工文件 `docs/UI-COPY-REVIEW.md` §5 的 C4）。
 *
 * 为什么要有它：冒烟里有几十处**逐字比较界面文本**（`scripts/smoke.mjs`）。文案写死在两处时，
 * 改一句话要同时改实现与断言 —— 那就是「改文案必然牵动测试」的根源。
 * 把**被断言钉住**的那些串收在这里：实现与断言读同一个常量，改文案只改这一个文件。
 *
 * 收进来的判据（**不是**所有中文串都要搬家）：
 * 1. **冒烟逐字比较过**它（硬判据，别凭感觉扩表）；
 * 2. 或者它**经常改**（数据层控件名、绘制模式名、未定义类型的标签）。
 * 描述性长句**不收**：它们本来就该随文案轮改，且很少被逐字断言。
 */

import type { GeometryMode } from '../core/hexEdges.ts'

/** 绘制模式的四个人话名（`GeometryMode` → 界面文字；侧栏按钮与浮窗提示共用） */
export const DRAW_MODE_LABELS = {
  edge: '沿网格走',
  step: '逐格前进',
  interior: '锚点折线',
  free: '自由绘制',
} as const

/**
 * 每个绘制模式的一句话提示（**≤20 字**；侧栏按钮的 `title` 与浮窗提示行共用）。
 *
 * 为什么要写成短句而不是长说明：这四个按钮并排一行，长说明只能挂在 hover 上，
 * 而用户判断"该点哪一个"往往发生在**不 hover** 的时候（§5.77 的同一类问题）。
 * 短句读得完，长解释留在本文件与 `USER-MANUAL.md` 里。
 */
export const DRAW_MODE_HINTS = {
  edge: '落点吸附格点，段段沿网格线',
  step: '每次点击沿网格线前进一条边',
  interior: '点哪连哪的折线，顶点可再编辑',
  free: '按住左键随手画，没有可拖顶点',
} as const

/** `GeometryMode` → `DRAW_MODE_*` 的键（界面上 `edge-step` 叫「step」） */
const DRAW_MODE_KEYS: Record<GeometryMode, keyof typeof DRAW_MODE_LABELS> = {
  edge: 'edge',
  'edge-step': 'step',
  interior: 'interior',
  free: 'free',
}

/** 绘制模式的界面名（浮窗 / 侧栏 / 任何要显示"现在是什么模式"的地方都走这里） */
export function drawModeLabel(mode: GeometryMode): string {
  return DRAW_MODE_LABELS[DRAW_MODE_KEYS[mode]]
}

/** 绘制模式的一句话提示（同上：单一来源，别在别处再写一份） */
export function drawModeHint(mode: GeometryMode): string {
  return DRAW_MODE_HINTS[DRAW_MODE_KEYS[mode]]
}

/**
 * 本机没有这条定义时的显示名（图例 / 下拉 / Base 行 / 面板共用一份）。
 *
 * 为什么带 ID：用户看到「未定义类型」还知道去改哪一条；只写「未知」等于让他自己猜。
 */
export function unknownTypeLabel(id: string): string {
  return `未定义类型（${id}）`
}

/** 数据层那一组控件的名字（`spec.label` 是字段名：温度 / 深度 / 生物群系） */
export const OVERLAY_CONTROL_LABELS = {
  unit: (field: string): string => `${field}的展示单位`,
  opacity: (field: string): string => `${field}层的不透明度`,
  mode: (field: string): string => `${field}的显示方式`,
  contourInterval: (field: string): string => `${field}的等值线间距`,
  contourLabelSpacing: (field: string): string => `${field}等值线数字的重复间隔`,
  categoryColors: (field: string): string => `${field}的逐条颜色`,
  showValues: '在每个格上写出数值',
  resetRamp: '恢复出厂配色',
  rampOnlyPointer: '不透明度 / 显示方式 / 等值线 / 写出数值在设置页的「数值图层」里。',
} as const
