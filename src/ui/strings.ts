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

/** 绘制模式的三个人话名（`GeometryMode` → 界面文字；侧栏按钮与浮窗提示共用） */
export const DRAW_MODE_LABELS = {
  edge: '沿网格线连接',
  step: '格步进',
  interior: '沿格心连接',
} as const

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
