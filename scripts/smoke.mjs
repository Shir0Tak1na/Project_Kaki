/**
 * 运行时冒烟测试：用桩替身模拟 Obsidian，把编译产物 main.js 真正加载并执行一遍。
 *
 * 桩环境**复刻 Phase 0 在 Obsidian 1.13.7 上实测到的真实结构**（见 docs/archive/PHASE-0-RESULTS.md）：
 *   - wrapper(transform:none) 之下同时存在 svg、canvas-card-menu(纯平移矩阵)、canvas-controls
 *     和真正的世界层 div.canvas(矩阵 a = scale)，世界层里再套各个 canvas-node(纯平移矩阵)；
 *   - 几何关系 client = wrapperRect.topLeft + matrix(e,f) + scale × world；
 *   - tx/ty 默认故意不等于视口中心的世界坐标（对抗性设定）。
 *
 * 因此本测试能覆盖：
 *   - 打包产物能被 CJS 正确加载，插件类导出形态正确；
 *   - 挂载点判定不会误选卡片菜单/节点（这是首轮真实报告暴露出的 bug）；
 *   - 锚点投影与 posFromEvt 一致，闭式兜底关系成立；
 *   - 视口事件能区分「总数」与「有效变化数」，补丁卸载干净；
 *   - 剪贴板不可用时回退写入 vault 文件；
 *   - 没有打开 Canvas 时的降级提示。
 *
 * 运行：node scripts/build.mjs && node scripts/smoke.mjs [--verbose]
 *
 * ⚠️ 不先构建会被**拒绝运行**（见下面的"产物新鲜度门禁"）：冒烟加载的是打包产物，
 * 拿旧产物跑出来的"失败"不是真的失败。
 */

import fs from 'node:fs'
import Module from 'node:module'
import path from 'node:path'
import process from 'node:process'
// 纯模块（不依赖 obsidian）可以直接被测试导入：Node 24 原生剥离 TypeScript 类型。
// 桩环境用它来模拟 Obsidian 的 metadataCache 行为。
import { extractFrontmatterBlock, isMapFileContent, parseFrontmatter } from '../src/data/mapFile.ts'
import { summarizeMapDocument } from '../src/data/mapDocument.ts'
import { axialToWorld, cellKey, worldToAxial } from '../src/core/hex.ts'
import { snapToCellCenter } from '../src/render/markerPlacement.ts'
// 地形标签那一批（场景 54 用它当"期望值"）—— 与实现**共读同一常量**，改表不必改断言（同 C4 口径）
import { TERRAIN_TAGS } from '../src/render/terrainCatalog.ts'
// C4：被逐字断言钉住的界面文案从**单一来源**读（改文案只改 src/ui/strings.ts，不再牵动本文件）
import {
  BASE_TEXT,
  BRUSH_NOTES,
  BRUSH_REASONS,
  COMMAND_NAMES,
  DEFINITION_MODAL_LABELS,
  DEFINITION_ROW_LABELS,
  DIALOG_LABELS,
  DRAW_MODE_LABELS,
  MODAL_ACTIONS,
  NOTICES,
  PANEL_EMPTY_HINTS,
  PANEL_SECTION_TITLES,
  PANEL_TITLES,
  RAMP_AXIS_LABELS,
  SELECTION_MODE_LABELS,
  SELECTION_TEXT,
  SETTINGS_LABELS,
  STATUS_SECTIONS,
  TOOLBAR_TEXT,
  drawModeHint,
  OVERLAY_CONTROL_LABELS,
  unknownTypeLabel,
} from '../src/ui/strings.ts'
import { assertBundleIsFresh } from './lib/bundleFreshness.mjs'
import { scanSources } from './lib/sourceSanity.mjs'

const root = path.resolve(import.meta.dirname, '..')
const verbose = process.argv.includes('--verbose')

/* ------------------------------------------------------- 产物新鲜度门禁 */

/**
 * 拒绝在"陈旧产物"上运行 —— 门禁实现在 `scripts/lib/bundleFreshness.mjs`，
 * 因为 `scripts/deploy.mjs` 要防同一件事（而且那边的后果更难受：用户在真实 Obsidian 里
 * 验证一份过期构建）。两次发作的历史见 `docs/ENGINEERING-NOTES.md` §5.17。
 */
assertBundleIsFresh({ root, action: '冒烟测试' })

/** Phase 0 实测数值（Obsidian 1.13.7） */
const REAL = {
  scale: 0.44669732651951655,
  wrapperRect: { left: 344.6, top: 78.9, width: 681, height: 724 },
  matrixE: 299.375,
  matrixF: 287.988,
  /** 实测：量子 = 1.000001 CSS px（横纵一致），与 devicePixelRatio 无关 */
  quantumCssPx: 1,
  devicePixelRatio: 1.6500000953674316,
}

// 插件会把整份诊断报告 console.log 出来；默认抑制它，只在 --verbose 时显示，
// 否则真正的测试结论会被几百行报告淹没。报告内容仍会从 vault 写入路径断言。
const capturedReports = []
/**
 * 所有被打印到控制台的字符串。
 *
 * 为什么需要它：报告面板打不开时，插件会把报告正文**打到控制台**当作退路
 * （否则这次排查就白做了）。那条退路必须能被断言 —— 而 `capturedReports`
 * 只认诊断报告的前缀（`# Project Kaki — 运行时诊断`），状态报告不在其列。
 */
const consoleLines = []
const realConsoleLog = console.log.bind(console)
console.log = (first, ...rest) => {
  if (typeof first === 'string') consoleLines.push(first)
  if (typeof first === 'string' && first.startsWith('# Project Kaki — 运行时诊断')) {
    capturedReports.push(first)
    if (verbose) realConsoleLog(first)
    return
  }
  realConsoleLog(first, ...rest)
}

/**
 * 捕获 `console.warn`。
 *
 * 「回退到颜色 + 字形」这类降级行为**必须**在控制台留下可读原因，否则用户的体验就是
 * "某一格莫名其妙变灰了"。这条承诺只有把警告抓下来才断言得了，
 * 所以这里既记录又照常转发（转发保留原样，以免掩盖真实问题）。
 */
const warnLog = []
const realConsoleWarn = console.warn.bind(console)
console.warn = (...args) => {
  warnLog.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' '))
  realConsoleWarn(...args)
}

/**
 * 按 Obsidian 的方式加载产物：CommonJS 模块包装。
 * 不能直接 require()：本项目 package.json 是 "type": "module"，Node 会把 .js 当 ESM 加载，
 * 而 Obsidian 用的是自己的 CJS 加载器（插件目录里也不带 package.json）。
 */
function loadBundleAsCjs() {
  const file = path.join(root, 'main.js')
  const mod = new Module(file, null)
  mod.filename = file
  mod.paths = Module._nodeModulePaths(root)
  mod._compile(fs.readFileSync(file, 'utf8'), file)
  return mod.exports
}

let failures = 0
/** 断言总数：交接文档里要写数字，就必须是数出来的而不是估的 */
let assertions = 0

/**
 * 执行一个已注册的命令。
 *
 * 命令现在统一用 `checkCallback`（这样"开发者模式"才能把开发用命令从面板里隐藏），
 * 因此不能再直接调 `command.callback()` —— 这里两种形态都兼容。
 */
function runCommand(plugin, id) {
  const command = plugin.commands.find((item) => item.id === id)
  if (!command) throw new Error(`未注册命令：${id}`)
  if (typeof command.callback === 'function') return command.callback()
  if (typeof command.checkCallback === 'function') return command.checkCallback(false)
  throw new Error(`命令没有可执行的入口：${id}`)
}

function check(label, condition, detail = '') {
  assertions += 1
  if (condition) {
    console.log(`  ✔ ${label}`)
  } else {
    failures += 1
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* --------------------------------------------------- 源码粘贴污染体检 */

/**
 * 拒绝"把读文件工具的输出贴进源码"这类破坏（`scripts/lib/sourceSanity.mjs`）。
 *
 * 这条是 **真的会红** 的：§5.32 那次 `src/base/pngExport.ts` 被追加带行号正文、
 * `tsc` 报 79 个错才拦住；若同样的粘贴落进注释或字符串，类型系统不会报错，
 * 垃圾会跟着产物发出去。这里在文本层再守一道（构建前也会走同一条检查）。
 *
 * ⚠️ 位置有讲究：必须放在 `assertions` / `check` **之后** —— 放在文件开头会撞上
 * `let assertions` 的暂时性死区，整个冒烟当场崩掉（实现时踩过一次：
 * `ReferenceError: Cannot access 'assertions' before initialization`）。
 */
const sourceFindings = scanSources(root)
check(
  '源码里没有被粘贴进来的带行号正文（§5.32 那一类污染）',
  sourceFindings.length === 0,
  sourceFindings.map((finding) => `${finding.file}:${finding.line}(${finding.kind})`).join(', '),
)

/**
 * 读文档里写着的"本次冒烟有多少条断言"，用来对账（见场景末尾那条自检）。
 *
 * 只取**每个文件的第一次**匹配：只有基线行会写成"N 条断言"，正文里提到旧数字的句子
 * （例如"（977 → 982）"）不带"条断言"这个词，所以第一次匹配就是当前基线。
 */
function readDocumentedAssertionCounts() {
  const files = ['docs/ENGINEERING-NOTES.md', 'docs/HANDOFF.md', 'README.md']
  const found = []
  for (const relative of files) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8')
    const match = text.match(/(\d+)\s*条断言/)
    if (match) found.push({ file: relative, value: Number(match[1]) })
  }
  return found
}

// ---------------------------------------------------------------- 环境桩

if (typeof globalThis.MouseEvent !== 'function') {
  globalThis.MouseEvent = class MouseEventStub {
    constructor(type, init = {}) {
      this.type = type
      this.clientX = init.clientX ?? 0
      this.clientY = init.clientY ?? 0
      this.bubbles = Boolean(init.bubbles)
    }
  }
}

/**
 * 「库里存在的图片」资源地址登记表。
 *
 * 真实的 `Image` 由浏览器决定能不能解码：文件不存在 → `onerror`。假 vault 在写入文件时
 * 把它的资源地址登记到这里，于是"文件存在 → 图片能加载"这条因果关系在桩里也是真的，
 * 测试不必自己去维护"哪些图是好的"。
 */
const loadableImageUrls = new Set()

/**
 * 假 `Image`：**语义要与浏览器一致** ——
 * 赋 `src` 之后异步触发 `onload` 或 `onerror`（同步触发会让"未加载完时画回退样式"这条路径永远测不到）。
 */
class FakeImage {
  constructor() {
    this.width = 64
    this.height = 48
    this.naturalWidth = 64
    this.naturalHeight = 48
    this.onload = null
    this.onerror = null
    this._src = ''
    /** 供断言：这张图是"真的被画上去"还是只是被构造了 */
    this.__isFakeImage = true
    // ---- 元素面 ----
    // 真实浏览器里 `createElement('img')` 返回的对象**既是图片也是元素**：
    // 标记层会给它设 class/alt/draggable、用 addEventListener 注册 error，切回字形时还要 remove() 它。
    // 桩里缺这些成员的表现是"真实浏览器里正常、冒烟里抛 TypeError"—— 那种失败最容易被误读成实现有问题，
    // 所以这里按真实 DOM 补齐（同 §5.25：桩必须如实复刻被用到的能力）。
    this.tagName = 'IMG'
    this.className = ''
    this.alt = ''
    this.draggable = true
    this.parentNode = null
    this._listeners = new Map()
    // 按创建顺序登记：测试用"最后被创建的那张图"来分辨"换图之后画的是不是新的那张"
    FakeImage.instances.push(this)
  }

  get src() {
    return this._src
  }

  set src(value) {
    this._src = String(value)
    globalThis.setTimeout(() => {
      // `data:` 地址是浏览器**原生就能解码**的（PNG 导出就是喂给它一张 SVG 的 data URL），
      // 所以这里必须按"加载成功"处理：否则导出会在"图片解码"这一步就失败，
      // 而真正要覆盖的那条降级路径（假画布没有 toBlob）永远走不到。
      if (this._src.startsWith('data:') || loadableImageUrls.has(this._src)) {
        this.onload?.()
        this.dispatchEvent({ type: 'load' })
      } else {
        const error = new Error(`图片不存在：${this._src}`)
        this.onerror?.(error)
        this.dispatchEvent({ type: 'error' })
      }
    }, 0)
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event) {
    for (const handler of [...(this._listeners.get(event.type) ?? [])]) handler(event)
    return true
  }

  /** 真实元素从父节点上摘掉自己（标记层切回字形时会调用） */
  remove() {
    const parent = this.parentNode
    if (parent && typeof parent.removeChild === 'function') parent.removeChild(this)
    this.parentNode = null
  }
}
globalThis.Image = globalThis.Image ?? FakeImage
FakeImage.instances = []

/** 所有被创建过的画布上下文（按创建顺序）：用来在不暴露内部字段的前提下检查离屏图集 */
const createdCanvasContexts = []

// ---------------------------------------------------------------- 假 DOM

/** 记录型 2D 上下文：只统计调用次数与关键属性，供断言使用 */
function makeRecordingContext() {
  const calls = {
    drawImage: 0,
    fill: 0,
    stroke: 0,
    arc: 0,
    clearRect: 0,
    clip: 0,
    save: 0,
    restore: 0,
    setTransform: 0,
    bezierCurveTo: 0,
    closePath: 0,
    setLineDash: 0,
    fillText: 0,
    strokeText: 0,
    putImageData: 0,
  }
  /**
   * 每次 `stroke()` 记录一条「路径段」：该段的点、描边颜色与线宽。
   *
   * 这让测试能检查**画出来的几何**（例如"河流到底是曲线还是折线"），
   * 而不只是"调用了几次 stroke" —— 后者曾经让一个真实缺陷蒙混过关：
   * 变宽分支直接连原始顶点，河流在提交后变成折线，而"逐段描边"的断言照样通过。
   */
  const groups = []
  /** 每次 fillText / strokeText 记录文字内容、位置、旋转角与字号 */
  const texts = []
  /**
   * 每次 `fill()` 记录**用什么颜色填了哪条路径**。
   *
   * 只数"fill 被调了几次"是不够的：自定义地形这个功能的核心承诺就是"这一格用的是
   * 用户设定的颜色 / 这张图片"，而颜色只出现在调用参数里。
   */
  const fills = []
  /** 每次 `drawImage()` 的实参（source + 目标矩形）：用来断言"画的是这张图/这个图块" */
  const images = []
  /** 每次 `putImageData()` 的尺寸与"实色 / 全透明"像素计数（连续场的颜色面） */
  const putImages = []
  /**
   * 每次 `clip()` 时当前路径的点（位图坐标）。
   *
   * 「整片铺图」的正确性有一半在裁剪上：**超出这片区域的不渲染**。
   * 只记录"clip 被调用过"是不够的 —— 那样连"裁到哪"都不知道，断言不出任何几何性质。
   */
  const clips = []
  let current = null
  // 变换只累积平移与旋转（被测代码只用 translate + rotate，不做嵌套矩阵运算）
  let tx = 0
  let ty = 0
  let angle = 0
  const stack = []
  const context = {
    calls,
    groups,
    texts,
    fills,
    images,
    putImages,
    clips,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    /**
     * 虚线状态。
     *
     * 真实 canvas 的 `setLineDash(pattern)` 是**状态**：之后画的每一笔都带着它，
     * 直到被重新设置。桩必须同样保存它，否则"这条区域画的是实线还是虚线"
     * 根本没有地方可断言（`setLineDash` 的参数会被丢掉）——
     * 那正是"设了但没生效"这类缺陷能悄悄溜过去的地方。
     */
    lineDash: [],
    globalAlpha: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    /** 清空计数，用于精确测量"单帧"的绘制量 */
    resetCalls() {
      for (const key of Object.keys(calls)) calls[key] = 0
      groups.length = 0
      texts.length = 0
      fills.length = 0
      images.length = 0
      putImages.length = 0
      clips.length = 0
      current = null
      tx = 0
      ty = 0
      angle = 0
      stack.length = 0
      context.resetFont()
    },
    setTransform() {
      calls.setTransform += 1
    },
    clearRect() {
      calls.clearRect += 1
    },
    beginPath() {
      // 端点/连接样式也要在 `beginPath` 时快照下来：`drawPath` 正是先设这两项、再 beginPath，
      // 而"某条路径用的是平头还是圆头"只存在于这两个属性里 —— 不记录就断言不出来
      current = {
        points: [],
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
        lineCap: context.lineCap,
        lineJoin: context.lineJoin,
        // 虚线也要快照：`drawRegion` 正是先 setLineDash、再 beginPath，
        // 只看 setLineDash 的调用次数分不清"画的是哪条虚线"
        lineDash: [...context.lineDash],
        beziers: 0,
      }
    },
    moveTo(x, y) {
      if (current) current.points.push({ x, y })
    },
    lineTo(x, y) {
      if (current) current.points.push({ x, y })
    },
    closePath() {
      calls.closePath += 1
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      calls.bezierCurveTo += 1
      if (current) {
        current.beziers += 1
        current.points.push({ x, y })
      }
    },
    setLineDash(pattern) {
      calls.setLineDash += 1
      // 与真实 canvas 一致：这是**状态**，不是一次性参数
      context.lineDash = Array.isArray(pattern) ? [...pattern] : []
    },
    fillText(text, x, y) {
      calls.fillText += 1
      // 文字色也要记：越界格要求"纯蓝底**白字**"，不记颜色就断言不出来（与 fill 同一个理由）
      texts.push({ kind: 'fill', text, x: tx + x, y: ty + y, angle, font: context.font, fillStyle: context.fillStyle })
    },
    strokeText(text, x, y) {
      calls.strokeText += 1
      // 描边记的是 `strokeStyle`（不是 `fillStyle`）：等值线数字的**描边颜色必须与字色相反**，
      // 而"相反"这件事只有在能读到描边色时才断言得了 —— 桩记错颜色会让那条断言永远看不到东西
      texts.push({ kind: 'stroke', text, x: tx + x, y: ty + y, angle, font: context.font, strokeStyle: context.strokeStyle })
    },
    measureText(text) {
      // 按当前字号估算宽度：CJK 约 1 em、西文约 0.55 em。
      // 排版逻辑依赖它，桩不能返回与字号无关的常数。
      const px = fontPxOf({ font: context.font })
      const size = Number.isFinite(px) ? px : 16
      let width = 0
      for (const char of String(text)) width += char.codePointAt(0) > 0x2e80 ? size : size * 0.55
      return { width }
    },
    fill() {
      calls.fill += 1
      fills.push({
        fillStyle: context.fillStyle,
        alpha: context.globalAlpha,
        points: current ? current.points.map((point) => ({ x: point.x, y: point.y })) : [],
      })
    },
    stroke() {
      calls.stroke += 1
      if (current) {
        groups.push(current)
        current = null
      }
    },
    arc() {
      calls.arc += 1
    },
    save() {
      calls.save += 1
      stack.push({ tx, ty, angle })
    },
    restore() {
      calls.restore += 1
      const previous = stack.pop()
      if (previous) {
        tx = previous.tx
        ty = previous.ty
        angle = previous.angle
      }
    },
    translate(x, y) {
      tx += x
      ty += y
    },
    rotate(value) {
      angle += value
    },
    clip() {
      calls.clip += 1
      // 记录**裁到哪个路径**，而不只是次数：整片铺图的正确性就体现在
      // "裁剪路径 = 这一片所有六边形的并集"上，只数次数断言不出任何几何性质。
      clips.push(current ? current.points.map((point) => ({ x: point.x, y: point.y })) : [])
    },
    drawImage(source, ...args) {
      calls.drawImage += 1
      // 记录来源与目标矩形：这样"画的是哪张图 / 哪个图块"可以被断言，
      // 而不是只能断言"drawImage 被调了 N 次"（后者放过过真 bug）
      images.push({ source, args: args.map((value) => (typeof value === 'number' ? value : value)) })
    },
    /**
     * 连续场的颜色面：先把 RGBA 像素放进 `ImageData`，`putImageData` 落在离屏画布上，
     * 再由 `drawImage` 缩放铺到主画布。桩必须支持这三步，否则"连续场是不是真的一张栅格"
     * 就只能靠肉眼 —— 而那正是用户实机报"呈方格状"时我们缺的东西。
     */
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) }
    },
    putImageData(image, x, y) {
      calls.putImageData += 1
      // 记下**像素的内容**（哈希一下即可）：断言"有值的点是实色、没值的是全透明"要靠它
      let opaque = 0
      let transparent = 0
      for (let index = 3; index < image.data.length; index += 4) {
        if (image.data[index] === 0) transparent += 1
        else opaque += 1
      }
      putImages.push({ width: image.width, height: image.height, x, y, opaque, transparent })
    },
  }

  /**
   * `font` 用带校验的存取器，**复刻浏览器规则**：
   * canvas 的 `font` 是 CSS font 简写，其中不能出现 `var()`（没有元素可供替换），
   * 一旦非法整条声明无效、赋值被**静默忽略**，画布继续用上一个字体（默认 `10px sans-serif`）。
   *
   * 这个坑真实发生过：字号一直是默认的 10 px，改字号常量"完全没用"，
   * 只有线宽（普通数值属性）会变 —— 用户看到的正是"只有阴影在变化"。
   */
  let fontValue = '10px sans-serif'
  /** 每一次**尝试**写入的字体串（含被拒绝的），用来验证我们从不写 var() */
  const fontAttempts = []
  context.fontAttempts = fontAttempts
  Object.defineProperty(context, 'font', {
    enumerable: true,
    get: () => fontValue,
    set: (value) => {
      fontAttempts.push(String(value))
      if (/var\(/i.test(String(value))) return
      fontValue = String(value)
    },
  })
  context.resetFont = () => {
    fontValue = '10px sans-serif'
    fontAttempts.length = 0
  }

  return context
}

/** 可控的 rAF：把回调排队，由测试显式 flush —— 这样能验证"同帧内合并" */
const frameQueue = []
function flushFrames() {
  const pending = frameQueue.splice(0, frameQueue.length)
  for (const callback of pending) callback(0)
  return pending.length
}

/** 假元素：支持子节点管理、样式、class、canvas 尺寸与记录型上下文 */
function makeEl({
  tagName = 'div',
  className = 'el',
  transform = 'none',
  getTransform = null,
  children = [],
  rect = { left: 0, top: 0, width: 100, height: 100 },
  ownerDocument = null,
} = {}) {
  const el = {
    tagName: tagName.toUpperCase(),
    className,
    style: {
      setProperty(name, value) {
        this[name] = value
      },
      removeProperty(name) {
        delete this[name]
      },
    },
    children: [],
    parentNode: null,
    /**
     * 与真实 DOM 同构的 childElementCount。
     *
     * 曾经漏掉过它：面板用它判断"DOM 是不是空的需要重建"，而 `undefined > 0`
     * 永远是 false —— 于是"状态没变就跳过重绘"这条策略在冒烟里从未生效，
     * 断言只能看到"每次都重建"。假 DOM 少一个成员就会让被测逻辑走另一条分支。
     */
    get childElementCount() {
      return el.children.length
    },
    /**
     * `<select multiple>` 的 `selectedOptions` —— 筛选器的「属于其中之一」用的就是原生多选
     * （`SelectionFilterModal`），而"值"那一栏是枚举里唯一走多选的地方。
     *
     * 真实 DOM 里它是**当时**被选中的那些 option，所以这里按 `selected` **现算**，
     * 而不是在设值的那一刻快照一份 —— 否则测试里改完 `option.selected` 再派发 change
     * 会读到改之前的旧值（"桩少写一半行为"，§5.13 那类）。
     */
    get selectedOptions() {
      return el.children.filter((child) => child.selected === true)
    },
    width: 0,
    height: 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    doc: { activeElement: null },
    /** 与真实 DOM 同构的 dataset */
    dataset: {},
    /** 与真实 DOM 同构的 classList（工具栏等会用 add/remove/toggle） */
    classList: {
      add(...names) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean))
        for (const name of names) set.add(name)
        el.className = [...set].join(' ')
      },
      remove(...names) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean))
        for (const name of names) set.delete(name)
        el.className = [...set].join(' ')
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name)
      },
      toggle(name, force) {
        const has = el.classList.contains(name)
        const shouldHave = force === undefined ? !has : Boolean(force)
        if (shouldHave) el.classList.add(name)
        else el.classList.remove(name)
        return shouldHave
      },
    },
    _transform: transform,
    _getTransform: getTransform,
    _ctx: null,
    _rect: rect,
    _listeners: new Map(),
    /** 滚动相关：真实元素都有这四个成员；桩里默认"不滚动"，测试需要时自己设 */
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientHeight: 0,
    /** 与真实 DOM 同构：`parentElement` 就是父元素（没有父节点时为 null） */
    get parentElement() {
      return el.parentNode ?? null
    },
    addEventListener(type, handler) {
      if (!el._listeners.has(type)) el._listeners.set(type, new Set())
      el._listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      el._listeners.get(type)?.delete(handler)
    },
    dispatchEvent(event) {
      for (const handler of [...(el._listeners.get(event.type) ?? [])]) handler(event)
      return true
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    /**
     * 聚焦相关：真实 DOM 的每个元素都有这几个方法，而对话框打开后会自动聚焦输入框
     * （`setTimeout(() => inputEl.focus(), 0)`）。桩里缺 `focus` 会在下一个 tick 抛错 ——
     * 报错位置离真正的原因很远，所以这里一并补上，并如实维护 `document.activeElement`。
     */
    focus() {
      el.doc.activeElement = el
      /**
       * 真实的 `document.activeElement` 与 `el.doc.activeElement` 是**同一份**信息的两个入口：
       * `CanvasAdapter` 读前者（`el.doc?.activeElement ?? document.activeElement`），
       * 而工具条的"数值框有焦点时别去改它的字"读的是 `ownerDocument.activeElement`。
       * 只更新 `el.doc` 会让后一条守卫在冒烟里**永不生效** —— 表现是"打字打到一半被冲掉"
       * 这个真实缺陷在测试里看不见（桩少了一半行为，§5.13 那类）。
       */
      if (el.ownerDocument) el.ownerDocument.activeElement = el
    },
    blur() {
      if (el.doc.activeElement === el) el.doc.activeElement = null
      if (el.ownerDocument && el.ownerDocument.activeElement === el) el.ownerDocument.activeElement = null
    },
    select() {},
    setSelectionRange() {},
    appendChild(child) {
      child.parentNode = el
      el.children.push(child)
      return child
    },
    /** DOM 的 ParentNode.append：一次追加多个子节点 */
    append(...nodes) {
      for (const node of nodes) el.appendChild(node)
    },
    insertBefore(child, reference) {
      child.parentNode = el
      const index = reference ? el.children.indexOf(reference) : -1
      if (index >= 0) el.children.splice(index, 0, child)
      else el.children.push(child)
      return child
    },
    removeChild(child) {
      const index = el.children.indexOf(child)
      if (index >= 0) el.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    remove() {
      el.parentNode?.removeChild(el)
    },
    get firstChild() {
      return el.children[0] ?? null
    },
    getContext() {
      return el._ctx
    },
    /** 与真实 DOM 同构的 contains：沿父链查找（交互层用它判断事件是否落在地图视图内） */
    contains(node) {
      let current = node?.parentNode ?? null
      while (current) {
        if (current === el) return true
        current = current.parentNode
      }
      return false
    },
    /** 极简 closest：只支持 `.class` 选择器（交互层用它识别 Obsidian 的画布控件） */
    closest(selector) {
      const wanted = String(selector)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('.'))
        .map((part) => part.slice(1))
      const matches = (node) => wanted.some((name) => (node.className ?? '').split(/\s+/).includes(name))
      let current = el
      while (current) {
        if (matches(current)) return current
        current = current.parentNode
      }
      return null
    },
    getBoundingClientRect: () => ({ ...el._rect, right: el._rect.left + el._rect.width, bottom: el._rect.top + el._rect.height }),
    setAttribute(name, value) {
      el[name] = value
    },
    /** Obsidian 的 DOM 扩展：Base 视图与设置界面都依赖它们 */
    createEl(tagName, options = {}) {
      const child = makeEl({ tagName, className: options.cls ?? '' })
      if (typeof options.text === 'string') child.textContent = options.text
      el.appendChild(child)
      return child
    },
    /**
     * Obsidian 在 `HTMLElement` 上还挂了 `createDiv` / `createSpan`（`createEl` 的糖）。
     * 真实环境里它们一直都在，桩里缺了就会**把"用了糖"的实现判成崩溃** ——
     * 那是桩太薄造成的假失败，与被测逻辑无关。
     */
    createDiv(options = {}) {
      return el.createEl('div', options)
    },
    createSpan(options = {}) {
      return el.createEl('span', options)
    },
    empty() {
      el.children.length = 0
      // 真实浏览器里，把滚动容器的内容清空会让 `scrollHeight` 变成 0，
      // 于是 `scrollTop` 被**钳回 0** —— 这就是"重建整页会把设置面板弹回顶上"的机制。
      // 桩里如实模拟这一步，否则"重建前后保住滚动位置"那条断言是空转的
      // （不模拟的话，什么都不做 scrollTop 也不会变）。
      el.scrollTop = 0
    },
    addClass(...names) {
      el.classList.add(...names)
    },
    removeClass(...names) {
      el.classList.remove(...names)
    },
    setText(text) {
      el.textContent = String(text)
    },
  }
  el.ownerDocument = ownerDocument ?? fakeDocument
  // textContent 必须像真实 DOM 一样**聚合子节点**：Base 视图把文字放在子元素里，
  // 只返回自身文本的话断言会全部读到 undefined（曾经因此误判为"渲染失败"）
  let ownText = ''
  Object.defineProperty(el, 'textContent', {
    enumerable: true,
    get() {
      if (ownText.length > 0) return ownText
      return el.children.map((child) => child.textContent ?? '').join('')
    },
    set(value) {
      ownText = String(value)
      el.children.length = 0
    },
  })
  for (const child of children) el.appendChild(child)
  return el
}

const fakeDocument = {
  activeElement: null,
  defaultView: null,
  /**
   * `document` 上的监听（真实 DOM 一定有）。
   *
   * 工具条的「点外面就把下拉收起来」正是往 document 上挂捕获阶段监听 ——
   * 假 document 缺这两个方法时，那段逻辑要么抛错、要么（更糟）静默不生效，
   * 而"点地图不会顺手画一个点"这条行为就再也断言不出来了。
   */
  _listeners: new Map(),
  addEventListener(type, handler) {
    if (!fakeDocument._listeners.has(type)) fakeDocument._listeners.set(type, new Set())
    fakeDocument._listeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    fakeDocument._listeners.get(type)?.delete(handler)
  },
  dispatchEvent(event) {
    for (const handler of [...(fakeDocument._listeners.get(event.type) ?? [])]) handler(event)
    return true
  },
  createElement(tagName) {
    // 与真实 DOM 同构：`createElement('img')` 给出的是图片对象（有 onload/onerror/complete/naturalWidth），
    // 不是通用元素。PNG 导出正是走这条路，早先的桩在这里少了一个成员，
    // 结果"等待图片加载"永远不返回 —— 那类问题在真实浏览器里根本不存在，却会把测试卡死。
    if (String(tagName).toLowerCase() === 'img') return new FakeImage()
    const el = makeEl({ tagName, className: '' })
    el.ownerDocument = fakeDocument
    if (String(tagName).toLowerCase() === 'canvas') {
      el._ctx = makeRecordingContext()
      // 离屏画布（地形图集、导出用的位图）也要能被检查：它们是内部对象，
      // 不从任何公开 API 暴露出来，但"图集里那一格到底画了什么"正是这个功能要验证的东西。
      createdCanvasContexts.push(el._ctx)
      // 刻意**不**提供 `toBlob`：这就是 PNG 导出在受限环境下的降级分支
      // （真实浏览器都有，缺它的情况出现在部分移动端 WebView 上）。
    }
    return el
  },
}
fakeDocument.defaultView = {
  devicePixelRatio: REAL.devicePixelRatio,
  document: fakeDocument,
  getComputedStyle: (el) => ({
    transform: typeof el._getTransform === 'function' ? el._getTransform() : (el._transform ?? 'none'),
    // 真实浏览器会给出**已解析**的字体族（画布的 ctx.font 需要它：font 是 CSS font 简写，
    // 里面不能出现 var()，否则整条声明无效、赋值被静默忽略）
    fontFamily: fakeDocument.defaultView?.fontFamilyOverride ?? '"Fake Sans", system-ui, sans-serif',
  }),
  requestAnimationFrame: (callback) => {
    frameQueue.push(callback)
    return frameQueue.length
  },
  cancelAnimationFrame: (id) => {
    if (typeof id === 'number' && id > 0) frameQueue.splice(id - 1, 1)
  },
}

// Electron 渲染进程里 window 存在；桩环境提供实测到的 devicePixelRatio（1.65），
// 用于验证报告能正确区分「量化粒度是 CSS 像素」与「量化粒度是设备像素」。
globalThis.window = globalThis.window ?? fakeDocument.defaultView

/**
 * 同理：真实环境里 `document` 一直都在，而 `CanvasAdapter.leafContainerContainsFocus` 会读
 * `document.activeElement`（元素自己那份 `doc.activeElement` 为空时的退路）。
 * 桩里不提供这个全局，那条退路一旦被走到就是 `ReferenceError: document is not defined`
 * —— 报错位置离真正的原因很远（场景 53 第一次跑就是这么崩的）。
 */
globalThis.document = globalThis.document ?? fakeDocument

const noticeLog = []
/** 与 noticeLog 一一对应：每条提示的时长（毫秒）。用户抱怨过"等太久才消失"，所以时长必须可断言 */
const noticeDurations = []
const vaultWrites = []
/** 记录被打开过的笔记链接（工作区桩会往里写） */
const openedLinks = []

/**
 * 假的剪贴板：如实记录被写入的文本。
 *
 * 真实 Obsidian 里报告面板的「复制」按钮走 `navigator.clipboard.writeText`；
 * 桩里没有它的话，那条断言只能看到"复制失败的分支"，等于没测成功路径。
 * `installClipboard(false)` 覆盖"剪贴板不可用"的退化分支（真实环境确实会发生：
 * 非安全上下文、权限被拒）。
 *
 * ⚠️ 实现上**只给真实的 `navigator` 加一个属性**，不替换它：
 * 前两版都栽在这上面 —— 第一版把 navigator 换成只有 `clipboard` 的对象，
 * 结果 `navigator.userAgent` 没了，诊断报告直接抛错（与剪贴板毫不相干的功能被打挂）；
 * 第二版改用 `Object.create(navigator)` 继承，又撞上 Node 的 `userAgent` 是**私有字段 getter**，
 * 换个 receiver 就抛 "Cannot read private member"。
 * 教训：**桩要补全能力，不要替换实体**；浏览器里的 navigator 本来就有 clipboard，
 * 给它加一个属性才是更接近真实的形状。
 */
const clipboardWrites = []
function installClipboard(available) {
  const target = globalThis.navigator
  if (target === undefined || target === null) return false
  if (available) {
    target.clipboard = {
      writeText: async (text) => {
        clipboardWrites.push(String(text))
      },
    }
  } else {
    // 不可用时把它去掉（Node 的 navigator 本来就没有 clipboard，所以在原型链上也取不到）
    delete target.clipboard
  }
  return true
}
installClipboard(true)

/**
 * 假 Notice。
 *
 * 时长也记下来：报告原来是 `new Notice(多行文本, 15000)`，用户的反馈是"过一会才消失，等待时间过久"。
 * 只记文本的话，"时长"这个缺陷在测试里**完全看不见** —— 冒烟里那条全局上界断言就是靠这个字段成立的。
 * 省略时长时按 5000 记（真实 Obsidian 的默认值约 5 秒；`0` 表示常驻，这里如实保留 0）。
 */
class FakeNotice {
  constructor(message, duration) {
    noticeLog.push(String(message))
    noticeDurations.push(typeof duration === 'number' ? duration : 5000)
  }
}

/**
 * 清空提示记录。
 *
 * **必须成对清空** `noticeLog` 与 `noticeDurations`：两个数组一一对应，
 * 只清一个就会让错位发生 —— 末尾那条"所有提示都不超过 6000ms"的全局断言会读到别的提示的时长，
 * 于是可能漏掉一条超时提示、也可能误报。这类错位是沉默的，只在很久以后才被发现。
 */
function clearNotices() {
  noticeLog.length = 0
  noticeDurations.length = 0
}

class FakeTFile {
  constructor(filePath) {
    this.path = filePath
  }
}

/**
 * 假 Setting：记录自己被设置过的名称/描述与滑块状态。
 * 设置界面是"用户自己调字号"的唯一入口，因此桩要能把它的数值暴露给断言。
 */
class FakeSetting {
  static created = []

  constructor(containerEl) {
    this.containerEl = containerEl
    /**
     * 真实的 `Setting` 会把控件挂进 `.setting-item-control`（名字在左、控件在右的那一栏），
     * 插件也可以直接往它里面塞自定义控件 —— 自定义地形的「标签」一排 chip 就是这么挂的。
     * 桩里缺这个成员的表现是"真实 Obsidian 一切正常、冒烟里抛 TypeError"（§5.13 那类）。
     */
    this.controlEl = makeEl({ tagName: 'div', className: 'setting-item-control' })
    containerEl.appendChild(this.controlEl)
    this.info = {}
    this.slider = null
    FakeSetting.created.push(this)
  }

  setName(name) {
    this.info.name = name
    return this
  }

  setDesc(desc) {
    this.info.desc = desc
    /**
     * 真实的 `Setting.setDesc` 会建一个 `.setting-item-description` 元素，
     * 而且**插件可以往它里面追加内容**（自定义标记的图片预览就是这么挂上去的）。
     * 桩里缺 `descEl` 的表现是"真实 Obsidian 一切正常、冒烟里抛 TypeError" ——
     * 那类失败最难读（看起来像实现坏了，其实是桩少了一个成员），所以如实补上。
     */
    if (!this.descEl) {
      this.descEl = makeEl({ tagName: 'div', className: 'setting-item-description' })
      this.containerEl.appendChild(this.descEl)
    }
    this.descEl.textContent = String(desc ?? '')
    return this
  }

  addText(callback) {
    const setting = this
    const text = {
      value: '',
      placeholder: null,
      /**
       * `inputEl` 必须存在且是真假元素：真实的 TextPromptModal 会在它上面挂 keydown
       * （"回车提交"就靠这个），`PlaceMarkerModal` 也一样。
       * 之前假 Modal 的 `open()` 是空实现，这些对话框在冒烟里从未真的被构建过，
       * 于是缺这一项也一直没暴露 —— 把 `open()` 改忠实之后立刻就炸了。
       */
      inputEl: makeEl({ tagName: 'input', className: 'text-input' }),
      setPlaceholder(value) {
        this.placeholder = value
        return this
      },
      setValue(value) {
        this.value = value
        /**
         * 真实 `TextComponent.setValue` 会**同时**写进 `inputEl.value`，而插件里确实有地方
         * 直接读 DOM（「设置海拔标定」与「设置数值图层默认值」对话框都是先拿 `inputEl` 再读 `.value`）。
         * 桩只写自己那个 `value` 的话，这条读取路径在冒烟里永远看到空串 ——
         * 表现是"填了值却没生效"，看起来像实现坏了，其实是桩少了一半行为（§5.13 那类）。
         */
        this.inputEl.value = String(value ?? '')
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
      /** 模拟用户在输入框里打字后失焦（触发 onChange） */
      async type(value) {
        this.value = value
        this.inputEl.value = String(value ?? '')
        await this.handler?.(value)
        return this
      },
    }
    callback?.(text)
    // 一个 Setting 上可以挂多个输入框（例如"新增地形"的 ID + 显示名）：
    // 桩如果只留最后一个，测试就没法分别驱动它们，只能看到一半的行为
    setting.texts = setting.texts ?? []
    setting.texts.push(text)
    setting.text = text
    return this
  }

  addColorPicker(callback) {
    const setting = this
    const picker = {
      value: null,
      setValue(value) {
        this.value = value
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
      /** 模拟用户选了一个颜色 */
      async pick(value) {
        this.value = value
        await this.handler?.(value)
        return this
      },
    }
    callback?.(picker)
    setting.colorPickers = setting.colorPickers ?? []
    setting.colorPickers.push(picker)
    setting.colorPicker = picker
    return this
  }

  addButton(callback) {
    const setting = this
    /**
     * 按钮桩要覆盖真实 `ButtonComponent` 里**插件实际用到的**那些链式方法。
     * 缺一个（例如 `setCta`）就会在 `onOpen` 里抛错 —— 而这类错误只在
     * "真的把对话框打开一次"时才会出现，所以过去一直没被发现。
     *
     * `buttonEl` 同理（真实 `ButtonComponent` 一定有它）：导入对话框会往它身上挂
     * `dataset.fcImportRole` 作为稳定标记。桩里缺这个成员不会报错，只会让标记无处可挂 ——
     * 断言于是永远找不到按钮，失败信息看起来像"界面没渲染"，其实是假 DOM 少了一个成员。
     */
    const buttonEl = makeEl({ tagName: 'button', className: 'mod-cta' })
    const button = {
      text: '',
      disabled: false,
      cta: false,
      buttonEl,
      setButtonText(value) {
        this.text = value
        buttonEl.textContent = value
        return this
      },
      setCta() {
        this.cta = true
        return this
      },
      setWarning() {
        this.warning = true
        return this
      },
      setDisabled(value) {
        this.disabled = Boolean(value)
        return this
      },
      setTooltip(value) {
        this.tooltip = value
        return this
      },
      setIcon(value) {
        this.icon = value
        return this
      },
      onClick(handler) {
        this.handler = handler
        return this
      },
      /** 模拟点击 */
      async click() {
        await this.handler?.()
        return this
      },
    }
    callback?.(button)
    // 一个 Setting 上可以挂多个按钮（例如"删除"+"复制"）；`button` 保留为最后一个，兼容既有断言
    setting.buttons = setting.buttons ?? []
    setting.buttons.push(button)
    setting.button = button
    return this
  }

  /**
   * 下拉框。真实语义：`addOption(value, label)` 先登记选项，`setValue` 选中，
   * `onChange` 在用户改选时触发。桩必须保留选项表 —— 否则"字形下拉框里有没有内置地形"
   * 这类断言就没法写。
   *
   * `selectEl` 也是必须的：真实 `DropdownComponent` 一定有它，而插件会往它身上挂
   * `dataset` 标记（对话框里一行有多个下拉时，只能靠标记区分谁是谁）。
   * 桩里缺这个成员不会报错、只会让标记无处可挂 —— 断言于是永远找不到控件，
   * 失败信息看起来像"界面没渲染"，其实是假 DOM 少了一个成员。
   */
  addDropdown(callback) {
    const setting = this
    const selectEl = makeEl({ tagName: 'select', className: 'dropdown' })
    const dropdown = {
      options: [],
      value: null,
      selectEl,
      addOption(value, label) {
        this.options.push({ value, label })
        return this
      },
      addOptions(record) {
        for (const [value, label] of Object.entries(record)) this.options.push({ value, label })
        return this
      },
      setValue(value) {
        this.value = value
        selectEl.value = value
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
      /** 模拟用户改选 */
      async select(value) {
        this.value = value
        selectEl.value = value
        await this.handler?.(value)
        return this
      },
    }
    callback?.(dropdown)
    // 一个 Setting 上只挂一个下拉，但一个对话框里会有好几个：`dropdown` 保留为最后一个，
    // `dropdowns` 收集全部（按渲染顺序），兼容既有断言
    setting.dropdowns = setting.dropdowns ?? []
    setting.dropdowns.push(dropdown)
    setting.dropdown = dropdown
    return this
  }

  addSlider(callback) {
    const setting = this
    const slider = {
      value: null,
      limits: null,
      setLimits(min, max, step) {
        this.limits = { min, max, step }
        return this
      },
      setValue(value) {
        this.value = value
        return this
      },
      setDynamicTooltip() {
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
    }
    callback(slider)
    setting.slider = slider
    return this
  }

  addToggle(callback) {
    const setting = this
    const toggle = {
      value: null,
      // 真实 ToggleComponent 有 `toggleEl`（设置页要给它挂 dataset 标记）与 `setTooltip`。
      // 桩里缺这两个会让"用了它们"的实现直接崩 —— 那是桩太薄造成的假失败。
      toggleEl: makeEl({ tagName: 'div', className: 'checkbox-container' }),
      setTooltip() {
        return this
      },
      setValue(value) {
        this.value = value
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
    }
    callback(toggle)
    setting.toggle = toggle
    return this
  }
}

class FakePlugin {
  constructor(app, manifest) {
    this.app = app
    this.manifest = manifest
    this.commands = []
    /** 落盘的 settings（loadData/saveData 的桩实现：与真实插件一样是 JSON 往返） */
    this._data = null
    this.settingTabs = []
    /** 注册过的 Base 视图（测试据此拿到 factory 并手动实例化） */
    this.basesViews = []
    /** 注册过的视图类型（地图面板） */
    this.registeredViews = []
    /** 注册过的侧边栏图标 */
    this.ribbonIcons = []
  }
  async loadData() {
    return this._data === null ? null : JSON.parse(this._data)
  }
  async saveData(data) {
    this._data = JSON.stringify(data)
  }
  addSettingTab(tab) {
    this.settingTabs.push(tab)
  }
  /**
   * 与真实 Plugin 同签名。刻意放在原型上，以便测试用
   * `delete FakePlugin.prototype.registerBasesView` 模拟"旧版本没有这个 API"。
   */
  registerBasesView(viewId, registration) {
    this.basesViews.push({ viewId, registration })
    return true
  }
  /** 记录注册过的视图（地图面板用），测试据此拿到 creator 并手动实例化 */
  registerView(type, creator) {
    this.registeredViews.push({ type, creator })
    registeredViewCreators.set(type, creator)
  }
  addRibbonIcon(icon, title, callback) {
    this.ribbonIcons.push({ icon, title, callback })
    return makeEl({ className: 'side-dock-ribbon-action' })
  }
  addCommand(command) {
    this.commands.push(command)
    return command
  }
  registerEvent() {}
  registerDomEvent() {}
  registerInterval() {}
  register() {}
}

/**
 * 假 BasesView：与真实基类同构的最小实现。
 *
 * `config` / `data` 由框架在调用 `onDataUpdated()` **之前**填好，桩必须一样 ——
 * 否则测出来的时序和真实环境不同（真实环境里视图不能假设它们在构造时就绪）。
 */
class FakeBasesView {
  constructor(controller) {
    this.controller = controller
    this.config = null
    this.data = null
    this.allProperties = []
  }
}

/** 假 BasesViewConfig：只实现被测代码用到的那部分 */
function makeBasesConfig(values = {}) {
  return {
    values,
    name: '地图',
    get(key) {
      return Object.hasOwn(values, key) ? values[key] : undefined
    },
    getAsPropertyId(key) {
      const value = values[key]
      return typeof value === 'string' ? value : null
    },
    set(key, value) {
      values[key] = value
    },
    getOrder: () => [],
    getSort: () => [],
    getDisplayName: (id) => String(id),
    getEvaluatedFormula: () => null,
  }
}

/** 假 BasesEntry：`getValue` 按属性 id 取前置元数据值 */
function makeBasesEntry(basename, values, dir = '') {
  const path = dir ? `${dir}/${basename}.md` : `${basename}.md`
  return {
    file: { path, basename, extension: 'md' },
    getValue(id) {
      const key = String(id).replace(/^(note|file|formula)\./, '')
      return Object.hasOwn(values, key) ? values[key] : null
    },
  }
}

const fakeObsidian = {
  Plugin: FakePlugin,
  Notice: FakeNotice,
  TFile: FakeTFile,
  TFolder: class FakeTFolder {
    constructor(path) {
      this.path = path
    }
  },
  normalizePath: (value) =>
    String(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '') || '/',
  // TextPromptModal 会 extends Modal，因此桩里必须存在这两个类（否则类定义阶段就会抛错）
  Modal: class FakeModal {
    /**
     * 最近一次 `open()` 的对话框（按类名索引）。
     *
     * 为什么要有它：有些对话框的控件是**裸 DOM**（不是 `Setting`），
     * 于是 `FakeSetting.created` 那条路子看不到它们 —— 而"对话框里到底建了什么"
     * 恰恰是要断言的（选择筛选器的子句行就是这种情况）。
     * 用 `FakeModal.last.get('SelectionFilterModal')` 取那一份，比给对话框加测试专用后门干净。
     */
    static last = new Map()
    /** 最近一次 `open()` 的对话框（不分类型）—— 免得断言依赖被压缩后的类名 */
    static lastAny = null
    constructor(app) {
      this.app = app
      /**
       * `contentEl` 必须是**真的**假元素（有 children / createEl / setText …），
       * 而不是 `{ empty() {}, createEl: () => ({}) }`。
       * 报告面板要在里面建 `<pre>` 并写正文；用一个只会返回空对象的桩，
       * 断言就只能看到 undefined —— 那是"桩太薄"造成的假失败，与实现无关。
       */
      this.contentEl = makeEl({ className: 'modal-content' })
    }
    /**
     * 如实调用 `onOpen` / `onClose`：真实 `Modal.open()` 会触发 `onOpen`。
     * 桩里不调的话，面板的正文根本不会被构建 —— 于是"面板里的内容"这类断言全部测不到东西。
     */
    open() {
      FakeModal.last.set(this.constructor.name, this)
      FakeModal.lastAny = this
      this.onOpen?.()
    }
    close() {
      this.onClose?.()
    }
  },
  /**
   * `FuzzySuggestModal` 的桩：存在的理由是"类定义阶段不能炸" ——
   * `AssetSuggestModal extends FuzzySuggestModal`，而 extends 在**模块加载时**就求值，
   * 缺这个基类会让整个 main.js 加载失败（报错位置与真实原因毫不相干）。
   *
   * ⚠️ 它**刻意不模拟**模糊搜索界面（那套 DOM 与键盘交互无法在假环境里可信复现）。
   * 取而代之：需要断言行为的地方走**注入的替身**（`setImagePickerFactory`），
   * 而真实弹窗自己的逻辑（清单筛选、短标签、选中回调）用 `getItems/getItemText/onChooseItem`
   * 这三个方法直接验 —— 它们才是我们写的代码，模糊搜索本身是 Obsidian 的。
   */
  FuzzySuggestModal: class FakeFuzzySuggestModal {
    constructor(app) {
      this.app = app
      this.placeholder = null
      this.opened = false
    }
    setPlaceholder(value) {
      this.placeholder = value
      return this
    }
    open() {
      this.opened = true
      this.onOpen?.()
    }
    close() {
      this.opened = false
      this.onClose?.()
    }
  },
  Setting: FakeSetting,
  // 设置界面会 extends PluginSettingTab：桩里必须有这个类（否则类定义阶段就抛错）
  PluginSettingTab: class FakePluginSettingTab {    constructor(app, plugin) {
      this.app = app
      this.plugin = plugin
      const container = makeEl({ className: 'setting-tab' })
      container.createEl = (tagName, options = {}) => {
        const child = makeEl({ tagName, className: options.cls ?? '' })
        if (typeof options.text === 'string') child.textContent = options.text
        container.appendChild(child)
        return child
      }
      container.empty = () => {
        container.children.length = 0
        // 与 `makeEl` 里的 `empty()` **同一口径**：内容被清空 ⇒ 浏览器把 scrollTop 钳回 0。
        // ⚠️ 这里必须重复一次，不能指望上面那个实现：设置页用的是这个**覆盖版** empty，
        // 漏掉这一行的话"重建整页会弹回顶部"那条断言就是空转的
        // （实测过：把修复去掉，断言照样绿 —— 因为桩根本没模拟滚动被钳位）。
        container.scrollTop = 0
      }
      this.containerEl = container
    }
    display() {}
  },
  // 按键作用域：桩里记录注册项，测试可直接触发某个按键处理函数
  Scope: class FakeScope {
    constructor(parent) {
      this.parent = parent
      this.registrations = []
    }
    register(modifiers, key, handler) {
      this.registrations.push({ modifiers: modifiers ?? [], key, handler })
      return this
    }
  },
  Keymap: class FakeKeymap {
    constructor() {
      this.scopes = []
    }
    pushScope(scope) {
      this.scopes.push(scope)
    }
    popScope(scope) {
      const index = this.scopes.indexOf(scope)
      if (index >= 0) this.scopes.splice(index, 1)
    }
    get activeScope() {
      return this.scopes[this.scopes.length - 1] ?? null
    }
  },
  apiVersion: '1.13.7-smoke',
  BasesView: FakeBasesView,
  /**
   * 假 ItemView：与真实基类同构的最小实现。
   * 面板视图继承它，因此 `contentEl`、`leaf`、`getViewType` 等必须存在，
   * 否则类定义阶段就会抛错（与 Modal/BasesView 一样的处理）。
   */
  ItemView: class FakeItemView {
    constructor(leaf) {
      this.leaf = leaf
      this.contentEl = makeEl({ className: 'view-content' })
    }
    getViewType() {
      return 'fake-view'
    }
    getDisplayText() {
      return 'Fake View'
    }
    getIcon() {
      return 'file'
    }
    async onOpen() {}
    async onClose() {}
    addAction() {
      return makeEl({ className: 'view-action' })
    }
  },
  Platform: { isDesktop: true, isMobile: false, isDesktopApp: true },
  // 图标：桩要复刻真实 `getIcon` 的**形状** —— 真实的它返回一个含子元素的 `<svg>` 元素，
  // 而导出侧会把子元素序列化成片段内联进 SVG（见 `lucideFragment.ts`）。
  // 桩里缺 `children` / `outerHTML` 的后果是那条链路**静默退回兜底圆点**：
  // 断言全绿、但"标记按字形画"根本没被验过。
  getIcon: (name) => ({ iconName: name, children: [{ outerHTML: `<path data-fc-icon="${name}"/>` }] }),
  setIcon: (el, name) => {
    el.textContent = ''
    el.dataset.icon = name
    return el
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian
  return originalLoad.call(this, request, parent, isMain)
}

// Electron 渲染进程里 window 存在；桩环境提供实测到的 devicePixelRatio（1.65），
// 用于验证报告能正确区分「量化粒度是 CSS 像素」与「量化粒度是设备像素」。
globalThis.window = globalThis.window ?? fakeDocument.defaultView

// ---------------------------------------------------------------- 场景构造

/**
 * 复刻真实 DOM 结构与几何关系，并允许在运行中改变视口（用于测试去重统计）。
 *
 * ⚠️ posFromEvt 带量化：按实测结论建模为**按 1 CSS 像素取整**
 * （不是设备像素 —— 实测 dpr=1.65，量子仍是整整 1 CSS px）。
 *
 * @param {{ txTyAtViewportCenter?: boolean, scale?: number, matrixScale?: number|null,
 *           quantize?: boolean, closedFormOffset?: {x: number, y: number} }} options
 */
function makeCanvas({
  txTyAtViewportCenter = false,
  scale = REAL.scale,
  matrixScale = null,
  quantize = true,
  closedFormOffset = { x: 0, y: 0 },
} = {}) {
  const rect = REAL.wrapperRect
  const state = {
    /** 物理缩放（矩阵 a 分量与 posFromEvt 都用它） */
    matrixScale: matrixScale ?? scale,
    /** 字段 scale 与 tZoom 用这个值，可用来制造不一致 */
    fieldScale: scale,
    e: REAL.matrixE,
    f: REAL.matrixF,
  }

  const origin = () => ({ x: rect.left + state.e, y: rect.top + state.f })
  const toWorld = (client) => {
    const raw = {
      x: (client.x - origin().x) / state.matrixScale,
      y: (client.y - origin().y) / state.matrixScale,
    }
    if (!quantize) return raw
    const quantumWorld = REAL.quantumCssPx / state.matrixScale
    return {
      x: Math.round(raw.x / quantumWorld) * quantumWorld,
      y: Math.round(raw.y / quantumWorld) * quantumWorld,
    }
  }
  const centerWorld = () => toWorld({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  /** 世界坐标 → 客户端坐标（测试用它构造指针事件；与 toWorld 互为逆运算，忽略量化） */
  const toClient = (world) => ({
    x: origin().x + world.x * state.matrixScale,
    y: origin().y + world.y * state.matrixScale,
  })

  const nodeA = makeEl({ className: 'canvas-node', transform: 'matrix(1, 0, 0, 1, -420, -260)', rect: { left: 0, top: 0, width: 420, height: 220 } })
  const nodeB = makeEl({ className: 'canvas-node', transform: 'matrix(1, 0, 0, 1, 220, 40)', rect: { left: 0, top: 0, width: 340, height: 180 } })
  const worldEl = makeEl({
    className: 'canvas',
    // 矩阵里额外叠加 closedFormOffset：用来模拟「闭式关系真的有系统偏差」的场景
    getTransform: () =>
      `matrix(${state.matrixScale}, 0, 0, ${state.matrixScale}, ${state.e + closedFormOffset.x}, ${state.f + closedFormOffset.y})`,
    children: [makeEl({ className: 'svg-layer' }), nodeA, nodeB],
    rect,
  })
  const cardMenu = makeEl({ className: 'canvas-card-menu', transform: 'matrix(1, 0, 0, 1, -71.9744, 0)' })
  const controls = makeEl({ className: 'canvas-controls', transform: 'none' })
  const wrapperEl = makeEl({
    className: 'canvas-wrapper node-insert-event',
    transform: 'none',
    children: [makeEl({ className: 'background-pattern' }), cardMenu, controls, worldEl],
    rect,
  })

  return {
    _state: state,
    _origin: origin,
    get tx() {
      const center = centerWorld()
      return txTyAtViewportCenter ? center.x : center.x + 137.5
    },
    get ty() {
      const center = centerWorld()
      return txTyAtViewportCenter ? center.y : center.y - 92.25
    },
    get tZoom() {
      return Math.log2(state.fieldScale)
    },
    get zoom() {
      return Math.log2(state.fieldScale) // 实测：zoom 是 tZoom 的别名
    },
    get scale() {
      return state.fieldScale
    },
    canvasRect: { width: rect.width, height: rect.height },
    canvasEl: worldEl,
    moverEl: null,
    wrapperEl,
    nodes: new Map([['n1', {}], ['n2', {}]]),
    edges: new Map([['e1', {}]]),
    data: { nodes: [{}, {}], edges: [{}] },
    markViewportChanged() {},
    requestSave() {},
    requestFrame() {},
    setViewport() {},
    zoomToFit() {},
    deselectAll() {},
    posFromEvt(evt) {
      return toWorld({ x: evt.clientX, y: evt.clientY })
    },
    posFromClient(pos) {
      return toWorld({ x: pos.x, y: pos.y })
    },
    /** 测试辅助：世界坐标 → 客户端坐标 */
    _clientFor(world) {
      return toClient(world)
    },
    /** 测试辅助：客户端坐标 → 世界坐标（_clientFor 的逆） */
    _worldFor(client) {
      return toWorld(client)
    },
    /** 测试辅助：世界坐标落在哪个格（与 core/hex.ts 的 pointy 轴向换算同构，格半径 40） */
    _cellContaining(world) {
      const size = 40
      const x = world.x / size
      const y = world.y / size
      const fq = (Math.sqrt(3) / 3) * x - (1 / 3) * y
      const fr = (2 / 3) * y
      let rx = Math.round(fq)
      let ry = Math.round(-fq - fr)
      let rz = Math.round(fr)
      const dx = Math.abs(rx - fq)
      const dy = Math.abs(ry - (-fq - fr))
      const dz = Math.abs(rz - fr)
      if (dx > dy && dx > dz) rx = -ry - rz
      else if (dy > dz) ry = -rx - rz
      else rz = -rx - ry
      const q = rx === 0 ? 0 : rx
      const r = rz === 0 ? 0 : rz
      return `${q}_${r}`
    },
    /** 模拟一次真实的视口变化（平移/缩放） */
    _applyViewport({ de = 40, df = 25, scaleFactor = 1.2 } = {}) {
      state.e += de
      state.f += df
      state.matrixScale *= scaleFactor
      state.fieldScale *= scaleFactor
    },
  }
}

/**
 * 假 vault：实现地图存储层用到的部分，并**如实派发事件**——
 * 自写保护是否生效，正是靠"我们的写入也会触发 modify 事件"来验证的。
 *
 * 两个刻意的真实性细节：
 * 1. 同一路径始终返回**同一个 TFile 实例**，且写入会更新它的 `stat.mtime`
 *    （存储层用 mtime 区分自写与外部改动，桩必须如实模拟）；
 * 2. 事件**异步派发**（setTimeout 0），与 Obsidian 的事件总线一致。
 */
/**
 * 库内路径 → 资源地址。
 *
 * 真实 Obsidian 上 `vault.getResourcePath()` 给出的是 `app://…` 这类地址，
 * 桩只需要保证"同一个路径每次得到同一个地址"，且文件存在与否能被假 `Image` 区分开。
 */
function resourceUrlFor(path) {
  return `app://local/${String(path).replace(/\\/g, '/')}`
}

function makeVault(initialFiles = new Map()) {  const files = new Map()
  const fileObjects = new Map()
  const listeners = { modify: [], create: [], delete: [], rename: [] }
  /** 二进制写入的原始字节（PNG 导出用）：`files` 里放占位串，字节单独留在这里供断言 */
  const binaryWrites = new Map()
  /**
   * 被要求创建的目录（真实 `vault.createFolder` 会真的建出目录）。
   *
   * 桩里以前是空实现：于是"导出到还不存在的目录时先把它建出来"这条承诺
   * 在冒烟里**无法断言**（看起来像"建目录"这一步根本不存在）。
   * 记下来即可 —— 断言只需要知道"我们有没有要求建"。
   */
  const createdFolders = []
  let clock = 1

  const fileFor = (path) => {
    let file = fileObjects.get(path)
    if (!file) {
      file = new FakeTFile(path)
      file.stat = { mtime: clock++, ctime: 1, size: 0 }
      fileObjects.set(path, file)
    }
    return file
  }

  const setContent = (path, content) => {
    files.set(path, content)
    const file = fileFor(path)
    file.stat = { mtime: clock++, ctime: 1, size: content.length }
    // 图片类文件：登记它的资源地址，于是"文件在库里 → 假 Image 能加载成功"成立
    if (/\.(png|jpe?g|webp|svg|gif)$/i.test(path)) loadableImageUrls.add(resourceUrlFor(path))
    return file
  }

  const emit = (event, file) => {
    globalThis.setTimeout(() => {
      for (const listener of listeners[event].slice()) listener(file)
    }, 0)
  }

  for (const [path, content] of initialFiles) setContent(path, content)

  return {
    files,
    listeners,
    fileFor,
    async read(file) {
      return files.get(file.path) ?? ''
    },
    async process(file, fn) {
      const current = files.get(file.path) ?? ''
      const next = fn(current) // 允许 fn 抛错来拒绝写入
      setContent(file.path, next)
      emit('modify', fileFor(file.path))
      return next
    },
    async create(path, data) {
      if (files.has(path)) throw new Error(`文件已存在：${path}`)
      const created = setContent(path, data)
      emit('create', created)
      return created
    },
    /**
     * 二进制写入（PNG 导出用）。
     *
     * 如实复刻三件事：① 文件进入库（`getAbstractFileByPath` 能找到）；② 重名要抛错（与 `create` 同口径）；
     * ③ 字节原样保留供断言。`files` 里放的是一个占位串而不是 ArrayBuffer ——
     * 假库其余读取路径都按文本处理，塞进二进制会连带弄坏那些断言；字节另存在 `binaryFiles` 里。
     */
    async createBinary(path, data) {
      if (files.has(path)) throw new Error(`文件已存在：${path}`)
      binaryWrites.set(path, data)
      const created = setContent(path, '<binary>')
      emit('create', created)
      return created
    },
    /** 供断言：某个路径被写入的二进制字节 */
    binaryFiles: binaryWrites,
    /** 真实语义：建出这个目录（嵌套路径会一并建出父级）。桩只记账，供断言 */
    async createFolder(path) {
      createdFolders.push(String(path))
    },
    /** 供断言：被要求创建过的目录 */
    createdFolders,
    getAbstractFileByPath(path) {
      return files.has(path) ? fileFor(path) : null
    },
    getMarkdownFiles() {
      return [...files.keys()].filter((path) => path.endsWith('.md')).map((path) => fileFor(path))
    },
    /** 官方 API：库内全部文件（图片选择器要用它列候选） */
    getFiles() {
      return [...files.keys()].map((path) => fileFor(path))
    },
    /** 官方 API：把库内文件变成可以直接塞给 `img.src` 的地址 */
    getResourcePath(file) {
      const path = typeof file === 'string' ? file : (file?.path ?? '')
      return resourceUrlFor(path)
    },
    /** 老写法（1.5 之前的适配器接口）；插件把它当回退路径使用 */
    adapter: {
      getResourcePath: (path) => resourceUrlFor(path),
    },
    on(event, callback) {
      listeners[event].push(callback)
      return { event, callback }
    },
    offref(ref) {
      const list = listeners[ref.event]
      const index = list.indexOf(ref.callback)
      if (index >= 0) list.splice(index, 1)
    },
  }
}

/** 让异步派发的 vault 事件有机会被处理 */
const settleEvents = () => new Promise((resolve) => setTimeout(resolve, 25))

/** 插件注册过的视图 creator（面板）—— 假工作区的 setViewState 用它造视图实例 */
const registeredViewCreators = new Map()

/** 构造并派发一个指针事件（模拟真实的按下—拖动—抬手） */
function firePointer(
  element,
  type,
  { clientX = 0, clientY = 0, button = 0, pointerId = 1, target = null, shiftKey = false, altKey = false } = {},
) {
  let prevented = false
  let stopped = false
  const event = {
    type,
    clientX,
    clientY,
    button,
    pointerId,
    // 修饰键要真的带上：选择模式的「Shift 加选 / Alt 取消单格」全靠它，
    // 桩里不给就会变成"断言永远落在默认分支上"（空转）
    shiftKey,
    altKey,
    target: target ?? element,
    preventDefault() {
      prevented = true
    },
    stopPropagation() {
      stopped = true
    },
    stopImmediatePropagation() {
      stopped = true
    },
  }
  element.dispatchEvent(event)
  return { prevented, stopped }
}

/**
 * 模拟真实浏览器里的一次画布 `pointerdown`：**先经过 `document`（捕获阶段），再到达画布容器**。
 *
 * 为什么需要它：假 DOM 不实现事件传播，`fakeDocument.dispatchEvent(...)` 只会在 document 上
 * 调监听器、**根本到不了画布**。于是「工具条在下拉展开时把这一击拦下、不让它落到画布上」
 * 这条契约无法被验证 —— 工具条什么都不做，那一点照样会落到画布，断言也照样绿（空转断言）。
 * 这里显式按真实顺序走两跳，并尊重 `stopPropagation()`：被拦下就不再送给画布。
 * 返回值里的 `reachedCanvas` 就是「这一击有没有到达画布」的客观记录。
 */
function firePointerThroughDocument(documentNode, canvasHost, { clientX = 0, clientY = 0, button = 0, pointerId = 1, target = null } = {}) {
  let stopped = false
  const event = {
    type: 'pointerdown',
    clientX,
    clientY,
    button,
    pointerId,
    target: target ?? canvasHost,
    preventDefault() {},
    stopPropagation() {
      stopped = true
    },
    stopImmediatePropagation() {
      stopped = true
    },
  }
  documentNode.dispatchEvent(event)
  // 必须在派发给画布**之前**判定：画布自己的 handler 也会调 stopPropagation（它在处理这一击），
  // 派发之后再读 `stopped` 会把「真的到达了画布」误报成「被拦下」。
  const reachedCanvas = !stopped
  if (reachedCanvas) canvasHost.dispatchEvent(event)
  return { stopped: !reachedCanvas, reachedCanvas }
}

/** 假 metadataCache：用被测仓库自己的 frontmatter 解析器，模拟 Obsidian 提供 frontmatter */
function makeMetadataCache(vault) {
  return {
    getFileCache(file) {
      const content = vault.files.get(file.path)
      if (typeof content !== 'string') return null
      const block = extractFrontmatterBlock(content)
      if (block === null) return null
      const parsed = parseFrontmatter(block)
      const frontmatter = { type: parsed.type, name: parsed.name, 'fc-version': parsed.fcVersion, ...parsed.rest }
      if (parsed.canvases.length > 0) frontmatter.canvases = parsed.canvases
      return { frontmatter }
    },
  }
}

function makeApp(canvas, options = {}) {
  // 视图容器包含 wrapperEl —— 交互层就是在这一层用捕获阶段监听指针
  const containerEl = makeEl({ className: 'workspace-leaf-content' })
  containerEl.appendChild(canvas.wrapperEl)
  /**
   * 诊断报告第 8 节会量"我方浮层有没有压住 Obsidian 原生控件"（D）。真实视图容器是个真 DOM，
   * 有 `querySelector`；桩里补一个**最小**实现，让这条链路在冒烟里也真的走一遍。
   * 几何判定的正确性由 `tests/overlayGeometry.test.ts` 的 6 条单测钉死，这里只证明"接线接上了、
   * 两个状态都报得出来"。
   */
  const fakeRects = [
    { selector: '.fc-toolbar', rect: { left: 8, top: 48, width: 200, height: 48 } },
    { selector: '.view-header', rect: { left: 0, top: 0, width: 900, height: 40 } },
    { selector: '.canvas-controls', rect: { left: 848, top: 640, width: 40, height: 60 } },
  ]
  containerEl.__fcRects = fakeRects
  containerEl.querySelector = (selector) => {
    const hit = fakeRects.find((entry) => entry.selector === String(selector))
    return hit ? makeEl({ className: String(selector).slice(1), rect: hit.rect }) : null
  }

  const leaf = {
    isDeferred: false,
    view: {
      canvas,
      file: new FakeTFile('Maps/World.canvas'),
      containerEl,
      getViewType: () => 'canvas',
    },
  }
  const vault = options.vault ?? makeVault()
  const workspaceListeners = []
  /**
   * 侧边栏叶子：面板视图会被挂到它上面。
   * `setViewState` 如实调用视图 creator —— 与真实工作区一样，
   * 这样测试能拿到面板实例并检查它渲染出来的按钮。
   */
  const panelLeaves = []
  const makeLeaf = (viewType) => {
    const leaf = {
      viewType,
      view: null,
      setViewState: async (state) => {
        leaf.viewType = state.type
        const registered = registeredViewCreators.get(state.type)
        if (registered) {
          leaf.view = registered(leaf)
          if (typeof leaf.view.onOpen === 'function') await leaf.view.onOpen()
        }
      },
      detach: () => {
        const index = panelLeaves.indexOf(leaf)
        if (index >= 0) panelLeaves.splice(index, 1)
      },
    }
    return leaf
  }
  return {
    vault,
    metadataCache: makeMetadataCache(vault),
    scope: new fakeObsidian.Scope(null),
    keymap: new fakeObsidian.Keymap(),
    workspace: {
      getLeavesOfType: (type) => {
        if (type === 'canvas') return [leaf]
        return panelLeaves.filter((item) => item.viewType === type)
      },
      getMostRecentLeaf: () => leaf,
      activeLeaf: leaf,
      on: (event, callback) => {
        workspaceListeners.push({ event, callback })
        return { event, callback }
      },
      offref: () => {},
      getLeaf: () => ({ openFile: async () => {} }),
      getRightLeaf: () => {
        const created = makeLeaf('empty')
        panelLeaves.push(created)
        return created
      },
      revealLeaf: async () => {},
      detachLeavesOfType: (type) => {
        for (const item of [...panelLeaves]) {
          if (item.viewType === type) item.detach()
        }
      },
      openLinkText: (link, source, newLeaf) => {
        openedLinks.push({ link, source, newLeaf })
        return Promise.resolve()
      },
    },
  }
}

async function loadPlugin(app) {
  const PluginClass = loadBundleAsCjs()
  const plugin = new PluginClass(app, { id: 'project-kaki' })
  await plugin.onload()
  return plugin
}

/** 运行诊断命令并取回报告（命令内部是异步的，需要让出一轮事件循环） */
async function runDiagnostics(app) {
  const plugin = await loadPlugin(app)
  const diagnose = plugin.commands.find((c) => c.id === 'diagnose-canvas')
  if (!diagnose) throw new Error('未注册 diagnose-canvas 命令')
  // 探针命令是"仅开发者模式"的：这里先把开关打开，模拟用户主动启用（默认是关的，见场景 22）
  await plugin.setDeveloperMode(true)
  const before = capturedReports.length
  runCommand(plugin, 'diagnose-canvas')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const report = capturedReports[before] ?? ''
  return { plugin, report }
}

/**
 * 捕获「报告面板」的内容。
 *
 * 地图状态报告与诊断报告现在走报告面板而不是长 `Notice`（用户反馈：弹窗盖住侧边栏按钮、
 * 要等很久才消失、而且文字复制不出来）。于是断言不能再从 `noticeLog` 拿文本 ——
 * 这里注入一个"只记下 options"的替身，并把**默认工厂**一并返回：
 * 需要验证真实面板的按钮时，用默认工厂自己去造一个面板实例。
 */
function captureReports(plugin) {
  const reports = []
  const defaultFactory = plugin.reportModalFactory
  plugin.setReportModalFactory((_app, options) => {
    reports.push(options)
    return { open() {} }
  })
  return {
    reports,
    /** 最近一次报告的正文（没有报告时返回空串，让断言能给出可读的失败信息） */
    text: () => reports.at(-1)?.text ?? '',
    last: () => reports.at(-1),
    /** 恢复成真实面板（此后命令会真的造一个 ReportModal） */
    restore: () => plugin.setReportModalFactory(defaultFactory),
    defaultFactory,
  }
}

/**
 * 打开「地图定义」弹窗（A3：四类定义的增删改从设置页搬到了这里）。
 *
 * 读回**默认工厂**再自行实例化 —— 与 `captureReports` 的做法一致：我们不拦截它，
 * 而是要拿到真实实现，然后用假 DOM（`FakeSetting.created`）驱动它的控件。
 * 这一步替代了旧的「`plugin.settingTabs[0].display()` 然后去设置页里找控件」。
 */
function openDefinitionManager(plugin) {
  const modal = plugin.definitionModalFactory(plugin.app, plugin)
  modal.open()
  return modal
}

/**
 * 捕获「删除定义」确认框收到的选项（与 `captureReports` / `captureExportModals` 同一套路）。
 *
 * 用来钉住 A3 的一条明确要求：**只在有地图引用它时才拦一下**。
 * 没有引用的删除走的是"直接删"那条快路，根本不会碰这个工厂 ——
 * 所以"`opened` 是空的"本身就是"没有弹窗打扰用户"的证据。
 */
function captureDeleteModals(plugin) {
  const opened = []
  const defaultFactory = plugin.deleteModalFactory
  plugin.setDeleteModalFactory((_app, options) => {
    opened.push(options)
    return { open() {} }
  })
  return {
    opened,
    last: () => opened.at(-1),
    restore: () => plugin.setDeleteModalFactory(defaultFactory),
    defaultFactory,
  }
}

/**
 * 捕获「导出地图」对话框收到的选项（与 `captureReports` 同一套路）。
 *
 * 为什么要捕获：对话框里"范围/格式/区域"这些内容全是 `main.ts` 现算出来传进去的，
 * 而那才是我们写的逻辑；对话框本身只负责把它们画出来。
 * 把**默认工厂**一并返回，就能再用同一份选项造一个**真对话框**，
 * 用假 DOM 驱动它的下拉框与按钮（`FakeSetting.created` 收着它建的每一个 Setting）。
 */
function captureExportModals(plugin) {
  const opened = []
  const defaultFactory = plugin.exportModalFactory
  plugin.setExportModalFactory((_app, options) => {
    opened.push(options)
    return { open() {} }
  })
  return {
    opened,
    last: () => opened.at(-1),
    restore: () => plugin.setExportModalFactory(defaultFactory),
    defaultFactory,
  }
}

/**
 * 捕获「导入定义文件」对话框收到的选项（与 `captureExportModals` 同一套路）。
 *
 * 为什么要捕获：对话框里的正文（新增几条、跳过哪些、哪一段文件里没有）全是 `main.ts`
 * 现算出来传进去的，而那才是我们写的逻辑。把**默认工厂**一并返回，就能用同一份选项
 * 造一个真对话框，用假 DOM 驱动它的按钮。
 */
function captureImportModals(plugin) {
  const opened = []
  const defaultFactory = plugin.importModalFactory
  plugin.setImportModalFactory((_app, options) => {
    opened.push(options)
    return { open() {} }
  })
  return {
    opened,
    last: () => opened.at(-1),
    restore: () => plugin.setImportModalFactory(defaultFactory),
    defaultFactory,
  }
}

/**
 * 递归收集某个 class 的所有后代元素（按**完整 class 词**匹配，避免前缀误伤）。
 *
 * `root` 允许为 `undefined`：断言里常常写 `collectByClass(某个可能没找到的元素, ...)`，
 * 让它在"元素不存在"时返回空数组，失败信息才会落在**那条断言**上；
 * 否则会抛 TypeError，看起来像测试脚本坏了，而不是被测行为不对。
 */
function collectByClass(root, className) {
  const out = []
  if (root === undefined || root === null) return out
  const walk = (node) => {
    if (typeof node.className === 'string' && node.className.split(/\s+/).includes(className)) out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return out
}

/**
 * 打开（或复用）侧栏地图面板并返回它的视图。
 *
 * 为什么要它：施工文件 §F.2 那一轮把**工具 / 笔刷 / 选择方式**三节控件从画布浮窗搬进了侧栏，
 * 浮窗只剩「状态 + 模式 + 撤销/重做」。于是"地形按钮有几个""筛选…在哪""刷什么下拉"
 * 这类断言必须去面板里找 —— 面板是全局单例视图，开一次就够。
 *
 * ⚠️ 面板的重绘排队在可控 rAF 里（见 `frameQueue`）：改完状态要 `flushFrames()` 之后再读 DOM，
 * 否则读到的还是上一帧。
 */
async function openMapPanel(app, plugin) {
  if (app.workspace.getLeavesOfType('fictional-cartographer-panel').length === 0) {
    plugin.ribbonIcons[0].callback()
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
}

/** 面板里的元素查询（§F.2 之后，工具 / 笔刷 / 选择方式的控件都在面板里） */
function inPanel(panel, className) {
  return collectByClass(panel?.contentEl, className)
}

/**
 * 把若干条「路径段」按顺序拼成一条折线。
 *
 * 变宽描边是**逐段**画的（每段一次 beginPath/stroke），所以一条河流会记录成很多条 2 点记录；
 * 这里把它们接回去，得到"实际画出来的那条线"。相邻重复点会被去掉。
 */
function joinStrokePoints(groups, strokeStyle) {
  const points = []
  for (const group of groups) {
    if (strokeStyle !== undefined && group.strokeStyle !== strokeStyle) continue
    for (const point of group.points) {
      const last = points[points.length - 1]
      if (last && Math.abs(last.x - point.x) < 1e-9 && Math.abs(last.y - point.y) < 1e-9) continue
      points.push(point)
    }
  }
  return points
}

/**
 * 折线的转角（度）。这是"曲线 vs 折线"的判别器：
 * 折线把转弯集中在少数几个顶点上（单点转角很大），曲线则把同样的总转角摊到很多小转角上。
 */
function turningAngles(points) {
  const turns = []
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const first = Math.atan2(b.y - a.y, b.x - a.x)
    const second = Math.atan2(c.y - b.y, c.x - b.x)
    let delta = second - first
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    if (Math.abs(delta) > 1e-12) turns.push(delta)
  }
  const degrees = turns.map((turn) => (turn * 180) / Math.PI)
  return {
    count: degrees.length,
    max: degrees.length > 0 ? Math.max(...degrees.map(Math.abs)) : 0,
    total: degrees.reduce((sum, value) => sum + value, 0),
  }
}

/**
 * 折线上离某点最近处的**弧长**。
 * 用来验证"文字是沿线条等距摆放的"——直线距离在弯曲处会被缩短，只有弧长才是真的等距。
 */
function nearestArcLength(points, target) {
  let travelled = 0
  let best = { distance: Number.POSITIVE_INFINITY, arc: 0 }
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]
    const to = points[i + 1]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length <= 0) continue
    const t = Math.min(1, Math.max(0, ((target.x - from.x) * dx + (target.y - from.y) * dy) / (length * length)))
    const distance = Math.hypot(target.x - (from.x + dx * t), target.y - (from.y + dy * t))
    if (distance < best.distance) best = { distance, arc: travelled + length * t }
    travelled += length
  }
  return best
}

/** 这一帧里"作为完整一段"被画出来的文字（排除描边光晕那一遍） */
function drawnRuns(context) {
  return context.texts.filter((item) => item.kind === 'fill')
}

/** 这一帧里被画出来的所有文字内容（按绘制顺序拼接） */
function drawnText(context) {
  return drawnRuns(context)
    .map((item) => item.text)
    .join('')
}

/** 从 `600 25px var(--font-interface...)` 里取出 25 */
function fontPxOf(text) {
  const match = /(\d+(?:\.\d+)?)px/.exec(text.font ?? '')
  return match ? Number(match[1]) : Number.NaN
}

/**
 * 让覆盖层画布如实报告它在屏幕上的尺寸。
 *
 * 真实浏览器里 `getBoundingClientRect()` 返回的是元素经过**所有祖先 transform**之后的尺寸：
 * 覆盖层容器的 CSS 尺寸是"可见世界尺寸"，而 `div.canvas` 上还有 scale 变换，
 * 因此屏幕宽度 = 容器 CSS 宽度 × 缩放。
 *
 * 插件用这个实测值把"名称字号（屏幕 CSS 像素）"换算成位图像素。桩必须如实模拟，
 * 否则测到的会是"回退到 devicePixelRatio"那条路，而不是真实路径。
 * 返回一个可以覆盖测量结果的函数（用于制造"模型算错了"的对抗性场景）。
 */
function attachFaithfulRect(canvasElement, canvas) {
  const overlay = canvasElement.parentNode
  const scale = canvas._state.matrixScale
  const screenWidth = () => (Number.parseFloat(overlay.style.width) || 0) * scale
  const screenHeight = () => (Number.parseFloat(overlay.style.height) || 0) * scale
  canvasElement.getBoundingClientRect = () => {
    const width = screenWidth()
    const height = screenHeight()
    return { left: 0, top: 0, width, height, right: width, bottom: height }
  }
  /** 把屏幕宽度改成原来的 `factor` 倍（模拟"位图与 CSS 尺寸的比例和我以为的不一样"） */
  return (factor) => {
    canvasElement.getBoundingClientRect = () => {
      const width = screenWidth() * factor
      const height = screenHeight() * factor
      return { left: 0, top: 0, width, height, right: width, bottom: height }
    }
  }
}

/**
 * 派发一个带常用方法的通用事件（click / contextmenu 等）。
 *
 * `element` 允许为 `undefined`（"本以为存在的元素没找到"）：这时直接返回，
 * 让后续断言去失败，而不是在这里抛 TypeError —— 报错位置应当在断言上。
 */
function fireEvent(element, type, init = {}) {
  let prevented = false
  let stopped = false
  const event = {
    type,
    target: init.target ?? element,
    preventDefault() {
      prevented = true
    },
    stopPropagation() {
      stopped = true
    },
    stopImmediatePropagation() {
      stopped = true
    },
  }
  // 真实键盘事件带 `key`；桩里必须补上，否则"按 Enter 提交"这类断言根本发不出来
  // （缺了它，handler 里的 `event.key === 'Enter'` 永远是 false —— 断言会变成空转）
  if (init.key !== undefined) event.key = init.key
  // 指针坐标：拖动类断言要按 `clientX` 算位置（缺了它，`event.clientX` 是 undefined，拖动变成空转）
  if (init.clientX !== undefined) event.clientX = init.clientX
  if (init.clientY !== undefined) event.clientY = init.clientY
  if (init.pointerId !== undefined) event.pointerId = init.pointerId
  if (element === undefined || element === null) return { prevented, stopped }
  element.dispatchEvent(event)
  return { prevented, stopped }
}

// ---------------------------------------------------------------- 执行

console.log('Project Kaki — 运行时冒烟测试\n')

console.log('场景 1：运行时诊断报告（此刻状态 / 投影裁决 / 规模与 DOM）')
{
  const app = makeApp(makeCanvas())
  const { report } = await runDiagnostics(app)
  check('报告已生成并被捕获', report.length > 0)
  check('标题已从 Phase 0 改成运行时诊断', report.startsWith('# Project Kaki — 运行时诊断'))
  check('报告包含 Canvas 叶子小节', report.includes('## 1. Canvas 叶子'), report.slice(0, 60))
  check('报告列出了活动画布路径', report.includes('Maps/World.canvas'))

  // (a) 这一刻系统是什么状态
  check('报告给出地图文档小节（未绑定时如实说明）', report.includes('## 2. 地图文档') && report.includes('未绑定地图文档'))
  check('报告给出图层/覆盖层的解析来源', report.includes('## 3. 图层与覆盖层的解析来源') && report.includes('库级模板（当前没有绑定地图）'))
  check('报告给出当前选中与内容规模', report.includes('## 4. 当前选中与内容规模') && report.includes('当前选中：无'))
  check('内容规模在无文档时如实说无法计算', report.includes('内容规模：无已加载的地图文档'))

  // (b) 投影是怎么判的 —— 本轮重点
  check('报告新增投影裁决小节', report.includes('## 5. 投影是怎么判的'))
  check('挂载点判定为 div.canvas', report.includes('世界层挂载点 = `div.canvas`'), report.match(/世界层挂载点[^\n]*/)?.[0] ?? '(缺少判定行)')
  check('挂载点不是卡片菜单或节点', !/世界层挂载点 = `div\.canvas-(card-menu|node|controls|control)/.test(report))
  check('给出缩放与来源', report.includes('缩放：0.446697327（来源：变换矩阵 a 分量）'), report.match(/- 缩放：[^\n]*/)?.[0] ?? '')
  check('给出投影原点', report.includes('- 原点：(643.975, 366.888)'), report.match(/- 原点：[^\n]*/)?.[0] ?? '')
  check('给出判定来源（闭式与采样一致 ⇒ closed-form）', report.includes('判定来源：closed-form'), report.match(/- 判定来源：[^\n]*/)?.[0] ?? '')
  check('给出闭式与采样的差（本轮重点）', report.includes('闭式 vs 采样：originDeltaPx=0.1754 · scaleDelta=0.000657'), report.match(/- 闭式 vs 采样[^\n]*/)?.[0] ?? '')
  check('明确写出是否发生切换', report.includes('是否发生切换：否（闭式与采样一致，仍用闭式）'))
  check('给出 posFromClient 往返偏差', report.includes('posFromClient 往返偏差：0.1256 px'))
  check('给出视口矩形', report.includes('视口矩形：left=344.60 top=78.90 681×724'))
  check('给出 world bbox', report.includes('world bbox：x∈[-670.2, 854.3] y∈[-644.7, 976.1]'), report.match(/world bbox[^\n]*/)?.[0] ?? '')

  // (c) 规模与 DOM
  check('报告新增规模与 DOM 小节', report.includes('## 6. 规模与 DOM'))
  check('无地图时如实说无法计算规模', report.includes('无法计算：缺少地图文档、投影或视口矩形'))
  check('给出浮层元素数', report.includes('浮层元素：我方 1 个 · 原生控件 2 个'))

  // 保留的两节：浮层重叠 + 选择器命中
  check('报告保留「浮层与原生控件是否重叠」为第 7 节', report.includes('## 7. 浮层与原生控件是否重叠'))
  check('报告保留「CSS 选择器命中」为第 8 节', report.includes('## 8. CSS 选择器命中'))
  check('真的量到尺寸并逐对比较（1 个浮层 × 2 个原生控件 = 2 组）', report.includes('- ✅ 逐对比较 2 组，没有一组重叠'), report.match(/- (✅|⚠️)[^\n]*/)?.[0] ?? '(缺判定行)')
  check('两边的清单都写清了是谁', report.includes('`.fc-toolbar`') && report.includes('`.view-header`') && report.includes('`.canvas-controls`'))
  check(
    '写清我方浮层选择器命中几个（未命中的点名）',
    report.includes('- 选择器命中：1 / 3（未找到：`.fc-selection-card` / `.fc-legend`）'),
    report.match(/- 选择器命中[^\n]*/)?.[0] ?? '(缺命中行)',
  )
  check('写清原生控件选择器命中几个（未命中的点名）', report.includes('- 选择器命中：2 / 4（未找到：`.canvas-card-menu` / `.canvas-menu`）'))
  // 反例控制：把浮层挪到标题栏上方再跑一次 —— 同一段代码必须报出重叠与尺寸，否则上面那条 ✅ 是空转
  const diagRects = app.workspace.getLeavesOfType('canvas')[0].view.containerEl.__fcRects
  const toolbarRect = diagRects.find((entry) => entry.selector === '.fc-toolbar').rect
  toolbarRect.top = 0
  const { report: reportOverlap } = await runDiagnostics(app)
  check(
    '浮层真的压住标题栏时报出 ⚠️ 与重叠尺寸',
    reportOverlap.includes('- ⚠️ 1 组重叠') && reportOverlap.includes('`.fc-toolbar` × `.view-header` = 200×40 px'),
    reportOverlap.match(/- ⚠️[^\n]*/)?.[0] ?? '(缺重叠行)',
  )
  toolbarRect.top = 48

  // Phase 0 的三节必须真的退休（不再逐次重算历史量）
  check('报告不再有量子探测', !report.includes('存在量化') && !report.includes('未观察到量化'))
  check('报告不再有中心公式判定', !report.includes('中心公式判定'))
  check('报告不再有 25 点标定', !report.includes('多点标定'))
  check('报告不再有挂载点候选表', !report.includes('挂载点探测') && !report.includes('| ★ |'))
  check('报告保留 Phase 0 历史结论的引用', report.includes('## 9. 历史结论') && report.includes('PHASE-0-RESULTS.md'))

  // 诊断命令现在**只**打开报告面板：不再自动复制剪贴板、也不再自动写库内文件。
  check('诊断命令不再自动写库内文件（写文件是面板上的按钮）', app.vault.files.has('FC-diagnostics.md') === false)
  check('诊断命令不再自动写剪贴板', clipboardWrites.length === 0, clipboardWrites.join(' | ').slice(0, 80))
}
console.log('\n场景 1b：闭式被人为偏移时投影裁决应改用采样（鉴别力对照）')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ closedFormOffset: { x: 4, y: -3 } })))
  check('判定来源改成采样', report.includes('判定来源：posFromEvt'), report.match(/- 判定来源[^\n]*/)?.[0] ?? '')
  check('明确写出发生了切换', report.includes('是否发生切换：是（闭式与采样不一致，已改用采样）'))
  check('报出闭式与采样的差（约 5.15 px）', /originDeltaPx=5\.1\d*/.test(report), report.match(/- 闭式 vs 采样[^\n]*/)?.[0] ?? '')
  check('留下「已改用采样」的备注', report.includes('已改用 posFromEvt'))
}
console.log('\n场景 2：运行时诊断的当下状态（a）—— 地图 / 版本 / definitions / 解析来源 / 条数')
{
  const app = makeApp(makeCanvas())
  const PluginClass = loadBundleAsCjs()
  const plugin = new PluginClass(app, { id: 'project-kaki' })
  plugin._data = JSON.stringify({
    layers: { terrain: true },
    mapViews: {
      'Maps/World.map.md': { layers: { terrain: false }, overlays: { temperature: { opacity: 0.2 } } },
    },
  })
  await plugin.onload()
  await plugin.setDeveloperMode(true)
  const store = plugin.getStore()
  const world = await store.createMap({
    name: 'World',
    folder: 'Maps',
    canvasPath: 'Maps/World.canvas',
    definitions: plugin.libraryDefinitionsBlock(),
  })
  const loaded = await store.load(world)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  loaded.document.markers.push({ id: 'm1', label: '营地', p: [0, 0], icon: 'pin' })
  loaded.document.labels.push({ id: 'l1', text: '名字', p: [0, 0] })
  await store.writeNow(world, loaded.document, loaded.frontmatter.name ?? 'World', loaded.frontmatter.canvases, loaded.frontmatter.rest)
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 90))

  const before = capturedReports.length
  runCommand(plugin, 'diagnose-canvas')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const report = capturedReports[before] ?? ''

  check('报告给出地图文档路径', report.includes('地图文档：Maps/World.map.md'), report.match(/- 地图文档：[^\n]*/)?.[0] ?? '')
  check('报告给出文件版本 v2 与 definitions 在文件里', report.includes('文件版本：v2') && report.includes('definitions：在文件里（以文件为准）'), report.match(/- 文件版本[^\n]*/)?.[0] ?? '')
  check('图层解析来源点名 mapViews[该图]', report.includes('图层可见性：`mapViews[Maps/World.map.md]`（这张图自己那一份）'), report.match(/- 图层可见性[^\n]*/)?.[0] ?? '')
  check('覆盖层解析来源同样点名这张图', report.includes('覆盖层参数：`mapViews[Maps/World.map.md]`'))
  check('内容规模列出地形 / 标记 / 文字', report.includes('内容规模：地形 1 格 · 标记 1 · 文字 1'), report.match(/- 内容规模[^\n]*/)?.[0] ?? '')
  check('展平图元与裁剪比（地形层被关 ⇒ 0 格）', report.includes('展平图元：地形 0 格（裁剪 0）'), report.match(/- 展平图元[^\n]*/)?.[0] ?? '')
  check('placement 数（marker / label）', report.includes('placement：marker 1/1（保留 100.0%）· label 1/1（保留 100.0%）'), report.match(/- placement[^\n]*/)?.[0] ?? '')

  plugin.onunload()
}
console.log('\n场景 3：矩阵缩放与 tZoom 字段不一致时应报警，且结构证据仍能找到挂载点')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ scale: REAL.scale, matrixScale: 0.65 })))
  check('报出矩阵缩放与 tZoom 推算不一致', report.includes('与 tZoom 推算') && report.includes('不一致'), report.match(/矩阵缩放[^\n]*/)?.[0] ?? '')
  check('仍靠结构证据选中 div.canvas', report.includes('世界层挂载点 = `div.canvas`'))
  check('投影仍以矩阵缩放为准', report.includes('（来源：变换矩阵 a 分量）'), report.match(/- 缩放：[^\n]*/)?.[0] ?? '')
}

console.log('\n场景 4：采样不量化时闭式与采样完全吻合（投影裁决的对照组）')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ quantize: false })))
  check('判定来源为闭式', report.includes('判定来源：closed-form'), report.match(/- 判定来源[^\n]*/)?.[0] ?? '')
  check('闭式与采样的差为 0', report.includes('闭式 vs 采样：originDeltaPx=0.0000 · scaleDelta=0.000000'), report.match(/- 闭式 vs 采样[^\n]*/)?.[0] ?? '')
  check('没有发生切换', report.includes('是否发生切换：否'))
  check('posFromClient 往返偏差为 0', report.includes('posFromClient 往返偏差：0.0000 px'))
}
console.log('\n场景 4：投影监视（每次有效变化打印 scale / origin / source / 是否切换）')
{
  const canvas = makeCanvas()
  const originalMethod = canvas.markViewportChanged
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)

  const toggle = plugin.commands.find((c) => c.id === 'toggle-viewport-watch')
  if (!toggle) throw new Error('未注册 toggle-viewport-watch 命令')
  // 探针命令仅开发者模式可见（默认关闭），这里显式打开
  await plugin.setDeveloperMode(true)

  check('补丁前 markViewportChanged 未被替换', canvas.markViewportChanged === originalMethod)
  runCommand(plugin, 'toggle-viewport-watch')
  check('补丁已装上', canvas.markViewportChanged !== originalMethod)

  // 三次重复触发（模拟动画帧内视口未变）+ 一次真实变化
  canvas.markViewportChanged()
  canvas.markViewportChanged()
  canvas.markViewportChanged()
  canvas._applyViewport()
  canvas.markViewportChanged()

  runCommand(plugin, 'toggle-viewport-watch')
  const stopNotice = noticeLog.at(-1) ?? ''
  check('有效投影变化统计为 2（首次 + 真实变化）', stopNotice.includes('有效投影变化 2 次'), stopNotice)
  check('来源切换统计为 0', stopNotice.includes('来源切换 0 次'), stopNotice)
  check(
    '停止提示带上最近一次的 scale / origin / source / 是否切换',
    stopNotice.includes('scale=') && stopNotice.includes('origin=') && stopNotice.includes('source=closed-form') && stopNotice.includes('切换=否'),
    stopNotice,
  )
  check('卸载后原方法已还原', canvas.markViewportChanged === originalMethod)

  plugin.onunload()
}
console.log('\n场景 5：没有打开 Canvas 时的降级提示')
{
  const app = makeApp(makeCanvas())
  app.workspace.getLeavesOfType = () => []
  app.workspace.getMostRecentLeaf = () => null
  app.workspace.activeLeaf = null
  const before = noticeLog.length
  await runDiagnostics(app)
  const messages = noticeLog.slice(before).join(' | ')
  check('给出「请先打开 .canvas」的提示', messages.includes('打开一个 .canvas'), messages)
}

console.log('\n场景 6：地图文档的创建、绑定与索引')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  check('插件暴露了地图存储层', store !== null && store !== undefined)

  const file = await store.createMap({ name: '艾尔登大陆', folder: 'Maps', canvasPath: 'Maps/World.canvas' })
  const content = app.vault.files.get(file.path) ?? ''
  check('创建了 .map.md 文件', file.path === 'Maps/艾尔登大陆.map.md', file.path)
  check('文件被标记为地图文档', isMapFileContent(content))
  check(
    'frontmatter 里记录了绑定关系',
    parseFrontmatter(extractFrontmatterBlock(content)).canvases.includes('Maps/World.canvas'),
  )
  check('绑定的 canvas 能反查到地图', store.mapFilePathForCanvas('Maps/World.canvas') === file.path, String(store.mapFilePathForCanvas('Maps/World.canvas')))
  check('未绑定的 canvas 查不到地图', store.mapFilePathForCanvas('Maps/Other.canvas') === null)

  const loaded = await store.load(file)
  check('加载回来没有任何问题', loaded.document !== null && loaded.issues.length === 0, JSON.stringify(loaded.issues))
  check('空地图统计为零', summarizeMapDocument(loaded.document).cells === 0)
  check('库内地图清点正确', store.listMapFiles().length === 1)

  // ---- 定义随图（v2，方案 B）：新建的地图把"当时的定义集"写进自己的文件 ----
  // 用户 m01845 的裁定是"分享一张图 ⇒ 对方拿到完整定义，不再出现未定义类型"。
  // 这一节只钉**新建**这一条路；"老图一个字节都不动"由单测钉（`tests/mapDefinitions.test.ts`）。
  const block = plugin.libraryDefinitionsBlock()
  check(
    '插件层把库级那一份定义装成 definitions 块（路径 / 区域类型的内置项跟着走 —— 它们的参数可改）',
    (block.pathTypes ?? []).length === 4 && (block.regionTypes ?? []).length === 6,
    JSON.stringify({ pathTypes: (block.pathTypes ?? []).length, regionTypes: (block.regionTypes ?? []).length }),
  )
  const withDefs = await store.createMap({ name: '带定义', folder: 'Maps', definitions: block })
  const withDefsText = app.vault.files.get(withDefs.path) ?? ''
  check(
    '给了定义的新图：文件里真的写着 definitions 段，且版本升到 2',
    withDefsText.includes('"definitions"') && withDefsText.includes('"version": 2'),
    withDefsText.slice(0, 300),
  )
  check(
    '定义段里带着那 4 条内置路径类型（"这张图用的是哪套线宽"在文件里是完整的）',
    withDefsText.includes('"pathTypes"') && withDefsText.includes('"river"'),
    withDefsText.slice(0, 500),
  )
  const plain = await store.createMap({ name: '无定义', folder: 'Maps' })
  const plainText = app.vault.files.get(plain.path) ?? ''
  check(
    '没给定义的新图：**不写** definitions 段（空表不留键，别让每张图都背一串空数组）',
    !plainText.includes('"definitions"'),
    plainText.slice(0, 240),
  )
}

console.log('\n场景 7：保存往返、防抖与安全闸')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath: 'Maps/World.canvas' })

  const loaded = await store.load(file)
  const doc = loaded.document
  doc.terrain['0_0'] = { t: 'forest' }
  doc.terrain['1_-1'] = { t: 'mountain' }
  doc.markers.push({ id: 'm1', label: '龙脊山脉', p: [10, 20], icon: 'mountain-peak' })

  store.scheduleSave(file, doc, 'World', loaded.frontmatter.canvases)
  check('防抖期间文件尚未变化', !(app.vault.files.get(file.path) ?? '').includes('forest'))
  check('存在待写内容', store.hasPendingWrites() === true)

  await store.flush()
  const saved = app.vault.files.get(file.path) ?? ''
  check('flush 后已落盘', saved.includes('forest') && saved.includes('mountain-peak'))
  check('落盘后无待写内容', store.hasPendingWrites() === false)

  const reloaded = await store.load(file)
  check('落盘后可完整解析', reloaded.document !== null && reloaded.issues.length === 0, JSON.stringify(reloaded.issues))
  check(
    '地形与标记往返一致',
    Object.keys(reloaded.document.terrain).length === 2 && reloaded.document.markers[0].label === '龙脊山脉',
  )

  // 安全闸：缺少类型标记的文件必须拒绝写入（防止把用户笔记覆盖成地图）
  app.vault.files.set('Notes/普通笔记.md', '# 我的笔记\n\n重要内容\n')
  const noteFile = app.vault.getAbstractFileByPath('Notes/普通笔记.md')
  let rejected = false
  let rejectMessage = ''
  try {
    await store.writeNow(noteFile, doc, 'x', [])
  } catch (error) {
    rejected = true
    rejectMessage = error instanceof Error ? error.message : String(error)
  }
  check('拒绝覆盖非地图文档', rejected, rejectMessage)
  check('普通笔记内容未被改动', (app.vault.files.get('Notes/普通笔记.md') ?? '').includes('重要内容'))
}

console.log('\n场景 8：自写保护（按 mtime 区分自写与外部改动）')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath: 'Maps/World.canvas' })
  const loaded = await store.load(file)

  await settleEvents() // 让 create 事件先派发完
  store.mapFilePathForCanvas('Maps/World.canvas') // 建立索引缓存

  await store.writeNow(file, loaded.document, 'World', ['Maps/World.canvas'])
  store.mapFilePathForCanvas('Maps/World.canvas') // 我们的写入必须使缓存失效 → 重建一次
  const afterOwnWrite = store.indexBuildCount
  await settleEvents()
  store.mapFilePathForCanvas('Maps/World.canvas')
  check('自写事件没有造成额外重建', store.indexBuildCount === afterOwnWrite, `${afterOwnWrite} → ${store.indexBuildCount}`)

  // 对照组：外部改动（不经过存储层）必须触发索引失效
  await app.vault.process(file, (content) => content)
  await settleEvents()
  store.mapFilePathForCanvas('Maps/World.canvas')
  check(
    '外部改动触发了额外的索引重建',
    store.indexBuildCount > afterOwnWrite,
    `${afterOwnWrite} → ${store.indexBuildCount}`,
  )
}

console.log('\n场景 9：地图状态命令（端到端走一遍命令路径）')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath: 'Maps/World.canvas' })

  // 先灌入一些内容，让状态命令有东西可报
  const loaded = await store.load(file)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  loaded.document.terrain['1_0'] = { t: 'forest' }
  loaded.document.terrain['2_0'] = { t: 'water' }
  await store.writeNow(file, loaded.document, 'World', ['Maps/World.canvas'])

  const status = plugin.commands.find((c) => c.id === 'map-status')
  if (!status) throw new Error('未注册 map-status 命令')
  const capture = captureReports(plugin)
  const before = noticeLog.length
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const message = capture.text()
  check('状态报告打开了报告面板（而不是弹一条长提示）', capture.reports.length === 1, String(capture.reports.length))
  check('状态命令报出地图路径', message.includes('Maps/World.map.md'), message.slice(0, 120))
  check('状态命令报出地形格数', message.includes('地形 3 格'), message.slice(0, 160))
  check('状态命令报出地形分类', message.includes('forest×2') && message.includes('water×1'), message.slice(0, 160))
  check('状态命令报出文件体积', /文件 [\d.]+ KiB/.test(message))
  check('状态命令报出绑定状态而非「未绑定」', !message.includes('尚未绑定地图文档'), message.slice(0, 120))
  check(
    '报告不再经过 Notice（长文本与短提示是两条通道）',
    noticeLog.slice(before).every((line) => !line.includes('地形 3 格')),
    noticeLog.slice(before).join(' | '),
  )
  check(
    '导出文件名基于地图基础名',
    capture.last()?.fileName === 'Maps/World-状态报告.md',
    String(capture.last()?.fileName),
  )
  check(
    '报告面板拿到了导出回调（按钮才有事可做）',
    typeof capture.last()?.onExport === 'function',
    String(typeof capture.last()?.onExport),
  )
  capture.restore()

  // 未绑定时应给出明确提示（这一条仍然是短提示：它是一句话，不是报告）
  const other = makeApp(makeCanvas())
  const otherPlugin = await loadPlugin(other)
  const otherStatus = otherPlugin.commands.find((c) => c.id === 'map-status')
  const before2 = noticeLog.length
  runCommand(otherPlugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const message2 = noticeLog.slice(before2).join(' | ')
  check('未绑定时提示「尚未绑定」', message2.includes('尚未绑定地图文档'), message2.slice(0, 120))
}

console.log('\n场景 10：地图层挂载、地形渲染与逐帧合并')
{
  const canvas = makeCanvas()
  const originalMethod = canvas.markViewportChanged
  const host = canvas.canvasEl
  const initialChildCount = host.children.length

  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath: 'Maps/World.canvas' })

  // 视口内 3 格 + 视口外 2 格（用于验证裁剪）
  const loaded = await store.load(file)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  loaded.document.terrain['1_0'] = { t: 'mountain' }
  loaded.document.terrain['-1_1'] = { t: 'water' }
  loaded.document.terrain['80_80'] = { t: 'desert' }
  loaded.document.terrain['-90_40'] = { t: 'plains' }
  await store.writeNow(file, loaded.document, 'World', ['Maps/World.canvas'])
  // 先消化"文件写入触发 modify 事件"这一拍：否则它请求的补帧会混进后面的单帧测量
  await settleEvents()

  const toggle = plugin.commands.find((c) => c.id === 'toggle-map-layer')
  if (!toggle) throw new Error('未注册 toggle-map-layer 命令')

  const before = noticeLog.length
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const message = noticeLog.slice(before).join(' | ')
  check('启用命令报告成功', message.includes(NOTICES.layerEnabled), message.slice(0, 100))
  check('报告挂载点为 div.canvas', message.includes('挂载点：canvas'), message.slice(0, 200))
  check('报告绘制与裁剪格数', message.includes('地形 3 格') && message.includes('裁剪 2 格'), message.slice(0, 240))

  const container = host.children[0]
  check('覆盖层插在宿主最前（地形位于原生节点之下）', container?.className === 'fc-overlay', String(container?.className))
  check('覆盖层位置绝对且不拦截指针', container?.style.position === 'absolute' && container?.style.pointerEvents === 'none')

  const layerCanvas = container?.children?.[0]
  check('覆盖层内含一张画布', layerCanvas?.tagName === 'CANVAS', String(layerCanvas?.tagName))
  check(
    '位图尺寸 = 视口 × devicePixelRatio',
    layerCanvas.width === Math.round(REAL.wrapperRect.width * REAL.devicePixelRatio) &&
      layerCanvas.height === Math.round(REAL.wrapperRect.height * REAL.devicePixelRatio),
    `${layerCanvas?.width}×${layerCanvas?.height}`,
  )

  const leftBefore = Number.parseFloat(container.style.left)
  const topBefore = Number.parseFloat(container.style.top)
  const widthWorld = Number.parseFloat(container.style.width)
  check('覆盖层左/上为可见世界左上角（负值）', leftBefore < 0 && topBefore < 0, `left=${leftBefore} top=${topBefore}`)
  check(
    '覆盖层 CSS 尺寸 = 视口世界尺寸（视口 ÷ 缩放）',
    Math.abs(widthWorld - REAL.wrapperRect.width / REAL.scale) < 1,
    `${widthWorld} vs ${REAL.wrapperRect.width / REAL.scale}`,
  )

  // 挂载时已同步画过一帧，因此现在还没有待执行的帧
  check('挂载后没有积压的帧（首帧是同步画的）', frameQueue.length === 0, String(frameQueue.length))

  // 精确测量"单帧"的绘制量：清空计数后只触发一次视口变化
  const ctx = layerCanvas._ctx
  ctx.resetCalls()
  canvas.markViewportChanged()
  canvas.markViewportChanged()
  const flushed = flushFrames()
  check('同帧内只执行一帧重绘', flushed === 1, String(flushed))
  check('地形绘制调用数 = 视口内格数', ctx.calls.drawImage === 3, String(ctx.calls.drawImage))
  check('每帧只清屏一次', ctx.calls.clearRect === 1, String(ctx.calls.clearRect))
  // 性能性质：网格线整帧只描边一次（可见格上千时逐格描边会拖垮帧率）
  check('网格线整帧只描边一次', ctx.calls.stroke <= 2, `stroke=${ctx.calls.stroke}`)
  const gridCells = plugin.getLayerManager().listStatus()[0].stats.lastGridCells
  check('网格确实画了（可见格数被计入统计）', gridCells > 100, String(gridCells))

  // 平移：覆盖层位置必须跟着走
  canvas._applyViewport({ de: 40, df: 25, scaleFactor: 1 })
  canvas.markViewportChanged()
  check('平移只排一帧', flushFrames() === 1)
  const leftAfter = Number.parseFloat(container.style.left)
  check('覆盖层位置随平移更新', leftAfter < leftBefore, `${leftBefore} → ${leftAfter}`)

  // 连续三次事件（模拟逐帧回调）应仍只排一帧
  canvas.markViewportChanged()
  canvas.markViewportChanged()
  canvas.markViewportChanged()
  check('同帧内三次事件合并为一帧', flushFrames() === 1)

  // 缩放后位图尺寸不变（它取决于视口与 dpr，不取决于缩放）
  const scaleBefore = layerCanvas.width
  canvas._applyViewport({ de: 0, df: 0, scaleFactor: 1.5 })
  canvas.markViewportChanged()
  flushFrames()
  check('缩放后位图尺寸不变（始终 1:1 像素密度）', layerCanvas.width === scaleBefore, `${scaleBefore} → ${layerCanvas.width}`)
  check('缩放后覆盖层宽度变小（世界可见范围变大）', Number.parseFloat(container.style.width) < widthWorld)

  // 停用：元素移除 + 补丁还原
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 40))
  check('停用后覆盖层已从宿主移除', host.children.length === initialChildCount, `children=${host.children.length}`)
  check('停用后 markViewportChanged 已还原', canvas.markViewportChanged === originalMethod)
  check('再次触发视口事件不再排帧', (canvas.markViewportChanged(), flushFrames() === 0))

  plugin.onunload()
}

console.log('\n场景 11：未绑定地图时启用地图层应给出明确原因')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const toggle = plugin.commands.find((c) => c.id === 'toggle-map-layer')
  const before = noticeLog.length
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const message = noticeLog.slice(before).join(' | ')
  check('提示尚未绑定地图文档', message.includes('尚未绑定地图文档'), message.slice(0, 160))
}

console.log('\n场景 12：地形笔刷（按下—拖动—抬手、撤销/重做、模式与快捷键）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'

  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const toggleLayer = plugin.commands.find((c) => c.id === 'toggle-map-layer')
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const overlayContainer = canvas.canvasEl.children[0]
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const toolbarEl = wrapper.children.find((child) => child.className === 'fc-toolbar')
  check('工具条已挂到未变换的 wrapperEl 上', toolbarEl !== undefined && toolbarEl.className === 'fc-toolbar')
  // §F.2：工具 / 笔刷 / 选择方式都搬进了侧栏，于是"地形按钮在哪"这类断言要改去面板里看 ——
  // 顺带把"浮窗上确实不再有它们"钉住（这才是 ISSUE-004 的彻底版）。
  const panel = await openMapPanel(app, plugin)
  check('侧栏「笔刷」列出了 9 种地形', inPanel(panel, 'fc-panel-terrain').length === 9, String(inPanel(panel, 'fc-panel-terrain').length))
  check(
    '浮窗只剩状态与三个按钮（模式 + 撤销/重做）',
    collectByClass(toolbarEl, 'fc-ctl-button').length === 3,
    collectByClass(toolbarEl, 'fc-ctl-button').map((button) => button.textContent).join('|'),
  )

  // 根因回归：覆盖层位于命中测试最底层，因此它必须**始终** pointer-events: none，
  // 绘制手势改在视图容器上以捕获阶段监听（下一条断言验证监听确实在容器上）。
  check('覆盖层始终保持 pointer-events: none（不做命中测试）', overlayContainer.style.pointerEvents !== 'auto', String(overlayContainer.style.pointerEvents))
  check('指针监听挂在视图容器上（捕获阶段）', host._listeners.get('pointerdown')?.size === 1, String(host._listeners.get('pointerdown')?.size))

  // 选择模式下**左键归插件**（施工文件 §C.1 那张表：左键拖动 = 框选 / 笔迹选择）。
  // 这条以前断言的是"左键原样放行"——那是旧口径（那时选择模式只有"点一下选中对象"）。
  // 现在 §C.1 明确要求插件消费左键，硬纪律改成了"永不接管右键 / 中键 / 滚轮 / 空格拖动"。
  const idlePoint = canvas._clientFor({ x: 0, y: 0 })
  const idleDown = firePointer(host, 'pointerdown', { clientX: idlePoint.x, clientY: idlePoint.y, target: wrapper })
  check('选择模式下左键被消费（拖动 = 框选）', idleDown.stopped === true && idleDown.prevented === true)
  // 中键必须原样放行（原生平移）
  const idleMiddle = firePointer(host, 'pointerdown', {
    clientX: idlePoint.x,
    clientY: idlePoint.y,
    button: 1,
    target: wrapper,
  })
  check('选择模式下中键不被接管（原生平移）', idleMiddle.stopped === false && idleMiddle.prevented === false)
  // 右键没命中形状时必须照常弹出菜单
  const idleRight = firePointer(host, 'pointerdown', {
    clientX: idlePoint.x,
    clientY: idlePoint.y,
    button: 2,
    target: wrapper,
  })
  check('选择模式下右键不被接管（原生菜单）', idleRight.stopped === false && idleRight.prevented === false)
  // 把这次单击收尾，别让手势状态带到下一段
  firePointer(host, 'pointerup', { clientX: idlePoint.x, clientY: idlePoint.y, target: wrapper })

  // 进入绘制模式（用命令路径）
  const toggleMode = plugin.commands.find((c) => c.id === 'toggle-edit-mode')
  runCommand(plugin, 'toggle-edit-mode')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const editor = layers.getEditor(canvasPath)
  check('编辑器已创建并进入绘制模式', editor !== null && editor.mode === 'paint', String(editor?.mode))
  const toolbarTitle = () => collectByClass(toolbarEl, 'fc-toolbar-title')[0]
  const modeButtonEl = () => collectByClass(toolbarEl, 'fc-toolbar-mode')[0]
  check('工具条显示为绘制中', (modeButtonEl()?.textContent ?? '').includes('绘制'), String(modeButtonEl()?.textContent))
  // ISSUE-004：这个浮框必须有**标题行**（它是这个框的名字），且标题说明"这个框现在归谁"。
  // 用户的原话是"筛选和绘制在同一个框里，反直觉"—— 显隐早已按模式做对，缺的就是这一行。
  check(
    '工具条有标题行，写着"绘制 · <工具>"',
    new RegExp(`^${TOOLBAR_TEXT.paintPrefix}.+`).test(toolbarTitle()?.textContent ?? ''),
    String(toolbarTitle()?.textContent),
  )
  check('标题行是工具条的**第一个**元素（身份要最先被看到）', toolbarEl.children[0] === toolbarTitle(), String(toolbarEl.children[0]?.className))
  check(
    '浮窗上不再有工具切换与参数组（§F.2 的搬家：一个框只留一个角色）',
    collectByClass(toolbarEl, 'fc-panel-tool').length === 0 &&
      collectByClass(toolbarEl, 'fc-panel-terrain').length === 0 &&
      collectByClass(toolbarEl, 'fc-panel-brush-field').length === 0,
    collectByClass(toolbarEl, 'fc-ctl-button').map((button) => button.textContent).join('|'),
  )
  flushFrames()
  check(
    '绘制模式下侧栏「选择方式」整组置灰（不隐藏：常驻面板里藏起来会像"功能没了"）',
    inPanel(panel, 'fc-panel-selection-mode-button').length === 2 &&
      inPanel(panel, 'fc-panel-selection-mode-button').every((button) => button.disabled === true) &&
      inPanel(panel, 'fc-panel-selection-filter').every((button) => button.disabled === true),
    inPanel(panel, 'fc-panel-selection-mode-button').map((button) => `${button.textContent}:${button.disabled}`).join('|'),
  )
  check('进入绘制模式后覆盖层仍不参与命中测试', overlayContainer.style.pointerEvents !== 'auto')

  // 工具条的点击必须放行：它和 canvas 在同一个视图容器里，
  // 若不过滤，捕获阶段的 stopImmediatePropagation 会把按钮点击整个吃掉。
  // 注意先做这些检查：下面的"拦截"断言本身会真的开始一笔笔画。
  const start = canvas._clientFor({ x: 0, y: 0 })
  // 浮窗上的点击必须放行（它与 canvas 在同一个视图容器里，不过滤的话捕获阶段的
  // stopImmediatePropagation 会把按钮点击整个吃掉）—— 现在浮窗上还剩模式与撤销/重做
  const toolbarDown = firePointer(host, 'pointerdown', {
    clientX: start.x,
    clientY: start.y,
    target: collectByClass(toolbarEl, 'fc-toolbar-mode')[0],
  })
  check('浮窗上的指针事件不被拦截', toolbarDown.stopped === false && toolbarDown.prevented === false)

  flushFrames()
  const terrainButton = inPanel(panel, 'fc-panel-terrain')[2]
  const terrainBefore = editor.terrainType
  fireEvent(terrainButton, 'click')
  check('点击侧栏「笔刷」里的地形能切换地形', editor.terrainType !== terrainBefore, `${terrainBefore} → ${editor.terrainType}`)
  check('点击侧栏不会在画布上落笔', Object.keys(layers.getDocument(canvasPath).terrain).length === 0)

  const controlsEl = wrapper.children.find((child) => child.className === 'canvas-controls')
  const controlsDown = firePointer(host, 'pointerdown', { clientX: start.x, clientY: start.y, target: controlsEl })
  check('Obsidian 画布控件（缩放按钮等）不被拦截', controlsDown.stopped === false)

  // 恢复成森林，并开始真正的笔画：这一次 pointerdown 同时用来验证拦截
  editor.setTerrainType('forest')
  const armed = firePointer(host, 'pointerdown', { clientX: start.x, clientY: start.y, target: wrapper })
  check('绘制模式下左键被拦截（原生框选不会启动）', armed.stopped === true && armed.prevented === true)

  // 拖动：事件仍派发到同一个宿主，验证 capture + 指针捕获后仍能持续收到
  const end = canvas._clientFor({ x: 0, y: 240 })
  firePointer(host, 'pointermove', { clientX: end.x, clientY: end.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: end.x, clientY: end.y, target: wrapper })

  const document_ = layers.getDocument(canvasPath)
  const paintedKeys = Object.keys(document_.terrain)
  check('笔刷画上了地形', paintedKeys.length > 5, `格数=${paintedKeys.length}`)
  check('落点格正确（世界原点 → 格 0_0）', paintedKeys.includes('0_0'), paintedKeys.slice(0, 5).join(','))

  // ---- FEATURE-AUDIT §1.1 B1：同一片地形**再刷一遍** ⇒ 提示行必须说"这一笔没有改变任何格" ----
  // "值相同就不动"是刻意的（不该为空操作堆历史），但**静默**是缺陷：与 ISSUE-008（刷了隐藏层）
  // 长得一模一样 —— 用户只会看到"我刷了、屏幕没变"。
  const hintEl = () => collectByClass(toolbarEl, 'fc-toolbar-hint')[0]
  const undoBeforeRepeat = editor.getStatus().undo
  firePointer(host, 'pointerdown', { clientX: start.x, clientY: start.y, target: wrapper })
  firePointer(host, 'pointermove', { clientX: end.x, clientY: end.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: end.x, clientY: end.y, target: wrapper })
  flushFrames()
  check(
    '重刷同一片地形：地图一个字节没变、也没多出一条历史',
    Object.keys(layers.getDocument(canvasPath).terrain).length === paintedKeys.length &&
      editor.getStatus().undo === undoBeforeRepeat,
    `${Object.keys(layers.getDocument(canvasPath).terrain).length} 格 / undo=${editor.getStatus().undo}`,
  )
  check(
    '但提示行说清了"这一笔没有改变任何格"（不许静默）',
    hintEl()?.textContent === `${BRUSH_NOTES.noChange} · Esc 退出`,
    String(hintEl()?.textContent),
  )

  // 注意：世界坐标竖直向下在六边形网格里是"斜穿"的（q/r 交替步进），
  // 因此不能硬编码期望格号，而应断言真正关心的性质：**笔画连通无洞**，且覆盖到终点附近。
  const parsed = paintedKeys.map((key) => {
    const at = key.indexOf('_')
    return { key, q: Number(key.slice(0, at)), r: Number(key.slice(at + 1)) }
  })
  const adjacency = (a, b) => {
    const dq = a.q - b.q
    const dr = a.r - b.r
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1
  }
  const seen = new Set([parsed[0].key])
  const queue = [parsed[0]]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const other of parsed) {
      if (seen.has(other.key)) continue
      if (!adjacency(current, other)) continue
      seen.add(other.key)
      queue.push(other)
    }
  }
  check('笔画是一条连通路径（无断线/空洞）', seen.size === parsed.length, `连通 ${seen.size}/${parsed.length}`)

  const endCell = canvas._cellContaining({ x: 0, y: 240 })
  check(
    `拖动终点落在笔迹内（格 ${endCell}）`,
    paintedKeys.includes(endCell),
    `终点格=${endCell}，实际=${paintedKeys.join(' ')}`,
  )
  check('绘制的是当前选中地形', document_.terrain['0_0'].t === 'forest', JSON.stringify(document_.terrain['0_0']))

  // 一次笔画 = 一条历史
  check('一次笔画只产生一条历史', editor.getStatus().undo === 1, `undo=${editor.getStatus().undo}`)

  // 落盘
  await store.flush()
  const saved = app.vault.files.get(file.path) ?? ''
  check('笔画结束后已请求保存并落盘', saved.includes('"t":"forest"'), saved.slice(0, 80))

  // 撤销 / 重做
  const undoCommand = plugin.commands.find((c) => c.id === 'undo-map-edit')
  runCommand(plugin, 'undo-map-edit')
  check('撤销后地形回到空白', Object.keys(layers.getDocument(canvasPath).terrain).length === 0, `${Object.keys(layers.getDocument(canvasPath).terrain).length} 格`)
  const redoCommand = plugin.commands.find((c) => c.id === 'redo-map-edit')
  runCommand(plugin, 'redo-map-edit')
  check('重做后地形恢复', Object.keys(layers.getDocument(canvasPath).terrain).length === paintedKeys.length)

  // 快捷键：通过作用域的注册项触发
  const scope = app.keymap.activeScope
  check('已推入按键作用域', scope !== null)
  const press = (key, modifiers = []) => {
    const registration = scope.registrations.find(
      (item) => item.key === key && item.modifiers.length === modifiers.length && item.modifiers.every((m) => modifiers.includes(m)),
    )
    if (!registration) return null
    return registration.handler({ key })
  }
  check('注册了 D / Esc / 1-9 / [ ] / Mod+Z', scope.registrations.length >= 14, String(scope.registrations.length))

  press('3')
  check('数字键切换地形', editor.terrainType === 'water', String(editor.terrainType))
  press(']')
  check('] 增大笔刷', editor.getBrushRadius() === 1, String(editor.getBrushRadius()))
  press('[')
  check('[ 减小笔刷', editor.getBrushRadius() === 0, String(editor.getBrushRadius()))
  press('Escape')
  check('Esc 回到选择模式', editor.mode === 'select', String(editor.mode))
  press('d')
  check('D 再次进入绘制模式', editor.mode === 'paint', String(editor.mode))

  // ---- FEATURE-AUDIT §3.3：**五个工具键**与"撤销只在绘制模式下接管"以前没有任何断言 ----
  // （数字键 / `[` `]` / Esc / D 上面已经钉住了；这里补的是剩下那两类，
  //   而它们正是"按了没反应"最容易发生的地方。）
  press('m')
  check('「m」切到标记工具', editor.tool === 'marker', String(editor.tool))
  press('t')
  check('「t」切到文字标注', editor.tool === 'label', String(editor.tool))
  press('p')
  check('「p」切到路径工具', editor.tool === 'path', String(editor.tool))
  press('r')
  check('「r」切到区域工具', editor.tool === 'region', String(editor.tool))
  press('b')
  check('「b」切回地形笔刷', editor.tool === 'brush', String(editor.tool))

  const cellsBeforeUndoKey = Object.keys(layers.getDocument(canvasPath).terrain).length
  check('绘制模式下 Ctrl+Z 被我们接管（返回 false = 已消费）', press('z', ['Mod']) === false)
  check(
    '它真的撤销了一笔（不是只吞了按键）',
    Object.keys(layers.getDocument(canvasPath).terrain).length < cellsBeforeUndoKey,
    `${cellsBeforeUndoKey} → ${Object.keys(layers.getDocument(canvasPath).terrain).length}`,
  )
  check('Ctrl+Shift+Z 被我们接管（重做）', press('z', ['Mod', 'Shift']) === false)
  check(
    '重做把它还回来了',
    Object.keys(layers.getDocument(canvasPath).terrain).length === cellsBeforeUndoKey,
    String(Object.keys(layers.getDocument(canvasPath).terrain).length),
  )
  press('Escape')
  check(
    '选择模式下 Ctrl+Z **放行**给 Obsidian（返回 true = 未处理；否则会去撤销地图而不是撤销文字）',
    press('z', ['Mod']) === true,
    String(press('z', ['Mod'])),
  )
  press('d')
  check('回到绘制模式（下面的断言仍按绘制模式走）', editor.mode === 'paint', String(editor.mode))

  // 笔刷大小生效：半径 2 的一次落笔应覆盖 19 格
  editor.setBrushRadius(2)
  editor.setTerrainType('water')
  const before = Object.keys(layers.getDocument(canvasPath).terrain).length
  const far = canvas._clientFor({ x: 600, y: 400 })
  firePointer(host, 'pointerdown', { clientX: far.x, clientY: far.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: far.x, clientY: far.y, target: wrapper })
  const added = Object.keys(layers.getDocument(canvasPath).terrain).length - before
  check('半径 2 的笔刷一次落笔覆盖 19 格', added === 19, `实际 ${added} 格`)

  // 非左键不接管（让原生平移仍可用）
  const middle = firePointer(host, 'pointerdown', { clientX: far.x, clientY: far.y, button: 1, target: wrapper })
  check('中键不被接管（留给原生平移）', middle.stopped === false)

  // 地图视图之外的指针事件不应被拦截（否则会干扰其它面板）
  const outside = firePointer(host, 'pointerdown', {
    clientX: far.x,
    clientY: far.y,
    target: makeEl({ className: 'other-pane' }),
  })
  check('地图视图之外的事件不被拦截', outside.stopped === false, `stopped=${outside.stopped}`)

  // 选择模式下拖动不应产生任何地形（放行给原生框选）
  press('Escape')
  const idleBefore = Object.keys(layers.getDocument(canvasPath).terrain).length
  firePointer(host, 'pointerdown', { clientX: far.x, clientY: far.y, target: wrapper })
  firePointer(host, 'pointermove', { clientX: far.x + 30, clientY: far.y + 30, target: wrapper })
  firePointer(host, 'pointerup', { clientX: far.x + 30, clientY: far.y + 30, target: wrapper })
  check(
    '选择模式下拖动不落笔（原生框选行为保持不变）',
    Object.keys(layers.getDocument(canvasPath).terrain).length === idleBefore,
  )

  // 停用后工具条与监听都应清理
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const toolbarAfter = wrapper.children.find((child) => child.className === 'fc-toolbar')
  check('停用后工具条已移除', toolbarAfter === undefined)
  check('停用后按键作用域已弹出', app.keymap.scopes.length === 0, String(app.keymap.scopes.length))

  plugin.onunload()
}

console.log('\n场景 13：回归 —— 自写保存不得清空撤销历史')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const point = canvas._clientFor({ x: 0, y: 0 })

  editor.setMode('paint')
  firePointer(host, 'pointerdown', { clientX: point.x, clientY: point.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: point.x, clientY: point.y, target: wrapper })
  check('落笔后有一条历史', editor.getStatus().undo === 1, `undo=${editor.getStatus().undo}`)

  // 走真实路径：笔画结束 → 防抖保存 → 落盘 → modify 事件
  await store.flush()
  await settleEvents()
  check('自写保存后撤销历史仍在（曾因重载被清空）', editor.getStatus().undo === 1, `undo=${editor.getStatus().undo}`)
  check('自写保存没有把文档换掉', Object.keys(layers.getDocument(canvasPath).terrain).length === 1)
  check('撤销仍然可用', editor.undo() === true)
  check('撤销后地形被清掉', Object.keys(layers.getDocument(canvasPath).terrain).length === 0)

  // 对照：**外部改动**应当触发重载，但同样不该清空历史
  await store.flush() // 先让文件处于已知状态（撤销也要落盘），否则下面的替换匹配不上
  await settleEvents()
  const beforeExternal = app.vault.files.get(file.path) ?? ''
  check('文件里此刻是空地形（撤销已落盘）', /"terrain":\s*\{\s*\}/.test(beforeExternal), beforeExternal.match(/"terrain":[^\n]*/)?.[0] ?? '')

  await app.vault.process(file, (content) =>
    content.replace(/"terrain":[\s\S]*?(?=,\n\s*"paths")/, '"terrain": {\n    "9_9": {"t":"desert"}\n  }'),
  )
  await settleEvents()
  check('外部改动会被重载进来', Object.keys(layers.getDocument(canvasPath).terrain).includes('9_9'))
  check(
    '外部改动后历史仍保留（op 按格记录，对替换后的文档依然成立）',
    editor.getStatus().undo === 1 || editor.getStatus().redo === 1,
    `undo=${editor.getStatus().undo} redo=${editor.getStatus().redo}`,
  )

  plugin.onunload()
}

console.log('\n场景 14：标记与文字标注（放置、渲染、点击打开笔记、右键删除）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  // 注入放置对话框替身：直接以固定内容提交，跳过 DOM 表单
  let modalKind = null
  plugin.setPlaceModalFactory((_app, options) => {
    modalKind = options.kind
    return {
      open() {
        options.onSubmit(
          options.kind === 'marker'
            ? { label: '龙脊城', icon: 'city', link: 'Locations/龙脊城.md' }
            : { label: '北境王国', icon: 'town', link: '' },
        )
      },
    }
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const markerLayerEl = collectByClass(wrapper, 'fc-marker-layer')[0]

  check('标记层已挂到未变换的 wrapperEl 上', markerLayerEl !== undefined)
  check(
    '选择模式下实体可交互（靠 class，而不是把容器设成可命中）',
    markerLayerEl.classList.contains('is-interactive'),
    markerLayerEl.className,
  )
  // 回归：容器铺满整个视口，它自己绝不能可命中，否则会挡住原生画布的点选/拖拽
  check('标记层容器自身始终穿透', markerLayerEl.style.pointerEvents !== 'auto', String(markerLayerEl.style.pointerEvents))

  editor.setMode('paint')
  check(
    '绘制模式下实体不参与命中测试（让位给放置手势）',
    !markerLayerEl.classList.contains('is-interactive'),
    markerLayerEl.className,
  )

  // 切到标记工具并点击放置
  editor.setTool('marker')
  const point = canvas._clientFor({ x: 0, y: 0 })
  firePointer(host, 'pointerdown', { clientX: point.x, clientY: point.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: point.x, clientY: point.y, target: wrapper })
  flushFrames()

  const document_ = layers.getDocument(canvasPath)
  check('放置对话框以「标记」类型打开', modalKind === 'marker', String(modalKind))
  check('标记已写入文档', document_.markers.length === 1, String(document_.markers.length))
  const marker = document_.markers[0]
  check('标记内容正确', marker.label === '龙脊城' && marker.icon === 'city' && marker.link === 'Locations/龙脊城.md')
  check(
    '标记位置吸附到格心',
    Math.abs(marker.p[0] - 0) < 1e-6 && Math.abs(marker.p[1] - 0) < 1e-6,
    `p=[${marker.p.join(', ')}]`,
  )
  check('放置产生了一条可撤销的历史', editor.getStatus().undo === 1, String(editor.getStatus().undo))

  const markerEl = markerLayerEl.children.find((child) => child.className === 'fc-marker')
  check('标记元素已渲染', markerEl !== undefined)
  check('标记元素带上了链接数据', markerEl?.dataset?.fcLink === 'Locations/龙脊城.md', String(markerEl?.dataset?.fcLink))
  check(
    '标记元素用 translate3d 定位在屏幕坐标上',
    /translate3d\([\d.-]+px, [\d.-]+px, 0\)/.test(markerEl?.style?.transform ?? ''),
    String(markerEl?.style?.transform),
  )
  // W8 回归（用户报的「地标在放大缩小视图时移动不准」）：标记的屏幕位置必须等于
  // **Obsidian 自己的映射**（posFromEvt）换算出来的位置 —— 投影原点若与权威映射不一致，这条会红。
  {
    const expected = canvas._clientFor({ x: marker.p[0], y: marker.p[1] })
    const parsed = /translate3d\(([\d.-]+)px, ([\d.-]+)px, 0\)/.exec(markerEl?.style?.transform ?? '')
    const expectedX = expected.x - REAL.wrapperRect.left
    const expectedY = expected.y - REAL.wrapperRect.top
    const dx = Number(parsed?.[1]) - expectedX
    const dy = Number(parsed?.[2]) - expectedY
    check(
      '标记的屏幕位置 = Obsidian 自己映射出来的位置（投影与权威源不一致时这条会红）',
      parsed !== null && Math.hypot(dx, dy) <= 1.5,
      `Δ=(${dx.toFixed(2)}, ${dy.toFixed(2)}) 期望=(${expectedX.toFixed(2)}, ${expectedY.toFixed(2)})`,
    )
  }

  // 拖动不会放置标记（否则一拖就放一片）
  const dragStart = canvas._clientFor({ x: 200, y: 200 })
  firePointer(host, 'pointerdown', { clientX: dragStart.x, clientY: dragStart.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: dragStart.x + 40, clientY: dragStart.y + 30, target: wrapper })
  check('拖动不会放置标记', layers.getDocument(canvasPath).markers.length === 1)

  // 位置确实跟着点击走（排除"标记总落在同一处"的可能）
  const secondPoint = canvas._clientFor({ x: 400, y: -240 })
  firePointer(host, 'pointerdown', { clientX: secondPoint.x, clientY: secondPoint.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: secondPoint.x, clientY: secondPoint.y, target: wrapper })
  flushFrames()
  const twoMarkers = layers.getDocument(canvasPath).markers
  check('第二个标记落在另一处', twoMarkers.length === 2 && twoMarkers[1].p[0] !== twoMarkers[0].p[0], JSON.stringify(twoMarkers.map((m) => m.p)))
  // 撤销掉第二个，后面的断言仍针对第一个标记
  editor.undo()
  flushFrames()

  // 点击标记打开笔记（仅选择模式）
  editor.setMode('select')
  const before = openedLinks.length
  fireEvent(markerEl, 'click')
  check('点击标记打开了对应笔记', openedLinks.length === before + 1 && openedLinks.at(-1).link === 'Locations/龙脊城.md', JSON.stringify(openedLinks.at(-1)))
  check('打开链接时以地图文件为基准解析相对路径', openedLinks.at(-1).source === 'Maps/World.map.md', String(openedLinks.at(-1).source))

  // 右键删除
  fireEvent(markerEl, 'contextmenu')
  flushFrames()
  check('右键删除了标记', layers.getDocument(canvasPath).markers.length === 0)
  check('删除后 DOM 元素也被移除', markerLayerEl.children.filter((c) => c.className === 'fc-marker').length === 0)
  check('删除可撤销', editor.undo() === true && layers.getDocument(canvasPath).markers.length === 1)

  // 文字标注
  editor.setMode('paint')
  editor.setTool('label')
  firePointer(host, 'pointerdown', { clientX: point.x, clientY: point.y, target: wrapper })
  firePointer(host, 'pointerup', { clientX: point.x, clientY: point.y, target: wrapper })
  flushFrames()
  const labelDoc = layers.getDocument(canvasPath)
  check('文字标注已写入文档', labelDoc.labels.length === 1 && labelDoc.labels[0].text === '北境王国')
  const labelEl = markerLayerEl.children.find((child) => child.className === 'fc-label')
  check('文字标注元素已渲染', labelEl !== undefined)
  check('文字内容正确', labelEl?.textContent === '北境王国', String(labelEl?.textContent))
  check('字号已按缩放写入内联样式', /px/.test(labelEl?.style?.fontSize ?? ''), String(labelEl?.style?.fontSize))

  // 文字标注也必须能删（曾经只给标记注册了右键）
  editor.setMode('select')
  const labelsBefore = layers.getDocument(canvasPath).labels.length
  fireEvent(labelEl, 'contextmenu')
  flushFrames()
  check('右键能删除文字标注', layers.getDocument(canvasPath).labels.length === labelsBefore - 1, `剩余 ${layers.getDocument(canvasPath).labels.length}`)
  check('删除文字后可撤销', editor.undo() === true && layers.getDocument(canvasPath).labels.length === 1)

  // 拖动移动标记
  editor.setMode('select')
  const markerBefore = { ...layers.getDocument(canvasPath).markers[0] }
  const undoBeforeDrag = editor.getStatus().undo
  const markerElForDrag = collectByClass(markerLayerEl, 'fc-marker')[0]
  const from = canvas._clientFor({ x: markerBefore.p[0], y: markerBefore.p[1] })
  const to = canvas._clientFor({ x: markerBefore.p[0] + 240, y: markerBefore.p[1] + 160 })
  firePointer(markerElForDrag, 'pointerdown', { clientX: from.x, clientY: from.y })
  firePointer(markerElForDrag, 'pointermove', { clientX: to.x, clientY: to.y })
  firePointer(markerElForDrag, 'pointerup', { clientX: to.x, clientY: to.y })
  flushFrames()
  const movedMarker = layers.getDocument(canvasPath).markers[0]
  check(
    '拖动改变了标记位置',
    movedMarker.p[0] !== markerBefore.p[0] || movedMarker.p[1] !== markerBefore.p[1],
    JSON.stringify(movedMarker.p),
  )

  // 吸附检查要有实际内容：用落点算出**期望的格心**，而不是断言"看起来像整数"
  const grid = layers.getDocument(canvasPath).grid
  const dropWorld = canvas._worldFor({ x: to.x, y: to.y })
  const dropAxial = worldToAxial(grid, dropWorld)
  const expectedSnap = snapToCellCenter(grid, dropAxial.q, dropAxial.r)
  check(
    '拖动结束后标记吸附到落点所在格的中心',
    Math.abs(movedMarker.p[0] - expectedSnap.x) < 1e-6 && Math.abs(movedMarker.p[1] - expectedSnap.y) < 1e-6,
    `实际 [${movedMarker.p.join(', ')}] 期望 [${expectedSnap.x}, ${expectedSnap.y}]`,
  )
  check(
    '一次拖动只产生一条历史',
    editor.getStatus().undo === undoBeforeDrag + 1,
    `${undoBeforeDrag} → ${editor.getStatus().undo}`,
  )
  check('可用撤销移回原位', editor.undo() === true)
  const restored = layers.getDocument(canvasPath).markers[0]
  check('撤销后回到拖动前的位置', restored.p[0] === markerBefore.p[0] && restored.p[1] === markerBefore.p[1], JSON.stringify(restored.p))

  // 保存与重载后标记仍在（走文件往返）
  await store.flush()
  const reloaded = await store.load(file)
  check('标记已落盘', (app.vault.files.get(file.path) ?? '').includes('龙脊城'))
  check('落盘后可完整解析回来', reloaded.document.markers.length === 1 && reloaded.document.labels.length === 1)

  plugin.onunload()
}

console.log('\n场景 15：路径与区域绘制（逐点点击、双击/回车结束、右键删除）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx

  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  const moveTo = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointermove', { clientX: client.x, clientY: client.y, target: wrapper })
  }

  editor.setMode('paint')
  editor.setTool('path')
  check('路径工具有默认类型（河流）', editor.pathType === 'river', String(editor.pathType))

  // 逐点点击定顶点
  clickAt({ x: -300, y: -200 })
  check('第一次点击建立草稿', editor.isDrafting() && editor.getStatus().draftPoints === 1)
  moveTo({ x: 0, y: 0 })
  clickAt({ x: 0, y: 0 })
  clickAt({ x: 300, y: 150 })
  check('草稿累计到 3 个顶点', editor.getStatus().draftPoints === 3, String(editor.getStatus().draftPoints))
  check('草稿尚未写入文档（草稿只在内存里）', layers.getDocument(canvasPath).paths.length === 0)

  // 草稿要画出来：橡皮筋 + 顶点手柄 + 平滑曲线
  ctx.resetCalls()
  editor.updateDraftCursor({ x: 400, y: 200 })
  flushFrames()
  // 注意：断言的是**几何**（转角被摊平 = 曲线），不是"调用了 bezierCurveTo"。
  // 变宽预览改成逐段描边后就不再走贝塞尔命令了，用实现细节当断言会误报。
  const draftColor = editor.getDraft().color
  const draftShape = turningAngles(joinStrokePoints(ctx.groups, draftColor))
  check(
    '草稿预览是平滑曲线（转角被摊平，而不是集中在顶点上）',
    draftShape.count >= 20 && draftShape.max < 20,
    `点数=${draftShape.count} 最大转角=${draftShape.max.toFixed(1)}°`,
  )
  check('草稿预览画了顶点手柄', ctx.calls.arc >= 3, String(ctx.calls.arc))

  // 回车结束
  const scope = app.keymap.activeScope
  const enterHandler = scope.registrations.find((item) => item.key === 'Enter')
  check('注册了回车结束草稿', enterHandler !== undefined)
  enterHandler.handler({ key: 'Enter' })
  flushFrames()

  const pathDoc = layers.getDocument(canvasPath)
  check('回车结束并写入路径', pathDoc.paths.length === 1, String(pathDoc.paths.length))
  const path = pathDoc.paths[0]
  check('路径顶点数正确', path.pts.length === 3, String(path.pts.length))
  check('路径采用当前类型与样式', path.type === 'river' && path.taper === true && path.smooth === true, JSON.stringify({ type: path.type, taper: path.taper, smooth: path.smooth }))
  check('结束后草稿被清空', editor.isDrafting() === false)
  check('绘制路径产生了一条历史', editor.getStatus().undo === 1, String(editor.getStatus().undo))

  // 渲染统计：路径进入渲染计划（先触发一次真实重绘）
  ctx.resetCalls()
  canvas.markViewportChanged()
  check('路径重绘只排一帧', flushFrames() === 1)
  const stats = layers.listStatus()[0].stats
  check('渲染计划包含这条路径', stats.lastPathCount === 1, String(stats.lastPathCount))
  // 提交后的河流必须仍然是**曲线**：变宽描边是逐段画的，如果直接连原始顶点就会变成折线
  // （带尖角的对抗性用例在场景 17，这里的河流本身接近直线，只看"点数多、处处都是小转角"）
  const riverShape = turningAngles(joinStrokePoints(ctx.groups, path.color))
  check('河流按段描边（变宽是逐段画的）', ctx.calls.stroke >= 2, String(ctx.calls.stroke))
  check(
    '提交后仍是平滑曲线，没有退化成折线',
    riverShape.count >= 20 && riverShape.max < 20,
    `点数=${riverShape.count} 最大转角=${riverShape.max.toFixed(1)}°`,
  )

  // 撤销 / 重做
  check('撤销移除了路径', editor.undo() === true && layers.getDocument(canvasPath).paths.length === 0)
  check('重做恢复了路径', editor.redo() === true && layers.getDocument(canvasPath).paths.length === 1)

  // 区域：逐点点击 + 双击结束
  editor.setTool('region')
  clickAt({ x: -400, y: 300 })
  clickAt({ x: 100, y: 300 })
  clickAt({ x: 100, y: 600 })
  const beforeRegionUndo = editor.getStatus().undo
  // 双击（同一位置连续两次 pointerdown 即被判定为双击）
  clickAt({ x: -400, y: 600 })
  clickAt({ x: -400, y: 600 })
  flushFrames()
  const regionDoc = layers.getDocument(canvasPath)
  check('双击结束并写入区域', regionDoc.regions.length === 1, String(regionDoc.regions.length))
  check('区域顶点数为 4（双击那次不额外加点）', regionDoc.regions[0].pts.length === 4, String(regionDoc.regions[0].pts.length))
  check('区域使用当前颜色与默认透明度', regionDoc.regions[0].opacity === 0.22, String(regionDoc.regions[0].opacity))
  check('绘制区域只产生一条历史', editor.getStatus().undo === beforeRegionUndo + 1, `${beforeRegionUndo} → ${editor.getStatus().undo}`)

  // Esc 取消草稿（不写入文档）
  editor.setTool('region')
  clickAt({ x: 0, y: 0 })
  clickAt({ x: 50, y: 50 })
  const labelsBefore = layers.getDocument(canvasPath).regions.length
  const escHandler = scope.registrations.find((item) => item.key === 'Escape')
  escHandler.handler({ key: 'Escape' })
  check('Esc 取消草稿且不写入文档', editor.isDrafting() === false && layers.getDocument(canvasPath).regions.length === labelsBefore)
  check('Esc 取消草稿时仍停留在绘制模式（只退出这一步）', editor.mode === 'paint', String(editor.mode))

  // 顶点不足时结束：不产生历史（避免"点了两下就多一条撤销"）
  const undoBeforeTinyDraft = editor.getStatus().undo
  editor.setTool('region')
  clickAt({ x: 0, y: 0 })
  clickAt({ x: 40, y: 0 })
  enterHandler.handler({ key: 'Enter' })
  check('顶点不足的区域被放弃且不入历史', editor.getStatus().undo === undoBeforeTinyDraft, String(editor.getStatus().undo))

  // 选择模式右键删除区域（命中测试）
  editor.setMode('select')
  const regionCenter = { x: -150, y: 450 }
  const missPoint = { x: 2000, y: 2000 }
  const missedClick = (() => {
    const client = canvas._clientFor(missPoint)
    return firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, button: 2, target: wrapper })
  })()
  check('右键空白处不被拦截（原生菜单照常）', missedClick.stopped === false)

  const beforeDeleteRegion = layers.getDocument(canvasPath).regions.length
  const hitClick = (() => {
    const client = canvas._clientFor(regionCenter)
    return firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, button: 2, target: wrapper })
  })()
  flushFrames()
  check('右键区域内被拦截并删除区域', hitClick.stopped === true && layers.getDocument(canvasPath).regions.length === beforeDeleteRegion - 1)
  check('删除区域可撤销', editor.undo() === true && layers.getDocument(canvasPath).regions.length === beforeDeleteRegion)

  // 右键删除路径（命中线宽范围）
  const pathPoint = { x: 0, y: 0 }
  const beforeDeletePath = layers.getDocument(canvasPath).paths.length
  const pathClick = (() => {
    const client = canvas._clientFor(pathPoint)
    return firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, button: 2, target: wrapper })
  })()
  flushFrames()
  check('右键路径上被拦截并删除路径', pathClick.stopped === true && layers.getDocument(canvasPath).paths.length === beforeDeletePath - 1, `paths=${layers.getDocument(canvasPath).paths.length}`)

  // 落盘往返
  // 注意：上面为测试删除操作删掉了路径，而"新操作会清空重做栈"——
  // 所以这里要用 undo() 把它撤回来（redo() 已经没有东西可重做了）。
  editor.undo()
  check(
    '清理后路径与区域都在文档里',
    layers.getDocument(canvasPath).paths.length === 1 && layers.getDocument(canvasPath).regions.length === 1,
    `paths=${layers.getDocument(canvasPath).paths.length} regions=${layers.getDocument(canvasPath).regions.length}`,
  )
  await store.flush()
  const saved = app.vault.files.get(canvasPath.replace('.canvas', '.map.md')) ?? ''
  check('区域的标签字段被写入文件', saved.includes('"regions"'))
  check('路径的样式字段被写入文件（taper/smooth）', saved.includes('"taper":true') && saved.includes('"smooth":true'))

  plugin.onunload()
}

console.log('\n场景 16：路径与区域命名（画完即命名、双击重命名、名称显示开关）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  // 命名对话框换成可注入的假实现：记录弹出的参数，并允许测试直接"点确定"
  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)

  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  /** 画一个矩形区域：4 个顶点 + 末点双击结束 */
  const drawRegion = (x0, y0, x1, y1) => {
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x1, y: y0 })
    clickAt({ x: x1, y: y1 })
    clickAt({ x: x0, y: y1 })
    clickAt({ x: x0, y: y1 })
    flushFrames()
  }
  /** 取当前作用域里的某个按键处理函数（作用域会在每次点击后被重建，必须现取） */
  const pressKey = (key) => {
    const scope = app.keymap.activeScope
    const entry = scope?.registrations.find((item) => item.key === key)
    if (!entry) throw new Error(`找不到按键处理：${key}`)
    entry.handler({ key })
    flushFrames()
  }
  /** 重新绘制一帧并返回这一帧的画布调用统计 */
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx.calls
  }

  // ---- 画完区域立刻命名 ----
  editor.setMode('paint')
  editor.setTool('region')
  drawRegion(-400, 300, 100, 600)
  check('双击结束后弹出命名对话框', prompts.length === 1, String(prompts.length))
  check('弹出的是区域命名', prompts[0]?.options.title === '命名区域', String(prompts[0]?.options.title))
  check('命名对话框允许留空（跳过命名）', prompts[0]?.options.allowEmpty === true)
  check('弹框时形状已经写入文档', doc().regions.length === 1, String(doc().regions.length))
  prompts[0].onSubmit('北境领')
  flushFrames()
  check('提交后区域带上了名称', doc().regions[0].label === '北境领', JSON.stringify(doc().regions[0].label))

  let calls = frame()
  check(
    '区域名称被画到画布上（描边光晕 + 填充）',
    calls.strokeText === 1 && calls.fillText === 1,
    `strokeText=${calls.strokeText} fillText=${calls.fillText}`,
  )

  // ---- 名称显示开关（唯一真相是图层设置 layers.labels）----
  // §F.2 之后它**只在侧栏「显示 · 地物」一组里出现一次**：浮窗上那个同名按钮已经删掉
  // （同一个开关挂两处正是 §5.12 那一类问题："点了哪个才算数"会说不清）
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const panel = await openMapPanel(app, plugin)
  const nameToggle = () => inPanel(panel, 'fc-layer-toggle').find((element) => element.dataset.layer === 'labels')
  check('侧栏「地物」里有"名称"开关', nameToggle() !== undefined)
  check(
    '浮窗上不再重复挂同一个开关',
    collectByClass(toolbarEl, 'fc-ctl-button').every((button) => (button.textContent ?? '') !== '名称'),
    collectByClass(toolbarEl, 'fc-ctl-button').map((button) => button.textContent).join('|'),
  )
  check('名称图层初始是打开的', plugin.getSettings().layers.labels === true, JSON.stringify(plugin.getSettings().layers))
  fireEvent(nameToggle(), 'click')
  // 刻意**不 await**：点一下必须当场生效（广播在落盘之前），
  // 否则会出现"点了之后下一帧还画着名称"
  check(
    '点击名称开关改的是图层设置（不是编辑器里的一份私有状态）',
    plugin.getSettings().layers.labels === false,
    JSON.stringify(plugin.getSettings().layers),
  )
  flushFrames()
  check(
    '开关的高亮读的是设置，重建后跟着变',
    nameToggle()?.classList.contains('is-active') === false,
    String(nameToggle()?.className),
  )
  calls = frame()
  check(
    '隐藏名称后不画任何形状文字',
    calls.fillText === 0 && calls.strokeText === 0,
    `strokeText=${calls.strokeText} fillText=${calls.fillText}`,
  )
  check('区域本身照常绘制（只是没有名字）', calls.fill >= 1, String(calls.fill))
  fireEvent(nameToggle(), 'click')
  check('再点一次恢复显示名称', plugin.getSettings().layers.labels === true, JSON.stringify(plugin.getSettings().layers))
  calls = frame()
  check('名称重新出现', drawnText(ctx).includes('北境领'), drawnText(ctx))

  // ---- 画完路径立刻命名（回车结束）----
  const undoBeforePath = editor.getStatus().undo
  editor.setTool('path')
  clickAt({ x: -300, y: -200 })
  clickAt({ x: 0, y: 0 })
  clickAt({ x: 300, y: 150 })
  pressKey('Enter')
  check('回车结束后弹出路径命名对话框', prompts.length === 2 && prompts[1].options.title === '命名路径', String(prompts[1]?.options.title))
  prompts[1].onSubmit('北境商路')
  flushFrames()
  check('路径带上了名称', doc().paths[0].label === '北境商路', JSON.stringify(doc().paths[0].label))
  check('路径命名后弹出可选链接输入', prompts.length === 3 && prompts[2].options.title === '关联路径笔记', String(prompts[2]?.options.title))
  prompts[2].onSubmit(null)
  flushFrames()
  check(
    '绘制与命名各占一条历史（可以分开撤销）',
    editor.getStatus().undo === undoBeforePath + 2,
    `${undoBeforePath} → ${editor.getStatus().undo}`,
  )
  calls = frame()
  const bothNamed = drawnText(ctx)
  check(
    '两个名称都被画出来（路径名称是逐字画的，所以按"文字内容"而不是调用次数判断）',
    bothNamed.includes('北境领') && bothNamed.includes('北境商路'),
    bothNamed,
  )

  // ---- 命名是可撤销的编辑 ----
  editor.undo()
  check('撤销只回退命名，路径还在', doc().paths.length === 1 && doc().paths[0].label === undefined, JSON.stringify(doc().paths[0].label))
  editor.redo()
  check('重做恢复名称', doc().paths[0].label === '北境商路')

  // ---- 选择模式下双击区域重命名 ----
  editor.setMode('select')
  clickAt({ x: -150, y: 450 })
  clickAt({ x: -150, y: 450 })
  check('双击区域弹出重命名对话框', prompts.length === 4 && prompts[3].options.title === '重命名区域', String(prompts[3]?.options.title))
  check('重命名对话框预填了当前名称', prompts[3].options.initialValue === '北境领', String(prompts[3]?.options.initialValue))
  prompts[3].onSubmit('北境')
  flushFrames()
  check('重命名生效', doc().regions[0].label === '北境', JSON.stringify(doc().regions[0].label))
  editor.undo()
  check('重命名可以撤销', doc().regions[0].label === '北境领', JSON.stringify(doc().regions[0].label))
  editor.redo()
  check('重做后又回到新名字', doc().regions[0].label === '北境', JSON.stringify(doc().regions[0].label))

  // ---- 留空 = 清除名称（区域）----
  clickAt({ x: -150, y: 450 })
  clickAt({ x: -150, y: 450 })
  check('再次双击又能改名', prompts.length === 5, String(prompts.length))
  prompts[4].onSubmit(null)
  flushFrames()
  check('留空提交清除了区域名称', doc().regions[0].label === '', JSON.stringify(doc().regions[0].label))
  calls = frame()
  check('清除后只剩路径的名称', drawnText(ctx) === '北境商路', drawnText(ctx))
  editor.undo()
  // 撤销回到的是"上一个名字"，也就是重命名那一步的结果（北境），而不是更早的北境领
  check('清除名称也能撤销', doc().regions[0].label === '北境', JSON.stringify(doc().regions[0].label))

  // ---- 新画完留空：形状必须保留 ----
  editor.setMode('paint')
  editor.setTool('region')
  drawRegion(500, 300, 700, 500)
  check('第三个区域又弹出命名框', prompts.length === 6, String(prompts.length))
  prompts[5].onSubmit(null)
  flushFrames()
  check('留空跳过命名不会删掉刚画的形状', doc().regions.length === 2, String(doc().regions.length))
  check('未命名的区域没有 label 内容', doc().regions[1].label === '', JSON.stringify(doc().regions[1].label))
  calls = frame()
  // 区域画在路径之前，因此顺序是「已命名的第一个区域 → 路径」；第三个区域没有名字，不贡献文字
  check('未命名区域不贡献文字', drawnText(ctx) === '北境北境商路', drawnText(ctx))

  // ---- 笔刷不触发命名 ----
  editor.setTool('brush')
  const promptsBeforeBrush = prompts.length
  clickAt({ x: -700, y: -500 })
  flushFrames()
  check('画地形不会弹出命名框', prompts.length === promptsBeforeBrush, String(prompts.length))

  // ---- 命名框打开时，输入框里的按键不能被画布抢走 ----
  // （我们的快捷键是无修饰键的字母，Modal 只注册自己用到的键，其余会落到画布作用域）
  const inputTarget = { tagName: 'INPUT', isContentEditable: false }
  const scopeForKeys = app.keymap.activeScope
  const pHandler = scopeForKeys.registrations.find((item) => item.key === 'p')
  const enterKeyHandler = scopeForKeys.registrations.find((item) => item.key === 'Enter')
  editor.setTool('brush')
  check('前提：当前工具是地形', editor.tool === 'brush', String(editor.tool))
  const keyResult = pHandler.handler({ key: 'p', target: inputTarget })
  check('输入框里按 P 不切换工具', editor.tool === 'brush', String(editor.tool))
  check('并且把按键让给下层（返回 true 表示未处理）', keyResult === true, String(keyResult))
  const enterResult = enterKeyHandler.handler({ key: 'Enter', target: { tagName: 'DIV', isContentEditable: true } })
  check('可编辑区域里按回车也不结束草稿', enterResult === true, String(enterResult))
  // 画布上的按键必须照常生效（别把守卫写成"一律不响应"）
  const pOnCanvas = pHandler.handler({ key: 'p', target: { tagName: 'DIV', isContentEditable: false } })
  check('画布上按 P 照常切换工具', editor.tool === 'path' && pOnCanvas === false, String(editor.tool))

  // ---- 落盘 ----
  await store.flush()
  const saved = app.vault.files.get(canvasPath.replace('.canvas', '.map.md')) ?? ''
  check('区域名称写进了文件', saved.includes('"label":"北境"'), saved.slice(0, 200))
  check('路径名称也写进了文件', saved.includes('北境商路'))
  const reloaded = await store.load(app.vault.getAbstractFileByPath(canvasPath.replace('.canvas', '.map.md')))
  check(
    '重新解析后名称仍在',
    reloaded.document.regions[0].label === '北境' && reloaded.document.paths[0].label === '北境商路',
    JSON.stringify([reloaded.document.regions[0].label, reloaded.document.paths[0].label]),
  )

  plugin.onunload()
}

console.log('\n场景 17：三项视觉缺陷的回归（河流折线化 / 名称过小 / 名称不随线条走）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const dpr = REAL.devicePixelRatio

  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  /** 重画一帧并返回该帧的调用统计（清掉上一帧的记录） */
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  /** 取当前作用域里的按键处理函数（作用域会在每次点击后被重建，必须现取） */
  const pressKey = (key) => {
    const scope = app.keymap.activeScope
    const entry = scope?.registrations.find((item) => item.key === key)
    if (!entry) throw new Error(`找不到按键处理：${key}`)
    entry.handler({ key })
    flushFrames()
  }

  // ---- 缺陷 3：河流画完变成折线 ----
  // 三个控制点构成一个直角：折线会在拐点处出现一个约 90° 的尖角，曲线会把转角摊开
  editor.setMode('paint')
  editor.setTool('path')
  editor.setPathType('river')
  clickAt({ x: -400, y: -300 })
  clickAt({ x: 0, y: -300 })
  clickAt({ x: 0, y: 200 })
  const enterHandler = app.keymap.activeScope.registrations.find((item) => item.key === 'Enter')
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  check('河流已写入文档', doc().paths.length === 1, String(doc().paths.length))
  check('河流带着平滑标记', doc().paths[0].smooth === true && doc().paths[0].taper === true)

  const river = doc().paths[0]
  let frameCtx = frame()
  const riverLine = joinStrokePoints(frameCtx.groups, river.color)
  const riverTurn = turningAngles(riverLine)
  check('河流被展平成很多段（逐段变宽需要）', riverLine.length >= 30, `${riverLine.length} 个点`)
  check(
    '拐点被摊平：没有任何一处是尖角（折线会有一个 ~90° 的角）',
    riverTurn.max < 15,
    `最大转角=${riverTurn.max.toFixed(1)}°（折线约 90°）`,
  )
  check(
    '整条河的总转角仍接近 90°（说明它确实转了弯，不是被画成直线）',
    Math.abs(Math.abs(riverTurn.total) - 90) < 25,
    `总转角=${riverTurn.total.toFixed(1)}°`,
  )
  check('逐段描边的次数与点数一致（每段一次 stroke）', frameCtx.calls.stroke >= riverLine.length - 1, `${frameCtx.calls.stroke} 次`)

  // ---- 缺陷 1 + 2：名称过小、名称不随线条走 ----
  prompts[0].onSubmit('北境商路')
  flushFrames()
  frameCtx = frame()
  const glyphs = drawnRuns(frameCtx)
  check('名称按**逐字**排版（每个字一次绘制）', glyphs.length === 4, `${glyphs.length} 个字形：${glyphs.map((g) => g.text).join('')}`)
  check('名字顺序没有被打乱', glyphs.map((g) => g.text).join('') === '北境商路', glyphs.map((g) => g.text).join(''))
  check(
    '字号不再是"最小可读"档：路径名称 ≥ 15 CSS px',
    glyphs.every((g) => fontPxOf(g) / dpr >= 15 - 1e-9),
    `实际 ${(fontPxOf(glyphs[0]) / dpr).toFixed(1)} CSS px（位图 ${fontPxOf(glyphs[0])}）`,
  )
  // 这条河在屏幕上是"先向右、再向下"，逐字旋转后每个字的倾角都应不为 0
  const angles = glyphs.map((g) => g.angle)
  check(
    '每个字都按所在处的切线旋转了（不是水平一段）',
    angles.every((value) => Math.abs(value) > 1e-6),
    angles.map((value) => ((value * 180) / Math.PI).toFixed(1)).join('° / ') + '°',
  )
  check(
    '文字确实"顺着线条走"：两端字的倾角不同（水平直线上才会相同）',
    Math.max(...angles.map(Math.abs)) - Math.min(...angles.map(Math.abs)) > 0.05,
    angles.map((value) => ((value * 180) / Math.PI).toFixed(1)).join('° / ') + '°',
  )
  // 沿弧长等距摆放：直线距离在拐弯处会被缩短，因此要比较**弧长**上的间距
  const arcs = glyphs.map((glyph) => nearestArcLength(riverLine, glyph).arc)
  const arcGaps = []
  for (let i = 1; i < arcs.length; i += 1) arcGaps.push(arcs[i] - arcs[i - 1])
  check(
    '相邻字在**弧长**上等距（每个字都落在它该在的位置上）',
    arcGaps.length >= 3 && Math.max(...arcGaps) - Math.min(...arcGaps) < 1.5,
    arcGaps.map((value) => value.toFixed(1)).join(', '),
  )
  // 文字整体在被画出来的线上方：与线条上的点做一次最近距离检查
  const nearest = glyphs.map((glyph) => nearestArcLength(riverLine, glyph).distance)
  check(
    '名称整段贴在线上方（既不会压住线，也不会飘远）',
    nearest.every((distance) => distance > river.width / 2 && distance < 40),
    nearest.map((value) => value.toFixed(1)).join(', '),
  )

  // ---- 名称比线条长时退化为整体旋转，而不是溢出或挤成一团 ----
  // 造一条很短的河流（放在第一条河附近，确保在视口内），再给它一个远超其长度的名称
  const rasterOf = (world) => {
    const client = canvas._clientFor(world)
    return { x: (client.x - REAL.wrapperRect.left) * dpr, y: (client.y - REAL.wrapperRect.top) * dpr }
  }
  editor.setMode('paint')
  editor.setTool('path')
  clickAt({ x: -400, y: -200 })
  clickAt({ x: -360, y: -200 })
  pressKey('Enter')
  const shortPrompt = prompts[prompts.length - 1]
  check('短河流画完也会弹命名框', shortPrompt?.options.title === '命名路径', String(shortPrompt?.options.title))
  shortPrompt.onSubmit('一条名字非常非常长的河流名称超出短线段')
  flushFrames()
  check('长名称已写入文档', (doc().paths[1]?.label ?? '').length > 10, doc().paths[1]?.label)
  frameCtx = frame()
  const longRun = drawnRuns(frameCtx).filter((item) => item.text.includes('一条名字'))
  check('过长的名称退化为"整段旋转"（一次绘制整串文字）', longRun.length === 1, `${longRun.length} 段`)
  check(
    '退化分支对水平线段保持水平（不旋转）',
    Math.abs(longRun[0].angle) < 1e-9,
    `${((longRun[0].angle * 180) / Math.PI).toFixed(1)}°`,
  )
  const shortRail = rasterOf({ x: -380, y: -200 })
  check(
    '退化分支把整串文字居中放在线段中点上方',
    Math.abs(longRun[0].x - shortRail.x) < 2 && longRun[0].y < shortRail.y - 5,
    `文字(${longRun[0].x.toFixed(1)}, ${longRun[0].y.toFixed(1)}) 线段中点(${shortRail.x.toFixed(1)}, ${shortRail.y.toFixed(1)})`,
  )

  // ---- 区域名称：水平、字号更大、落在形状内 ----
  editor.setMode('paint')
  editor.setTool('region')
  clickAt({ x: 400, y: 300 })
  clickAt({ x: 800, y: 300 })
  clickAt({ x: 800, y: 600 })
  clickAt({ x: 400, y: 600 })
  clickAt({ x: 400, y: 600 })
  flushFrames()
  prompts[4].onSubmit('北境领')
  flushFrames()
  frameCtx = frame()
  const regionText = drawnRuns(frameCtx).filter((item) => item.text === '北境领')
  check('区域名称整段水平绘制', regionText.length === 1 && Math.abs(regionText[0].angle) < 1e-9, `${regionText.length} 段`)
  check(
    '区域名称比路径名称更大（≥ 24 CSS px）',
    fontPxOf(regionText[0]) / dpr >= 24 - 1e-9,
    `${(fontPxOf(regionText[0]) / dpr).toFixed(1)} CSS px`,
  )
  check('区域名称字号大于路径名称字号', fontPxOf(regionText[0]) > fontPxOf(glyphs[0]), `${fontPxOf(regionText[0])} vs ${fontPxOf(glyphs[0])}`)

  plugin.onunload()
}

console.log('\n场景 18：名称字号的实测标定与用户可调（"字太小"两轮反馈的收敛方案）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  // 让画布如实报告屏幕尺寸；返回值可用来模拟"位图与 CSS 尺寸的比例不是我以为的那样"
  const setScreenFactor = attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const dpr = REAL.devicePixelRatio

  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const statsOf = () => layers.listStatus()[0].stats
  /** 画一个带名字的区域，返回这一帧里该名称的字号（位图像素） */
  const nameRegionFontPx = (name, x0, y0) => {
    editor.setMode('paint')
    editor.setTool('region')
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x0 + 400, y: y0 })
    clickAt({ x: x0 + 400, y: y0 + 300 })
    clickAt({ x: x0, y: y0 + 300 })
    clickAt({ x: x0, y: y0 + 300 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit(name)
    flushFrames()
    const run = drawnRuns(frame()).find((item) => item.text === name)
    return run ? fontPxOf(run) : Number.NaN
  }

  // ---- 标定：换算必须用**实测**比例，而不是假设"位图比例 = dpr" ----
  const baseline = nameRegionFontPx('标定一', -400, 100)
  const stats = statsOf()
  check(
    '实测标定 ≈ 设备像素比（位图尺寸取整带来 ≤0.1% 的差异）',
    Math.abs(stats.rasterPxPerCssPx / dpr - 1) < 0.001,
    `实测 ${stats.rasterPxPerCssPx} vs dpr ${dpr}（比值 ${(stats.rasterPxPerCssPx / dpr).toFixed(6)}）`,
  )
  check(
    '实际字号 = 策略字号 × 实测标定',
    Math.abs(baseline - stats.labelCssPx.region * stats.rasterPxPerCssPx) < 1e-6,
    `绘制 ${baseline}，期望 ${stats.labelCssPx.region} × ${stats.rasterPxPerCssPx}`,
  )
  check(
    '从不把 var() 写进 ctx.font（非法字体串会被静默忽略，字号退回默认 10 px）',
    ctx.fontAttempts.every((value) => !/var\(/.test(value)),
    ctx.fontAttempts.filter((value) => /var\(/.test(value)).join(' | ') || '（无）',
  )
  check('字体族是已解析的列表（不是变量）', /Fake Sans/.test(String(ctx.font)), String(ctx.font))

  // 防御性：万一从 getComputedStyle 拿到的是 var()，也必须退到合法字体，字号不能退回默认
  fakeDocument.defaultView.fontFamilyOverride = 'var(--font-interface, sans-serif)'
  const escaped = nameRegionFontPx('变量字体', 400, 700)
  check('拿到 var() 字体时字号仍然正确（内部已挡掉并退到 sans-serif）', Math.abs(escaped - baseline) < 1e-6, `${baseline} → ${escaped}`)
  fakeDocument.defaultView.fontFamilyOverride = null
  check(
    '名称字号下限足够大（路径 ≥ 20 px、区域 ≥ 24 px CSS）',
    stats.labelCssPx.path >= 20 && stats.labelCssPx.region >= 24,
    `路径 ${stats.labelCssPx.path} px · 区域 ${stats.labelCssPx.region} px`,
  )
  check('区域名称大于路径名称', stats.labelCssPx.region > stats.labelCssPx.path)

  // ---- 对抗性：把"屏幕尺寸"量成一半 → 字号必须翻倍 ----
  setScreenFactor(0.5)
  const doubled = nameRegionFontPx('标定二', -400, 700)
  check(
    '屏幕尺寸被量成一半时字号翻倍（证明换算用的是实测标定）',
    Math.abs(doubled - baseline * 2) < 1e-6,
    `${baseline} → ${doubled}`,
  )
  setScreenFactor(1)
  const restored = nameRegionFontPx('标定三', 400, 100)
  check('恢复真实屏幕尺寸后字号回到原值', Math.abs(restored - baseline) < 1e-6, `${restored} vs ${baseline}`)

  // ---- 设置：倍率立即生效并落盘 ----
  check('插件注册了设置界面', plugin.settingTabs.length === 1, String(plugin.settingTabs.length))
  check('默认倍率为 1', plugin.getSettings().labelScale === 1, String(plugin.getSettings().labelScale))

  await plugin.setLabelScale(2)
  flushFrames()
  const big = nameRegionFontPx('放大', -400, 100)
  check('倍率 2 时字号翻倍', Math.abs(big - baseline * 2) < 1e-6, `${baseline} → ${big}`)
  check('倍率已落盘', String(plugin._data ?? '').includes('"labelScale":2'), String(plugin._data))

  await plugin.setLabelScale(0.5)
  flushFrames()
  const small = nameRegionFontPx('缩小', -400, 700)
  check('倍率 0.5 时字号减半', Math.abs(small - baseline * 0.5) < 1e-6, `${baseline} → ${small}`)

  await plugin.setLabelScale(99)
  check('过大的倍率被收敛到上限 3', plugin.getSettings().labelScale === 3, String(plugin.getSettings().labelScale))
  await plugin.setLabelScale(-5)
  check('过小的倍率被收敛到下限 0.5', plugin.getSettings().labelScale === 0.5, String(plugin.getSettings().labelScale))
  await plugin.setLabelScale(1)
  check('回到默认倍率', plugin.getSettings().labelScale === 1)

  // ---- 设置界面把"猜"变成"看"：滑块带当前值，并显示实际字号 ----
  const tab = plugin.settingTabs[0]
  FakeSetting.created.length = 0
  tab.display()
  const heading = (tab.containerEl.children ?? []).find((child) => child.tagName === 'H2')
  check('设置界面已渲染 Project Kaki 标题', heading?.textContent === 'Project Kaki', String(heading?.textContent))
  const sliderSetting = FakeSetting.created.find((setting) => setting.slider)
  check('设置界面有字号滑块', sliderSetting !== undefined)
  // A3 撤掉了那行重复的「显示六边形网格」；W1c 又把**整组**图层开关搬出了设置页
  // （用户 m01803 第 6 条：「图层开关属于高频使用的功能，建议只留在侧栏里。」）⇒
  // 现在设置页里**一个网格开关都没有**，网格只由侧栏「底图」那一组的「网格」控制
  // （画布工具条上**没有**网格按钮 —— 那是旧注释的说法，已核实为假）。
  const legacyGrid = FakeSetting.created.find((setting) => setting.info.name === '显示六边形网格')
  const gridSetting = FakeSetting.created.find((setting) => setting.info.name === '显示网格')
  check(
    '设置页里一个网格开关都没有（重复的那行早撤了，图层那组也整组搬去侧栏了）',
    legacyGrid === undefined && gridSetting === undefined,
    `legacy=${String(legacyGrid?.info?.name)} grid=${String(gridSetting?.info?.name)}`,
  )
  check(
    '滑块带当前倍率与合法区间',
    sliderSetting?.slider.value === 1 &&
      sliderSetting?.slider.limits?.min === 0.5 &&
      sliderSetting?.slider.limits?.max === 3,
    JSON.stringify({ value: sliderSetting?.slider.value, limits: sliderSetting?.slider.limits }),
  )
  check(
    '开发者模式关闭时，「当前实际字号」那一组不出现（本轮起它属于开发者选项）',
    FakeSetting.created.find((setting) => setting.info.name === SETTINGS_LABELS.currentLabelPx) === undefined,
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name).filter((name) => name === SETTINGS_LABELS.currentLabelPx)),
  )
  // 打开开发者模式后它才出现（用户 2026-09-27 的要求：把它移进开发者选项里）
  await plugin.setDeveloperMode(true)
  plugin.settingTabs[0].display()
  const liveInfo = FakeSetting.created.find((setting) => setting.info.name === SETTINGS_LABELS.currentLabelPx)
  check(
    '开发者模式下显示当前实际字号（便于直接读数）',
    typeof liveInfo?.info.desc === 'string' && /路径 \d+ px · 区域 \d+ px/.test(liveInfo.info.desc),
    String(liveInfo?.info.desc),
  )

  // 状态命令要把实测字号报出来（下一轮反馈可以直接贴这个数字）
  const sizeCapture = captureReports(plugin)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const statusText = sizeCapture.text()
  check('状态命令报出名称字号', /名称字号：路径 \d+ px · 区域 \d+ px/.test(statusText), statusText.replace(/\n/g, ' | ').slice(0, 200))
  check('状态命令报出实测标定', /标定 1 CSS px = [\d.]+ 位图像素/.test(statusText), statusText.replace(/\n/g, ' | ').slice(0, 200))
  sizeCapture.restore()

  plugin.onunload()
}

console.log('\n场景 19：Base 自定义视图（注册、合并两个来源、渲染、降级）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  // 在地图文档里放一条标记，用来验证"两个来源合并"
  const mapPath = 'Maps/World.map.md'
  const mapFile = app.vault.getAbstractFileByPath(mapPath)
  const loaded = await store.load(mapFile)
  loaded.document.markers.push({ id: 'm1', label: '龙脊城', p: [100, 50], icon: 'city' })
  loaded.document.regions.push({ id: 'r1', label: '北境领', pts: [[0, 0], [200, 0], [200, 200], [0, 200]], color: '#44cf6e', opacity: 0.22 })
  await store.writeNow(mapFile, loaded.document, 'World', [canvasPath])
  await settleEvents()

  // ---- 注册 ----
  check('插件注册了 Base 视图', plugin.basesViews.length === 1, String(plugin.basesViews.length))
  const { viewId, registration } = plugin.basesViews[0] ?? {}
  check('视图类型 id 正确', viewId === 'fictional-map', String(viewId))
  check('视图有名称与图标', registration?.name === '地图' && registration?.icon === 'map', JSON.stringify({ name: registration?.name, icon: registration?.icon }))
  check('插件报告 Base 可用', plugin.getBasesAvailable() === true, String(plugin.getBasesAvailable()))

  const options = registration.options()
  const optionKeys = options.map((option) => option.key)
  check(
    '视图选项包含地图文档与三个属性',
    optionKeys.includes('mapFile') && optionKeys.includes('coordProperty') && optionKeys.includes('typeProperty') && optionKeys.includes('regionProperty'),
    optionKeys.join(', '),
  )
  check(
    '选项里没有使用 shouldHide（1.10.2 起签名有破坏性变更）',
    options.every((option) => option.shouldHide === undefined),
    JSON.stringify(options.map((o) => o.shouldHide)),
  )
  check('地图文档选项是 file 类型', options.find((o) => o.key === 'mapFile')?.type === 'file')
  const sortOption = options.find((o) => o.key === 'sortBy')
  check('排序选项是下拉框且有可选值', sortOption?.type === 'dropdown' && Object.keys(sortOption.options ?? {}).length >= 4)

  // ---- 实例化视图并渲染 ----
  const container = makeEl({ className: 'bases-view-container' })
  const controller = { type: 'bases' }
  const view = registration.factory(controller, container)
  check('factory 返回了视图实例', typeof view?.onDataUpdated === 'function')

  // 基斯的 Value 形态：ListValue 有 length()/get()，元素是带 toString 的 Value
  const listValue = { length: () => 2, get: (i) => ({ toString: () => (i === 0 ? '320' : '-140') }) }
  view.config = makeBasesConfig({
    mapFile: mapPath,
    coordProperty: 'note.coordinates',
    typeProperty: 'note.map-type',
    regionProperty: 'note.region',
    sortBy: 'name',
  })
  view.data = {
    data: [
      makeBasesEntry('灰港', { coordinates: '-40, 220', 'map-type': 'port' }, 'Locations'),
      makeBasesEntry('荒村', { coordinates: '东边那座城' }, 'Locations'),
      makeBasesEntry('无名地', {}, 'Locations'),
      makeBasesEntry('龙脊城', { coordinates: listValue, 'map-type': 'city', region: '北境' }, 'Locations'),
    ],
  }
  view.onDataUpdated()
  await new Promise((resolve) => setTimeout(resolve, 60))

  const rows = collectByClass(container, 'fc-base-row')
  check('渲染出了表格行', rows.length === 6, `${rows.length} 行（4 笔记 + 1 标记 + 1 区域）`)
  check('Base 视图创建了地图缩略图容器', collectByClass(container, 'fc-base-preview-wrap').length === 1)

  const cellsOf = (row) => row.children.map((cell) => cell.textContent ?? '')
  const byName = new Map(rows.map((row) => [row.children[0]?.textContent, cellsOf(row)]))
  check('笔记行带上了世界坐标', byName.get('灰港')?.[3] === '-40, 220', JSON.stringify(byName.get('灰港')))
  check('基斯的 ListValue 形态坐标也被解析', byName.get('龙脊城')?.[3] === '320, -140', JSON.stringify(byName.get('龙脊城')))
  // 同名条目（笔记 + 地图标记）必须**各占一行**且来源可区分
  const dragonRows = rows.map(cellsOf).filter((cells) => cells[0] === '龙脊城')
  check(
    '笔记与地图标记同名时各占一行，来源可区分',
    dragonRows.length === 2 &&
      dragonRows.some((cells) => cells[2] === BASE_TEXT.sourceNote) &&
      dragonRows.some((cells) => cells[2] === BASE_TEXT.sourceMap),
    JSON.stringify(dragonRows),
  )
  check('区域行来自地图文档', byName.get('北境领')?.[1] === BASE_TEXT.kind.region, JSON.stringify(byName.get('北境领')))
  check('没有坐标的笔记仍然入表', byName.get('无名地')?.[3] === BASE_TEXT.noCoords, JSON.stringify(byName.get('无名地')))
  check('坐标写错的笔记被标记出来', byName.get('荒村') && rows.find((r) => r.children[0]?.textContent === '荒村')?.classList.contains('is-invalid'))
  check('表格按名称排序（缺坐标的不影响排序）', rows[0]?.children[0]?.textContent !== undefined)

  const summaryText = collectByClass(container, 'fc-base-summary')[0]?.children.map((c) => c.textContent).join(' | ') ?? ''
  check(
    '摘要显示地图路径与计数',
    summaryText.includes(mapPath) && summaryText.includes(BASE_TEXT.summary(4, 2, 6)),
    summaryText,
  )

  const warnings = collectByClass(container, 'fc-base-warning')
  check('对无法解析的坐标给出警告', warnings.length === 1, String(warnings.length))
  check(
    '警告里列出了出问题的笔记',
    (warnings[0]?.textContent ?? '').includes('Locations/荒村.md'),
    warnings[0]?.textContent,
  )

  // ---- 点击跳转 ----
  openedLinks.length = 0
  const nameCell = rows.find((row) => row.children[0]?.textContent === '灰港')?.children[0]
  fireEvent(nameCell, 'click')
  check(
    '点击行打开对应笔记',
    openedLinks.some((entry) => entry.link === 'Locations/灰港.md'),
    JSON.stringify(openedLinks),
  )

  // ---- 没配地图文档时：只显示笔记，并给出配置提示（不空白） ----
  const bare = makeEl({ className: 'bare' })
  const bareView = registration.factory(controller, bare)
  bareView.config = makeBasesConfig({})
  bareView.data = { data: [makeBasesEntry('灰港', { coordinates: '-40, 220' }, 'Locations')] }
  bareView.onDataUpdated()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const bareRows = collectByClass(bare, 'fc-base-row')
  check('没配地图时仍然列出笔记', bareRows.some((row) => row.children[0]?.textContent === '灰港'), String(bareRows.length))
  // 库里只有一张地图，因此不配也应自动用上它
  check('库里只有一张地图时自动选用', (collectByClass(bare, 'fc-base-summary-map')[0]?.textContent ?? '') === mapPath, collectByClass(bare, 'fc-base-summary-map')[0]?.textContent)

  // ---- 完全没数据时给出可操作的提示 ----
  const empty = makeEl({ className: 'empty' })
  const emptyView = registration.factory(controller, empty)
  emptyView.config = makeBasesConfig({ mapFile: '不存在的地图.md' })
  emptyView.data = { data: [] }
  emptyView.onDataUpdated()
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('地图文档不存在时给出明确原因', (collectByClass(empty, 'fc-base-summary-error')[0]?.textContent ?? '').includes('找不到地图文档'), collectByClass(empty, 'fc-base-summary-error')[0]?.textContent)
  check('并给出空状态提示而不是白屏', collectByClass(empty, 'fc-base-empty').length === 1)

  // ---- 生成起始 .base 文件 ----
  clearNotices()
  await runCommand(plugin, 'create-map-base')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const basePath = 'Maps/World.base'
  const baseText = app.vault.files.get(basePath)
  check('生成了 .base 文件', typeof baseText === 'string', String(baseText).slice(0, 40))
  check('.base 里包含我们的视图类型', (baseText ?? '').includes('type: fictional-map'))
  check('.base 里指向了地图文档', (baseText ?? '').includes(mapPath))
  check('命令给出了创建的提示', noticeLog.some((line) => line.includes(basePath)), noticeLog.join(' | '))

  // 再执行一次不能覆盖已有文件
  clearNotices()
  await runCommand(plugin, 'create-map-base')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('已存在时不覆盖', noticeLog.some((line) => line.includes(NOTICES.baseExists)), noticeLog.join(' | '))

  // ---- 版本门禁：没有 registerBasesView 的旧版本必须优雅降级 ----
  const legacyApp = makeApp(makeCanvas())
  const savedRegister = FakePlugin.prototype.registerBasesView
  delete FakePlugin.prototype.registerBasesView
  try {
    const legacy = await loadPlugin(legacyApp)
    check('旧版本上加载不报错', legacy.getBasesAvailable() === false, String(legacy.getBasesAvailable()))
    check('旧版本上 Base 视图未注册', legacy.basesViews.length === 0)
    clearNotices()
    await runCommand(legacy, 'create-map-base')
    check('旧版本上给出明确提示而不是静默失败', noticeLog.some((line) => line.includes('1.10.0+')), noticeLog.join(' | '))
    check('Canvas 功能不受影响（地图层仍可用）', typeof legacy.getLayerManager()?.enableForActiveCanvas === 'function')
    legacy.onunload()
  } finally {
    FakePlugin.prototype.registerBasesView = savedRegister
  }

  plugin.onunload()
}

console.log('\n场景 20：SVG 导出与 Base 缩略图（新功能端到端 + 降级路径）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const mapPath = 'Maps/World.map.md'
  const mapFile = app.vault.getAbstractFileByPath(mapPath)
  const loaded = await store.load(mapFile)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  loaded.document.terrain['1_0'] = { t: 'water' }
  loaded.document.markers.push({ id: 'm1', label: '龙脊城', p: [100, 50], icon: 'city' })
  loaded.document.labels.push({ id: 'l1', text: '迷雾海', p: [-200, -100] })
  loaded.document.paths.push({ id: 'p1', type: 'river', pts: [[0, 0], [200, 120]], width: 8, color: '#4a9fd8', label: '北境商路' })
  loaded.document.regions.push({ id: 'r1', label: '北境领', pts: [[0, 0], [200, 0], [200, 200], [0, 200]], color: '#44cf6e', opacity: 0.22 })
  await store.writeNow(mapFile, loaded.document, 'World', [canvasPath])
  await settleEvents()

  // ---- 未启用地图层时必须给出明确提示（而不是导出一个空文件）----
  clearNotices()
  await runCommand(plugin, 'export-map-svg')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    '没有启用地图层时给出明确提示',
    noticeLog.some((line) => line.includes(NOTICES.noExportableMap) || line.includes(NOTICES.layerEnabled)),
    noticeLog.join(' | '),
  )
  check('未启用时不产生文件', app.vault.files.has('Maps/World.svg') === false)

  // ---- 启用地图层后导出 ----
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('地图层已启用', layers.getDocument(canvasPath) !== null)

  clearNotices()
  openedLinks.length = 0
  await runCommand(plugin, 'export-map-svg')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const svg = app.vault.files.get('Maps/World.svg')
  check('导出了 SVG 文件', typeof svg === 'string', String(svg).slice(0, 30))
  check('SVG 是完整文档', (svg ?? '').startsWith('<svg') && (svg ?? '').endsWith('</svg>'))
  check('SVG 使用导出尺寸', (svg ?? '').includes('width="1600"') && (svg ?? '').includes('height="1000"'))
  // 端到端锁住配色同源：地形底色必须来自 terrainStyle（画布用的那一份）
  check(
    '导出里的地形底色与画布同源',
    (svg ?? '').includes('#6d9c57') && (svg ?? '').includes('#5b9bd5'),
    '森林 #6d9c57 / 水域 #5b9bd5',
  )
  check('导出包含路径与区域', (svg ?? '').includes('<polyline') && (svg ?? '').includes('<polygon'))
  check('导出包含标记与文字', (svg ?? '').includes('map:marker:m1') && (svg ?? '').includes('map:label:l1'))
  // 工单 A 的端到端证据：导出里的标记是**字形**（形状来自 `getIcon`，不再是统一的小圆点）
  check(
    '导出里的标记按字形画（与缩略图共用同一份实现）',
    (svg ?? '').includes('data-fc-icon='),
    String(svg).slice(0, 240),
  )
  check('导出后打开了文件', openedLinks.some((entry) => entry.link === 'Maps/World.svg'), JSON.stringify(openedLinks))
  check('命令报告了导出路径', noticeLog.some((line) => line.includes('Maps/World.svg')), noticeLog.join(' | '))

  // ---- 重名不覆盖，自动加后缀 ----
  await runCommand(plugin, 'export-map-svg')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('重复导出时自动改名而不覆盖', app.vault.files.has('Maps/World-2.svg'), [...app.vault.files.keys()].join(', '))
  const first = app.vault.files.get('Maps/World.svg')
  check('先前导出的文件没有被覆盖', typeof first === 'string' && first.includes('<svg'))

  // ---- Base 缩略图：点击契约 ----
  const registration = plugin.basesViews[0].registration
  const container = makeEl({ className: 'bases-view-container' })
  const view = registration.factory({ type: 'bases' }, container)
  view.config = makeBasesConfig({ mapFile: mapPath, coordProperty: 'note.coordinates', sortBy: 'name' })
  view.data = { data: [makeBasesEntry('灰港', { coordinates: '-40, 220', 'map-type': 'port' }, 'Locations')] }
  view.onDataUpdated()
  await new Promise((resolve) => setTimeout(resolve, 60))

  const preview = collectByClass(container, 'fc-base-preview-wrap')[0]
  check('Base 视图渲染了缩略图容器', preview !== undefined)
  const previewHtml = String(preview?.innerHTML ?? '')
  check('缩略图是内联 SVG', previewHtml.startsWith('<svg') && previewHtml.includes('</svg>'))

  const embeddedIds = [...previewHtml.matchAll(/data-row-id="([^"]+)"/g)].map((match) => match[1])
  check('缩略图里的元素带 data-row-id（可点击）', embeddedIds.length >= 5, String(embeddedIds.length))
  const duplicates = embeddedIds.filter((id, index) => embeddedIds.indexOf(id) !== index)
  check('缩略图里没有重复的 data-row-id', duplicates.length === 0, duplicates.join(', '))
  // 点击契约：视图按 id 去 rows 里找行 —— id 必须与行模型的命名一致，否则点了没反应
  check(
    '缩略图里的 id 格式与行模型一致',
    embeddedIds.every((id) => id.startsWith('note:') || id.startsWith('map:')),
    embeddedIds.join(', '),
  )
  check('缩略图包含笔记点', embeddedIds.includes('note:Locations/灰港.md'), embeddedIds.join(', '))
  // 工单 A：标记不再一律是固定小圆点 —— 形状由 `resolveMarkerStyle` + 注入的 `iconSvgFor` 决定，
  // 缩略图与导出**共用同一份实现**（这条断言就是"两边真的都注入了"的端到端证据）
  check(
    '缩略图里的标记按字形画（不再是统一的小圆点）',
    previewHtml.includes('data-fc-icon='),
    previewHtml.slice(0, 240),
  )

  plugin.onunload()
}

console.log('\n场景 21：路径与区域的五种绘制模式（沿网格走 / 沿格心走 / 逐格前进 / 锚点折线 / 自由绘制）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  const moveTo = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointermove', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  const grid = () => layers.getDocument(canvasPath).grid
  /**
   * 折线的每一段长度。
   *
   * 注意：`MapPath.pts` / `MapRegion.pts` 是 `[x, y]` 数组，而**草稿的点是 `{x, y}` 对象**
   * 两者形状不同（第一版这里按数组写，草稿那几条断言全成了 NaN）。
   */
  const xy = (point) => (Array.isArray(point) ? { x: point[0], y: point[1] } : point)
  const segmentLengths = (pts) => {
    const out = []
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = xy(pts[i])
      const b = xy(pts[i + 1])
      out.push(Math.hypot(b.x - a.x, b.y - a.y))
    }
    return out
  }
  const allEdges = (pts) => segmentLengths(pts).every((length) => Math.abs(length - grid().size) < 1e-6)

  // ---- 绘制模式按钮（§F.2：从浮窗搬进侧栏「工具」一节）----
  const panel = await openMapPanel(app, plugin)
  editor.setMode('paint')
  editor.setTool('region')
  flushFrames()
  // ⚠️ 面板是**整块重建**式重绘：每次改状态后元素都是新的，所以这里要按需现取，
  // 不能像浮窗时期那样抓一个常量用到底（抓了常量会在"重建后"读到已脱离 DOM 的旧元素）。
  const geometryButtons = () => inPanel(panel, 'fc-panel-geometry')
  const geometryLabels = [DRAW_MODE_LABELS.edge, DRAW_MODE_LABELS.center, DRAW_MODE_LABELS.step, DRAW_MODE_LABELS.interior, DRAW_MODE_LABELS.free]
  check(
    '侧栏「工具」有五个绘制模式按钮（沿网格走 / 沿格心走 / 逐格前进 / 锚点折线 / 自由绘制）',
    geometryButtons().length === 5,
    String(geometryButtons().length),
  )
  check(
    '五个模式的标签齐全且顺序固定（两个「走」的相邻）',
    geometryButtons().map((button) => button.textContent).join('|') === geometryLabels.join('|'),
    geometryButtons().map((button) => button.textContent).join('|'),
  )
  // hint 的单一来源是 src/ui/strings.ts：按钮 title 必须与常量逐字相同，且 ≤20 字（用户要求）。
  check(
    '每个模式按钮都有 ≤20 字的提示（hint 与浮窗同源）',
    geometryButtons().every((button) => {
      const hint = drawModeHint(button.dataset.fcGeometry)
      return hint.length > 0 && hint.length <= 20 && button.title === hint
    }),
    geometryButtons().map((button) => `${button.dataset.fcGeometry}:${button.title}`).join(' | '),
  )
  check('默认是沿格心连接模式', editor.geometryMode === 'interior', editor.geometryMode)
  fireEvent(geometryButtons()[0], 'click')
  check('点击后切到沿网格线模式', editor.geometryMode === 'edge', editor.geometryMode)
  flushFrames()
  check(
    '按钮高亮跟随模式',
    geometryButtons()[0].classList.contains('is-active') && !geometryButtons()[1].classList.contains('is-active'),
    geometryButtons().map((button) => `${button.textContent}:${button.classList.contains('is-active')}`).join('|'),
  )


  // ---- 沿格心走（第五个模式）：落点吸附格心、相邻两格直连、同格连点去重、不叠平滑 ----
  // 世界坐标 → 轴坐标 → 格心（与标记放置同一判据）。断言也用它，于是"精确落在格心"可判伪。
  const gridSpec = () => grid()
  const centerOfCell = (q, r) => axialToWorld(gridSpec(), q, r)
  /** 三个格心对应的屏幕坐标（先吸到格心，再换算成 client） */
  const clicksOfCenter = (anchors) => anchors.map((anchor) => canvas._clientFor(anchor))
  const centerButton = geometryButtons().find((button) => button.textContent === DRAW_MODE_LABELS.center)
  check('侧栏「工具」有「沿格心走」按钮', centerButton !== undefined, geometryButtons().map((b) => b.textContent).join(', '))
  fireEvent(centerButton, 'click')
  check('点击「沿格心走」切到 center 模式', editor.geometryMode === 'center', editor.geometryMode)
  flushFrames()
  check('面板上没有两个按钮同时高亮', geometryButtons().filter((button) => button.classList.contains('is-active')).length === 1)

  editor.setTool('path')
  editor.setPathType('river')
  flushFrames()
  // 沿格心走这一节也要走一次命名框（与其它模式的口径一致：形状提交后弹命名）
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })
  // 回车结束草稿的处理器：这里先取（下面这一整节都要用它，声明在后面会踩到 TDZ）
  const enterHandler = app.keymap.activeScope.registrations.find((item) => item.key === 'Enter')
  const centerUndoBefore = editor.getStatus().undo
  const centerPathCountBefore = layers.getDocument(canvasPath).paths.length
  // 第 1 格：故意点在这一格里"偏一边"的位置，必须吸到格心而不是落在点击的像素上
  const centerCell1 = { q: -3, r: 2 }
  const centerCell2 = { q: 4, r: -3 }
  const centerCell3 = { q: 4, r: -1 }
  const centerAnchor1 = centerOfCell(centerCell1.q, centerCell1.r)
  const centerAnchor2 = centerOfCell(centerCell2.q, centerCell2.r)
  const centerAnchor3 = centerOfCell(centerCell3.q, centerCell3.r)
  const c1 = canvas._clientFor({ x: centerAnchor1.x + 7, y: centerAnchor1.y - 5 })
  const c2 = canvas._clientFor({ x: centerAnchor2.x - 6, y: centerAnchor2.y + 4 })
  const c3 = canvas._clientFor({ x: centerAnchor3.x + 5, y: centerAnchor3.y + 3 })
  /**
   * 点一格。
   *
   * ⚠️ 两次点击之间必须等一拍：`MapInteraction` 用 `DOUBLE_CLICK_MS` 判定"双击结束草稿"，
   * 同一格连点两次如果挨在一起，会被认成"双击"而不是"重复点击"。
   */
  const clickCell = async (client) => {
    await settleEvents()
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  await clickCell(c1)
  const centerDraftStart = editor.getDraft()
  check('沿格心走的起点吸附到格心（不是点击的像素位置）', centerDraftStart.points.length === 1 && Math.hypot(centerDraftStart.points[0].x - centerAnchor1.x, centerDraftStart.points[0].y - centerAnchor1.y) < 1e-6, JSON.stringify(centerDraftStart.points))
  check('沿格心走有锚点（草稿记着自己的模式，不是 free）', centerDraftStart.mode === 'center', String(centerDraftStart.mode))
  check('沿格心走的草稿不叠平滑（平滑会把线从格心上带走）', centerDraftStart.smooth === false, String(centerDraftStart.smooth))
  // 同一格连点两次：不产生重复点（零长线段丢掉），也不产生第二条历史。
  // ⚠️ 这里直接调 `addDraftPoint`（手势层在两次间隔 < `DOUBLE_CLICK_MS` 时把它当"双击结束"，
  //    不是"重复点击"）—— 走的仍是加点的同一段去重逻辑，只是绕开双击语义。
  editor.addDraftPoint({ x: centerAnchor1.x + 3, y: centerAnchor1.y - 2 })
  check('同一格连点两次不产生重复点（零长线段被丢掉）', editor.getDraft().points.length === 1, String(editor.getDraft().points.length))
  check('被丢掉的重复点击没有多出历史', editor.getStatus().undo === centerUndoBefore, String(editor.getStatus().undo))
  await clickCell(c2)
  await clickCell(c3)
  const centerDraft = editor.getDraft()
  check('三个不同格心 = 三个锚点', centerDraft.points.length === 3, String(centerDraft.points.length))
  const centerDraftSnapped = [centerAnchor1, centerAnchor2, centerAnchor3].every((anchor, index) =>
    Math.hypot(centerDraft.points[index].x - anchor.x, centerDraft.points[index].y - anchor.y) < 1e-6,
  )
  check('每一个锚点都精确落在格心（≤1e-6）', centerDraftSnapped, JSON.stringify(centerDraft.points))
  // 预览：光标那一端也要吸附（否则末段是"格心 → 任意像素"的斜线）
  const centerHover = centerOfCell(7, -4)
  const cHover = canvas._clientFor({ x: centerHover.x + 9, y: centerHover.y - 6 })
  firePointer(host, 'pointermove', { clientX: cHover.x, clientY: cHover.y, target: wrapper })
  const centerPreview = editor.getDraft()
  check('沿格心走的预览光标端也吸附到格心', centerPreview.cursor !== null && Math.hypot(centerPreview.cursor.x - centerHover.x, centerPreview.cursor.y - centerHover.y) < 1e-6, JSON.stringify(centerPreview.cursor))

  // 只有一个格心（不足 2 个不同格心）→ 不提交对象
  editor.cancelDraft()
  flushFrames()
  await clickCell(c1)
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  check('只有一个格心时不提交对象（与其它模式一致）', editor.getStatus().undo === centerUndoBefore && layers.getDocument(canvasPath).paths.length === centerPathCountBefore, String(editor.getStatus().undo))

  // 两个不同格心 → 提交：mode 是 center、两个点精确落在格心、不叠平滑。
  // ⚠️ 先等过 `DOUBLE_CLICK_MS`：上一步的"单击 + 同位置回车"留下的 lastClick 状态会让
  //    紧接着的同一格点击被认成双击（那是**手势**语义，不是这次要测的东西）。
  await new Promise((resolve) => setTimeout(resolve, 400))
  await clickCell(c1)
  await clickCell(c2)
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  // 命名框只在**真的提交出对象**时弹出；这里的守卫让"没提交"与"提交了"不会互相冒充
  if (prompts.length > 0) prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const centerPath = layers.getDocument(canvasPath).paths[centerPathCountBefore]
  check('沿格心走提交的路径 mode === center', centerPath?.mode === 'center', String(centerPath?.mode))
  check('沿格心走的路径正好两个顶点（同格连点没有补进来）', centerPath.pts.length === 2, String(centerPath.pts.length))
  check(
    '两个顶点都精确落在格心（≤1e-6）',
    centerPath.pts.every((pt, index) => {
      const anchor = [centerAnchor1, centerAnchor2][index]
      return Math.hypot(pt[0] - anchor.x, pt[1] - anchor.y) < 1e-6
    }),
    JSON.stringify(centerPath.pts),
  )
  const consecutiveCellsDiffer = centerPath.pts.every((pt, index) => {
    if (index === 0) return true
    const previous = worldToAxial(gridSpec(), { x: centerPath.pts[index - 1][0], y: centerPath.pts[index - 1][1] })
    const current = worldToAxial(gridSpec(), { x: pt[0], y: pt[1] })
    return cellKey(previous.q, previous.r) !== cellKey(current.q, current.r)
  })
  check('相邻顶点必定落在不同格（没有零长线段）', consecutiveCellsDiffer, JSON.stringify(centerPath.pts))
  check('沿格心走不叠平滑（河流的 smooth 对它不生效）', centerPath.smooth === undefined, String(centerPath.smooth))
  check('一次沿格心走 = 一条历史', editor.getStatus().undo === centerUndoBefore + 1, centerUndoBefore + ' → ' + editor.getStatus().undo)

  // 区域也能沿格心走：顶点就是三个格心（不做沿网格线的补点）
  editor.setTool('region')
  flushFrames()
  const centerRegionCountBefore = layers.getDocument(canvasPath).regions.length
  for (const client of clicksOfCenter([centerAnchor1, centerAnchor2, centerAnchor3])) await clickCell(client)
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  if (prompts.length > 0) prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const centerRegion = layers.getDocument(canvasPath).regions[centerRegionCountBefore]
  check('沿格心走的区域也记 mode === center', centerRegion?.mode === 'center', String(centerRegion?.mode))
  check('沿格心走的区域顶点就是三个格心（不补沿边顶点）', centerRegion.pts.length === 3, String(centerRegion.pts.length))

  // 落盘往返：center 写进文件、读回来仍是 center（老数据一个字节不改）
  await store.flush()
  const centerSaved = app.vault.files.get('Maps/World.map.md') ?? ''
  check('沿格心走写进了文件', centerSaved.includes('"mode": "center"') || centerSaved.includes('"mode":"center"'), centerSaved.slice(0, 200))

  // 下面那一节测的是沿网格走，所以这里把模式调回 `edge`（不是 `interior`）
  editor.setGeometryMode('edge')
  check('切回沿网格走（后续沿网格线那一节从这里开始）', editor.geometryMode === 'edge')
  flushFrames()
  // ---- 沿网格线模式：区域 ----
  prompts.length = 0
  clickAt({ x: -400, y: 300 })
  clickAt({ x: 100, y: 300 })
  clickAt({ x: 100, y: 600 })
  clickAt({ x: -400, y: 600 })
  clickAt({ x: -400, y: 600 })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()

  // ⚠️ 前面的沿格心走已经提交了一个区域（index 0）；这里按"最后一个"取，避免索引随新增模式漂移
  const region = layers.getDocument(canvasPath).regions[layers.getDocument(canvasPath).regions.length - 1]
  check('区域已提交', region !== undefined)
  check('区域记录了沿网格线模式', region.mode === 'edge', String(region.mode))
  check(
    '区域的每一段都是格边',
    allEdges(region.pts),
    `段长 ${segmentLengths(region.pts).map((n) => n.toFixed(1)).join(', ')} / 边长 ${grid().size}`,
  )
  // 数据里不重复存起点；隐式闭合的那条边也必须沿网格线
  const regionClose = Math.hypot(region.pts[0][0] - region.pts[region.pts.length - 1][0], region.pts[0][1] - region.pts[region.pts.length - 1][1])
  check('不重复存起点的同时，隐式闭合边也是格边', Math.abs(regionClose - grid().size) < 1e-6, String(regionClose))
  check('顶点数多于点击次数（中间补了沿边顶点）', region.pts.length > 4, String(region.pts.length))

  // ---- 沿网格线模式：区域命中测试仍然有效（点在图内应能删掉）----
  // 必须先回到选择模式：右键删除只在选择模式下生效（绘制模式里右键是"结束草稿"）
  editor.setMode('select')
  const before = layers.getDocument(canvasPath).regions.length
  const regionCenter = { x: -150, y: 450 }
  const hit = (() => {
    const client = canvas._clientFor(regionCenter)
    return firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, button: 2, target: wrapper })
  })()
  flushFrames()
  check(
    '沿网格线的区域仍能被右键命中并删除',
    hit.stopped === true && layers.getDocument(canvasPath).regions.length === before - 1,
    `拦截=${hit.stopped} 区域数 ${before} → ${layers.getDocument(canvasPath).regions.length}`,
  )
  editor.undo()
  check('删除区域可撤销（区域回来且模式还在）', layers.getDocument(canvasPath).regions[layers.getDocument(canvasPath).regions.length - 1]?.mode === 'edge')

  // ---- 沿网格线模式：路径（河流不再平滑，否则等于把格边抹掉）----
  editor.setMode('paint')
  editor.setTool('path')
  editor.setPathType('river')
  clickAt({ x: -300, y: -200 })
  clickAt({ x: 0, y: -200 })
  clickAt({ x: 0, y: 100 })
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()

  const edgePath = layers.getDocument(canvasPath).paths[layers.getDocument(canvasPath).paths.length - 1]
  check('路径记录了沿网格线模式', edgePath.mode === 'edge', String(edgePath.mode))
  check('沿网格线的路径不平滑（平滑会把格边抹成曲线）', edgePath.smooth === undefined, String(edgePath.smooth))
  check('沿网格线的路径每一段都是格边', allEdges(edgePath.pts), `段长 ${segmentLengths(edgePath.pts).map((n) => n.toFixed(1)).join(', ')}`)

  // ---- 草稿预览：光标那一端也要沿网格线走（所见即所得）----
  editor.setTool('region')
  clickAt({ x: -600, y: 200 })
  clickAt({ x: -300, y: 200 })
  const beforeCursor = editor.getDraft().points.length
  moveTo({ x: -100, y: 500 })
  const withCursor = editor.getDraft()
  check('预览里光标那一端沿网格线走（点数变多）', withCursor.points.length > beforeCursor, `${beforeCursor} → ${withCursor.points.length}`)
  check('预览的每一段也都是格边', allEdges(withCursor.points), `段长 ${segmentLengths(withCursor.points).map((n) => n.toFixed(1)).join(', ')}`)
  check('预览不再使用橡皮筋直线（cursor 已并入点序列）', withCursor.cursor === null, String(withCursor.cursor))

  // 换模式会取消草稿：否则会出现"前几个顶点沿网格线、后面沿格心连接"的混合形状
  editor.setGeometryMode('interior')
  check('切换模式会取消进行中的草稿', editor.isDrafting() === false)
  check('模式已切回沿格心连接', editor.geometryMode === 'interior')

  // ---- 沿格心连接模式：对照组（段长不应全部等于边长）----
  const undoBefore = editor.getStatus().undo
  editor.setTool('path')
  clickAt({ x: -300, y: -200 })
  clickAt({ x: -37, y: 41 })
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const freePath = layers.getDocument(canvasPath).paths[layers.getDocument(canvasPath).paths.length - 1]
  check('沿格心连接模式记录在数据里', freePath.mode === 'interior', String(freePath.mode))
  check('沿格心连接模式保留了河流的平滑', freePath.smooth === true, String(freePath.smooth))
  check('沿格心连接模式只有点击的两个顶点', freePath.pts.length === 2, String(freePath.pts.length))
  check('沿格心连接模式产生了一条可撤销历史', editor.getStatus().undo > undoBefore)

  // ---- 自由绘制（ISSUE-005 加进来的模式）：按住拖动采样、抬手一次性提交、没有可拖顶点 ----
  const freeButton = geometryButtons().find((button) => button.textContent === DRAW_MODE_LABELS.free)
  fireEvent(freeButton, 'click')
  check('点击「自由绘制」切到 free 模式', editor.geometryMode === 'free', editor.geometryMode)

  editor.setTool('path')
  editor.setPathType('river')
  flushFrames()
  const freeUndoBefore = editor.getStatus().undo
  const freeStart = canvas._clientFor({ x: 800, y: -800 })
  const freePointer = { pointerId: 21, target: wrapper }
  firePointer(host, 'pointerdown', { ...freePointer, clientX: freeStart.x, clientY: freeStart.y })
  const freeStartDraft = editor.getDraft()
  check('自由绘制的草稿记着它自己的模式（渲染据此不画顶点手柄）', freeStartDraft.mode === 'free', String(freeStartDraft.mode))
  check('自由绘制的起点不吸附（自由绘制没有锚点）', freeStartDraft.points.length === 1, String(freeStartDraft.points.length))
  check('自由绘制的草稿不平滑（轨迹本身就是采样）', freeStartDraft.smooth === false, String(freeStartDraft.smooth))

  // 只挪 1px 的移动不该被采纳（最小间距的作用）；连挪 5 次 20px 才该逐个落点
  firePointer(host, 'pointermove', { ...freePointer, clientX: freeStart.x + 1, clientY: freeStart.y })
  check('比最小间距更近的移动不取点', editor.getDraft().points.length === 1, String(editor.getDraft().points.length))
  const freeMoves = [1, 2, 3, 4, 5].map((n) => ({ clientX: freeStart.x + 20 * n, clientY: freeStart.y + 6 * n }))
  for (const move of freeMoves) firePointer(host, 'pointermove', { ...freePointer, ...move })
  const freeDraft = editor.getDraft()
  check(
    '自由绘制按指针轨迹累积采样点（超过最小间距的每一步都收）',
    freeDraft.points.length === 1 + freeMoves.length,
    String(freeDraft.points.length),
  )
  // 渲染层判据：草稿在画（有 stroke），但**一个顶点手柄都没有**（arc 数 = 0）
  ctx.resetCalls()
  flushFrames()
  check('自由绘制的草稿真的画出来了（不是「没画所以没手柄」）', ctx.calls.stroke >= 1, 'stroke=' + ctx.calls.stroke)
  check('自由绘制的草稿不画可拖顶点手柄', ctx.calls.arc === 0, 'arc=' + ctx.calls.arc)

  firePointer(host, 'pointerup', { ...freePointer, ...freeMoves[freeMoves.length - 1] })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const handPaths = layers.getDocument(canvasPath).paths
  const handPath = handPaths[handPaths.length - 1]
  check('自由绘制抬手即提交，数据里 mode === free', handPath?.mode === 'free', String(handPath?.mode))
  check(
    '自由绘制的路径保留轨迹上的每一个采样点（没有被吸附或补点）',
    handPath.pts.length === 1 + freeMoves.length,
    String(handPath.pts.length),
  )
  check('自由绘制不叠平滑（河流的 smooth 对它不生效）', handPath.smooth === undefined, String(handPath.smooth))
  check('一次自由绘制 = 一条历史', editor.getStatus().undo === freeUndoBefore + 1, freeUndoBefore + ' → ' + editor.getStatus().undo)
  check('提交后草稿已清空', editor.isDrafting() === false)

  // ---- 落盘往返：模式要写进文件并读回来 ----
  await store.flush()
  const saved = app.vault.files.get('Maps/World.map.md') ?? ''
  check('沿网格线模式写进了文件', saved.includes('"mode": "edge"') || saved.includes('"mode":"edge"'), saved.slice(0, 160))
  const reloaded = await store.load(app.vault.getAbstractFileByPath('Maps/World.map.md'))
  check(
    '重新解析后模式仍然保留',
    reloaded.document.paths.some((path) => path.mode === 'edge') && reloaded.document.regions.some((region) => region.mode === 'edge'),
    JSON.stringify(reloaded.document.paths.map((path) => path.mode)),
  )
  check('自由绘制模式也写进了文件', saved.includes('"mode": "free"') || saved.includes('"mode":"free"'), saved.slice(0, 240))
  check('重新解析后 free 仍是 free', reloaded.document.paths.some((path) => path.mode === 'free'), JSON.stringify(reloaded.document.paths.map((path) => path.mode)))
  // 老数据一个字节都不动：mode 是 'interior' 的路径读回来仍是 'interior'，没有被迁移成 free
  check(
    '老数据里的 interior 没有被迁移成 free',
    reloaded.document.paths.some((path) => path.mode === 'interior'),
    JSON.stringify(reloaded.document.paths.map((path) => path.mode)),
  )
  check(
    '每个路径的 mode 都是五个合法取值之一',
    reloaded.document.paths.every((path) => ['edge', 'center', 'edge-step', 'interior', 'free'].includes(path.mode)),
    JSON.stringify(reloaded.document.paths.map((path) => path.mode)),
  )

  // ---- 格步进模式：一次只画一条边 ----
  editor.setMode('paint')
  editor.setTool('region')
  flushFrames()
  const stepButton = geometryButtons().find((button) => button.textContent === DRAW_MODE_LABELS.step)
  check('侧栏「工具」有「格步进」按钮', stepButton !== undefined, geometryButtons().map((b) => b.textContent).join(', '))
  fireEvent(stepButton, 'click')
  check('已切到格步进模式', editor.geometryMode === 'edge-step', editor.geometryMode)

  // 沿着一个方向连续点：每次点击都应正好前进一条边
  const stepStart = { x: 600, y: -600 }
  clickAt(stepStart)
  const draftAfterFirst = editor.getDraft()
  check('格步进模式起点也吸附到顶点', draftAfterFirst.points.length === 1, String(draftAfterFirst.points.length))

  const directions = [
    { x: stepStart.x + 200, y: stepStart.y },
    { x: stepStart.x + 400, y: stepStart.y },
    { x: stepStart.x + 600, y: stepStart.y },
  ]
  for (const target of directions) clickAt(target)
  const stepped = editor.getDraft()
  check('三次点击 = 三个顶点（每次只走一条边）', stepped.points.length === 4, String(stepped.points.length))
  check(
    '格步进走过的每一段都是格边',
    allEdges(stepped.points),
    `段长 ${segmentLengths(stepped.points).map((n) => n.toFixed(1)).join(', ')}`,
  )
  // 预览：只显示"接下来那一条边"
  moveTo({ x: stepStart.x + 900, y: stepStart.y })
  const steppedPreview = editor.getDraft()
  check('格步进预览只多出一条边', steppedPreview.points.length === 5, String(steppedPreview.points.length))
  check('预览的那一条边也是格边', allEdges(steppedPreview.points), `段长 ${segmentLengths(steppedPreview.points).map((n) => n.toFixed(1)).join(', ')}`)

  // 拐弯：往另一个方向点，应当朝那个方向拐（而不是继续直行）
  const beforeTurn = editor.getDraft().points
  const turnTarget = { x: beforeTurn[beforeTurn.length - 1].x, y: beforeTurn[beforeTurn.length - 1].y + 300 }
  clickAt(turnTarget)
  const afterTurn = editor.getDraft().points
  const turnVector = {
    x: afterTurn[afterTurn.length - 1].x - afterTurn[afterTurn.length - 2].x,
    y: afterTurn[afterTurn.length - 1].y - afterTurn[afterTurn.length - 2].y,
  }
  check(
    '往侧面点就会拐弯（不是一路直行）',
    Math.abs(turnVector.y) > Math.abs(turnVector.x),
    `这一步方向 ${turnVector.x.toFixed(1)}, ${turnVector.y.toFixed(1)}`,
  )

  // 结束并提交：区域闭合，每条边（含闭合边）都是格边
  const regionCountBefore = layers.getDocument(canvasPath).regions.length
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const steppedRegion = layers.getDocument(canvasPath).regions[regionCountBefore]
  check('格步进模式画出的区域已提交', steppedRegion !== undefined)
  check('区域记录了格步进模式', steppedRegion.mode === 'edge-step', String(steppedRegion.mode))
  check('格步进区域每一段都是格边', allEdges(steppedRegion.pts), `顶点 ${steppedRegion.pts.length}`)
  const steppedClose = Math.hypot(
    steppedRegion.pts[0][0] - steppedRegion.pts[steppedRegion.pts.length - 1][0],
    steppedRegion.pts[0][1] - steppedRegion.pts[steppedRegion.pts.length - 1][1],
  )
  check('格步进区域的闭合边也是格边', Math.abs(steppedClose - grid().size) < 1e-6, String(steppedClose))
  // 格步进记录的顶点必须与画出来的完全一致（前缀核对）；多出来的只能是**闭合回程**的顶点
  // —— 区域必须闭合，而格步进模式下最后一点通常离起点还很远，那段回程同样沿网格线走。
  const traced = afterTurn.map((point) => ({ x: point.x, y: point.y }))
  const prefixMatches = traced.every((point, index) => {
    const actual = steppedRegion.pts[index]
    return actual !== undefined && Math.abs(actual[0] - point.x) < 1e-6 && Math.abs(actual[1] - point.y) < 1e-6
  })
  check(
    '格步进记录的顶点与描出来的完全一致（不做自动补点）',
    prefixMatches && steppedRegion.pts.length >= traced.length,
    `描了 ${traced.length} 个，区域共 ${steppedRegion.pts.length} 个`,
  )
  check(
    '多出的顶点只来自闭合回程（很少）',
    steppedRegion.pts.length - traced.length <= 6,
    `闭合回程补了 ${steppedRegion.pts.length - traced.length} 个顶点`,
  )

  // ---- 落盘往返（整场汇总）：五种模式的 mode 都要原样回来，老数据一个字节不改 ----
  await store.flush()
  const allSaved = app.vault.files.get('Maps/World.map.md') ?? ''
  const allReloaded = await store.load(app.vault.getAbstractFileByPath('Maps/World.map.md'))
  const reloadedPathModes = allReloaded.document.paths.map((path) => path.mode)
  const reloadedRegionModes = allReloaded.document.regions.map((region) => region.mode)
  check('沿格心走写进了文件', allSaved.includes('"mode": "center"') || allSaved.includes('"mode":"center"'), allSaved.slice(0, 200))
  check(
    '重新解析后 center 仍是 center（没有被回退成 interior）',
    reloadedPathModes.includes('center') && reloadedRegionModes.includes('center'),
    `paths=${JSON.stringify(reloadedPathModes)} regions=${JSON.stringify(reloadedRegionModes)}`,
  )
  check(
    '五种模式都在文件里能原样读回（edge / center / edge-step / interior / free）',
    ['edge', 'center', 'edge-step', 'interior', 'free'].every((mode) => reloadedPathModes.includes(mode) || reloadedRegionModes.includes(mode)),
    `paths=${JSON.stringify(reloadedPathModes)} regions=${JSON.stringify(reloadedRegionModes)}`,
  )

  plugin.onunload()
}

console.log('\n场景 22：地图面板（侧边栏视图）与开发者模式的命令门禁')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const commandById = (id) => plugin.commands.find((command) => command.id === id)
  /** 命令是否"可用"（会被命令面板显示）：checkCallback(false) 的返回值 */
  const commandAvailable = (id) => commandById(id)?.checkCallback?.(true) === true

  // ---- 注册 ----
  check('注册了地图面板视图', plugin.registeredViews.some((view) => view.type === 'fictional-cartographer-panel'), plugin.registeredViews.map((v) => v.type).join(', '))
  check('注册了侧边栏图标（一键打开，不必翻命令面板）', plugin.ribbonIcons.length === 1, String(plugin.ribbonIcons.length))
  check('图标点击会打开面板', typeof plugin.ribbonIcons[0]?.callback === 'function')

  // 点击侧边栏图标 → 面板应被挂到一个叶子上
  plugin.ribbonIcons[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const panelLeaves = app.workspace.getLeavesOfType('fictional-cartographer-panel')
  check('面板已经打开在侧边栏里', panelLeaves.length === 1, String(panelLeaves.length))
  const panel = panelLeaves[0]?.view
  check('面板视图实例可用', panel !== undefined && typeof panel.render === 'function')

  // ---- 面板内容 ----
  // 注意：按钮是「图标 span + 名称 span」两段结构（图标在前），所以名称要从
  // `.fc-panel-button-label` 里取 —— 用 children[0] 会拿到那个空的图标 span。
  const buttons = () => collectByClass(panel.contentEl, 'fc-panel-button')
  const buttonLabels = () => collectByClass(panel.contentEl, 'fc-panel-button-label').map((el) => el.textContent ?? '')
  const buttonByLabel = (fragment) =>
    buttons().find((button) => (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes(fragment))
  const groupTitles = () => collectByClass(panel.contentEl, 'fc-panel-group-title').map((el) => el.textContent ?? '')

  check('面板列出了常用动作', buttons().length >= 6, `${buttons().length} 个按钮`)
  check(
    '常用动作都在面板里（含地图层/编辑/导出）',
    [COMMAND_NAMES.toggleLayer, COMMAND_NAMES.exportSvg, '创建地图 Base 文件（表格视图）'].every((name) =>
      buttonLabels().some((label) => label.includes(name)),
    ),
    buttonLabels().join(' | '),
  )
  check('每个按钮都有悬停提示（描述不再占一行，避免侧栏拥挤）', buttons().every((button) => (button.title ?? '').length > 0), buttons()[0]?.title ?? '')
  check('顶部显示了当前地图状态', (collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent ?? '').length > 0)

  // ---- 「打开地图面板」不进面板（UI 整理 W1b · 施工文件 §2.5-1）----
  // 面板里点它时面板本来就开着，`activatePanel()` 的两条路都不产生可见变化 ⇒ 那个按钮天然无意义。
  check(
    '面板里**没有**「打开地图面板」（在面板里点它必然没反应）',
    buttonLabels().every((label) => !label.includes(COMMAND_NAMES.openPanel)),
    buttonLabels().join(' | '),
  )
  check(
    '但它仍在命令面板里注册着（命令与 ribbon 是那两处唯一有意义的入口）',
    commandById('open-map-panel') !== undefined,
    String(commandById('open-map-panel')?.name),
  )

  // 未启用地图层的动作应被禁用（而不是点了报错）
  check('依赖地图层的动作在未启用时被禁用', buttonByLabel(COMMAND_NAMES.exportSvg)?.disabled === true, String(buttonByLabel(COMMAND_NAMES.exportSvg)?.disabled))

  // ---- 开发者模式：默认关闭 ----
  check('默认关闭开发者模式', plugin.getSettings().developerMode === false, String(plugin.getSettings().developerMode))
  check('开发用命令默认不出现在命令面板里', commandById('diagnose-canvas') !== undefined && commandAvailable('diagnose-canvas') === false)
  check('监视视口的命令同样被隐藏', commandAvailable('toggle-viewport-watch') === false)
  check(
    '面板里也没有「开发工具」一组',
    buttonLabels().every((label) => !label.includes('诊断当前 Canvas')) && !groupTitles().some((title) => title.includes(SETTINGS_LABELS.developerMode)),
    buttonLabels().join(' | '),
  )
  // 正常命令不受影响
  check('普通命令仍然可用', commandAvailable('toggle-map-layer') === true && commandAvailable('map-status') === true)

  // ---- 打开开发者模式 ----
  await plugin.setDeveloperMode(true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  plugin.refreshPanel()
  // 面板重绘走 rAF 合并（避免"切视图就重建 DOM"的卡顿），这里要让出一帧
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('打开后开发用命令可用', commandAvailable('diagnose-canvas') === true && commandAvailable('toggle-viewport-watch') === true)
  check(
    '面板里出现开发工具一组',
    buttonLabels().some((label) => label.includes('诊断当前 Canvas')),
    buttonLabels().join(' | '),
  )
  check('分组标题注明了"仅开发者模式"', groupTitles().some((title) => title.includes(SETTINGS_LABELS.developerMode)), groupTitles().join(' | '))
  check('开关已落盘', String(plugin._data ?? '').includes('"developerMode":true'), String(plugin._data))

  // 关回去
  await plugin.setDeveloperMode(false)
  plugin.refreshPanel()
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('关掉后开发用命令又隐藏', commandAvailable('diagnose-canvas') === false)
  check('面板里也不再显示', buttonLabels().every((label) => !label.includes('诊断当前 Canvas')), buttonLabels().join(' | '))

  // ---- 点面板按钮 = 执行命令 ----
  clearNotices()
  const layerButton = () => buttonByLabel(COMMAND_NAMES.toggleLayer)
  check('地图层按钮可用', layerButton()?.disabled === false, String(layerButton()?.disabled))
  fireEvent(layerButton(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 80))
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('点面板按钮真的启用了地图层', layers.listStatus().some((status) => status.attached), JSON.stringify(layers.listStatus().map((s) => s.attached)))
  check('面板状态行随之更新', (collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent ?? '').includes('Maps/World.map.md'), collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent)
  check('启用后导出按钮变成可用', buttonByLabel(COMMAND_NAMES.exportSvg)?.disabled === false, String(buttonByLabel(COMMAND_NAMES.exportSvg)?.disabled))

  // ---- 重绘策略：状态没变就不重建 DOM（这是"卡"的主要对策）----
  // 先把还在排队的重绘跑完：动作 settle 之后面板会自己请求一次重绘，
  // 若此时就断言"节点没变"会误报（这是测试时序，不是实现问题）。
  const settle = async () => {
    flushFrames()
    await new Promise((resolve) => setTimeout(resolve, 25))
    flushFrames()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await settle()
  /** 按面板的实现方式重建一次状态签名（用来定位"到底哪一项在变"） */
  const signatureOf = () =>
    plugin
      .getPanelActions()
      .map((action) => `${action.id}:${action.available ? action.available() : true}:${action.describe?.() ?? ''}`)
      .join('|')
  const firstSignature = signatureOf()
  const secondSignature = signatureOf()
  check(
    '连续两次求值得到相同的状态签名（否则面板每次都会重建）',
    firstSignature === secondSignature,
    firstSignature === secondSignature ? '' : `第一次：${firstSignature}\n第二次：${secondSignature}`,
  )
  const firstButton = buttons()[0]
  const rendersBefore = collectByClass(panel.contentEl, 'fc-panel-button').length
  // 面板把「顶部状态 + 每个动作」压成签名；失败时把两份签名打出来，
  // 一眼就能看出是"哪一项在变"（否则只能猜）
  const signatureBefore = panel.lastSignature
  panel.render()
  const signatureAfter = panel.lastSignature
  const afterRepeat = collectByClass(panel.contentEl, 'fc-panel-button')
  const brief = (el) => (el === undefined ? 'undefined' : el === null ? 'null' : `${el.tagName}#${el.className}`)
  check(
    '状态未变时重复 render 不重建 DOM（按钮还是同一个节点）',
    afterRepeat[0] === firstButton && rendersBefore === afterRepeat.length,
    `同一节点=${afterRepeat[0] === firstButton} 数量 ${rendersBefore} → ${afterRepeat.length}` +
      `｜前节点=${brief(firstButton)} 后节点=${brief(afterRepeat[0])}` +
      `｜可见=${String(panel.isVisible())} 子元素=${panel.contentEl.childElementCount}` +
      `｜签名前=${signatureBefore === null ? 'null' : '有'} 后=${signatureAfter === null ? 'null' : '有'}`,
  )
  panel.render(true)
  check('force 时才会强制重建', collectByClass(panel.contentEl, 'fc-panel-button')[0] !== firstButton)

  plugin.onunload()
}

console.log('\n场景 23：样式设置（路径/区域颜色、名称字体）与"只影响新对象"的边界')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  /** 画一条路径（起点/终点给世界坐标），跳过命名 */
  const drawPath = (x0, y0) => {
    editor.setMode('paint')
    editor.setTool('path')
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x0 + 300, y: y0 + 120 })
    clickAt({ x: x0 + 300, y: y0 + 120 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('')
    flushFrames()
    return doc().paths[doc().paths.length - 1]
  }
  /** 画一个区域（跳过命名） */
  const drawRegion = (x0, y0) => {
    editor.setMode('paint')
    editor.setTool('region')
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x0 + 400, y: y0 })
    clickAt({ x: x0 + 400, y: y0 + 300 })
    clickAt({ x: x0 + 400, y: y0 + 300 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('')
    flushFrames()
    return doc().regions[doc().regions.length - 1]
  }
  /** 设置页里按名字找控件 */
  const openSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    return FakeSetting.created
  }
  /**
   * 「地图定义」弹窗里按名字找控件。
   *
   * W4-1b（定义随图）之后，**路径 / 区域类型的参数**从设置页搬到了这个弹窗里：
   * 它们现在是"这张地图的那一套"，所以与定义住在一起。
   */
  const openDefs = () => {
    FakeSetting.created.length = 0
    openDefinitionManager(plugin)
    return FakeSetting.created
  }
  const pickerNamed = (fragment) =>
    FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.colorPicker
  const textNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.text
  const buttonNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.button

  // ---- 先画一条路径，用来验证"改设置不会动已有对象" ----
  const beforePath = drawPath(-500, -200)
  const defaultRiver = '#4a9fd8'

  // ---- 定义弹窗：每种类型的参数一条"外观"行 + 一条"尺寸"行 ----
  // ⑤-1 起"路径颜色"那种一行一个色块的做法换成**每种类型两条参数行**；
  // W4-1b 起它们住在「地图定义」弹窗里（内置 4 种 / 6 种也可以改）。
  openDefs()
  const defSettingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  const riverPicker = pickerNamed('河流')
  // ⑤-2 起区域也是"每种类型两条参数行"：第一行"填充与边框 · <名字>"，第二行"边框宽与虚线 · <名字>"
  const regionPicker = pickerNamed('公国')
  check(
    '「地图定义」弹窗有每种路径类型的参数行（含颜色选择器）',
    pickerNamed('河流') !== undefined && pickerNamed('边界') !== undefined && pickerNamed('贸易路线') !== undefined ? true : false,
  )
  check('「地图定义」弹窗有每种区域类型的参数行（含颜色选择器）', pickerNamed('王国') !== undefined && pickerNamed('海域') !== undefined)
  check(
    '区域类型的第二行是「边框宽与虚线 · <名字>」（与路径类型的「线宽与虚线」同构）',
    defSettingNamed(DEFINITION_ROW_LABELS.borderWidthDash('公国')) !== undefined &&
      (defSettingNamed(DEFINITION_ROW_LABELS.borderWidthDash('公国'))?.texts ?? []).length === 2,
    JSON.stringify((defSettingNamed(DEFINITION_ROW_LABELS.borderWidthDash('公国'))?.texts ?? []).map((text) => text.placeholder)),
  )
  check('选择器带出当前值（出厂默认）', riverPicker?.value === defaultRiver, String(riverPicker?.value))
  check(
    '每种路径类型都有端点与连接两个下拉（都要带出当前值）',
    (defSettingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns ?? []).map((dropdown) => dropdown.value).join(',') === 'round,round',
    JSON.stringify((defSettingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns ?? []).map((dropdown) => dropdown.value)),
  )

  // ---- 设置页只剩名称字体（路径 / 区域类型的参数已经搬走）----
  openSettings()
  const fontText = textNamed(SETTINGS_LABELS.labelFont)
  check('设置页有名称字体输入框', fontText !== undefined && fontText.placeholder === SETTINGS_LABELS.labelFontPlaceholder, String(fontText?.placeholder))
  check('字体族默认为空（= 跟随主题）', fontText?.value === '', JSON.stringify(fontText?.value))
  check(
    '设置页不再有路径 / 区域类型的参数行（一个控件只有一个家）',
    pickerNamed('河流') === undefined && pickerNamed('公国') === undefined,
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name).filter((name) => /河流|公国|边框/.test(String(name)))),
  )

  // ---- 改路径颜色：只影响**之后**新画的对象 ----
  await riverPicker.pick('#ff0000')
  check('路径颜色写进了路径类型目录', plugin.getSettings().pathTypes.find((entry) => entry.id === 'river')?.params.color === '#ff0000', JSON.stringify(plugin.getSettings().pathTypes.map((entry) => [entry.id, entry.params.color])))
  check(
    '旧字段 pathColors 与目录保持一致（回退到旧版插件仍看到自己改过的颜色）',
    plugin.getSettings().pathColors.river === '#ff0000',
    JSON.stringify(plugin.getSettings().pathColors),
  )
  const persisted = () => (plugin._data === null ? null : JSON.parse(plugin._data))
  check(
    '路径颜色已落盘（真实 JSON 往返，不是只存在内存里）',
    persisted()?.pathTypes?.find((entry) => entry.id === 'river')?.params?.color === '#ff0000',
    JSON.stringify(persisted()?.pathTypes),
  )
  const afterPath = drawPath(-500, 300)
  check('新画的路径用了新颜色', afterPath.color === '#ff0000', String(afterPath.color))
  check(
    '已经画好的路径不受设置影响（颜色存在地图文件里）',
    doc().paths[0].color === beforePath.color && doc().paths[0].color === defaultRiver,
    `第一条 ${doc().paths[0].color} · 第二条 ${afterPath.color}`,
  )

  // ---- 侧栏「工具」里的路径类型：色块跟着设置走 ----
  // （自绘下拉 `ToolbarDropdown` 随这次搬家退休：侧栏用原生 `<select>` +
  //   当前类型的色块，"我选的是哪一种"这个信息一条没少）
  const panel = await openMapPanel(app, plugin)
  editor.setMode('paint')
  editor.setTool('path')
  flushFrames()
  const pathTypeSelect = () => inPanel(panel, 'fc-panel-type-select').find((el) => el.dataset.fcPathType === '1')
  const pathSwatch = () => inPanel(panel, 'fc-panel-type-swatch').find((el) => el.dataset.fcPathSwatch === '1')
  check('侧栏路径类型下拉带出当前类型', pathTypeSelect()?.value === 'river', String(pathTypeSelect()?.value))
  check(
    '侧栏里当前路径类型的色块已变成新颜色',
    pathSwatch()?.style.backgroundColor === '#ff0000',
    String(pathSwatch()?.style.backgroundColor),
  )

  // ---- 区域类型：改颜色 → 只影响**之后**新画的区域 ----
  await regionPicker.pick('#123456')
  check(
    '区域颜色写进了区域类型目录',
    plugin.getSettings().regionTypes.find((entry) => entry.id === 'duchy')?.params.color === '#123456',
    JSON.stringify(plugin.getSettings().regionTypes.map((entry) => [entry.id, entry.params.color])),
  )
  check(
    '旧字段 regionColors 与目录保持一致（回退到旧版插件仍看到自己改过的颜色）',
    plugin.getSettings().regionColors[2] === '#123456',
    JSON.stringify(plugin.getSettings().regionColors),
  )
  editor.setRegionPresetIndex(2)
  check(
    '按下标选区域类型时取到的是目录里的颜色',
    editor.regionType === 'duchy' && editor.regionColor === '#123456',
    `${editor.regionType} / ${editor.regionColor}`,
  )
  const region = drawRegion(-500, 700)
  check('新画的区域用了新颜色', region.color === '#123456', String(region.color))
  check('新画的区域记下了类型 ID', region.type === 'duchy', String(region.type))
  check('区域不透明度仍是出厂默认（颜色设置不该改别的字段）', region.opacity === 0.22, String(region.opacity))

  // ---- 名称字体：必须真的出现在 ctx.font 里，且不能带 var() ----
  await fontText.type('Noto Serif SC, serif')
  const run = (() => {
    editor.setMode('paint')
    editor.setTool('region')
    clickAt({ x: -600, y: -600 })
    clickAt({ x: -200, y: -600 })
    clickAt({ x: -200, y: -300 })
    clickAt({ x: -200, y: -300 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('字体样本')
    flushFrames()
    return drawnRuns(frame()).find((item) => item.text === '字体样本')
  })()
  check('名称真的用上了设置的字体族', typeof run?.font === 'string' && run.font.includes('Noto Serif SC'), String(run?.font))
  check('字体串里没有 var()（否则整条声明会被静默忽略）', typeof run?.font === 'string' && !run.font.includes('var('), String(run?.font))
  check('字号仍然只有一个 px（没被拼成两条简写）', (String(run?.font).match(/\d+px/g) ?? []).length === 1, String(run?.font))

  // ---- 非法输入必须被挡在绘制层之外 ----
  await fontText.type('600 24px sans-serif')
  check('整条 font 简写被拒绝（会被收敛成空 = 跟随主题）', plugin.getSettings().labelFontFamily === '', JSON.stringify(plugin.getSettings().labelFontFamily))
  const fallbackRun = (() => {
    editor.setMode('paint')
    editor.setTool('region')
    clickAt({ x: 600, y: -600 })
    clickAt({ x: 1000, y: -600 })
    clickAt({ x: 1000, y: -300 })
    clickAt({ x: 1000, y: -300 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('回退样本')
    flushFrames()
    return drawnRuns(frame()).find((item) => item.text === '回退样本')
  })()
  check(
    '非法字体没有漏进 ctx.font',
    typeof fallbackRun?.font === 'string' && !fallbackRun.font.includes('600 24px'),
    String(fallbackRun?.font),
  )

  // 注意：颜色选择器的 onChange 不重新渲染设置页，所以上面拿到的控件还都是活的
  await riverPicker.pick('var(--text-normal)')
  check(
    '非法颜色被挡下并回退到出厂色（canvas 会静默忽略非法色）',
    plugin.getSettings().pathColors.river === defaultRiver,
    String(plugin.getSettings().pathColors.river),
  )

  // ---- 恢复默认参数（现在住在「地图定义」弹窗里，与参数控件同一个家）----
  // 先把字体设成一个合法值：下面要验证"恢复参数"**不动**字体族（字体是"怎么看"，留在设置页）
  await fontText.type('Noto Serif SC, serif')
  openDefs()
  await buttonNamed('路径与区域类型参数恢复出厂').click()
  const restored = plugin.getSettings()
  check(
    '「恢复默认参数」把路径类型与区域类型的参数都还原',
    restored.pathTypes.find((entry) => entry.id === 'river')?.params.color === defaultRiver &&
      restored.regionTypes.find((entry) => entry.id === 'duchy')?.params.color === '#a882ff',
    JSON.stringify({
      river: restored.pathTypes.find((entry) => entry.id === 'river')?.params.color,
      duchy: restored.regionTypes.find((entry) => entry.id === 'duchy')?.params.color,
    }),
  )
  check(
    '「恢复默认参数」不动名称字体（字体不随图，仍留在设置页）',
    restored.labelFontFamily === 'Noto Serif SC, serif',
    JSON.stringify(restored.labelFontFamily),
  )
  check(
    '旧字段 regionColors 也跟着目录还原了',
    restored.regionColors[2] === '#a882ff',
    JSON.stringify(restored.regionColors),
  )
  check('旧字段 pathColors 也跟着目录还原了', restored.pathColors.river === defaultRiver, String(restored.pathColors.river))
  check('未改动的键没有被写进设置（normalize 会过滤未知键）', !('extra' in restored.pathColors))

  plugin.onunload()
}

console.log('\n场景 24：自定义地形（设置定义 → 工具条 → 画布 → 文件 → 回退路径）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  // 一张真实存在的图片 + 一张不存在的图片 + 一张存在但解不开的"坏图"：三条路径都要走到
  app.vault.files.set('Assets/marsh.png', '<png-bytes>')
  loadableImageUrls.add(resourceUrlFor('Assets/marsh.png'))
  // 注意：故意用 files.set 而不是 setContent —— 后者会登记资源地址（= 能加载成功），
  // 而这里要的正是"文件在库里、但浏览器解不开"这条分支
  app.vault.files.set('Assets/broken.png', 'this-is-not-an-image')
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    onSubmit('')
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  // 定义管理（A3）从设置页搬到了「地图定义」弹窗：控件由弹窗建，断言因此改成对着弹窗取。
  // 每次 openSettings() 都会**新开一个弹窗**（新的 contentEl），旧对象随即过期 ——
  // 与设置页整页重建是同一回事，调用方在动作之后都要重新拿一次控件。
  let defModal = null
  const openSettings = () => {
    FakeSetting.created.length = 0
    defModal = openDefinitionManager(plugin)
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 弹窗里那一行"就地提示"（按 `dataset.fcNote` 取 —— 四节各一条） */
  const noteText = () =>
    collectByClass(defModal.contentEl, 'fc-settings-note').find((el) => el.dataset?.fcNote === 'terrain')
      ?.textContent ?? ''
  /** 画一笔地形（世界坐标） */
  const paintAt = (x, y) => {
    editor.setMode('paint')
    editor.setTool('brush')
    clickAt({ x, y })
    flushFrames()
  }
  /**
   * 把某条自定义地形切到指定模式。
   *
   * 模式控件是"地形 N · 显示名"那一行右侧的两个按钮（`dataset.mode`）。
   * 换了模式之后弹窗会整块重绘，所以这里切完再 `openSettings()` 一次，
   * 调用方拿到的才是新控件（旧对象是过期的 —— 这个坑本项目已经踩过）。
   */
  const switchMode = async (label, mode) => {
    openSettings()
    const container = defModal.contentEl
    const row = collectByClass(container, 'fc-terrain-mode').find((candidate) =>
      (collectByClass(candidate, 'fc-terrain-mode-title')[0]?.textContent ?? '').includes(label),
    )
    const button = collectByClass(row ?? container, 'fc-terrain-mode-button').find((candidate) => candidate.dataset.mode === mode)
    // 用 fireEvent 而不是 element.click()：假 DOM 的元素本身没有 click()，
    // 只有假 Setting 的控件对象才有（那是桩提供的便利方法）
    if (button !== undefined) fireEvent(button, 'click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    openSettings()
  }

  // ---------------------------------------------------------- 弹窗：新增
  openSettings()
  const addSetting = settingNamed(DEFINITION_MODAL_LABELS.addTerrain)
  check('「地图定义」弹窗里有「新增自定义地形」一节（A3：它已经从设置页搬走了）', addSetting !== undefined)
  check(
    '新增区有 ID、显示名、颜色三个控件（ID 与显示名必须分开，否则又会被耦合在一起）',
    (addSetting?.texts?.length ?? 0) === 2 && addSetting?.colorPicker !== undefined,
    `texts=${addSetting?.texts?.length} picker=${String(addSetting?.colorPicker !== undefined)}`,
  )
  check(
    '手填 ID 的规则搬进了输入框的悬停提示（不再占「新增」那一大段说明）',
    (addSetting?.texts?.[0]?.inputEl?.title ?? '').includes('custom:'),
    String(addSetting?.texts?.[0]?.inputEl?.title),
  )

  // 非法 ID：必须当场给出可读原因，且**不能**写进设置
  await addSetting.texts[0].type('Bad Id!')
  check('非法 ID 就地给出可读原因', noteText().includes('ID'), noteText())
  check(
    '提示里除了"为什么错"，还写明"接下来怎么办"（用户实测：输错也不知道怎么改）',
    noteText().includes('还没写进设置') && noteText().includes('改好上面那一栏'),
    noteText(),
  )
  check(
    '正确写法的**例子**由输入框占位提示承担（提示行与占位提示各说一件事）',
    (addSetting.texts[0].placeholder ?? '').includes('例如') && (addSetting.texts[0].placeholder ?? '').includes('留空'),
    String(addSetting.texts[0].placeholder),
  )
  await addSetting.button.click()
  check('非法 ID 点「新增」不会写进设置', plugin.getSettings().customTerrains.length === 0, JSON.stringify(plugin.getSettings().customTerrains))
  check(
    '失败之后已经填好的内容还在（不用重打，改好那一栏再点新增即可）',
    addSetting.texts[0].value === 'Bad Id!',
    String(addSetting.texts[0].value),
  )

  // 合法 ID：新增成功，ID 收敛成 custom: 前缀
  await addSetting.texts[0].type('Marsh')
  await addSetting.texts[1].type('沼泽地')
  await addSetting.colorPicker.pick('#336655')
  await addSetting.button.click()
  const added = plugin.getSettings().customTerrains
  check(
    '新增的自定义地形 ID 收敛为 custom:marsh（小写 + 自动前缀）',
    added.length === 1 && added[0].id === 'custom:marsh',
    JSON.stringify(added),
  )
  check('显示名与 ID 分离存储', added[0]?.label === '沼泽地' && added[0]?.color === '#336655', JSON.stringify(added[0]))
  check(
    '自定义地形已落盘（真实 JSON 往返）',
    JSON.parse(plugin._data ?? '{}')?.customTerrains?.[0]?.id === 'custom:marsh',
    String(plugin._data).slice(0, 160),
  )

  // 重复 ID 必须被拒绝（同一个 ID 两条定义会让"画上去是哪个颜色"说不清）
  openSettings()
  const addDup = settingNamed(DEFINITION_MODAL_LABELS.addTerrain)
  await addDup.texts[0].type('MARSH')
  await addDup.button.click()
  check('重复 ID（大小写不同）被拒绝', plugin.getSettings().customTerrains.length === 1, JSON.stringify(plugin.getSettings().customTerrains))

  // 再建两个：一个带存在的图片，一个带不存在的图片
  openSettings()
  const addReef = settingNamed(DEFINITION_MODAL_LABELS.addTerrain)
  await addReef.texts[0].type('reef')
  await addReef.texts[1].type('礁石')
  await addReef.button.click()
  openSettings()
  const addGhost = settingNamed(DEFINITION_MODAL_LABELS.addTerrain)
  await addGhost.texts[0].type('ghost')
  await addGhost.texts[1].type('幽灵地')
  await addGhost.button.click()
  openSettings()
  const addBroken = settingNamed(DEFINITION_MODAL_LABELS.addTerrain)
  await addBroken.texts[0].type('broken')
  await addBroken.texts[1].type('破碎地')
  await addBroken.button.click()
  check(
    '四个自定义地形都在设置里',
    plugin.getSettings().customTerrains.length === 4,
    JSON.stringify(plugin.getSettings().customTerrains.map((terrain) => terrain.id)),
  )

  // 图片路径：合法 → 存盘（反斜杠归一化）；非法 → 就地报错且不写盘
  // 注意：要先切到「图片」模式 —— 调色模式下图片那一栏**根本不存在**（这是设计要求：
  // 当前模式下不可能填错的东西就该不出现）。
  await switchMode('礁石', 'image')
  await switchMode('幽灵地', 'image')
  await switchMode('破碎地', 'image')
  openSettings()
  const reefRow = settingNamed(DEFINITION_ROW_LABELS.image('礁石'))
  await reefRow.texts[0].type('Assets\\marsh.png')
  check(
    '图片路径写进设置（Windows 反斜杠被统一为正斜杠）',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png',
    JSON.stringify(plugin.getSettings().customTerrains[1]),
  )
  openSettings()
  const ghostRow = settingNamed(DEFINITION_ROW_LABELS.image('幽灵地'))
  await ghostRow.texts[0].type('Assets/does-not-exist.png')
  check(
    '指向不存在文件的路径**合法**（存不存在只有加载器知道），照样写进设置 —— 回退由绘制层负责',
    plugin.getSettings().customTerrains[2]?.imagePath === 'Assets/does-not-exist.png',
    JSON.stringify(plugin.getSettings().customTerrains[2]),
  )
  openSettings()
  const brokenRow = settingNamed(DEFINITION_ROW_LABELS.image('破碎地'))
  await brokenRow.texts[0].type('Assets/broken.png')
  check(
    '存在但解不开的图片路径也照样写进设置（解不开是运行期的事）',
    plugin.getSettings().customTerrains[3]?.imagePath === 'Assets/broken.png',
    JSON.stringify(plugin.getSettings().customTerrains[3]),
  )
  openSettings()
  const reefRow2 = settingNamed(DEFINITION_ROW_LABELS.image('礁石'))
  await reefRow2.texts[0].type('http://example.com/a.png')
  check(
    '非法图片路径被拒绝并就地给出原因',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png' && noteText().includes('网址'),
    `路径=${plugin.getSettings().customTerrains[1]?.imagePath} 提示=${noteText()}`,
  )
  check(
    '字形下拉框列出「通用」+ 内置 9 种（借字形是个可选项，不是隐藏功能）',
    (settingNamed(DEFINITION_ROW_LABELS.glyph('沼泽地'))?.dropdown?.options?.length ?? 0) === 10,
    JSON.stringify(settingNamed(DEFINITION_ROW_LABELS.glyph('沼泽地'))?.dropdown?.options?.map((option) => option.value)),
  )

  // ---------------------------------------------------------- 侧栏「笔刷」里的地形调色板
  // §F.2：地形选择属于**笔刷**（它就是"刷什么"），从浮窗搬进侧栏，且只出现这一处。
  const panel = await openMapPanel(app, plugin)
  const terrainButtons = () => inPanel(panel, 'fc-panel-terrain')
  /** 地形按钮的可见文字：结构是「色块 span + 名称 span」 */
  const terrainLabels = () => terrainButtons().map((button) => button.children[1]?.textContent ?? button.textContent ?? '')
  editor.setMode('paint')
  editor.setTool('brush')
  flushFrames()
  check('侧栏「笔刷」出现内置 9 种 + 4 个自定义地形', terrainButtons().length === 13, terrainLabels().join(','))
  const labels = terrainLabels()
  check(
    '自定义地形排在内置之后，且顺序与设置一致',
    labels.slice(9).join(',') === '沼泽地,礁石,幽灵地,破碎地',
    labels.join(','),
  )
  check(
    '内置 9 种的中文名与顺序完全没变（这个功能不许动它们）',
    // 这是**出厂顺序的快照**（与 TERRAIN_TYPES 一致）。写死在这里是有意的：
    // 内置顺序就是数字键 1–9 的位置，改动它必须是有意识的行为 —— 改这条断言即为确认。
    labels.slice(0, 9).join(',') === '山脉,森林,水域,沙漠,平原,沼泽,丘陵,冻原,火山',
    labels.slice(0, 9).join(','),
  )
  check(
    '自定义地形没有混进内置那一段（顺序错位会让数字键选到别的地形）',
    labels.slice(9).every((label) => ['沼泽地', '礁石', '幽灵地', '破碎地'].includes(label)),
    labels.join(','),
  )
  check(
    '自定义地形的按钮带自己的颜色（不是内置色）',
    collectByClass(terrainButtons()[9], 'fc-ctl-swatch')[0]?.style.backgroundColor === '#336655',
    String(collectByClass(terrainButtons()[9], 'fc-ctl-swatch')[0]?.style.backgroundColor),
  )
  check(
    '自定义地形的悬停提示里带着完整 ID（界面上要能分清哪个是哪个）',
    (terrainButtons()[9]?.title ?? '').includes('custom:marsh'),
    terrainButtons()[9]?.title,
  )

  // 点侧栏里的自定义地形 → 编辑器切过去 → 画上去 → 文件里是自定义 ID
  fireEvent(terrainButtons()[9], 'click')
  check('点自定义地形按钮后编辑器切到该 ID', editor.getStatus().terrainType === 'custom:marsh', editor.getStatus().terrainType)
  paintAt(-400, -200)
  const paintedKeys = Object.keys(doc().terrain)
  check('自定义地形被画上了画布（有格子）', paintedKeys.length > 0, JSON.stringify(doc().terrain))
  check(
    '文件里存的是自定义 ID 本身',
    paintedKeys.every((key) => doc().terrain[key].t === 'custom:marsh'),
    JSON.stringify(doc().terrain[paintedKeys[0]]),
  )

  // 内置地形不受影响：切回内置照样画内置 ID
  editor.setTerrainType('forest')
  paintAt(600, 600)
  const forestKeys = Object.keys(doc().terrain).filter((key) => doc().terrain[key].t === 'forest')
  check('内置地形仍然照旧（画出来就是内置 ID）', forestKeys.length > 0, JSON.stringify(Object.values(doc().terrain).map((cell) => cell.t)))

  // 等待防抖落盘 → 重新解析文件 → 自定义 ID 仍然认得出
  await new Promise((resolve) => setTimeout(resolve, 500))
  const reloaded = await store.load(app.vault.getAbstractFileByPath('Maps/World.map.md'))
  check(
    '重新解析后仍然认得自定义 ID（内置 9 种曾经是白名单，自定义必须也过得去）',
    reloaded.document !== null && Object.values(reloaded.document.terrain).some((cell) => cell.t === 'custom:marsh'),
    JSON.stringify(Object.values(reloaded.document?.terrain ?? {}).slice(0, 3)),
  )
  check(
    '自定义 ID 不会产生任何告警（它不是"未知地形"）',
    reloaded.issues.filter((issue) => issue.level === 'warning').length === 0,
    JSON.stringify(reloaded.issues),
  )

  // ---------------------------------------------------------- 画布绘制：图片 vs 回退
  frame()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  /** 贴了图片的那张离屏图集（图集不对外暴露，只能按"它画过这张图"来找） */
  const atlas = createdCanvasContexts.filter((candidate) => candidate.images.some((entry) => entry.source?.__isFakeImage)).at(-1)
  check(
    '图片存在时图集里真的贴了这张图（drawImage 的 source 就是加载到的那幅图）',
    atlas !== undefined,
    `创建过的画布上下文数=${createdCanvasContexts.length}`,
  )
  check(
    '同一张图集里：有图片的格子铺了底色，缺图片的格子回退到颜色 + 字形',
    atlas !== undefined &&
      atlas.fills.some((fill) => fill.fillStyle === '#336655') &&
      atlas.fills.some((fill) => fill.fillStyle === '#8fa3b0') &&
      atlas.calls.arc >= 3,
    atlas ? `填充色=${JSON.stringify([...new Set(atlas.fills.map((fill) => fill.fillStyle))])} arc=${atlas.calls.arc}` : '',
  )
  /** 当时加载成功的那张图（换图之后它必须从图集里消失） */
  const firstLoadedImage = atlas ? [...atlas.images].reverse().find((entry) => entry.source?.__isFakeImage)?.source : undefined
  const missingWarnings = warnLog.filter((line) => line.includes('does-not-exist.png'))
  check(
    '图片缺失时给出可读原因（文件不存在）',
    missingWarnings.some((line) => line.includes('不存在')),
    JSON.stringify(missingWarnings.slice(0, 2)),
  )
  const brokenWarnings = warnLog.filter((line) => line.includes('broken.png'))
  check(
    '图片存在但解不开时也给出可读原因（走的是 onerror 这条分支，与"文件不存在"不同）',
    brokenWarnings.some((line) => line.includes('解码失败')),
    JSON.stringify(brokenWarnings.slice(0, 2)),
  )

  // ---- 换图：把 custom:reef 的图片换成另一张，画布上必须变成新的那张 ----
  // （缓存按"地形 ID"存的话，这里会一直画旧图 —— 用户要重开画布才更新）
  app.vault.files.set('Assets/reef2.png', '<png-bytes-2>')
  loadableImageUrls.add(resourceUrlFor('Assets/reef2.png'))
  openSettings()
  await settingNamed(DEFINITION_ROW_LABELS.image('礁石')).texts[0].type('Assets/reef2.png')
  check(
    '设置里换成了新路径',
    plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:reef')?.imagePath === 'Assets/reef2.png',
    JSON.stringify(plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:reef')),
  )
  frame()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  const newestImage = FakeImage.instances.at(-1)
  const latestAtlas = createdCanvasContexts.filter((candidate) => candidate.images.some((entry) => entry.source?.__isFakeImage)).at(-1)
  check(
    '换成另一张图后，图集里画的是新的那张（缓存按路径而不是按地形 ID）',
    latestAtlas !== undefined && latestAtlas.images.some((entry) => entry.source === newestImage),
    latestAtlas ? `图集里 ${latestAtlas.images.length} 次 drawImage（含图片=${latestAtlas.images.filter((entry) => entry.source?.__isFakeImage).length}）` : '没有图集',
  )
  check(
    '旧的那张图已经完全不再出现（这条断言在"按地形 ID 缓存"的旧写法上会失败）',
    firstLoadedImage !== undefined && latestAtlas !== undefined && latestAtlas.images.every((entry) => entry.source !== firstLoadedImage),
    `旧图=${String(firstLoadedImage?.src)} 仍在图集里=${latestAtlas?.images.some((entry) => entry.source === firstLoadedImage)}`,
  )

  // ---------------------------------------------------------- 未知 ID：必须仍然画出来
  // 把一格已经画好的地形改成设置里没有的 ID：它必须照样被绘制（回退视觉），
  // 而不是在画布上留一个洞 —— 图集是按 ID 取精灵的，漏进签名就会静默消失。
  const warnBefore = warnLog.length
  // 用**森林**那一格改成未知 ID（不是沼泽那一格 —— 后面还要用它验证"删定义不影响数据"）
  const unknownKey = forestKeys[0]
  doc().terrain[unknownKey] = { t: 'custom:never-defined' }
  const before = Object.keys(doc().terrain).length
  const redrawn = frame()
  check(
    '设置里没有的 ID 仍然被画出来（可见格数 = 绘制调用数，没有洞）',
    redrawn.calls.drawImage === before,
    `文档格数=${before} 本帧 drawImage=${redrawn.calls.drawImage}`,
  )
  const unknownWarnings = warnLog.slice(warnBefore).filter((line) => line.includes('未知地形'))
  check('未知 ID 给出一条可读告警', unknownWarnings.length >= 1 && unknownWarnings.length <= 3, JSON.stringify(unknownWarnings))
  frame()
  check(
    '第二次重绘不再重复告警（每帧都会遍历所有格，不能刷屏）',
    warnLog.slice(warnBefore).filter((line) => line.includes('未知地形')).length === unknownWarnings.length,
    String(warnLog.length - warnBefore),
  )
  check('未知 ID 的格子仍然留在文档里（不因为不认识就被丢掉）', doc().terrain[unknownKey]?.t === 'custom:never-defined')

  // ---------------------------------------------------------- 旧文件：完全外来的 t
  // 内存里改一格只能证明绘制层；这里走**文件级**：一份旧地图/别人库里的地图，
  // 里面有两种本机设置里都没有的地形 ID，必须能加载、保留、并给出可读告警
  const foreignDoc = {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: { '0_0': { t: 'custom:gone' }, '1_0': { t: 'ancient-marsh' } },
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  }
  app.vault.files.set(
    'Maps/Old.map.md',
    '---\ntype: fictional-cartographer-map\nfc-version: 1\nname: "Old"\ncanvases: []\n---\n\n```json\n' +
      JSON.stringify(foreignDoc, null, 2) +
      '\n```\n',
  )
  const oldLoaded = await store.load(app.vault.getAbstractFileByPath('Maps/Old.map.md'))
  check('未知 t 的旧文件能被加载（不整体拒绝加载）', oldLoaded.document !== null, JSON.stringify(oldLoaded.issues.slice(0, 2)))
  check(
    '两种未知 ID 的格子都被保留下来',
    oldLoaded.document !== null && Object.keys(oldLoaded.document.terrain).length === 2,
    JSON.stringify(oldLoaded.document?.terrain),
  )
  check(
    '外来 ID 有一条可读告警（说明它被保留了，而不是被丢弃）',
    oldLoaded.issues.some((issue) => issue.level === 'warning' && issue.message.includes('已保留')),
    JSON.stringify(oldLoaded.issues.map((issue) => issue.message)),
  )

  // ---------------------------------------------------------- 删除定义：有引用才拦一下，数据不受影响
  // A3 的明确要求：**有地图引用它时**先弹影响面确认框，看清再删；
  // **没有引用**则直接删、一个字都不打扰（无影响面可说，弹框只会白挡一下）。
  const deletes = captureDeleteModals(plugin)
  try {
    openSettings()
    const beforeDeleteData = plugin._data
    await settingNamed(DEFINITION_ROW_LABELS.terrainNameColor('沼泽地')).button.click()
    // 「删除」按钮的处理函数不返回 promise（它 fire-and-forget 地发起影响面扫描），
    // 所以这里要等一拍，让 collectReferences 的读盘跑完
    await new Promise((resolve) => setTimeout(resolve, 20))
    check('有地图引用它时先弹确认框，而不是直接删', deletes.opened.length === 1, `弹了 ${deletes.opened.length} 次`)
    const preview = await deletes.last()?.onPreview?.()
    check(
      '确认框的影响面说清了"几张地图、共几处"',
      (preview?.text ?? '').includes('张地图') &&
        (preview?.text ?? '').includes('处引用') &&
        (preview?.text ?? '').includes('custom:marsh'),
      String(preview?.text),
    )
    check(
      '影响面里必须写明"这些对象不会被删除"、只会变成回退样式（否则用户会以为删除会毁掉地图）',
      (preview?.text ?? '').includes('不会被删除') && (preview?.text ?? '').includes('回退样式'),
      String(preview?.text),
    )
    check(
      '只是弹了框：此刻定义**还没**被删（删不删由用户在对话框里决定）',
      plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:marsh'),
      JSON.stringify(plugin.getSettings().customTerrains.map((terrain) => terrain.id)),
    )
    check(
      '而且此刻一个字节都没落盘（弹框本身不许改动数据 —— 要等用户在框里确认）',
      plugin._data === beforeDeleteData,
      String(plugin._data).slice(0, 160),
    )
    const outcome = await deletes.last()?.onConfirm?.()
    check('在确认框里点删除之后才真的删掉', outcome?.ok === true, JSON.stringify(outcome))
    check(
      '删除后设置里没有它了',
      plugin.getSettings().customTerrains.length === 3 && !plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:marsh'),
      JSON.stringify(plugin.getSettings().customTerrains.map((terrain) => terrain.id)),
    )
    check(
      '删除定义**不会**删掉已经画好的格子（不可逆的数据操作绝不能顺手做）',
      Object.values(doc().terrain).some((cell) => cell.t === 'custom:marsh'),
      String(Object.values(doc().terrain).filter((cell) => cell.t === 'custom:marsh').length),
    )
    // 目录变了 → 面板要重绘一次（面板按目录签名判断"选项数量本身变了"）
    flushFrames()
    check('侧栏「笔刷」随之少一个按钮', terrainButtons().length === 12, String(terrainButtons().length))
    const afterDelete = frame()
    check(
      '被删掉定义的那些格子仍在绘制（回退视觉，而不是消失）',
      afterDelete.calls.drawImage === Object.keys(doc().terrain).length,
      `文档格数=${Object.keys(doc().terrain).length} drawImage=${afterDelete.calls.drawImage}`,
    )

    // 对照组：一条**从没被画过**的定义 → 不弹框，直接删（这条断言在"总是拦一下"的写法上会失败）
    const openedBefore = deletes.opened.length
    openSettings()
    await settingNamed(DEFINITION_ROW_LABELS.terrainNameColor('幽灵地')).button.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    check(
      '没有引用时**不弹**确认框（无影响面可说就别打扰用户）',
      deletes.opened.length === openedBefore,
      `多弹了 ${deletes.opened.length - openedBefore} 次`,
    )
    check(
      '没有引用时定义照样被删掉了（不弹框 ≠ 什么都没发生）',
      !plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:ghost'),
      JSON.stringify(plugin.getSettings().customTerrains.map((terrain) => terrain.id)),
    )
  } finally {
    deletes.restore()
  }

  plugin.onunload()
}

console.log('\n场景 25：图层开关与图例（改的是"看不看"，不是"有没有"）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }

  // 直接往文档里放内容：本场景测的是**渲染与图层**，不是绘制手势（那是场景 15/21 的事）。
  // 直接用真实存在的 ID 与颜色，断言才能钉住"画的是这个东西"。
  const RIVER_COLOR = '#4a9fd8'
  const REGION_COLOR = '#44cf6e'
  doc().terrain['0_0'] = { t: 'forest' }
  doc().terrain['1_0'] = { t: 'water' }
  doc().paths.push({
    id: 'p1',
    type: 'river',
    pts: [[0, 0], [200, 0], [200, 200]],
    width: 8,
    color: RIVER_COLOR,
    label: '长歌川',
  })
  doc().regions.push({
    id: 'r1',
    label: '北境领',
    pts: [[-300, -200], [0, -200], [0, 0], [-300, 0]],
    color: REGION_COLOR,
    opacity: 0.22,
  })
  doc().markers.push({ id: 'm1', label: '龙脊城', p: [100, 100], icon: 'city' })

  // ---- 默认：六个图层全开 ----
  let calls = frame()
  check(
    '默认六层都显示',
    stats().lastCellCount === 2 && stats().lastPathCount === 1 && stats().lastRegionCount === 1,
    `格 ${stats().lastCellCount} 路径 ${stats().lastPathCount} 区域 ${stats().lastRegionCount}`,
  )
  check(
    '默认那一帧真的画了河流（用文档里存的那个颜色描边）',
    calls.groups.some((group) => group.strokeStyle === RIVER_COLOR),
    JSON.stringify([...new Set(calls.groups.map((group) => group.strokeStyle))]),
  )
  check(
    '默认那一帧真的填了区域色',
    calls.fills.some((fill) => fill.fillStyle === REGION_COLOR),
    JSON.stringify([...new Set(calls.fills.map((fill) => fill.fillStyle))]),
  )
  check('默认那一帧画了形状名称', drawnText(ctx).includes('北境领') || drawnText(ctx).includes('长歌川'), drawnText(ctx))

  // ---- 隐藏路径：那一帧没有路径描边，但文档里的路径还在 ----
  await plugin.setLayerVisible('paths', false)
  calls = frame()
  check('隐藏路径后计划里没有路径', stats().lastPathCount === 0, String(stats().lastPathCount))
  check(
    '隐藏路径后没有任何一条河流颜色的描边',
    calls.groups.every((group) => group.strokeStyle !== RIVER_COLOR),
    JSON.stringify([...new Set(calls.groups.map((group) => group.strokeStyle))]),
  )
  check('路径仍然在文档里（图层不改数据）', doc().paths.length === 1, String(doc().paths.length))
  check('区域不受影响（只关了路径这一层）', stats().lastRegionCount === 1, String(stats().lastRegionCount))

  // ---- 隐藏地形：计划里没有格子，文档格数不变 ----
  const cellCountBefore = Object.keys(doc().terrain).length
  await plugin.setLayerVisible('terrain', false)
  calls = frame()
  check('隐藏地形后没有格子被画', stats().lastCellCount === 0, String(stats().lastCellCount))
  check('地形格仍然在文档里', Object.keys(doc().terrain).length === cellCountBefore, String(Object.keys(doc().terrain).length))
  await plugin.setLayerVisible('regions', false)
  calls = frame()
  check(
    '地形与区域都关掉后，这一帧一个填色都没有',
    calls.fills.length === 0,
    `${calls.fills.length} 次 fill（${JSON.stringify([...new Set(calls.fills.map((fill) => fill.fillStyle))])}）`,
  )
  check('文档里的区域也没被删', doc().regions.length === 1, String(doc().regions.length))

  // ---- 隐藏标记：DOM 不显示（而不是把实体销毁） ----
  const markerContainer = () => collectByClass(wrapper, 'fc-marker-layer')[0]
  await plugin.setLayerVisible('markers', false)
  frame()
  check('隐藏标记后统计为 0', stats().lastMarkerCount === 0, String(stats().lastMarkerCount))
  check(
    '隐藏标记后标记层的 DOM 不显示',
    markerContainer() !== undefined && markerContainer().style.display === 'none',
    String(markerContainer()?.style.display),
  )
  check('标记仍然在文档里', doc().markers.length === 1, String(doc().markers.length))
  await plugin.setLayerVisible('markers', true)
  frame()
  check(
    '重新打开标记层后 DOM 又显示（DOM 没有被销毁过）',
    markerContainer().style.display !== 'none' && stats().lastMarkerCount === 1,
    `display=${markerContainer().style.display} 标记=${stats().lastMarkerCount}`,
  )

  // ---- 隐藏名称：形状名称不再绘制 ----
  await plugin.setLayerVisible('terrain', true)
  await plugin.setLayerVisible('regions', true)
  await plugin.setLayerVisible('paths', true)
  frame()
  await plugin.setLayerVisible('labels', false)
  calls = frame()
  check(
    '隐藏名称后没有任何文字被画出来',
    calls.calls.fillText === 0 && calls.calls.strokeText === 0,
    `fillText=${calls.calls.fillText} strokeText=${calls.calls.strokeText}`,
  )
  check('形状本身照常绘制', stats().lastPathCount === 1 && stats().lastRegionCount === 1)
  // §F.2 之后这个开关只在侧栏「显示 · 地物」一组里（浮窗上那个同名按钮已删）
  const panel = await openMapPanel(app, plugin)
  flushFrames()
  const nameToggle = () => inPanel(panel, 'fc-layer-toggle').find((element) => element.dataset.layer === 'labels')
  check(
    '侧栏「名称」开关的高亮读的是设置（不是它自己的状态）',
    nameToggle()?.classList.contains('is-active') === false,
    String(nameToggle()?.className),
  )

  // ---- 图例 ----
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]
  const legendRows = () =>
    collectByClass(legendEl(), 'fc-legend-row').map((row) => ({
      kind: row.dataset.kind,
      label: collectByClass(row, 'fc-legend-label')[0]?.textContent ?? '',
      count: collectByClass(row, 'fc-legend-count')[0]?.textContent ?? '',
      color: collectByClass(row, 'fc-legend-swatch')[0]?.style.backgroundColor ?? '',
    }))
  check('图例默认是隐藏的', legendEl() !== undefined && legendEl().style.display === 'none', String(legendEl()?.style.display))

  await plugin.setLayerVisible('labels', true)
  await plugin.setShowLegend(true)
  frame()
  check('打开图例后它显示出来', legendEl().style.display !== 'none', String(legendEl().style.display))
  const rows = legendRows()
  const labels = rows.map((row) => row.label)
  check(
    '图例只列地图上实际有的东西（地形两种 + 河流 + 区域预设名）',
    labels.includes('森林') && labels.includes('水域') && labels.includes('河流') && labels.includes('王国'),
    JSON.stringify(labels),
  )
  check(
    '图例里的计数与地图内容一致',
    rows.filter((row) => row.kind === 'terrain').every((row) => row.count === '1') &&
      rows.filter((row) => row.kind === 'path').every((row) => row.count === '1'),
    JSON.stringify(rows),
  )
  check(
    '图例色块用绘制层同一份颜色（河流色 = 文档/调色板里的值）',
    rows.some((row) => row.kind === 'path' && row.color === RIVER_COLOR),
    JSON.stringify(rows.filter((row) => row.kind === 'path')),
  )
  check('图例里没有地图上不存在的层（没有标记条目 —— 标记不参与图例）', rows.every((row) => row.kind !== 'marker'))

  // 隐藏一层 → 该层的条目消失（图例跟着"实际启用的"走）
  await plugin.setLayerVisible('paths', false)
  frame()
  check('隐藏路径后图例里没有河流', !legendRows().map((row) => row.label).includes('河流'), JSON.stringify(legendRows().map((row) => row.label)))
  await plugin.setLayerVisible('terrain', false)
  frame()
  const afterTerrainOff = legendRows().map((row) => row.label)
  check('隐藏地形后图例里没有地形', !afterTerrainOff.includes('森林') && !afterTerrainOff.includes('水域'), JSON.stringify(afterTerrainOff))
  await plugin.setLayerVisible('paths', true)
  await plugin.setLayerVisible('terrain', true)

  // ---- 侧栏「显示」里的两个入口（§F.2：浮窗上那两个同名按钮已删，避免一个开关挂两处）----
  flushFrames()
  const legendToggle = () => inPanel(panel, 'fc-legend-toggle')[0]
  check('侧栏「地物」一组里有「显示图例」', legendToggle() !== undefined)
  fireEvent(legendToggle(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('点它会把图例设置写回', plugin.getSettings().showLegend === false, String(plugin.getSettings().showLegend))
  frame()
  check('并且图例真的收起来了', legendEl().style.display === 'none', String(legendEl().style.display))

  flushFrames()
  fireEvent(nameToggle(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '侧栏「名称」开关写的是图层设置（不是编辑器里的一份私有状态）',
    plugin.getSettings().layers.labels === false,
    JSON.stringify(plugin.getSettings().layers),
  )

  // ---- 设置页 ----
  const openSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  openSettings()
  // ---- 设置页**不再有**图层开关（UI 整理 W1c · 用户 m01803 第 6 条「只留在侧栏里」）----
  check(
    '设置页里没有任何图层 / 图例开关（它们的家只在侧栏「底图」「地物」两组里）',
    ['显示地形', '显示网格', '显示区域', '显示路径', '显示标记', '显示名称', '显示图例'].every(
      (name) => settingNamed(name) === undefined,
    ),
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name).filter((name) => (name ?? '').includes('显示'))),
  )

  // 关网格改从**侧栏**驱动（同一条写入路径：照旧落进 `layers.grid`）
  flushFrames()
  const gridToggle = () => inPanel(panel, 'fc-layer-toggle').find((el) => el.dataset.layer === 'grid')
  fireEvent(gridToggle(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('侧栏关掉网格 → 图层设置里网格是关的', plugin.getSettings().layers.grid === false, JSON.stringify(plugin.getSettings().layers))
  calls = frame()
  check('关掉网格后那一帧不描网格线', stats().lastGridCells === 0, String(stats().lastGridCells))
  // 次序是显式的（`LAYER_TABLE.order` → `LAYERS_BY_DRAW_ORDER`）：这一串就是"谁在谁上面"的实测证据，
  // 关掉的层不许出现在里面 —— 否则"开关是亮的/灭的"与"真的画没画"就对不上了。
  check(
    '关掉网格后它也不在绘制序列里',
    stats().lastDrawOrder.includes('grid') === false,
    stats().lastDrawOrder.join(','),
  )
  check(
    '绘制序列自下而上：地形 → 区域 → 路径 → 标记（名称在上一步被工具条关掉了，所以不在里面）',
    stats().lastDrawOrder.join(',') === 'terrain,regions,paths,markers',
    stats().lastDrawOrder.join(','),
  )

  // ---- 状态命令：让"地图怎么少了东西"有一个可查的答案 ----
  await plugin.setLayerVisible('paths', false)
  await plugin.setLayerVisible('labels', false)
  await plugin.setShowLegend(true)
  const layerCapture = captureReports(plugin)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const statusText = layerCapture.text()
  check(
    '状态命令报出当前隐藏了哪些层',
    statusText.includes(STATUS_SECTIONS.layerPrefix) && statusText.includes('路径') && statusText.includes('名称'),
    statusText.slice(0, 200),
  )
  check(
    '状态命令列出图例条目（从地图实际内容生成）',
    statusText.includes(STATUS_SECTIONS.legendPrefix) && statusText.includes('森林') && statusText.includes('王国'),
    statusText.slice(0, 300),
  )
  await plugin.setLayerVisible('paths', true)
  await plugin.setLayerVisible('labels', true)
  // 网格在前面的设置页步骤里被关掉了：这里显式恢复，才能断言"全部显示"这句话
  await plugin.setLayerVisible('grid', true)
  // 温度 / 深度两条数值图层出厂默认都是**关**的（数值图层不该在用户没要求时改变现有画面）：
  // 所以只想看"全部显示"那句话，就得连它们一起打开 —— 隐藏清单里会如实写着它们。
  await plugin.setLayerVisible('temperature', true)
  await plugin.setLayerVisible('depth', true)
  await plugin.setLayerVisible('biome', true)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('全部显示时状态命令这么说', layerCapture.text().includes(STATUS_SECTIONS.layersAllVisible), layerCapture.text().slice(0, 200))
  await plugin.setLayerVisible('temperature', false)
  await plugin.setLayerVisible('depth', false)
  await plugin.setLayerVisible('biome', false)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    '数值图层默认关着这件事在状态命令里可查（"地图怎么没有颜色"有一个可读答案）',
    layerCapture.text().includes('已隐藏 温度 / 深度 / 生物群系'),
    layerCapture.text().slice(0, 200),
  )
  layerCapture.restore()

  // ---- 重开地图层：侧栏里的开关必须与设置一致 ----
  // 这是"两份状态"最容易露馅的地方：如果名称开关还存在每张画布的运行时状态里，
  // 重开之后开关显示的就是默认值，而设置里却是另一个值 —— 用户看到的就是"我明明关了它又开了"。
  // ⚠️ §F.2 之后这个开关只在侧栏（浮窗上那个按钮已删）：状态的唯一真相仍然是**设置**，
  // 所以重开地图层这件事对开关的显示**没有任何影响**。
  await plugin.setLayerVisible('labels', false)
  layers.disable(canvasPath)
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  flushFrames()
  const nameToggleAfterReopen = () => inPanel(panel, 'fc-layer-toggle').find((element) => element.dataset.layer === 'labels')
  check(
    '重开地图层后，名称开关仍然显示设置里的状态（关闭）',
    nameToggleAfterReopen()?.classList.contains('is-active') === false,
    String(nameToggleAfterReopen()?.className),
  )
  await plugin.setLayerVisible('labels', true)
  flushFrames()
  check(
    '在设置侧打开后，开关也跟着打开',
    nameToggleAfterReopen()?.classList.contains('is-active') === true,
    String(nameToggleAfterReopen()?.className),
  )

  // ---- 落盘 + 重启读回 ----
  // 显式造一个"非默认"组合：不去依赖前面步骤留下的状态（第一版就是靠残留状态断言，
  // 结果在我调整步骤顺序后立刻失效 —— 断言必须自己把前提摆好）
  await plugin.setLayerVisible('paths', false)
  await plugin.setLayerVisible('markers', false)
  await plugin.setShowLegend(true)
  const persisted = JSON.parse(plugin._data ?? '{}')
  check(
    '图层与图例都落盘了',
    persisted.layers?.paths === false &&
      persisted.layers?.markers === false &&
      persisted.layers?.terrain === true &&
      persisted.showLegend === true,
    JSON.stringify({ layers: persisted.layers, showLegend: persisted.showLegend }),
  )
  const saved = plugin._data
  plugin.onunload()

  const PluginClass = loadBundleAsCjs()
  const restarted = new PluginClass(app, { id: 'project-kaki' })
  restarted._data = saved
  await restarted.onload()
  check(
    '重启后图层与图例设置读回',
    restarted.getSettings().layers.paths === false &&
      restarted.getSettings().layers.markers === false &&
      restarted.getSettings().layers.terrain === true &&
      restarted.getSettings().showLegend === true,
    JSON.stringify({ layers: restarted.getSettings().layers, showLegend: restarted.getSettings().showLegend }),
  )
  restarted.onunload()

  // ---- 旧设置的迁移：老用户把 showGrid 关掉过，不能因为换代就把他的选择丢掉 ----
  const legacy = new PluginClass(app, { id: 'project-kaki' })
  legacy._data = JSON.stringify({ showGrid: false, labelScale: 2 })
  await legacy.onload()
  check(
    '旧 showGrid:false 迁移成"隐藏网格"，其余层照常显示',
    legacy.getSettings().layers.grid === false &&
      legacy.getSettings().layers.terrain === true &&
      legacy.getSettings().labelScale === 2,
    JSON.stringify({ layers: legacy.getSettings().layers, labelScale: legacy.getSettings().labelScale }),
  )
  legacy.onunload()
}

console.log('\n场景 26：PNG 导出（复用 SVG 几何 → 光栅化 → 两种失败都要给人话）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const mapPath = 'Maps/World.map.md'
  const mapFile = app.vault.getAbstractFileByPath(mapPath)
  const loaded = await store.load(mapFile)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  loaded.document.paths.push({ id: 'p1', type: 'river', pts: [[0, 0], [200, 120]], width: 8, color: '#4a9fd8', label: '北境商路' })
  loaded.document.regions.push({ id: 'r1', label: '北境领', pts: [[0, 0], [200, 0], [200, 200], [0, 200]], color: '#44cf6e', opacity: 0.22 })
  await store.writeNow(mapFile, loaded.document, 'World', [canvasPath])
  await settleEvents()

  const commandById = (id) => plugin.commands.find((command) => command.id === id)

  check('注册了"导出当前地图为 PNG"命令', commandById('export-map-png') !== undefined)
  check(
    '命令出现在地图面板里（与命令面板共用同一份动作表）',
    plugin.getPanelActions().some((action) => action.id === 'export-map-png'),
    plugin.getPanelActions().map((action) => action.id).join(','),
  )
  // 注意口径：本项目里 `available` **只用于面板禁用**，命令本身不做可见性门禁
  // （开发用探针那种"从命令面板消失"是另一条规则，见 `registerActions`）。
  // 所以"不能导出"这件事要在**两处**都成立：面板按钮禁用 + 点了给可读提示。
  const panelAction = plugin.getPanelActions().find((action) => action.id === 'export-map-png')
  check(
    '未启用地图层时面板按钮是禁用的（而不是点了才报错）',
    panelAction?.available?.() === false,
    String(panelAction?.available?.()),
  )

  // ---- 未启用地图层：明确提示，且不产生文件 ----
  clearNotices()
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    '没有启用地图层时给出明确提示',
    noticeLog.some((line) => line.includes(NOTICES.noExportableMap) || line.includes(NOTICES.layerEnabled)),
    noticeLog.join(' | '),
  )
  check('未启用时不产生文件', app.vault.files.has('Maps/World.png') === false)

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('地图层已启用', layers.getDocument(canvasPath) !== null)

  // ---- 降级路径（不注入任何替身）----
  // 假环境有 Image 与 2D 上下文，但画布**没有 toBlob** —— 正是部分移动端 WebView 的样子。
  // 期望：给出可读原因、**不产生文件**（半个空图比没有文件更糟：用户会以为导出成功了）。
  clearNotices()
  openedLinks.length = 0
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const failedNotice = noticeLog.find((line) => line.includes(NOTICES.pngFailedPrefix)) ?? ''
  check('环境不支持时给出可读的失败原因', failedNotice.length > 0, noticeLog.join(' | '))
  check(
    '失败提示是人话而不是堆栈（不能出现 Error/at 这类痕迹）',
    failedNotice.includes('PNG') && !/Error\b|TypeError|undefined| at /.test(failedNotice),
    failedNotice,
  )
  check('失败时不产生文件', app.vault.files.has('Maps/World.png') === false && app.vault.binaryFiles.size === 0)

  // ---- 精确覆盖"没有 toBlob"这条分支（不依赖假 DOM 的细节）----
  plugin.setPngRasterizer({
    createImage: () => ({ src: '', complete: false, naturalWidth: 8, onload: null, onerror: null }),
    waitForImage: async () => true,
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    toBlob: async () => null,
  })
  clearNotices()
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    'toBlob 返回空时也给人话，且不写文件',
    noticeLog.some((line) => line.includes(NOTICES.pngFailedPrefix) && line.includes('toBlob')) &&
      app.vault.binaryFiles.size === 0,
    noticeLog.join(' | '),
  )

  // ---- 成功路径：注入替身，断言写进去的**是真的字节**、用的是**导出几何** ----
  const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const seenSvgs = []
  plugin.setPngRasterizer({
    createImage: () => ({ src: '', complete: false, naturalWidth: 8, onload: null, onerror: null }),
    waitForImage: async (image) => {
      seenSvgs.push(image.src)
      return true
    },
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    toBlob: async () => ({ arrayBuffer: async () => pngMagic.buffer.slice(0) }),
  })

  clearNotices()
  openedLinks.length = 0
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 60))

  const bytes = app.vault.binaryFiles.get('Maps/World.png')
  check('导出了 PNG 文件', bytes !== undefined && bytes.byteLength > 0, String(bytes?.byteLength))
  check(
    '写入的是真正的 PNG 字节（签名 89 50 4E 47…）而不是文本',
    bytes instanceof ArrayBuffer && new Uint8Array(bytes)[0] === 0x89 && new Uint8Array(bytes)[1] === 0x50,
    bytes instanceof ArrayBuffer ? [...new Uint8Array(bytes)].slice(0, 4).join(',') : String(bytes),
  )
  check('命令报告了导出路径', noticeLog.some((line) => line.includes('Maps/World.png')), noticeLog.join(' | '))
  check('导出后打开了文件', openedLinks.some((entry) => entry.link === 'Maps/World.png'), JSON.stringify(openedLinks))

  // 复用导出几何：交给光栅化器的那份 SVG 必须**就是**地图导出那一份（含同源的配色与几何），
  // 而不是 PNG 自己另画一套 —— 这类"两份实现慢慢分叉"的缺陷只能靠断言这个来防。
  const decoded = seenSvgs.length > 0 ? decodeURIComponent(seenSvgs[0].replace(/^data:[^,]*,/, '')) : ''
  check('交给光栅化器的是一张 SVG 的 data URL', seenSvgs[0]?.startsWith('data:image/svg+xml') === true, String(seenSvgs[0]).slice(0, 40))
  check(
    'PNG 复用的是地图导出的几何与配色（不是第二套实现）',
    decoded.includes('#44cf6e') && decoded.includes('<polyline') && decoded.includes('width="1600"'),
    decoded.slice(0, 120),
  )

  // ---- 重名不覆盖，自动加后缀（与 SVG 导出同一份命名逻辑）----
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    '重名时自动加后缀（不覆盖已有文件）',
    app.vault.binaryFiles.has('Maps/World-2.png') && app.vault.binaryFiles.has('Maps/World.png'),
    [...app.vault.binaryFiles.keys()].join(','),
  )

  // ---- 恢复真实实现：注入点只该影响测试 ----
  plugin.setPngRasterizer(null)
  clearNotices()
  await runCommand(plugin, 'export-map-png')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    '传 null 恢复真实实现（回到降级分支而不是沿用替身）',
    noticeLog.some((line) => line.includes(NOTICES.pngFailedPrefix)),
    noticeLog.join(' | '),
  )

  plugin.onunload()
}

console.log('\n场景 27：地图面板的图层开关与工具条精简（用户反馈：那个按钮不知道是干什么的）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }

  const RIVER_COLOR = '#4a9fd8'
  doc().terrain['0_0'] = { t: 'forest' }
  doc().terrain['1_0'] = { t: 'water' }
  doc().paths.push({ id: 'p1', type: 'river', pts: [[0, 0], [200, 0]], width: 8, color: RIVER_COLOR, label: '长歌川' })

  // ---- 工具条：那个让人看不懂的按钮必须真的没了 ----
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  check('工具条还在（只是少了一个按钮）', toolbarEl !== undefined)
  check(
    '工具条上不再有「地图层」按钮',
    collectByClass(wrapper, 'fc-toolbar-layer').length === 0,
    String(collectByClass(wrapper, 'fc-toolbar-layer').length),
  )
  check(
    '浮窗上没有任何按钮的文字是「地图层」',
    collectByClass(toolbarEl, 'fc-ctl-button').every((button) => (button.textContent ?? '') !== '地图层'),
    collectByClass(toolbarEl, 'fc-ctl-button').map((button) => button.textContent).join(','),
  )

  // ---- 面板：六个图层开关 ----
  plugin.ribbonIcons[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
  check('面板已打开', panel !== undefined)
  const toggleEls = () => collectByClass(panel.contentEl, 'fc-layer-toggle')
  const toggleFor = (key) => toggleEls().find((element) => element.dataset.layer === key)
  check('面板里有九个图层开关（六层 + 温度、深度、生物群系三条数值图层）', toggleEls().length === 9, String(toggleEls().length))
  const panelLayerOrder = toggleEls().map((element) => element.dataset.layer).join(',')
  check(
    '九个开关的 key 与图层登记表一致（表驱动，顺序就是表里的行序）',
    panelLayerOrder === 'terrain,temperature,depth,biome,grid,regions,paths,markers,labels',
    panelLayerOrder,
  )
  check(
    '开关显示的是中文层名',
    collectByClass(panel.contentEl, 'fc-layer-toggle-label').map((el) => el.textContent).join(',') ===
      '地形,温度,深度,生物群系,网格,区域,路径,标记,名称',
    collectByClass(panel.contentEl, 'fc-layer-toggle-label').map((el) => el.textContent).join(','),
  )
  const dataLayerKeys = ['temperature', 'depth', 'biome']
  check(
    '除数值图层外默认都是"开"（三条数值图层出厂是关的：新功能不该改变现有画面）',
    toggleEls()
      .filter((element) => !dataLayerKeys.includes(element.dataset.layer))
      .every((element) => element.classList.contains('is-active')) &&
      dataLayerKeys.every((key) => toggleFor(key)?.classList.contains('is-active') === false),
    toggleEls().map((element) => `${element.dataset.layer}:${element.classList.contains('is-active') ? 1 : 0}`).join(' '),
  )
  check(
    '开关的悬停提示写清了这一层管什么（用具名文案，而不是让人猜）',
    (toggleFor('markers')?.title ?? '').includes('地标标记与文字标注') && (toggleFor('labels')?.title ?? '').includes('名称文字'),
    String(toggleFor('markers')?.title),
  )

  // ---- 绘制次序是表里写明的，不是绘制函数调用的先后 ----
  frame()
  check(
    '真实渲染按图层登记表的次序画（自下而上：地形 → 网格 → 区域 → 名称 → 路径 → 标记）',
    stats().lastDrawOrder.join(',') === 'terrain,grid,regions,labels,paths,markers',
    stats().lastDrawOrder.join(','),
  )

  // ---- 从别处改图层时，面板要跟着变（否则会出现"设置改了、开关还亮着旧的"）----
  await plugin.setLayerVisible('paths', false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  flushFrames()
  check(
    '从别处关掉路径后，面板上的路径开关自己也灭了',
    !toggleFor('paths')?.classList.contains('is-active'),
    String(toggleFor('paths')?.classList.contains('is-active')),
  )
  check(
    '灭掉的开关用空心标记（○）表示，一眼能看出是关的',
    collectByClass(toggleFor('paths'), 'fc-layer-toggle-mark')[0]?.textContent === '○',
    String(collectByClass(toggleFor('paths'), 'fc-layer-toggle-mark')[0]?.textContent),
  )
  await plugin.setLayerVisible('paths', true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  flushFrames()
  check('开回来时面板上的开关也亮回来', toggleFor('paths')?.classList.contains('is-active') === true)

  // ---- 点面板里的开关：设置真的变、这一帧真的不画、文档里的数据不动 ----
  fireEvent(toggleFor('terrain'), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  flushFrames()
  check('点开关后设置里的地形层被关掉', plugin.getSettings().layers.terrain === false, JSON.stringify(plugin.getSettings().layers))
  const hiddenFrame = frame()
  check('关掉地形后这一帧没有画任何格子', stats().lastCellCount === 0, String(stats().lastCellCount))
  check(
    '但文档里的地形格仍在（图层不改数据）',
    Object.keys(doc().terrain).length === 2,
    String(Object.keys(doc().terrain).length),
  )
  check('关掉地形不影响路径（只动点的那一层）', hiddenFrame.groups.some((group) => group.strokeStyle === RIVER_COLOR))
  check(
    '关掉地形后它也不在绘制序列里（其余五层顺序不变）',
    stats().lastDrawOrder.join(',') === 'grid,regions,labels,paths,markers',
    stats().lastDrawOrder.join(','),
  )

  fireEvent(toggleFor('terrain'), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  flushFrames()
  check('再点一次就开回来', plugin.getSettings().layers.terrain === true)
  frame()
  check('开回来后格子又画出来了', stats().lastCellCount === 2, String(stats().lastCellCount))

  fireEvent(toggleFor('paths'), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const noPathFrame = frame()
  check(
    '点开关关掉路径后，那一帧没有河流描边',
    noPathFrame.groups.every((group) => group.strokeStyle !== RIVER_COLOR),
    JSON.stringify([...new Set(noPathFrame.groups.map((group) => group.strokeStyle))]),
  )
  check('路径仍在文档里', doc().paths.length === 1)
  fireEvent(toggleFor('paths'), 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  flushFrames()

  // ---- 关键回归：关掉地图层之后，入口不能跟着消失 ----
  const layerButton = () =>
    collectByClass(panel.contentEl, 'fc-panel-button').find((button) =>
      (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes(COMMAND_NAMES.toggleLayer),
    )
  check('面板里有「启用/停用当前 Canvas 的地图层」这个入口', layerButton() !== undefined)
  fireEvent(layerButton(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 80))
  flushFrames()
  // 停用后这个画布会被从「已启用」集合里移除，所以 listStatus() 是**空数组**
  // （不是 [{attached:false}]）—— 断言要按真实的返回形状写，否则会把正确行为判成失败。
  check(
    '点它之后地图层被停用（工具条与覆盖层一起收起）',
    layers.listStatus().length === 0,
    JSON.stringify(layers.listStatus().map((status) => status.attached)),
  )
  check('工具条确实随地图层一起消失了', collectByClass(wrapper, 'fc-toolbar').length === 0)
  check('而面板还在（所以关掉之后仍有入口 —— 这正是把按钮从工具条拿掉的前提）', collectByClass(panel.contentEl, 'fc-layer-toggle').length === 9)

  fireEvent(layerButton(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 80))
  check(
    '再从面板点一次就能把地图层开回来',
    layers.listStatus().some((status) => status.attached) === true,
    JSON.stringify(layers.listStatus().map((status) => status.attached)),
  )

  plugin.onunload()
}

console.log('\n场景 28：报告面板（状态报告不再用长提示，而是可复制/可导出的面板）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const canvasPath = 'Maps/World.canvas'
  const mapFile = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  // 地形要**落盘**：状态命令会重新读文件（不是读内存里的文档），
  // 只改内存的话报告里会写着"地形 0 格"——第一版就是这样，连带让"报告没走 Notice"那条断言
  // 变成了空断言（因为那一刻报告里根本没有"地形 1 格"这句话可找）。
  const persisted = await store.load(mapFile)
  persisted.document.terrain['0_0'] = { t: 'forest' }
  await store.writeNow(mapFile, persisted.document, 'World', [canvasPath])
  await settleEvents()

  // 启用地图层并画一帧：报告里的「名称字号 / 实测标定」只有真的画过帧才有数字
  // （没画过时它会如实写"本帧未绘制"——那也是正确行为，但用户记住的是有数字的那一版）
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  canvas.markViewportChanged()
  flushFrames()

  // ---- 命令侧：打开面板而不是弹长提示 ----
  const capture = captureReports(plugin)
  const before = noticeLog.length
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const report = capture.last()
  check('状态命令打开了报告面板', capture.reports.length === 1 && typeof report?.text === 'string', String(capture.reports.length))
  check(
    '报告正文包含用户记住的那两行（名称字号与实测标定）',
    /名称字号：路径 \d+ px/.test(report?.text ?? '') && /标定 1 CSS px = [\d.]+ 位图像素/.test(report?.text ?? ''),
    (report?.text ?? '').replace(/\n/g, ' | ').slice(0, 240),
  )
  check(
    '报告正文也包含图层与图例（排查"东西不见了"的两行）',
    (report?.text ?? '').includes(STATUS_SECTIONS.layerPrefix) && (report?.text ?? '').includes(STATUS_SECTIONS.legendPrefix),
    (report?.text ?? '').replace(/\n/g, ' | ').slice(0, 240),
  )
  check(
    '这一操作没有留下任何长提示（用户抱怨的就是"等太久"）',
    noticeLog
      .slice(before)
      .every((_line, index) => (noticeDurations[before + index] ?? 0) <= 6000),
    JSON.stringify(noticeDurations.slice(before)),
  )
  check('报告没有走 Notice 通道', !noticeLog.slice(before).some((line) => line.includes('地形 1 格')), noticeLog.slice(before).join(' | '))

  // ---- 真实面板：正文、复制、导出（用默认工厂造一个真面板，选项是命令刚传进去的那份） ----
  capture.restore()
  const realModal = capture.defaultFactory(app, report)
  realModal.open()
  const body = collectByClass(realModal.contentEl, 'fc-report-body')[0]
  check('正文渲染在 <pre> 里（换行与缩进保留）', body !== undefined && body.tagName === 'PRE', String(body?.tagName))
  check('pre 里的文本与报告完全一致（不截断）', body?.textContent === report.text, String(body?.textContent).slice(0, 120))
  check(
    '面板标题表明这是地图状态报告',
    collectByClass(realModal.contentEl, 'fc-report-title')[0]?.textContent === COMMAND_NAMES.statusReport,
    String(collectByClass(realModal.contentEl, 'fc-report-title')[0]?.textContent),
  )
  check(
    '提示里写清了导出文件名与重名规则',
    (collectByClass(realModal.contentEl, 'fc-report-hint')[0]?.textContent ?? '').includes('Maps/World-状态报告.md'),
    String(collectByClass(realModal.contentEl, 'fc-report-hint')[0]?.textContent),
  )

  // 按钮通过 `Setting` 创建：一个 Setting 上挂了三个按钮（复制 / 导出 / 关闭），
  // 所以要在**所有** setting 的按钮列表里找，而不是只看 `setting.button`（那是最后一个）。
  const openFreshModal = () => {
    FakeSetting.created.length = 0
    const modal = capture.defaultFactory(app, report)
    modal.open()
    return modal
  }
  const buttonNamed = (fragment) =>
    FakeSetting.created
      .flatMap((setting) => setting.buttons ?? [])
      .find((button) => (button.text ?? '').includes(fragment))

  openFreshModal()

  check('面板上有「复制」按钮', buttonNamed('复制') !== undefined)
  check('面板上有「导出为库内文件」按钮', buttonNamed('导出为库内文件') !== undefined)
  check('面板上有「关闭」按钮', buttonNamed('关闭') !== undefined)

  clipboardWrites.length = 0
  await buttonNamed('复制').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('复制按钮把正文写进了剪贴板', clipboardWrites.length === 1 && clipboardWrites[0] === report.text, `${clipboardWrites.length} 次`)
  check(
    '复制成功给的是短提示（不该再出现十几秒的弹窗）',
    noticeDurations.at(-1) !== undefined && noticeDurations.at(-1) <= 4000,
    String(noticeDurations.at(-1)),
  )
  check('提示说明了复制了多少字符', (noticeLog.at(-1) ?? '').includes(`${report.text.length} 字符`), String(noticeLog.at(-1)))

  // 导出：真的写进假库，内容等于面板正文
  await buttonNamed('导出为库内文件').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '导出按钮把报告写进了库内文件（内容等于正文）',
    app.vault.files.get('Maps/World-状态报告.md') === report.text,
    String(app.vault.files.get('Maps/World-状态报告.md')?.slice(0, 60)),
  )
  check('导出成功也给短提示并报出路径', (noticeLog.at(-1) ?? '').includes('Maps/World-状态报告.md'), String(noticeLog.at(-1)))

  // 重名：加 -2，不覆盖已有文件（与 SVG/PNG 导出同一份命名规则）
  await buttonNamed('导出为库内文件').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '重名时自动加 -2（不覆盖上一次的报告）',
    app.vault.files.has('Maps/World-状态报告-2.md') && app.vault.files.get('Maps/World-状态报告.md') === report.text,
    [...app.vault.files.keys()].filter((key) => key.startsWith('Maps/World-状态报告')).join(','),
  )

  // 剪贴板不可用：必须退化为"帮你选中 + 告诉我按什么键"，而不是静默失败
  installClipboard(false)
  const fallbackModal = openFreshModal()
  await buttonNamed('复制').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '剪贴板不可用时给出可操作的退路（不是静默失败）',
    /选中|手动/.test(noticeLog.at(-1) ?? ''),
    String(noticeLog.at(-1)),
  )
  check('退路提示也是短提示', (noticeDurations.at(-1) ?? 0) <= 4000, String(noticeDurations.at(-1)))
  installClipboard(true)

  // 面板自身不该持有库知识：导出失败时它只负责把后端的原因讲出来
  FakeSetting.created.length = 0
  const failingModal = capture.defaultFactory(app, {
    title: '失败样本',
    text: 'x',
    fileName: 'Maps/失败报告.md',
    onExport: async () => {
      throw new Error('磁盘满了')
    },
  })
  failingModal.open()
  await buttonNamed('导出为库内文件').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('导出失败时把后端的原因原样讲出来', (noticeLog.at(-1) ?? '').includes('磁盘满了'), String(noticeLog.at(-1)))

  // ---- 面板打不开时的退路：报告不能消失（否则这次排查就白做了） ----
  const consoleBefore = consoleLines.length
  plugin.setReportModalFactory(() => {
    throw new Error('面板构造失败')
  })
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    '面板打不开时给出可读提示而不是静默失败',
    (noticeLog.at(-1) ?? '').includes('控制台'),
    String(noticeLog.at(-1)),
  )
  check(
    '并且把报告正文打印到控制台（内容不会丢）',
    consoleLines.slice(consoleBefore).some((line) => line.includes('地形 1 格')),
    consoleLines.slice(consoleBefore).join(' | ').slice(0, 160),
  )
  capture.restore()

  plugin.onunload()
}

console.log('')

// ---------------------------------------------------------------- 全局回归
// 用户的原话是"过一会才消失，等待时间过久"：这条断言盯住**上界**，
// 而不是某一条具体的提示 —— 下次谁再写一个 15 秒的弹窗，这里会直接红。
{
  const offenders = noticeDurations
    .map((duration, index) => ({ duration, message: noticeLog[index] ?? '' }))
    .filter((item) => item.duration > 6000)
  check(
    '所有提示的时长都不超过 6000ms（与 main.ts 的 NOTICE_MAX_MS 一致）',
    offenders.length === 0,
    offenders
      .slice(0, 3)
      .map((item) => `${item.duration}ms：${item.message.replace(/\n/g, ' ').slice(0, 60)}`)
      .join(' | '),
  )
  check(
    '提示的时长都被如实记录（桩不能漏记，否则上一条断言会假通过）',
    noticeDurations.length === noticeLog.length && noticeDurations.every((value) => typeof value === 'number'),
    `${noticeDurations.length} vs ${noticeLog.length}`,
  )
}

console.log('\n场景 29：自定义地形的图片「从库里选」（不再手打路径）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath: 'Maps/World.canvas' })
  await settleEvents()

  // 库里放几张图（外加两个非图片文件，用来验证筛选）
  app.vault.files.set('Assets/forest.png', '<png>')
  app.vault.files.set('Assets/地形/reef.svg', '<svg>')
  app.vault.files.set('Assets/notes.txt', '不是图片')
  app.vault.files.set('Assets/data.json', '{}')

  await plugin.addCustomTerrain({ id: 'marsh', label: '沼泽地', color: '#336655' })
  await settleEvents()

  /**
   * 默认工厂要**在注入替身之前**拿到：注入之后再读 `plugin.imagePickerFactory` 拿到的就是替身了
   * （我第一次就写错了，报错是 "real.getItems is not a function"）。
   */
  const defaultPickerFactory = plugin.imagePickerFactory

  // 定义管理（A3）搬到了「地图定义」弹窗：控件对着弹窗取（设置页那一侧只剩引导与全局开关）。
  // 每次 openSettings() 都会新开一个弹窗（新 contentEl），旧对象随即过期。
  let defModal = null
  const openSettings = () => {
    FakeSetting.created.length = 0
    defModal = openDefinitionManager(plugin)
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 切换某条地形的模式（模式控件是弹窗里"地形 N · 显示名"那一行右侧的两个按钮） */
  const switchMode = async (label, mode) => {
    openSettings()
    const container = defModal.contentEl
    const row = collectByClass(container, 'fc-terrain-mode').find((candidate) =>
      (collectByClass(candidate, 'fc-terrain-mode-title')[0]?.textContent ?? '').includes(label),
    )
    const button = collectByClass(row ?? container, 'fc-terrain-mode-button').find((candidate) => candidate.dataset.mode === mode)
    // 用 fireEvent 而不是 element.click()：假 DOM 的元素本身没有 click()，
    // 只有假 Setting 的控件对象才有（那是桩提供的便利方法）
    if (button !== undefined) fireEvent(button, 'click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    openSettings()
  }
  const imageRow = () => settingNamed(DEFINITION_ROW_LABELS.image('沼泽地'))
  const allNotes = () => collectByClass(defModal.contentEl, 'fc-settings-note').map((el) => el.textContent ?? '')
  /** 地形那一节的就地提示（按 `dataset.fcNote` 取：弹窗里四节各有一条提示行） */
  const noteText = () =>
    collectByClass(defModal.contentEl, 'fc-settings-note').find((el) => el.dataset?.fcNote === 'terrain')
      ?.textContent ?? ''
  const persisted = () => (plugin._data === null ? null : JSON.parse(plugin._data))
  const imagePathInSettings = () => plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:marsh')?.imagePath

  /**
   * ---- 设置页那一侧的布局契约（与弹窗无关，单独渲染一次设置页来验）----
   *
   * CSS 布局在假 DOM 里**无法断言**（假 DOM 没有布局引擎）。所以这里只钉**挂载点**：
   * `styles.css` 里那一组"控件多的一行不许溢出"的规则挂在 `.fc-settings` 上，
   * 设置页必须真的带上这个类 —— 否则规则静默失效，用户下次又会看到"按钮跑到区域外面"
   * （这个现象是用户实测报的，当时「新增自定义路径类型」一行有 6 个控件，见 §5.31）。
   *
   * ⚠️ 顺序有讲究：类是在 `display()` 里加的，所以必须先渲染再断言
   *（第一版写反了，读到的是加类之前的 `setting-tab`）。
   */
  plugin.settingTabs[0].display()
  const settingsRoot = plugin.settingTabs[0].containerEl
  check(
    '设置页容器带 fc-settings 类（防溢出规则的挂载点）',
    String(settingsRoot.className ?? '').split(/\s+/).includes('fc-settings'),
    String(settingsRoot.className),
  )
  const stylesCssText = fs.readFileSync(path.join(root, 'styles.css'), 'utf8')
  check(
    'styles.css 里确实有挂在 .fc-settings 上的折行规则（类名不许只改一边）',
    /\.fc-settings\s+\.setting-item-control\s*\{[^}]*flex-wrap:\s*wrap/.test(stylesCssText),
    '未找到 .fc-settings .setting-item-control { … flex-wrap: wrap … }',
  )
  check(
    'styles.css 里也有挂在 .fc-defmodal 上的折行规则（弹窗里同样有控件很多的那几行）',
    /\.fc-defmodal\s+\.setting-item-control\s*\{[^}]*flex-wrap:\s*wrap/.test(stylesCssText),
    '未找到 .fc-defmodal .setting-item-control { … flex-wrap: wrap … }',
  )
  check(
    'styles.css 里把"空控件容器"藏起来了（内置行不该看起来像有两个空按钮）',
    // 选择器是一串（弹窗 + 设置页两处共用），所以 `:empty` 后面允许接逗号再接第二个选择器
    /\.fc-defmodal\s+\.setting-item-control:empty[^{]*\{[^}]*display:\s*none/.test(stylesCssText),
    '未找到 .fc-defmodal .setting-item-control:empty { … display: none … }',
  )

  openSettings()
  check('默认是「调色」模式（新建时的默认值：不依赖任何外部资源）', plugin.getSettings().customTerrains[0]?.mode === 'color', String(plugin.getSettings().customTerrains[0]?.mode))
  check(
    '调色模式下**也有**图片那一栏（用户实测反馈"没有看到图片导入按钮" —— 找不到入口就等于没有这个功能）',
    imageRow() !== undefined && imageRow()?.button !== undefined && settingNamed(DEFINITION_ROW_LABELS.glyph('沼泽地')) !== undefined,
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name)),
  )
  check(
    '调色模式下那一栏的说明写清当前状态与后果（点按钮会切到图片模式）',
    (imageRow()?.info.desc ?? '').includes('调色') && (imageRow()?.info.desc ?? '').includes('图片'),
    String(imageRow()?.info.desc),
  )

  await switchMode('沼泽地', 'image')
  check('切到图片模式后设置里记的是图片模式', plugin.getSettings().customTerrains[0]?.mode === 'image', String(plugin.getSettings().customTerrains[0]?.mode))
  check('自定义地形那一行有「从库中选择…」按钮', imageRow()?.button !== undefined)
  check(
    '手打的输入框还在（两条路都要通：有人就喜欢粘贴路径）',
    imageRow()?.text !== undefined,
    JSON.stringify(Object.keys(imageRow() ?? {})),
  )

  // ---- 注入替身：精确控制"用户选了哪一项" ----
  /** 替身选择器：记下 options，并按剧本回调 */
  const makePickerDouble = (choice) => {
    const calls = []
    const factory = (_app, options) => {
      calls.push(options)
      return {
        open() {
          if (choice !== undefined) options.onChoose(choice)
        },
      }
    }
    return { factory, calls }
  }

  const good = makePickerDouble('Assets/forest.png')
  plugin.setImagePickerFactory(good.factory)
  clearNotices()
  await imageRow().button.click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('选择器被打开了一次', good.calls.length === 1, String(good.calls.length))
  check(
    '列出的候选只含图片（非图片文件不能被列出来，否则会出现"选了却被拒"）',
    JSON.stringify(good.calls[0]?.files) === JSON.stringify(['Assets/forest.png', 'Assets/地形/reef.svg']),
    JSON.stringify(good.calls[0]?.files),
  )
  check('弹窗标题带上了是哪一条地形（用户要能确认自己在给谁选图）', (good.calls[0]?.title ?? '').includes('沼泽地'), String(good.calls[0]?.title))
  check('选中的路径写进了设置', imagePathInSettings() === 'Assets/forest.png', String(imagePathInSettings()))
  check('并且已落盘（不是只改了内存）', persisted()?.customTerrains?.[0]?.imagePath === 'Assets/forest.png', JSON.stringify(persisted()?.customTerrains))
  const noteDiag = () => {
    const live = collectByClass(defModal.contentEl, 'fc-settings-note')
    return JSON.stringify({ liveNotes: live.map((el) => el.textContent ?? '') })
  }
  check(
    '就地提示说明了选中的是哪张图',
    allNotes().some((text) => text.includes('Assets/forest.png')),
    noteDiag(),
  )

  // ---- 关键回归：调色模式下点「从库中选择…」必须先自动切到图片模式 ----
  // 用户实测反馈"没有看到图片导入按钮"，根因就是调色模式下那一栏根本不渲染。
  // 现在入口永远可见，而且点它要**一次点击到位**（先切模式再选图），
  // 而不是让用户先去点上面的分段控件。
  await switchMode('沼泽地', 'color')
  check('前提：已切回调色模式', plugin.getSettings().customTerrains[0]?.mode === 'color', String(plugin.getSettings().customTerrains[0]?.mode))
  const fromColorMode = makePickerDouble('Assets/地形/reef.svg')
  plugin.setImagePickerFactory(fromColorMode.factory)
  await imageRow().button.click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('调色模式下点按钮：选择器照样被打开（入口不再被藏起来）', fromColorMode.calls.length === 1, String(fromColorMode.calls.length))
  check(
    '并且模式被自动切成了「图片」（否则用户会以为"选了没反应"，因为调色模式下图片不参与绘制）',
    plugin.getSettings().customTerrains[0]?.mode === 'image',
    String(plugin.getSettings().customTerrains[0]?.mode),
  )
  check(
    '选中的路径也写进去了',
    imagePathInSettings() === 'Assets/地形/reef.svg',
    String(imagePathInSettings()),
  )

  // 反向：调色模式下**直接填**一个合法路径，也要自动切模式
  await switchMode('沼泽地', 'color')
  plugin.setImagePickerFactory(null)
  openSettings()
  await imageRow().text.type('Assets/forest.png')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '调色模式下直接填路径 → 自动切到图片模式（填图片路径的意图是明确的）',
    plugin.getSettings().customTerrains[0]?.mode === 'image',
    String(plugin.getSettings().customTerrains[0]?.mode),
  )

  // 重绘后再读（`display()` 会重建整页的 Setting，旧对象是过期的，必须重新取）
  openSettings()
  check(
    '重绘后输入框里也是这条路径（两条路写的是同一份设置）',
    imageRow()?.text?.value === 'Assets/forest.png',
    JSON.stringify({
      hasRow: imageRow() !== undefined,
      hasText: imageRow()?.text !== undefined,
      value: imageRow()?.text?.value ?? null,
      settings: imagePathInSettings(),
      names: FakeSetting.created.map((setting) => setting.info.name ?? '').slice(0, 8),
    }),
  )

  // ---- 替身返回非法路径：必须被拒、给出原因、且不留下坏值 ----
  const bad = makePickerDouble('Assets/notes.txt')
  plugin.setImagePickerFactory(bad.factory)
  clearNotices()
  openSettings()
  await imageRow().button.click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('非法选择被拒（设置里仍是上一张合法图片）', imagePathInSettings() === 'Assets/forest.png', String(imagePathInSettings()))
  check('并给出可读原因（说的是支持哪些格式）', noteText().includes('只支持'), noteText())

  // ---- 库里没有图片：给可读提示，不弹空列表 ----
  const empty = makePickerDouble('Assets/forest.png')
  plugin.setImagePickerFactory(empty.factory)
  app.vault.files.delete('Assets/forest.png')
  app.vault.files.delete('Assets/地形/reef.svg')
  clearNotices()
  openSettings()
  await imageRow().button.click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('库里没有图片时不开空弹窗', empty.calls.length === 0, String(empty.calls.length))
  const hint = noticeLog.at(-1) ?? ''
  check('而是给一条可读提示（说清为什么没有、该做什么）', hint.includes('没有找到图片') && hint.includes('png'), hint)
  check('提示时长在上界内（别又变成十几秒的横幅）', (noticeDurations.at(-1) ?? 0) <= 6000, String(noticeDurations.at(-1)))

  // ---- 真实弹窗自己的逻辑（模糊搜索是 Obsidian 的，这里只验我们写的那三个方法）----
  app.vault.files.set('Assets/forest.png', '<png>')
  app.vault.files.set('Assets/地形/reef.svg', '<svg>')
  const real = defaultPickerFactory(app, {
    files: app.vault.getFiles().map((file) => file.path),
    kind: 'image',
    title: '选择图片',
    onChoose: () => {},
  })
  check(
    '真实弹窗的清单：只含图片且顺序确定',
    JSON.stringify(real.getItems()) === JSON.stringify(['Assets/forest.png', 'Assets/地形/reef.svg']),
    JSON.stringify(real.getItems()),
  )
  check(
    '真实弹窗的条目文字带上所在文件夹（同名文件也能分辨）',
    real.getItemText('Assets/地形/reef.svg') === 'reef.svg · Assets/地形',
    real.getItemText('Assets/地形/reef.svg'),
  )
  check('真实弹窗把占位提示交给搜索框', real.placeholder === '选择图片', String(real.placeholder))
  /**
   * 同一个真实弹窗，`kind: 'bundle'` 时必须换筛选。
   *
   * 这两条是**用户实测逼出来的**：以前 `getItems()` 写死 `listImagePaths(files)`，
   * 于是"导入定义文件"传进来的 `.json` 全被图片白名单筛掉 —— 选择器恒为空，
   * 用户看到的现象是"导入定义的 UI 不工作"。当时所有导入断言都走注入的替身，
   * 真实弹窗只被**图片**这一类验过，所以一条都不红（教训见 §5.30）。
   * 上面那条"只含图片"的断言同时也是反向对照：修 bundle 不许把图片那一类改坏。
   */
  const realBundle = defaultPickerFactory(app, {
    files: ['project-kaki-definitions-20260101-0000.json', 'Assets/forest.png', 'Notes/readme.md'],
    kind: 'bundle',
    onChoose: () => {},
  })
  check(
    '真实弹窗（kind: bundle）列的是 .json —— 不会被图片白名单筛空',
    JSON.stringify(realBundle.getItems()) === JSON.stringify(['project-kaki-definitions-20260101-0000.json']),
    JSON.stringify(realBundle.getItems()),
  )
  check(
    '真实弹窗（kind: bundle）的缺省提示是给定义文件用的（不是「选择库内图片…」）',
    realBundle.placeholder === DIALOG_LABELS.pickDefinitionFile,
    String(realBundle.placeholder),
  )
  let chosen = null
  const realForChoose = defaultPickerFactory(app, {
    files: ['Assets/forest.png'],
    kind: 'image',
    onChoose: (path) => {
      chosen = path
    },
  })
  realForChoose.onChooseItem('Assets/forest.png')
  check('真实弹窗选中后把路径交给回调', chosen === 'Assets/forest.png', String(chosen))

  // ---- 手打这条路仍然能用 ----
  plugin.setImagePickerFactory((_app, options) => ({ open: () => options.onChoose('unused') }))
  openSettings()
  await imageRow().text.type('Assets/手动粘贴.PNG')
  check(
    '手打路径（含大写扩展名）照样写进设置',
    imagePathInSettings() === 'Assets/手动粘贴.PNG',
    String(imagePathInSettings()),
  )
  openSettings()
  await imageRow().text.type('http://example.com/a.png')
  check('手打网址仍被拒（校验没有因为加了选择器而放松）', noteText().includes('只支持') || noteText().includes('网址'), noteText())
  check('被拒的输入不会写进设置', imagePathInSettings() === 'Assets/手动粘贴.PNG', String(imagePathInSettings()))

  plugin.onunload()
}

console.log('\n场景 30：自定义地形的两种模式（调色 / 图片）与旧数据迁移')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  app.vault.files.set('Assets/reef.png', '<png-bytes>')
  loadableImageUrls.add(resourceUrlFor('Assets/reef.png'))
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    onSubmit('')
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const doc = () => layers.getDocument(canvasPath)
  /** 当前覆盖层画布（每次插件实例挂载后都要重新取：新实例会插自己的一张） */
  const overlayCtxNow = () => {
    const element = canvas.canvasEl.children[0].children[0]
    attachFaithfulRect(element, canvas)
    return element._ctx
  }
  let ctx = overlayCtxNow()
  /** 本场景开始前的图集数（`createdCanvasContexts` 跨场景共享，断言必须只数自己新建的那些） */
  const atlasBaseline = createdCanvasContexts.length
  const atlasesSince = (baseline = atlasBaseline) => createdCanvasContexts.slice(baseline)
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  // 定义管理（A3）搬到了「地图定义」弹窗：模式控件对着弹窗取
  let defModal = null
  const openSettings = () => {
    FakeSetting.created.length = 0
    defModal = openDefinitionManager(plugin)
    return FakeSetting.created
  }
  const terrainOf = () => plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:reef')
  const modeRow = (label) =>
    collectByClass(defModal.contentEl, 'fc-terrain-mode').find((candidate) =>
      (collectByClass(candidate, 'fc-terrain-mode-title')[0]?.textContent ?? '').includes(label),
    )
  const modeButton = (label, mode) =>
    collectByClass(modeRow(label) ?? defModal.contentEl, 'fc-terrain-mode-button').find(
      (candidate) => candidate.dataset.mode === mode,
    )
  const switchMode = async (label, mode) => {
    openSettings()
    // 用 fireEvent 而不是 element.click()：假 DOM 的元素本身没有 click()，
    // 只有假 Setting 的控件对象才有（那是桩提供的便利方法）
    const button = modeButton(label, mode)
    if (button !== undefined) fireEvent(button, 'click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    openSettings()
  }
  /** 从某个基线之后新建的、贴过图片的图集（`createdCanvasContexts` 是跨场景共享的，必须切片） */
  const atlasesWithImage = (baseline) =>
    createdCanvasContexts.slice(baseline).filter((candidate) => candidate.images.some((entry) => entry.source?.__isFakeImage))

  // ---- 显式模式：两条路都填过时，模式决定画哪个 ----
  await plugin.addCustomTerrain({ id: 'reef', label: '礁石', color: '#2f6f8f', imagePath: 'Assets/reef.png', mode: 'color' })
  await settleEvents()
  check(
    '显式选了「调色」：即使配了图也保持调色模式（模式不是靠"有没有图"推断出来的）',
    terrainOf()?.mode === 'color' && terrainOf()?.imagePath === 'Assets/reef.png',
    JSON.stringify(terrainOf()),
  )

  // ---- 画一格（用工具条上的自定义地形按钮，走真实交互路径）----
  openSettings()
  check('每条自定义地形都有模式控件（两选一）', modeRow('礁石') !== undefined)
  check(
    '模式控件的两个选项是「调色」与「图片」，且当前选中的是调色',
    collectByClass(modeRow('礁石'), 'fc-terrain-mode-button').map((button) => button.dataset.mode).join(',') === 'color,image' &&
      modeButton('礁石', 'color')?.classList.contains('is-active') === true &&
      modeButton('礁石', 'image')?.classList.contains('is-active') === false,
    collectByClass(modeRow('礁石'), 'fc-terrain-mode-button')
      .map((button) => `${button.dataset.mode}:${button.classList.contains('is-active')}`)
      .join(' '),
  )
  check(
    '调色模式下同时显示字形与图片入口（图片入口永远可见 —— 藏起来用户就找不到）',
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.glyph('礁石'))) &&
      FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.image('礁石'))),
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name)),
  )

  // 走**真实交互路径**：侧栏「笔刷」里的自定义地形按钮（§F.2 之后调色板在侧栏）
  const panel = await openMapPanel(app, plugin)
  editor.setMode('paint')
  editor.setTool('brush')
  flushFrames()
  const customButton = () => inPanel(panel, 'fc-panel-terrain')[9]
  check('侧栏「笔刷」里出现了自定义地形的按钮（排在内置 9 种之后）', customButton() !== undefined)
  fireEvent(customButton(), 'click')
  clickAt({ x: -400, y: -200 })
  flushFrames()
  check('文件里存的是自定义 ID', Object.values(doc().terrain).some((cell) => cell.t === 'custom:reef'), JSON.stringify(doc().terrain))

  // ---- 调色模式：图片配着也不画 ----
  const baselineColor = createdCanvasContexts.length
  let calls = frame()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  check(
    '调色模式下那一帧不把图片贴进图集（配了图也不画）',
    atlasesWithImage(baselineColor).length === 0,
    `新建的图集数=${createdCanvasContexts.length - baselineColor}`,
  )
  check(
    '调色模式下画的是这个地形自己的颜色（地形格子画在离屏图集里，所以要查图集的填充色）',
    atlasesSince().some((atlas) => atlas.fills.some((fill) => fill.fillStyle === '#2f6f8f')),
    `新建的图集数=${atlasesSince().length} 填充色=${JSON.stringify([...new Set(atlasesSince().flatMap((atlas) => atlas.fills.map((fill) => fill.fillStyle)))])}`,
  )

  // ---- 切到图片模式：同一帧起改成画图片 ----
  const baselineImage = createdCanvasContexts.length
  await switchMode('礁石', 'image')
  check('切换后设置里是图片模式，并且已落盘', terrainOf()?.mode === 'image' && JSON.parse(plugin._data ?? '{}')?.customTerrains?.[0]?.mode === 'image', `${terrainOf()?.mode} / ${JSON.parse(plugin._data ?? '{}')?.customTerrains?.[0]?.mode}`)
  check(
    '图片模式下显示图片那一栏、不再显示字形（同一件事只在一个地方配置）',
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.image('礁石'))) &&
      !FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.glyph('礁石'))),
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name)),
  )
  frame()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  check(
    '切到图片模式后，那一帧真的把图片贴进了图集（模式改变视觉，所以图集必须重建）',
    atlasesWithImage(baselineImage).length > 0,
    `新建的图集数=${createdCanvasContexts.length - baselineImage}`,
  )

  // ---- 切回调色：不能丢配置 ----
  const baselineBack = createdCanvasContexts.length
  await switchMode('礁石', 'color')
  check(
    '切回调色后图片路径仍然留在设置里（来回切不会白配一遍）',
    terrainOf()?.mode === 'color' && terrainOf()?.imagePath === 'Assets/reef.png',
    JSON.stringify(terrainOf()),
  )
  frame()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  check('切回调色后那一帧又不再画图片', atlasesWithImage(baselineBack).length === 0, `新建的图集数=${createdCanvasContexts.length - baselineBack}`)

  // 等防抖落盘：迁移那一段要让新的插件实例从**文件**里读到这一格
  await new Promise((resolve) => setTimeout(resolve, 500))
  const saved = plugin._data
  plugin.onunload()

  // ---- 旧数据迁移：只有 imagePath、没有 mode（老版本写出来的 data.json）----
  // ⚠️ 定义随图（W4-1b）之后，"老 data.json 里的定义"只在**图还没有 definitions 段**时生效：
  // 有那一段的图以**文件**为准（方案 B）。所以这里先把上面那张图退回 v1（删掉 definitions 那一行），
  // 才是在测"老用户"的真实处境（图是旧的、定义只活在 data.json 里）。
  const mapText = app.vault.files.get('Maps/World.map.md') ?? ''
  app.vault.files.set('Maps/World.map.md', mapText.replace(/^\s*"definitions": .*$\n?/m, ''))
  check(
    '前提：退回 v1 之后图里没有 definitions 段',
    !(app.vault.files.get('Maps/World.map.md') ?? '').includes('"definitions"'),
    (app.vault.files.get('Maps/World.map.md') ?? '').slice(0, 120),
  )
  const legacyData = JSON.stringify({
    ...JSON.parse(saved ?? '{}'),
    customTerrains: [{ id: 'custom:reef', label: '礁石', color: '#2f6f8f', glyph: '', imagePath: 'Assets/reef.png' }],
  })
  const PluginClass = loadBundleAsCjs()
  const legacy = new PluginClass(app, { id: 'project-kaki' })
  legacy._data = legacyData
  await legacy.onload()
  check(
    '旧 data.json（没有 mode 字段）被迁移成图片模式，路径没有被弄丢',
    legacy.getSettings().customTerrains[0]?.mode === 'image' && legacy.getSettings().customTerrains[0]?.imagePath === 'Assets/reef.png',
    JSON.stringify(legacy.getSettings().customTerrains[0]),
  )
  runCommand(legacy, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 120))
  ctx = overlayCtxNow()
  const baselineLegacy = createdCanvasContexts.length
  ctx.resetCalls()
  canvas.markViewportChanged()
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 60))
  flushFrames()
  check(
    '迁移之后那一帧按图片绘制（端到端证据：不是只改了设置字段）',
    atlasesWithImage(baselineLegacy).length > 0,
    `新建的图集数=${createdCanvasContexts.length - baselineLegacy}`,
  )
  legacy.onunload()
}

console.log('\n场景 31：图片地形的「显示方式」（单格一张 / 整片一张）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  // 图片：假 `Image` 是 64×48（4:3），于是"不改变比例"可以被精确断言
  app.vault.files.set('Assets/forest.png', '<png-bytes>')
  loadableImageUrls.add(resourceUrlFor('Assets/forest.png'))
  app.vault.files.set('Assets/missing.png', '<png-bytes>')

  await plugin.addCustomTerrain({
    id: 'grove',
    label: '林地',
    color: '#336655',
    imagePath: 'Assets/forest.png',
    mode: 'image',
    imageLayout: 'region',
  })
  await plugin.addCustomTerrain({
    id: 'cellwood',
    label: '单格林',
    color: '#445533',
    imagePath: 'Assets/forest.png',
    mode: 'image',
    imageLayout: 'cell',
  })
  await plugin.addCustomTerrain({
    id: 'ghost',
    label: '缺图林',
    color: '#554433',
    imagePath: 'Assets/missing.png',
    mode: 'image',
    imageLayout: 'region',
  })

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = async () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    await new Promise((resolve) => setTimeout(resolve, 40))
    flushFrames()
    return ctx
  }
  const regionImages = () => ctx.images.filter((entry) => entry.source?.__isFakeImage)
  const centroid = (points) => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  })
  const boundsOfPoints = (points) => ({
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  })

  // ---- 两个相邻的「整片」格：应当只画一张图，且范围跨两格 ----
  doc().terrain['0_0'] = { t: 'custom:grove' }
  doc().terrain['1_0'] = { t: 'custom:grove' }
  let calls = await frame()
  check('整片模式：两个相邻格只算一块', stats().lastImageRegionCount === 1, String(stats().lastImageRegionCount))
  check('整片模式：这一帧只画了一张这种图', regionImages().length === 1, `图片绘制 ${regionImages().length} 次`)
  const regionDraw = regionImages()[0]
  const rect = regionDraw ? regionDraw.args.slice(-4) : null
  check('整片模式：图片绘制带完整目标矩形', Array.isArray(rect) && rect.length === 4, JSON.stringify(rect))
  if (rect) {
    const ratio = rect[2] / rect[3]
    check(
      '整片模式：保持图片比例（64:48，没有被拉伸铺满）',
      Math.abs(ratio - 64 / 48) < 1e-6,
      `目标矩形 ${rect[2]}×${rect[3]}，比例 ${ratio.toFixed(4)}，图片比例 ${(64 / 48).toFixed(4)}`,
    )
  }

  // ---- 裁剪：必须是两格六边形的并集（12 个顶点），并且盖住两格的格心 ----
  check('整片模式：确实用了裁剪（超出区域不渲染靠它）', calls.clips.length >= 1, `clip 调用 ${calls.clips.length} 次`)
  const clipPath = calls.clips.find((points) => points.length === 12)
  check(
    '整片模式：裁剪路径是两格六边形的并集（12 个顶点）',
    clipPath !== undefined,
    calls.clips.map((points) => points.length).join(','),
  )
  if (clipPath && rect) {
    const first = centroid(clipPath.slice(0, 6))
    const second = centroid(clipPath.slice(6))
    const clipBounds = boundsOfPoints(clipPath)
    check(
      '整片模式：图片范围覆盖两格的格心（不是只画了一格）',
      rect[0] <= first.x && rect[0] + rect[2] >= first.x && rect[0] <= second.x && rect[0] + rect[2] >= second.x,
      `图片 x=${rect[0].toFixed(1)} w=${rect[2].toFixed(1)}；格心 ${first.x.toFixed(1)} / ${second.x.toFixed(1)}`,
    )
    check(
      '整片模式：图片不超出裁剪范围（contain 的结果必须装得下）',
      rect[0] >= clipBounds.minX - 1e-6 &&
        rect[1] >= clipBounds.minY - 1e-6 &&
        rect[0] + rect[2] <= clipBounds.maxX + 1e-6 &&
        rect[1] + rect[3] <= clipBounds.maxY + 1e-6,
      `图片 ${rect.join(',')} vs 裁剪 ${JSON.stringify(clipBounds)}`,
    )
    check(
      '整片模式：裁剪范围比两格心距更宽（确实跨了两格）',
      clipBounds.maxX - clipBounds.minX > Math.abs(second.x - first.x),
      `裁剪宽 ${(clipBounds.maxX - clipBounds.minX).toFixed(1)}，两格心距 ${Math.abs(second.x - first.x).toFixed(1)}`,
    )
  }

  // ---- 不相邻的第三格：另起一块，于是第二张图 ----
  doc().terrain['8_8'] = { t: 'custom:grove' }
  calls = await frame()
  check('整片模式：不相邻的第三格另算一块', stats().lastImageRegionCount === 2, String(stats().lastImageRegionCount))
  check('整片模式：两块各画一张图', regionImages().length === 2, `图片绘制 ${regionImages().length} 次`)
  check(
    '整片模式：两张图的目标矩形不同（不是同一块画了两遍）',
    regionImages().length === 2 && JSON.stringify(regionImages()[0].args) !== JSON.stringify(regionImages()[1].args),
    JSON.stringify(regionImages().map((entry) => entry.args)),
  )

  // ---- `cell` 布局保持原样：逐格贴图（走图集），不走整片路径 ----
  // 注意：这个计数是**全局**的（前面那两片 grove 还在），所以要比增量，不能写死 0。
  // 第一版就是写死了 0 而误判（实现是对的）—— 见 ENGINEERING-NOTES §5.15。
  const regionsBeforeCell = stats().lastImageRegionCount
  doc().terrain['10_10'] = { t: 'custom:cellwood' }
  calls = await frame()
  check(
    '单格布局：不产生整片绘制（走图集逐格贴图）',
    stats().lastImageRegionCount === regionsBeforeCell,
    `${regionsBeforeCell} → ${stats().lastImageRegionCount}`,
  )
  check('单格布局：格子照常被画（帧里有格子）', stats().lastCellCount >= 1, String(stats().lastCellCount))

  // ---- 图片缺失：不回退成"整片空白"，而是逐格的颜色 + 字形 ----
  const regionsBeforeMissing = stats().lastImageRegionCount
  doc().terrain['20_20'] = { t: 'custom:ghost' }
  doc().terrain['21_20'] = { t: 'custom:ghost' }
  calls = await frame()
  check(
    '缺图时不做整片绘制（图片不可用）',
    stats().lastImageRegionCount === regionsBeforeMissing,
    `${regionsBeforeMissing} → ${stats().lastImageRegionCount}`,
  )
  const regionsBeforeGhost = stats().lastImageRegionCount
  check('缺图时格子仍然被画（回退到颜色 + 字形，不是留白）', stats().lastCellCount >= 2, String(stats().lastCellCount))
  check(
    '缺图的那两格没有让整片计数增加（它们没有图片可整片铺）',
    stats().lastImageRegionCount === regionsBeforeGhost,
    String(stats().lastImageRegionCount),
  )

  // ---- 平移时整片图片的尺寸不能变（包围盒必须来自整块，而不是"当前可见的那部分"）----
  // 这是一条**回归断言**：第一版用视口裁剪后的格子做连通块，于是跨出视口的那一片
  // 会被当成"更小的一片" —— 平移时整片图片跟着缩放/抖动。
  const LONG_IMAGE = 'Assets/forest2.png'
  app.vault.files.set(LONG_IMAGE, '<png-bytes-2>')
  loadableImageUrls.add(resourceUrlFor(LONG_IMAGE))
  await plugin.addCustomTerrain({
    id: 'longwood',
    label: '长林',
    color: '#2f5f4f',
    imagePath: LONG_IMAGE,
    mode: 'image',
    imageLayout: 'region',
  })
  // 一条在**基线时整条可见**、平移后**左端出界**的连通林带。
  //
  // ⚠️ 几何要被算准，否则这条断言没有鉴别力（我在这上面试了三次）：
  // - 若林带比视口还宽：可见部分永远被视口宽度限制，平移前后尺寸一样 → **空断言**；
  // - 若平移量太小、林带没出界：两次的可见集合相同 → 也是空断言；
  // - 只有"整条可见 → 平移后只剩一部分"时，用可见格当整块的 bug 才会让尺寸变小。
  for (let q = -12; q <= 2; q += 1) doc().terrain[`${q}_3`] = { t: 'custom:longwood' }
  calls = await frame()
  const longImage = FakeImage.instances.find((image) => image.src === resourceUrlFor(LONG_IMAGE))
  const longRectBefore = calls.images.find((entry) => entry.source === longImage)?.args.slice(-4) ?? null
  check('长林带：整片只画一张图', longRectBefore !== null, `画了 ${calls.images.filter((entry) => entry.source === longImage).length} 次`)

  // 向左平移：林带的左端被推出视口，只剩一部分可见
  canvas._applyViewport({ de: -400, df: 0, scaleFactor: 1 })
  calls = await frame()
  const longRectAfter = calls.images.find((entry) => entry.source === longImage)?.args.slice(-4) ?? null
  if (longRectBefore && longRectAfter) {
    check(
      '平移之后整片图片的尺寸不变（说明包围盒来自整块，而不是可见的那部分）',
      Math.abs(longRectAfter[2] - longRectBefore[2]) < 1e-6 && Math.abs(longRectAfter[3] - longRectBefore[3]) < 1e-6,
      `平移前 ${longRectBefore[2].toFixed(1)}×${longRectBefore[3].toFixed(1)} → 平移后 ${longRectAfter[2].toFixed(1)}×${longRectAfter[3].toFixed(1)}`,
    )
    check(
      '平移确实改变了它在画面上的位置（否则上面的断言没有鉴别力）',
      Math.abs(longRectAfter[0] - longRectBefore[0]) > 1,
      `${longRectBefore[0].toFixed(1)} → ${longRectAfter[0].toFixed(1)}`,
    )
  } else {
    check('平移之后长林带仍然被画出来', false, `平移后拿到 ${longRectAfter === null ? 'null' : '矩形'}`)
  }

  plugin.onunload()
}

console.log('\n场景 32：导出时自己选范围（用户：一个离主体很远的孤立格会把整张图缩小）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  const mapPath = 'Maps/World.map.md'
  const mapFile = app.vault.getAbstractFileByPath(mapPath)
  const loaded = await store.load(mapFile)
  const grid = loaded.document.grid
  check('默认网格是 pointy（下面的世界坐标换算依赖这一点）', grid.orientation === 'pointy', String(grid.orientation))

  // 主体：一块 200×200 的区域 + 一个标记
  // ⚠️ 地图层还没启用，此时 `layers.getDocument()` 是 null —— 内容先写进 `loaded.document`
  loaded.document.regions.push({ id: 'r1', label: '北境领', pts: [[0, 0], [200, 0], [200, 200], [0, 200]], color: '#44cf6e', opacity: 0.22 })
  loaded.document.markers.push({ id: 'm1', label: '龙脊城', p: [100, 100], icon: 'city' })

  // 远处那一格（用户问的正是这种"离主体很远的孤立格"）+ 一个跟它同处的远处标记。
  // 世界坐标用真实几何算：pointy 下 x = s·(√3·q + √3/2·r)，y = s·1.5·r
  const SQRT3 = Math.sqrt(3)
  const FAR_AXIAL = { q: 98, r: 150 }
  const farWorld = [
    grid.origin[0] + grid.size * (SQRT3 * FAR_AXIAL.q + (SQRT3 / 2) * FAR_AXIAL.r),
    grid.origin[1] + grid.size * 1.5 * FAR_AXIAL.r,
  ]
  check(
    '远处的孤立格确实很远（世界坐标 > 10000）',
    farWorld[0] > 10000 && farWorld[1] > 5000,
    farWorld.join(','),
  )
  loaded.document.terrain[`${FAR_AXIAL.q}_${FAR_AXIAL.r}`] = { t: 'forest' }
  loaded.document.markers.push({ id: 'm-far', label: '孤岛', p: farWorld, icon: 'tower' })
  await store.writeNow(mapFile, loaded.document, 'World', [canvasPath])
  await settleEvents()
  /** 地图层里的**活文档**（层启用之后才是它；导出读的就是这一份） */
  const doc = () => layers.getDocument(canvasPath)

  const commandById = (id) => plugin.commands.find((command) => command.id === id)
  const panelAction = (id) => plugin.getPanelActions().find((action) => action.id === id)
  /**
   * 从导出 SVG 里读某个标记的像素坐标。
   *
   * 导出坐标系的 viewBox 恒为 `0 0 1600 1000` —— 范围改变的是"世界 → 像素"的映射，
   * 所以"远处的东西被裁掉了"这件事只能从**像素坐标超出画布**看出来。
   */
  const markerPixel = (svg, id) => {
    // 标记可能是**字形**（`<g transform="translate(x,y) …">`）或**兜底圆点**（`<circle cx cy>`）——
    // 走哪个分支由"`iconSvgFor` 拿不拿得到图标片段"决定，这里两种都要能读出来
    const glyph = new RegExp(`data-row-id="map:marker:${id}" transform="translate\\(([-\\d.]+),([-\\d.]+)\\)`).exec(
      svg ?? '',
    )
    if (glyph) return { x: Number(glyph[1]), y: Number(glyph[2]) }
    const match = new RegExp(`data-row-id="map:marker:${id}" cx="([-\\d.]+)" cy="([-\\d.]+)"`).exec(svg ?? '')
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null
  }
  const inCanvas = (point) => point !== null && point.x >= 0 && point.x <= 1600 && point.y >= 0 && point.y <= 1000
  const svgFiles = () => [...app.vault.files.keys()].filter((key) => key.endsWith('.svg'))

  // ---- 命令面：一条新命令，两条旧命令都留着 ----
  check('注册了「导出地图…」命令（范围与格式在对话框里选）', commandById('export-map') !== undefined)
  check('新命令出现在地图面板的动作表里', panelAction('export-map') !== undefined)
  check(
    '保留旧的 SVG / PNG 快捷命令（老用户的手指记忆不作废）',
    commandById('export-map-svg') !== undefined && commandById('export-map-png') !== undefined,
  )
  check('未启用地图层时新命令的面板按钮是禁用的', panelAction('export-map')?.available?.() === false, String(panelAction('export-map')?.available?.()))

  // ---- 未启用地图层：明确提示，且**对话框根本不开** ----
  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    '没有启用地图层时给出明确提示',
    noticeLog.some((line) => line.includes(NOTICES.noExportableMap) || line.includes(NOTICES.layerEnabled)),
    noticeLog.join(' | '),
  )
  check('未启用时不产生任何文件', svgFiles().length === 0, svgFiles().join(','))

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('地图层已启用', doc() !== null)
  // 面板描述会随状态变（"需要先启用地图层" → 讲清三种范围），所以要在启用之后再问一次
  check(
    '启用地图层后面板描述里写明了三种范围',
    /全部内容/.test(panelAction('export-map')?.describe?.() ?? ''),
    String(panelAction('export-map')?.describe?.()),
  )

  // ---- 命令传进对话框的选项：范围三种、格式两种、区域来自地图数据 ----
  const capture = captureExportModals(plugin)
  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const options = capture.last()
  check('「导出地图…」打开的是导出对话框', options !== undefined)
  check(
    '对话框里有三种范围，且默认是「全部内容」（与以前的行为一致）',
    options?.ranges?.map((item) => item.kind).join(',') === 'all,viewport,region' && options?.initialRange?.kind === 'all',
    `${options?.ranges?.map((item) => item.kind).join(',')} / ${options?.initialRange?.kind}`,
  )
  check('对话框里有两种格式，且默认 SVG', options?.initialFormat === 'svg', String(options?.initialFormat))
  check(
    '区域列表来自地图上画过的区域',
    JSON.stringify(options?.regions) === JSON.stringify([{ id: 'r1', label: '北境领' }]),
    JSON.stringify(options?.regions),
  )
  /** 落点（保存位置 + 文件名）—— 这一段默认都用"地图所在目录 + 地图名" */
  const target = { folder: 'Maps', fileName: 'World' }
  const defaultPreview = options?.describe({ kind: 'all' }, 'svg', target)
  check(
    '默认摘要说的是「全部内容」并预告输出文件名（点之前就知道会多出哪个文件）',
    defaultPreview?.ok === true && defaultPreview.text.includes('全部内容') && defaultPreview.text.includes('Maps/World.svg'),
    JSON.stringify(defaultPreview),
  )

  // ---- 真对话框：假 DOM 里驱动它的下拉与按钮 ----
  const dropdownByRole = (role) =>
    FakeSetting.created
      .flatMap((setting) => setting.dropdowns ?? [])
      .filter((dropdown) => dropdown.selectEl?.dataset?.fcExportRole === role)
      .at(-1)
  const summaryEl = (modal) =>
    collectByClass(modal.contentEl, 'fc-export-summary').find(
      (el) => el.dataset?.fcExportRole === 'summary',
    ) ?? collectByClass(modal.contentEl, 'fc-export-summary')[0]
  /** 按稳定标记取两个输入框 / 浏览按钮（改文案不会让断言失效） */
  const textByRole = (role) =>
    FakeSetting.created
      .flatMap((setting) => setting.texts ?? [])
      .filter((text) => text.inputEl?.dataset?.fcExportRole === role)
      .at(-1)
  const browseButton = () =>
    FakeSetting.created
      .flatMap((setting) => setting.buttons ?? [])
      .filter((button) => button.buttonEl?.dataset?.fcExportRole === 'browse')
      .at(-1)
  /**
   * 导出按钮：取**最后一次渲染**里的那一个。
   *
   * 不能用 `find`：整块重建之后旧的按钮对象还在 `FakeSetting.created` 里，
   * 而"变灰"是画在**新**按钮上的 —— 取到旧的会让这条断言永远是 false（假失败）。
   */
  const exportButton = () =>
    FakeSetting.created
      .flatMap((setting) => setting.buttons ?? [])
      .filter((button) => (button.text ?? '').includes('导出'))
      .at(-1)
  const openRealModal = (modalOptions) => {
    FakeSetting.created.length = 0
    const modal = capture.defaultFactory(app, modalOptions)
    modal.open()
    return modal
  }

  const modal = openRealModal(options)
  check('对话框里有「范围」下拉', dropdownByRole('range') !== undefined)
  check('对话框里有「格式」下拉', dropdownByRole('format') !== undefined)
  check(
    '范围下拉的三个取值与顺序',
    dropdownByRole('range')?.options.map((item) => item.value).join(',') === 'all,viewport,region',
    dropdownByRole('range')?.options.map((item) => `${item.value}=${item.label}`).join(' | '),
  )
  check(
    '格式下拉的两个取值',
    dropdownByRole('format')?.options.map((item) => item.value).join(',') === 'svg,png',
    dropdownByRole('format')?.options.map((item) => item.value).join(','),
  )
  check('没选「某个区域」时不显示区域下拉（条件渲染）', dropdownByRole('region') === undefined)
  check(
    '摘要显示默认范围与输出文件名',
    (summaryEl(modal)?.textContent ?? '').includes('全部内容') && (summaryEl(modal)?.textContent ?? '').includes('Maps/World.svg'),
    String(summaryEl(modal)?.textContent),
  )
  check('合法范围下导出按钮可点', exportButton()?.disabled === false, String(exportButton()?.disabled))
  check('导出按钮是主按钮（setCta）', exportButton()?.cta === true)

  // ---- 落点：保存位置 + 文件名（用户要的"文件资源管理器一样的浏览功能"） ----
  check('对话框里有「保存位置」输入框', textByRole('folder') !== undefined)
  check('对话框里有「文件名」输入框', textByRole('fileName') !== undefined)
  check(
    '保存位置默认落在地图文件所在目录（没记录过时与加这个功能之前一致）',
    textByRole('folder')?.value === 'Maps',
    String(textByRole('folder')?.value),
  )
  check('文件名默认不带扩展名（扩展名跟着格式走）', textByRole('fileName')?.value === 'World', String(textByRole('fileName')?.value))
  check('对话框里有「浏览…」按钮', browseButton() !== undefined)

  // ---- 浏览：从库内文件夹里挑一个（候选是文件夹，不是文件） ----
  const pickerOptionsSeen = []
  const pickerFactoryBefore = plugin.imagePickerFactory
  plugin.setImagePickerFactory((_pickerApp, pickerOptions) => {
    pickerOptionsSeen.push(pickerOptions)
    return { open() {} }
  })
  await browseButton()?.click()
  await new Promise((resolve) => setTimeout(resolve, 10))
  check(
    '浏览按钮打开的是"选文件夹"的选择器',
    pickerOptionsSeen.at(-1)?.kind === 'folder',
    String(pickerOptionsSeen.at(-1)?.kind),
  )
  check(
    '候选里能看到库内文件夹（含库根）',
    Array.isArray(pickerOptionsSeen.at(-1)?.files) && pickerOptionsSeen.at(-1).files.includes('Maps'),
    JSON.stringify(pickerOptionsSeen.at(-1)?.files),
  )
  pickerOptionsSeen.at(-1)?.onChoose('导出')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('挑完之后保存位置就是那个文件夹', textByRole('folder')?.value === '导出', String(textByRole('folder')?.value))
  check(
    '摘要跟着换成新落点（改完立刻看得见）',
    (summaryEl(modal)?.textContent ?? '').includes('导出/World.svg'),
    String(summaryEl(modal)?.textContent).replace(/\n/g, ' | '),
  )
  plugin.setImagePickerFactory(pickerFactoryBefore)

  // ---- 非法文件名：摘要说明原因 + 导出按钮变灰（点不动比点了报错好） ----
  await textByRole('fileName')?.type('a/b')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('文件名里带斜杠时摘要直接说原因', /斜杠/.test(summaryEl(modal)?.textContent ?? ''), String(summaryEl(modal)?.textContent))
  check('文件名非法时导出按钮变灰', exportButton()?.disabled === true, String(exportButton()?.disabled))
  // 改回合法值 → 按钮重新可点（证明上一条不是"按钮永远不会亮"）
  await textByRole('fileName')?.type('World')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('文件名改回合法值后按钮重新可点', exportButton()?.disabled === false, String(exportButton()?.disabled))
  // 落点改回地图所在目录：下面几段断言仍然按 Maps/… 走（落点已单独验过）
  await textByRole('folder')?.type('Maps')
  await new Promise((resolve) => setTimeout(resolve, 10))

  // ---- 切到「某个区域」：区域下拉出现并默认选中第一个 ----
  const rangeDropdown = dropdownByRole('range')
  FakeSetting.created.length = 0
  await rangeDropdown.select('region')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check(
    '选「某个区域」后出现区域下拉，并默认选中第一个区域',
    dropdownByRole('region')?.value === 'r1',
    String(dropdownByRole('region')?.value),
  )
  check(
    '区域下拉里是地图上画过的区域',
    dropdownByRole('region')?.options.map((item) => item.value).join(',') === 'r1',
    dropdownByRole('region')?.options.map((item) => item.value).join(','),
  )
  const regionSummary = summaryEl(modal)?.textContent ?? ''
  check(
    '摘要换成该区域的范围，并预告带区域名的新文件名',
    regionSummary.includes('北境领') && regionSummary.includes('Maps/World-北境领.svg'),
    regionSummary.replace(/\n/g, ' | '),
  )

  // ---- 真导出（区域 + SVG）：这一对断言就是整个功能存在的理由 ----
  clearNotices()
  openedLinks.length = 0
  await exportButton().click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const regionSvg = app.vault.files.get('Maps/World-北境领.svg')
  check('按区域导出写出的文件名带上了区域名', typeof regionSvg === 'string', svgFiles().join(','))
  const nearInRegion = markerPixel(regionSvg, 'm1')
  const farInRegion = markerPixel(regionSvg, 'm-far')
  check('区域内的标记在画面里', inCanvas(nearInRegion), JSON.stringify(nearInRegion))
  check(
    '**远处的孤立格被裁到画面之外**（用户就是被这个坑到的）',
    farInRegion !== null && !inCanvas(farInRegion),
    JSON.stringify(farInRegion),
  )
  check('裁掉 ≠ 丢数据：远处的标记仍然被画出来，只是落在 viewBox 之外', (regionSvg ?? '').includes('map:marker:m-far'))
  // 用户的抱怨是"整张图会变得特别小"。把它量化：主体（选中的那个区域）在图里占多高。
  // 按区域导出时它应当几乎填满画布；按全部内容导出时它被远处那一格压成一条细缝。
  const regionPolygon = (svg, id) => {
    const match = new RegExp(`data-row-id="map:region:${id}" points="([^"]+)"`).exec(svg ?? '')
    if (!match) return null
    return match[1].split(' ').map((pair) => ({ x: Number(pair.split(',')[0]), y: Number(pair.split(',')[1]) }))
  }
  const spanY = (points) => (points ? Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)) : 0)
  const regionSpanInRegion = spanY(regionPolygon(regionSvg, 'r1'))
  check(
    '选中的区域几乎填满了画布（这就是"自己选范围"要达到的效果）',
    regionSpanInRegion >= 600,
    `区域在图里高 ${regionSpanInRegion.toFixed(0)} / 1000 px`,
  )
  check(
    '提示里写清了这次用的是哪个范围',
    noticeLog.some((line) => line.includes('北境领') && line.includes(NOTICES.svgExportedPrefix)),
    noticeLog.join(' | '),
  )
  check('导出成功后对话框自己关掉', modal.contentEl.children.length === 0, String(modal.contentEl.children.length))

  // ---- 对照：快捷命令仍然是「全部内容」（老行为不变） ----
  await runCommand(plugin, 'export-map-svg')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const allSvg = app.vault.files.get('Maps/World.svg')
  check('快捷命令仍然导「全部内容」（文件名不带范围后缀）', typeof allSvg === 'string', svgFiles().join(','))
  check(
    '同一份内容：全部内容时远处的标记在画面里（证明上一条不是"它本来就在外面"）',
    inCanvas(markerPixel(allSvg, 'm-far')),
    JSON.stringify(markerPixel(allSvg, 'm-far')),
  )
  const regionSpanInAll = spanY(regionPolygon(allSvg, 'r1'))
  check(
    '**而按「全部内容」导出时同一块区域被压成一条细缝**（用户说的"整张图缩小"）',
    regionSpanInAll > 0 && regionSpanInAll <= 100,
    `区域在图里高 ${regionSpanInAll.toFixed(0)} / 1000 px`,
  )

  // ---- 范围＝「当前视口」：画一帧拿到可见世界矩形，再放一个"正好在正中"的标记 ----
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  canvas.markViewportChanged()
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flushFrames()
  const visible = layers.listStatus()[0]?.stats?.lastVisibleWorld ?? null
  check(
    '画过一帧之后记下了可见世界矩形（「当前视口」这个范围靠它）',
    visible !== null && visible.maxX > visible.minX && visible.maxY > visible.minY,
    JSON.stringify(visible),
  )
  const visibleCenter = visible ? { x: (visible.minX + visible.maxX) / 2, y: (visible.minY + visible.maxY) / 2 } : { x: 0, y: 0 }
  doc().markers.push({ id: 'm-center', label: '视口中心', p: [visibleCenter.x, visibleCenter.y], icon: 'city' })
  doc().markers.push({ id: 'm-corner', label: '视口角落', p: [visible?.minX ?? 0, visible?.minY ?? 0], icon: 'city' })

  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const viewportOptions = capture.last()
  check(
    '视口范围的摘要给出的是一块真实尺寸的范围',
    viewportOptions?.describe({ kind: 'viewport' }, 'svg', target)?.ok === true,
    JSON.stringify(viewportOptions?.describe({ kind: 'viewport' }, 'svg', target)),
  )
  const viewportModal = openRealModal(viewportOptions)
  const viewportRangeDropdown = dropdownByRole('range')
  FakeSetting.created.length = 0
  await viewportRangeDropdown.select('viewport')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check(
    '视口范围的摘要里带上了尺寸',
    /当前视口/.test(summaryEl(viewportModal)?.textContent ?? '') && /世界单位/.test(summaryEl(viewportModal)?.textContent ?? ''),
    String(summaryEl(viewportModal)?.textContent).replace(/\n/g, ' | '),
  )
  // 尺寸必须是**那块可见矩形**的尺寸（+留白）：与"全部内容"的尺寸完全不同，
  // 所以这条也能鉴别"范围被忽略、还是按全部内容算的"
  const expectedSpan = visible
    ? { w: Math.round(visible.maxX - visible.minX + 64), h: Math.round(visible.maxY - visible.minY + 64) }
    : null
  check(
    '摘要里的尺寸就是可见世界矩形的尺寸（而不是全部内容的尺寸）',
    expectedSpan !== null && (summaryEl(viewportModal)?.textContent ?? '').includes(`${expectedSpan.w} × ${expectedSpan.h}`),
    `${JSON.stringify(expectedSpan)} / ${String(summaryEl(viewportModal)?.textContent).replace(/\n/g, ' | ')}`,
  )
  clearNotices()
  await exportButton().click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const viewportSvg = app.vault.files.get('Maps/World-视口.svg')
  check('视口范围导出到带「-视口」后缀的文件', typeof viewportSvg === 'string', svgFiles().join(','))
  // "可见区域的正中"必须落在图片正中 —— 这条只有映射真的用了可见矩形才成立
  // （与画布长宽比无关：内容始终在图片里居中，所以中心点永远映射到 padding + 内区/2）
  const centerPixel = markerPixel(viewportSvg, 'm-center')
  check(
    '可见区域的正中落在图片正中（映射真的用了可见矩形）',
    centerPixel !== null && Math.abs(centerPixel.x - 800) < 1 && Math.abs(centerPixel.y - 500) < 1,
    JSON.stringify(centerPixel),
  )
  check(
    '可见矩形的一角也在画面里（视口范围内的东西不会被裁掉）',
    inCanvas(markerPixel(viewportSvg, 'm-corner')),
    JSON.stringify(markerPixel(viewportSvg, 'm-corner')),
  )
  // 同一张地图、同一个标记，按「全部内容」再导一次：它不该落在正中
  // （`Maps/World.svg` 已经被前面那次快捷导出占了，所以这里会是 `-2`）
  await runCommand(plugin, 'export-map-svg')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const allCenterPixel = markerPixel(app.vault.files.get('Maps/World-2.svg'), 'm-center')
  check(
    '同一张地图按「全部内容」导出时它不在正中（证明上一条不是恒真的）',
    allCenterPixel === null || Math.abs(allCenterPixel.x - 800) > 1 || Math.abs(allCenterPixel.y - 500) > 1,
    JSON.stringify(allCenterPixel),
  )

  // ---- 范围也要流进 PNG（PNG 就是同一张 SVG 的光栅化） ----
  const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const seenSvgs = []
  plugin.setPngRasterizer({
    createImage: () => ({ src: '', complete: false, naturalWidth: 8, onload: null, onerror: null }),
    waitForImage: async (image) => {
      seenSvgs.push(image.src)
      return true
    },
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    toBlob: async () => ({ arrayBuffer: async () => pngMagic.buffer.slice(0) }),
  })
  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const pngOptions = capture.last()
  const pngModal = openRealModal(pngOptions)
  const pngRangeDropdown = dropdownByRole('range')
  FakeSetting.created.length = 0
  await pngRangeDropdown.select('region')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const pngFormatDropdown = dropdownByRole('format')
  FakeSetting.created.length = 0
  await pngFormatDropdown.select('png')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check(
    '切换格式后摘要里的文件名跟着变成 .png',
    (summaryEl(pngModal)?.textContent ?? '').includes('Maps/World-北境领.png'),
    String(summaryEl(pngModal)?.textContent).replace(/\n/g, ' | '),
  )
  await exportButton().click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    '区域 + PNG 也按同样的范围命名',
    app.vault.binaryFiles.has('Maps/World-北境领.png'),
    [...app.vault.binaryFiles.keys()].join(','),
  )
  const decodedPngSvg = seenSvgs.length > 0 ? decodeURIComponent(String(seenSvgs.at(-1)).replace(/^data:[^,]*,/, '')) : ''
  check(
    'PNG 复用的是按区域取景的那张 SVG（远处标记在画面外）',
    decodedPngSvg.includes('map:marker:m-far') && !inCanvas(markerPixel(decodedPngSvg, 'm-far')),
    JSON.stringify(markerPixel(decodedPngSvg, 'm-far')),
  )

  // ---- 光栅化失败：对话框留在原地（用户正好可以改用 SVG），而且只给一条提示 ----
  plugin.setPngRasterizer({
    createImage: () => ({ src: '', complete: false, naturalWidth: 8, onload: null, onerror: null }),
    waitForImage: async () => true,
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    toBlob: async () => null,
  })
  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const failModal = openRealModal(capture.last())
  const failFormatDropdown = dropdownByRole('format')
  FakeSetting.created.length = 0
  await failFormatDropdown.select('png')
  await new Promise((resolve) => setTimeout(resolve, 10))
  await exportButton().click()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const failNotices = noticeLog.filter((line) => line.includes(NOTICES.pngFailedPrefix))
  check('光栅化不可用时给出可读原因', failNotices.length === 1 && failNotices[0].includes('toBlob'), noticeLog.join(' | '))
  check('失败只提示一次（不在对话框里重复一遍）', failNotices.length === 1, String(failNotices.length))
  check('失败时对话框留在原地（可以换个格式再试）', failModal.contentEl.children.length > 0, String(failModal.contentEl.children.length))
  plugin.setPngRasterizer(null)

  // ---- 守门在导出那一侧：对话框可以被绕过，导出必须自己再判断一次 ----
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const guardOptions = capture.last()
  const beforeGuard = svgFiles().length
  clearNotices()
  await guardOptions.onExport({ kind: 'region', regionId: 'gone' }, 'svg', target)
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(
    '区域已被删掉时给出可读原因（找不到，而不是堆栈）',
    noticeLog.some((line) => line.includes('无法导出') && line.includes('找不到') && !/undefined|Error\b/.test(line)),
    noticeLog.join(' | '),
  )
  check('这种失败不产生文件', svgFiles().length === beforeGuard, svgFiles().join(','))
  const badPreview = guardOptions.describe({ kind: 'region', regionId: 'gone' }, 'svg', target)
  check(
    '对话框侧同样判为不可导出（按钮会变灰）',
    badPreview?.ok === false && /找不到/.test(badPreview.reason),
    JSON.stringify(badPreview),
  )
  // ---- 守门也在落点那一侧：合法范围 + 非法文件名 ⇒ 不产出文件 ----
  const beforeBadTarget = svgFiles().length
  clearNotices()
  await guardOptions.onExport({ kind: 'all' }, 'svg', { folder: 'Maps', fileName: '   ' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(
    '空文件名时导出这一侧自己再判一次：给出可读原因且不产出文件',
    noticeLog.some((line) => line.includes('无法导出') && line.includes('保存位置或文件名')) && svgFiles().length === beforeBadTarget,
    noticeLog.join(' | '),
  )

  // ---- 一张还没画过区域的地图：区域下拉为空、摘要给出原因、导出按钮变灰 ----
  const regionsBackup = doc().regions.splice(0, doc().regions.length)
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const emptyOptions = capture.last()
  check('没有区域时对话框照常打开（而不是拒绝打开）', emptyOptions !== undefined && emptyOptions.regions.length === 0, JSON.stringify(emptyOptions?.regions))
  const emptyModal = openRealModal(emptyOptions)
  const emptyRangeDropdown = dropdownByRole('range')
  FakeSetting.created.length = 0
  await emptyRangeDropdown.select('region')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check(
    '没有区域时摘要直接显示原因（而不是给一张空图）',
    /还没有区域/.test(summaryEl(emptyModal)?.textContent ?? ''),
    String(summaryEl(emptyModal)?.textContent),
  )
  check('没有区域时摘要带上了"有问题"的样式', collectByClass(emptyModal.contentEl, 'is-problem').length === 1)
  check('没有区域时导出按钮变灰（点不动比点了报错好）', exportButton()?.disabled === true, String(exportButton()?.disabled))
  check('区域下拉此时是空的', (dropdownByRole('region')?.options ?? []).length === 0)
  // 绕过对话框直接导（按钮虽然灰了，但导出这一侧必须自己再判一次）
  const beforeEmptyGuard = svgFiles().length
  clearNotices()
  await emptyOptions.onExport({ kind: 'region' }, 'svg', target)
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(
    '没有区域时按区域导出：给出可读原因，且不产出文件',
    noticeLog.some((line) => line.includes('无法导出') && line.includes('还没有区域')) && svgFiles().length === beforeEmptyGuard,
    noticeLog.join(' | '),
  )
  doc().regions.push(...regionsBackup)

  // ---- 记住上次用的目录：导出成功之后，下一次打开对话框拿到的就是它 ----
  const folderPickerCalls = []
  plugin.setImagePickerFactory((_pickerApp, pickerOptions) => {
    folderPickerCalls.push(pickerOptions)
    return {
      open() {
        pickerOptions.onChoose('导出')
      },
    }
  })
  clearNotices()
  await runCommand(plugin, 'export-map')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const rememberOptions = capture.last()
  check(
    '导出过之后记住了上次的目录（写进插件设置，不进地图文件）',
    plugin.getSettings().exportFolder === 'Maps',
    String(plugin.getSettings().exportFolder),
  )
  check(
    '下次打开对话框时默认落点就是上次那个目录',
    rememberOptions?.initialFolder === 'Maps',
    String(rememberOptions?.initialFolder),
  )
  // 换一个目录、真导一次：文件应当真的写到新落点（而不只是界面上换了字）
  const rememberModal = openRealModal(rememberOptions)
  await browseButton()?.click()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await exportButton()?.click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    '浏览选中的目录真的成为落点：文件写到该目录下',
    typeof app.vault.files.get('导出/World.svg') === 'string',
    svgFiles().join(','),
  )
  check(
    '填的是一个还不存在的目录时，导出先把它建出来（对话框上就是这么承诺的）',
    app.vault.createdFolders.includes('导出'),
    JSON.stringify(app.vault.createdFolders),
  )
  check(
    '导出成功后记住的是新目录',
    plugin.getSettings().exportFolder === '导出',
    String(plugin.getSettings().exportFolder),
  )
  check('对话框关掉了（成功才关）', rememberModal.contentEl.children.length === 0, String(rememberModal.contentEl.children.length))
  plugin.setImagePickerFactory(pickerFactoryBefore)

  capture.restore()
  plugin.onunload()
}

console.log('\n场景 33：自定义标记图标（设置 → 工具条 → 放置对话框 → 画布 DOM → 文件 → 回退）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  // 一张能加载的图 + 一张"文件在库里但解不开"的图（后者覆盖回退路径）
  app.vault.files.set('Assets/lighthouse.png', '<png-bytes>')
  loadableImageUrls.add(resourceUrlFor('Assets/lighthouse.png'))
  // 故意用 files.set 而不是 setContent：后者会登记资源地址（= 能加载成功），
  // 而这里要的正是"文件在库里、但浏览器解不开"这条分支
  app.vault.files.set('Assets/gone.png', 'this-is-not-an-image')

  const plugin = await loadPlugin(app)
  // 真实的放置对话框工厂要在替换之前抓下来：`setPlaceModalFactory` 会把插件里那个字段换掉，
  // 之后 `plugin.placeModalFactory` 拿到的就是我们自己的替身（那个只有 open，没有 close）
  const realPlaceFactory = plugin.placeModalFactory
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })

  // 文件里先放一个"本机设置里没有"的图标：它必须被**保留**并在画布上画出回退视觉。
  // 这条走的是完整的 文件 → 解析 → 画布 路径（单测覆盖的是解析层本身）。
  const seeded = await store.load(file)
  seeded.document.markers.push({ id: 'm-foreign', label: '外来标记', p: [-300, -160], icon: 'spaceship' })
  await store.writeNow(file, seeded.document, 'World', [canvasPath])
  await settleEvents()

  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    onSubmit('')
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const doc = () => layers.getDocument(canvasPath)
  const markerLayerEl = () => collectByClass(wrapper, 'fc-marker-layer')[0]
  const markerElFor = (id) => collectByClass(markerLayerEl(), 'fc-marker').find((el) => el.dataset.fcId === id)
  const iconElFor = (id) => collectByClass(markerElFor(id), 'fc-marker-icon')[0]
  /** 该标记的图标框里挂着的图片元素（图片模式才应该非空） */
  const imagesIn = (id) => (iconElFor(id)?.children ?? []).filter((child) => child.__isFakeImage === true)
  // A3：自定义标记的增删改搬到了「地图定义」弹窗（设置页里只剩参数默认值）
  let defModal = null
  const openSettings = () => {
    FakeSetting.created.length = 0
    defModal = openDefinitionManager(plugin)
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 自定义标记区底部那一行就地提示（按 `dataset.fcNote` 取，见 DefinitionManagerModal） */
  const markerNoteText = () =>
    collectByClass(defModal.contentEl, 'fc-settings-note').find((el) => el.dataset?.fcNote === 'marker')
      ?.textContent ?? ''
  const markerRow = (label) =>
    collectByClass(defModal.contentEl, 'fc-terrain-mode').find((candidate) =>
      (collectByClass(candidate, 'fc-terrain-mode-title')[0]?.textContent ?? '').includes(label),
    )
  const markerModeButton = (label, mode) =>
    collectByClass(markerRow(label) ?? defModal.contentEl, 'fc-terrain-mode-button').find(
      (candidate) => candidate.dataset.mode === mode,
    )
  const switchMarkerMode = async (label, mode) => {
    openSettings()
    const button = markerModeButton(label, mode)
    if (button !== undefined) fireEvent(button, 'click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    openSettings()
  }
  // §F.2：标记图标也搬进了侧栏「工具」一节（只在标记工具下出现）
  const panel = await openMapPanel(app, plugin)
  const iconButtons = () => inPanel(panel, 'fc-panel-icon')
  const frame = () => {
    canvas.markViewportChanged()
    flushFrames()
  }

  // ------------------------------------------- 「地图定义」弹窗：新增（A3 从设置页搬来）
  openSettings()
  const addMarkerSetting = settingNamed(DEFINITION_MODAL_LABELS.addMarker)
  check('「地图定义」弹窗里有「新增自定义标记」一节', addMarkerSetting !== undefined)
  check(
    '新增区有 ID 与显示名两个控件',
    (addMarkerSetting?.texts?.length ?? 0) === 2,
    `texts=${addMarkerSetting?.texts?.length}`,
  )
  check(
    '手填 ID 的规则搬进了输入框的悬停提示（不再占「新增」那一大段说明）',
    (addMarkerSetting?.texts?.[0]?.inputEl?.title ?? '').includes('custom:'),
    String(addMarkerSetting?.texts?.[0]?.inputEl?.title),
  )

  // 非法 ID：当场给原因，且**不能**写进设置
  await addMarkerSetting.texts[0].type('Bad Id!')
  check('非法标记 ID 就地给出可读原因', markerNoteText().includes('ID'), markerNoteText())
  await addMarkerSetting.button.click()
  check(
    '非法 ID 点「新增」不会写进设置',
    plugin.getSettings().customMarkers.length === 0,
    JSON.stringify(plugin.getSettings().customMarkers),
  )

  // 合法 ID：新增成功
  await addMarkerSetting.texts[0].type('LightHouse')
  await addMarkerSetting.texts[1].type('灯塔')
  await addMarkerSetting.button.click()
  const addedMarkers = plugin.getSettings().customMarkers
  check(
    '新增的自定义标记 ID 收敛为 custom:lighthouse（小写 + 自动前缀）',
    addedMarkers.length === 1 && addedMarkers[0].id === 'custom:lighthouse',
    JSON.stringify(addedMarkers),
  )
  check(
    '显示名与 ID 分离存储，且默认是「字形」模式',
    addedMarkers[0]?.label === '灯塔' && addedMarkers[0]?.mode === 'glyph',
    JSON.stringify(addedMarkers[0]),
  )
  check(
    '自定义标记已落盘（真实 JSON 往返）',
    JSON.parse(plugin._data ?? '{}')?.customMarkers?.[0]?.id === 'custom:lighthouse',
    String(plugin._data).slice(0, 200),
  )

  // 重复 ID 必须被拒绝
  openSettings()
  const addDupMarker = settingNamed(DEFINITION_MODAL_LABELS.addMarker)
  await addDupMarker.texts[0].type('LIGHTHOUSE')
  await addDupMarker.button.click()
  check(
    '重复 ID（大小写不同）被拒绝',
    plugin.getSettings().customMarkers.length === 1,
    JSON.stringify(plugin.getSettings().customMarkers),
  )

  // 第二个标记：用来走图片模式（含"从字形切到图片"的自动切换）
  openSettings()
  const addMarker2 = settingNamed(DEFINITION_MODAL_LABELS.addMarker)
  await addMarker2.texts[0].type('beacon')
  await addMarker2.texts[1].type('灯标')
  await addMarker2.button.click()
  check('两个自定义标记都在设置里', plugin.getSettings().customMarkers.length === 2, JSON.stringify(plugin.getSettings().customMarkers.map((m) => m.id)))

  // 字形一栏与图片一栏在**两种模式下都要在**（藏起来用户就找不到入口 —— 实测反馈过）
  openSettings()
  check(
    '字形模式下同时显示字形与图片入口',
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.glyph('灯塔'))) &&
      FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.image('灯塔'))),
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name)),
  )
  check(
    '每条自定义标记都有模式控件（两选一），当前选中的是字形',
    markerModeButton('灯塔', 'glyph')?.classList.contains('is-active') === true &&
      markerModeButton('灯塔', 'image')?.classList.contains('is-active') === false,
    String(markerRow('灯塔')?.textContent),
  )
  // 字形下拉：给「灯塔」借用 tower 的字形（设置页里真的选一次）
  openSettings()
  const glyphSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.glyph('灯塔')))
  check('字形那一栏是下拉框', glyphSetting?.dropdown !== undefined)
  check(
    '字形下拉里有「通用」与全部内置图标',
    (glyphSetting?.dropdown?.options ?? []).length === 10 &&
      glyphSetting?.dropdown?.options?.[0]?.value === '' &&
      (glyphSetting?.dropdown?.options ?? []).some((option) => option.value === 'tower'),
    JSON.stringify(glyphSetting?.dropdown?.options),
  )
  await glyphSetting.dropdown.select('tower')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '选完字形后设置里记的是它（且已落盘）',
    plugin.getSettings().customMarkers[0]?.icon === 'tower' &&
      JSON.parse(plugin._data ?? '{}')?.customMarkers?.[0]?.icon === 'tower',
    JSON.stringify(plugin.getSettings().customMarkers[0]),
  )

  // ---------------------------------------------------------- 侧栏「工具」里的标记图标
  editor.setMode('paint')
  editor.setTool('marker')
  flushFrames()
  check(
    '侧栏「工具」出现内置 9 种 + 2 个自定义标记',
    iconButtons().length === 11,
    iconButtons().map((button) => button.title).join(','),
  )
  check(
    '自定义标记排在内置之后，且带 is-custom（一眼能区分）',
    iconButtons().slice(9).every((button) => button.classList.contains('is-custom')) &&
      iconButtons().slice(0, 9).every((button) => !button.classList.contains('is-custom')),
    iconButtons().map((button) => `${button.title}:${button.classList.contains('is-custom')}`).join(' '),
  )
  check(
    '自定义标记按钮的悬停提示里带着完整 ID（界面上要能分清哪个是哪个）',
    iconButtons()[9]?.title?.includes('custom:lighthouse'),
    String(iconButtons()[9]?.title),
  )
  check(
    '自定义标记按钮上带显示名（字形可能只是通用圆点，光看图分不出来）',
    collectByClass(iconButtons()[9], 'fc-panel-icon-glyph').length === 1 &&
      (iconButtons()[9]?.children.some((child) => child.textContent === '灯塔') ?? false),
    String(iconButtons()[9]?.textContent),
  )

  // ---------------------------------------------------------- 画布：外来图标被保留并回退
  frame()
  const foreignIcon = iconElFor('m-foreign')
  check('地图里未知图标的标记仍然被画出来（不丢弃、不消失）', foreignIcon !== undefined)
  check(
    '未知图标画的是回退字形（circle-dot），而不是随机图标',
    foreignIcon?.dataset.icon === 'circle-dot',
    String(foreignIcon?.dataset.icon),
  )
  check(
    '未知图标在文档里仍然是原值（改写成 town = 下次保存就永久改了用户数据）',
    doc().markers.find((marker) => marker.id === 'm-foreign')?.icon === 'spaceship',
    JSON.stringify(doc().markers.map((marker) => marker.icon)),
  )

  // ---------------------------------------------------------- 放置对话框（真实那一个）
  const placeModalOptions = []
  plugin.setPlaceModalFactory((_app, options) => {
    placeModalOptions.push(options)
    // 模拟用户在图标下拉里选了自定义标记
    options.onSubmit({ label: '白色灯塔', icon: 'custom:lighthouse', link: '' })
    return { open() {} }
  })
  editor.setMode('paint')
  editor.setTool('marker')
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  clickAt({ x: -300, y: 120 })
  frame()
  const placed = doc().markers.find((marker) => marker.label === '白色灯塔')
  check(
    '放置的标记写进文件的是自定义 ID',
    placed?.icon === 'custom:lighthouse',
    JSON.stringify(doc().markers.map((marker) => marker.icon)),
  )
  check(
    '放置对话框拿到了当前自定义标记（下拉里才会有它们）',
    placeModalOptions.at(-1)?.getCustomMarkers?.().length === 2,
    String(placeModalOptions.at(-1)?.getCustomMarkers?.().length),
  )

  // 真对话框：下拉里必须列出内置与自定义，且值一律是原始 ID
  const placeOptions = placeModalOptions.at(-1)
  const realPlaceModal = realPlaceFactory(app, { ...placeOptions, initialIcon: 'custom:gone' })
  FakeSetting.created.length = 0
  realPlaceModal.open()
  const placeDropdown = FakeSetting.created.flatMap((setting) => setting.dropdowns ?? []).at(-1)
  check(
    '放置对话框的图标下拉里有内置 9 种与自定义标记',
    (placeDropdown?.options ?? []).some((option) => option.value === 'city') &&
      (placeDropdown?.options ?? []).filter((option) => option.value === 'custom:lighthouse').length === 1 &&
      (placeDropdown?.options ?? []).filter((option) => option.value === 'custom:beacon').length === 1,
    JSON.stringify(placeDropdown?.options),
  )
  check(
    '自定义标记在下拉里用的是显示名，值是原始 ID（界面文字与数据解耦）',
    placeDropdown?.options?.find((option) => option.value === 'custom:beacon')?.label === '灯标',
    JSON.stringify(placeDropdown?.options?.find((option) => option.value === 'custom:beacon')),
  )
  check(
    '当前图标已被删掉时下拉里补一个「未知」项（否则 setValue 会静默落回第一项，看着像"图标自己换了"）',
    (placeDropdown?.options ?? []).some((option) => option.value === 'custom:gone' && /未定义类型/.test(option.label)) &&
      (placeDropdown?.options ?? []).length === 12,
    JSON.stringify(placeDropdown?.options),
  )
  realPlaceModal.close()

  // ---------------------------------------------------------- 画布 DOM：字形模式
  const glyphIcon = iconElFor(placed?.id)
  check(
    '自定义标记在画布上画出借来的字形（字形模式）',
    glyphIcon?.dataset.icon === 'tower-control',
    String(glyphIcon?.dataset.icon),
  )
  check('字形模式下不挂图片元素', imagesIn(placed?.id).length === 0, String(imagesIn(placed?.id).length))

  // ---------------------------------------------------------- 切到图片模式
  openSettings()
  const beaconImageText = FakeSetting.created
    .filter((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.image('灯标')))
    .flatMap((setting) => setting.texts ?? [])[0]
  await beaconImageText.type('Assets/lighthouse.png')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const beacon = () => plugin.getSettings().customMarkers.find((marker) => marker.id === 'custom:beacon')
  check(
    '填了图片路径就自动切到图片模式（否则用户会以为"填了没反应"）',
    beacon()?.mode === 'image' && beacon()?.imagePath === 'Assets/lighthouse.png',
    JSON.stringify(beacon()),
  )
  check(
    '工具条跟着更新（按目录签名重建，不需要重开画布）',
    iconButtons().length === 11 && imagesIn(placed?.id).length === 0,
    String(iconButtons().length),
  )

  // 放一个用自定义图片图标的标记
  editor.setMode('paint')
  editor.setTool('marker')
  plugin.setPlaceModalFactory((_app, options) => {
    options.onSubmit({ label: '灯标一号', icon: 'custom:beacon', link: '' })
    return { open() {} }
  })
  clickAt({ x: 120, y: 120 })
  frame()
  const beaconMarker = doc().markers.find((marker) => marker.label === '灯标一号')
  const beaconIconEl = iconElFor(beaconMarker?.id)
  check(
    '图片模式的自定义标记在画布上画的是图片（`<img>` 挂在图标框里）',
    imagesIn(beaconMarker?.id).length === 1,
    `children=${JSON.stringify((beaconIconEl?.children ?? []).map((child) => child.className ?? child.tagName))}`,
  )
  check(
    '图片的 src 来自库资源地址（渲染层不认识 vault，地址是注入进去的）',
    imagesIn(beaconMarker?.id)[0]?.src === resourceUrlFor('Assets/lighthouse.png'),
    String(imagesIn(beaconMarker?.id)[0]?.src),
  )
  check(
    '图片元素带 fc-marker-image 类（CSS 里靠它做等比缩放，不拉伸）',
    imagesIn(beaconMarker?.id)[0]?.className === 'fc-marker-image',
    String(imagesIn(beaconMarker?.id)[0]?.className),
  )
  check(
    '图片不可被浏览器原生拖拽（否则按住标记拖动会变成拖图片，指针链断掉）',
    imagesIn(beaconMarker?.id)[0]?.draggable === false,
    String(imagesIn(beaconMarker?.id)[0]?.draggable),
  )
  check(
    '图片模式下字形被清掉（两套视觉不能叠着画）',
    beaconIconEl?.dataset.icon === undefined && (beaconIconEl?.textContent ?? '') === '',
    `${String(beaconIconEl?.dataset.icon)} / ${String(beaconIconEl?.textContent)}`,
  )

  // ---------------------------------------------------------- 图片加载失败 → 回退字形
  const warnBaseline = warnLog.length
  openSettings()
  const beaconImageText2 = FakeSetting.created
    .filter((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.image('灯标')))
    .flatMap((setting) => setting.texts ?? [])[0]
  await beaconImageText2.type('Assets/gone.png')
  await new Promise((resolve) => setTimeout(resolve, 30))
  frame()
  await new Promise((resolve) => setTimeout(resolve, 30))
  frame()
  check(
    '图片解不开时回退到字形（标记不会因为图挂了就消失）',
    imagesIn(beaconMarker?.id).length === 0 && iconElFor(beaconMarker?.id)?.dataset.icon === 'circle-dot',
    `${String(iconElFor(beaconMarker?.id)?.dataset.icon)} / images=${imagesIn(beaconMarker?.id).length}`,
  )
  const failWarnings = warnLog.slice(warnBaseline).filter((line) => line.includes('标记图片加载失败'))
  check('失败必须在控制台留下可读原因', failWarnings.length === 1, warnLog.slice(warnBaseline).join(' | '))
  check('坏路径只尝试一次（不在每帧重复撞 404）', failWarnings.length === 1, String(failWarnings.length))
  const fakeImagesAfterFail = FakeImage.instances.filter((image) => image.src === resourceUrlFor('Assets/gone.png')).length
  frame()
  frame()
  check(
    '后续帧不再新建图片元素（否则每帧一次 404 + 每帧一条日志）',
    FakeImage.instances.filter((image) => image.src === resourceUrlFor('Assets/gone.png')).length === fakeImagesAfterFail,
    `${fakeImagesAfterFail} → ${FakeImage.instances.filter((image) => image.src === resourceUrlFor('Assets/gone.png')).length}`,
  )

  // ---------------------------------------------------------- 切回字形：图片元素必须被摘掉
  await switchMarkerMode('灯标', 'glyph')
  const beaconAfterSwitch = beacon()
  check(
    '切回字形后图片路径仍然留着（来回切不会白配一遍）',
    beaconAfterSwitch?.mode === 'glyph' && beaconAfterSwitch?.imagePath === 'Assets/gone.png',
    JSON.stringify(beaconAfterSwitch),
  )
  frame()
  check(
    '切回字形后 `<img>` 被真的摘掉，且字形画回来',
    imagesIn(beaconMarker?.id).length === 0 && iconElFor(beaconMarker?.id)?.dataset.icon === 'circle-dot',
    `${String(iconElFor(beaconMarker?.id)?.dataset.icon)} / images=${imagesIn(beaconMarker?.id).length}`,
  )

  // ---------------------------------------------------------- 删除定义：数据不动，画布回退
  openSettings()
  const deleteSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.name('灯塔')))
  const beforeDeleteIcons = iconButtons().length
  await deleteSetting.buttons.find((button) => button.text === MODAL_ACTIONS.delete).click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '删除定义后设置里没有它了',
    !plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:lighthouse'),
    JSON.stringify(plugin.getSettings().customMarkers.map((marker) => marker.id)),
  )
  flushFrames()
  check('侧栏「工具」里的图标跟着减少', iconButtons().length === beforeDeleteIcons - 1, `${beforeDeleteIcons} → ${iconButtons().length}`)
  frame()
  check(
    '被删掉定义的标记仍然画在画布上（回退字形，而不是消失）',
    iconElFor(placed?.id)?.dataset.icon === 'circle-dot',
    String(iconElFor(placed?.id)?.dataset.icon),
  )
  check(
    '地图文件里的自定义 ID 没被改动',
    doc().markers.find((marker) => marker.id === placed?.id)?.icon === 'custom:lighthouse',
    JSON.stringify(doc().markers.map((marker) => marker.icon)),
  )

  // ---------------------------------------------------------- 落盘往返：外来 ID 必须原样写回
  store.scheduleSave(file, doc(), 'World', [canvasPath])
  await store.flush()
  await settleEvents()
  const savedText = app.vault.files.get(file.path) ?? ''
  check('落盘后的文件里仍然有外来图标名', savedText.includes('spaceship'), savedText.match(/"icon":[^,}]*/g)?.join(' ') ?? '')
  check('落盘后的文件里仍然有自定义 ID', savedText.includes('custom:lighthouse'), savedText.match(/"icon":[^,}]*/g)?.join(' '))
  const reloaded = await store.load(file)
  check(
    '重新解析后图标一个都没变（这轮往返就是"保存会不会删数据"的答案）',
    reloaded.document?.markers.find((marker) => marker.id === 'm-foreign')?.icon === 'spaceship' &&
      reloaded.document?.markers.find((marker) => marker.id === placed?.id)?.icon === 'custom:lighthouse',
    JSON.stringify(reloaded.document?.markers.map((marker) => marker.icon)),
  )
  check(
    '重新解析时外来图标会给出可读告警（用户排查时看得见）',
    reloaded.issues.some((issue) => issue.level === 'warning' && issue.message.includes('已保留') && issue.message.includes('spaceship')),
    JSON.stringify(reloaded.issues.map((issue) => issue.message)),
  )

  plugin.onunload()
}

console.log('\n场景 34：路径类型目录（自定义类型参数 → 工具条下拉 → 画布 → 文件；未知类型不再丢数据）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })

  /**
   * 文件里先塞一条**别的版本写下的**未知类型路径。
   *
   * 这一条是 ⑤-1 最重要的回归：旧版本 `parsePath` 遇到不认识的 type 会把整条路径丢掉，
   * 用户打开一次别人的地图再保存，那条路就永久消失了。这里让它走完整的
   * 「文件 → 解析 → 画布 → 保存 → 再解析」一圈。
   */
  const FALLBACK_PATH_COLOR = '#9aa4ad'
  const seeded = await store.load(file)
  seeded.document.paths.push({
    id: 'p-foreign',
    type: 'spaceship-lane',
    pts: [[-900, -700], [-500, -600]],
    width: 6,
    color: '#ff00ff',
  })
  await store.writeNow(file, seeded.document, 'World', [canvasPath])
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  /** 画一条路径（跳过命名），返回刚提交的那条 */
  const drawPath = (x0, y0, x1, y1) => {
    editor.setMode('paint')
    editor.setTool('path')
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x1, y: y1 })
    clickAt({ x: x1, y: y1 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('')
    flushFrames()
    return doc().paths[doc().paths.length - 1]
  }
  const openSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    noteHost = plugin.settingTabs[0].containerEl
    return FakeSetting.created
  }
  /**
   * 打开「地图定义」弹窗（A3：路径类型的**增删改**搬到了这里；**参数行**仍在设置页）。
   *
   * 两侧各有一条 `dataset.fcNote === 'pathType'` 的就地提示，所以 `pathNote()` 跟着
   * 最后一次打开的宿主走 —— 不然"非法 ID"与"非法虚线"这两条断言会读到对方的提示元素。
   */
  let defModal = null
  let noteHost = plugin.settingTabs[0].containerEl
  const openDefModal = () => {
    FakeSetting.created.length = 0
    defModal = openDefinitionManager(plugin)
    noteHost = defModal.contentEl
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 当前宿主（设置页或弹窗）底部那一行路径类型就地提示（按 `dataset.fcNote` 取） */
  const pathNote = () =>
    collectByClass(noteHost, 'fc-settings-note').find((el) => el.dataset?.fcNote === 'pathType')?.textContent ?? ''
  // ⚠️ 自绘下拉（ToolbarDropdown）随 §F.2 搬家退休：侧栏用原生 <select> + 当前类型色块。
  // 查询辅助（pathSelect / pathOptions / pathOption / pathSwatch）在**用到的那一节**里定义 ——
  // 那时面板已经打开、编辑器也切到了路径工具（否则面板里根本没有那一行）。

  const entryOf = (id) => plugin.getSettings().pathTypes.find((entry) => entry.id === id)
  /** 某一帧里所有描边中用到的颜色（用来断言"这条路径画成了什么颜色"） */
  const strokeColors = () => frame().groups.map((group) => group.strokeStyle)

  // ---------------------------------------------------------- 定义弹窗：内置 4 种都有参数行
  // W4-1b（定义随图）之后，路径类型的**参数**从设置页搬进了「地图定义」弹窗
  // （它们现在是"这张地图的那一套"），所以这一节对着弹窗取控件。
  openDefModal()
  check(
    '内置 4 种路径各有参数行（颜色 + 端点 + 连接）',
    ['河流', '道路', '贸易路线', '边界'].every((label) => {
      const setting = FakeSetting.created.find((item) => item.info.name === DEFINITION_ROW_LABELS.appearance(label))
      return (setting?.colorPickers?.length ?? 0) === 1 && (setting?.dropdowns?.length ?? 0) === 2
    }),
  )
  check(
    '端点/连接下拉带出当前值（出厂 round/round）',
    (settingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns ?? []).map((dropdown) => dropdown.value).join(',') === 'round,round',
    JSON.stringify((settingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns ?? []).map((dropdown) => dropdown.value)),
  )
  check(
    '端点下拉里有三个选项（平头/圆头/方头）',
    (settingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns?.[0]?.options ?? []).map((option) => option.value).join(',') === 'butt,round,square',
    JSON.stringify(settingNamed(DEFINITION_ROW_LABELS.appearance('河流'))?.dropdowns?.[0]?.options),
  )
  check(
    '线宽/虚线两行带出当前值（河流：8、实线）',
    settingNamed(DEFINITION_ROW_LABELS.widthDash('河流'))?.texts?.[0]?.value === '8' && settingNamed(DEFINITION_ROW_LABELS.widthDash('河流'))?.texts?.[1]?.value === '',
    `${String(settingNamed(DEFINITION_ROW_LABELS.widthDash('河流'))?.texts?.[0]?.value)} / ${String(settingNamed(DEFINITION_ROW_LABELS.widthDash('河流'))?.texts?.[1]?.value)}`,
  )
  check('道路的虚线带出来了（14,10）', settingNamed(DEFINITION_ROW_LABELS.widthDash('道路'))?.texts?.[1]?.value === '14,10', String(settingNamed(DEFINITION_ROW_LABELS.widthDash('道路'))?.texts?.[1]?.value))

  // ---------------------------------------------------------- 改参数 → 只影响之后新画的
  await settingNamed(DEFINITION_ROW_LABELS.widthDash('河流')).texts[0].type('20')
  check('线宽写进目录', entryOf('river')?.params.width === 20, JSON.stringify(entryOf('river')?.params))
  await settingNamed(DEFINITION_ROW_LABELS.appearance('河流')).dropdowns[0].select('butt')
  check('端点样式写进目录', entryOf('river')?.params.cap === 'butt', JSON.stringify(entryOf('river')?.params))
  check('改端点不影响其它字段（线宽还是 20）', entryOf('river')?.params.width === 20)
  check(
    '旧字段 pathColors 与目录保持一致',
    plugin.getSettings().pathColors.river === entryOf('river')?.params.color,
    JSON.stringify(plugin.getSettings().pathColors),
  )

  const riverPath = drawPath(-500, -200, -200, -100)
  check('新画的河流用了新线宽', riverPath.width === 20, String(riverPath.width))
  check('新画的河流把端点样式**存进了文件**（改设置不会影响它）', riverPath.cap === 'butt' && riverPath.join === 'round', JSON.stringify({ cap: riverPath.cap, join: riverPath.join }))
  const riverStrokes = frame().groups.filter((group) => group.strokeStyle === entryOf('river')?.params.color)
  check(
    '端点样式真的画在了画布上（ctx.lineCap = butt）',
    riverStrokes.length > 0 && riverStrokes.every((group) => group.lineCap === 'butt'),
    JSON.stringify(riverStrokes.map((group) => group.lineCap)),
  )
  check(
    '已经画好的路径不受设置影响（种子那条宽度仍是 6）',
    doc().paths.find((path) => path.id === 'p-foreign')?.width === 6,
    JSON.stringify(doc().paths.find((path) => path.id === 'p-foreign')),
  )

  // 草稿预览也要用当前类型的端点样式：选的类型是"平头"却在预览里画成圆头，松手一变又是所见非所得
  editor.setMode('paint')
  editor.setTool('path')
  clickAt({ x: -900, y: 200 })
  const draftStrokes = frame().groups.filter((group) => group.strokeStyle === entryOf('river')?.params.color)
  check(
    '草稿预览也用当前类型的端点样式',
    draftStrokes.length > 0 && draftStrokes.every((group) => group.lineCap === 'butt'),
    JSON.stringify(draftStrokes.map((group) => group.lineCap)),
  )
  editor.setMode('select')

  // 非法虚线：就地给原因，且**不写进设置**（静默回退到出厂值会让用户以为填的生效了）
  // 参数控件在「地图定义」弹窗里，所以这里对着弹窗取（它的提示行与新增区共用同一条 `fcNote`）
  openDefModal()
  const riverDashBefore = entryOf('river')?.params.dash.join(',')
  await settingNamed(DEFINITION_ROW_LABELS.widthDash('河流')).texts[1].type('1')
  check('奇数段虚线被拒绝并给出原因', pathNote().includes('偶数'), pathNote())
  check('非法虚线没有改写目录', entryOf('river')?.params.dash.join(',') === riverDashBefore, String(entryOf('river')?.params.dash.join(',')))

  // ------------------------------- 自定义路径类型：新增（A3 从设置页搬进「地图定义」弹窗）
  openDefModal()
  const addSetting = settingNamed(DEFINITION_MODAL_LABELS.addPathType)
  check('「地图定义」弹窗里有「新增自定义路径类型」一节', addSetting !== undefined)
  check('新增区有 ID / 显示名 / 线宽 / 虚线四个文本框 + 一个颜色选择器', (addSetting?.texts?.length ?? 0) === 4 && (addSetting?.colorPickers?.length ?? 0) === 1, `texts=${addSetting?.texts?.length} pickers=${addSetting?.colorPickers?.length}`)
  check(
    '手填 ID 的规则搬进了输入框的悬停提示（不再占「新增」那一大段说明）',
    (addSetting?.texts?.[0]?.inputEl?.title ?? '').includes('custom:'),
    String(addSetting?.texts?.[0]?.inputEl?.title),
  )

  await addSetting.texts[0].type('Bad Id!')
  check('非法类型 ID 就地给出可读原因', pathNote().includes('ID'), pathNote())
  await addSetting.button.click()
  check(
    '非法 ID 点「新增」不会写进设置',
    plugin.getSettings().pathTypes.length === 4,
    JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)),
  )

  await addSetting.texts[0].type('HighWay')
  await addSetting.texts[1].type('官道')
  await addSetting.colorPickers[0].pick('#00aa88')
  await addSetting.texts[2].type('7')
  await addSetting.texts[3].type('12,4')
  await addSetting.button.click()
  check(
    '新增的自定义类型 ID 收敛为 custom:highway（小写 + 自动前缀）',
    entryOf('custom:highway') !== undefined,
    JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)),
  )
  check(
    '显示名/颜色/线宽/虚线都按填的存下来了',
    JSON.stringify(entryOf('custom:highway')?.params) ===
      JSON.stringify({ color: '#00aa88', width: 7, dash: [12, 4], taper: false, smooth: false, cap: 'round', join: 'round' }),
    JSON.stringify(entryOf('custom:highway')?.params),
  )
  check(
    '自定义类型已落盘（真实 JSON 往返）',
    JSON.parse(plugin._data ?? '{}')?.pathTypes?.some((entry) => entry.id === 'custom:highway'),
    String(plugin._data).slice(0, 160),
  )

  // 重复 ID（大小写不同）必须被拒绝：同一个 ID 两条定义说不清该用哪条
  openDefModal()
  await settingNamed(DEFINITION_MODAL_LABELS.addPathType).texts[0].type('highway')
  await settingNamed(DEFINITION_MODAL_LABELS.addPathType).button.click()
  check('重复 ID 被拒绝', plugin.getSettings().pathTypes.filter((entry) => entry.id === 'custom:highway').length === 1)

  // ---------------------------------------------------------- 侧栏「工具」里的路径类型
  // §F.2：类型选择从浮窗的**自绘下拉**搬进侧栏，改成原生 `<select>` + 当前类型的色块。
  // 于是"点外面收起 / 拦下那一击 / 展开时挂全局监听"这一组断言的对象（自绘菜单与它的
  // document 捕获监听）**不存在了**：原生选单没有全局监听，也不可能把一击漏到画布上
  // （面板与画布在不同的叶子里，事件根本到不了画布的宿主）。
  // 换成同样可判伪的三条：选项来自目录、显示名与 ID 解耦、色块跟着当前类型走。
  const panel = await openMapPanel(app, plugin)
  editor.setMode('paint')
  editor.setTool('path')
  flushFrames()
  const pathSelect = () => inPanel(panel, 'fc-panel-type-select').find((el) => el.dataset.fcPathType === '1')
  const pathOptions = () => pathSelect()?.children ?? []
  const pathOption = (id) => pathOptions().find((option) => option.value === id)
  const pathSwatch = () => inPanel(panel, 'fc-panel-type-swatch').find((el) => el.dataset.fcPathSwatch === '1')
  check(
    '侧栏路径类型下拉里是内置 4 种 + 自定义（数一数）',
    pathOptions().length === 5,
    JSON.stringify(pathOptions().map((option) => option.value)),
  )
  check(
    '选项用 ID 作值、显示名可读（界面文字与数据解耦）',
    pathOption('custom:highway') !== undefined && (pathOption('custom:highway').textContent ?? '').includes('官道'),
    String(pathOption('custom:highway')?.textContent),
  )
  check('下拉带出编辑器当前类型', pathSelect()?.value === 'river', String(pathSelect()?.value))
  // 用户操作就是原生 select 的 change
  pathSelect().value = 'custom:highway'
  fireEvent(pathSelect(), 'change')
  check('选中项就是编辑器当前类型', editor.getStatus().pathType === 'custom:highway', editor.getStatus().pathType)
  flushFrames()
  check('当前类型的色块跟着换成它的颜色', pathSwatch()?.style.backgroundColor === '#00aa88', String(pathSwatch()?.style.backgroundColor))
  check('下拉的当前值也是它', pathSelect()?.value === 'custom:highway', String(pathSelect()?.value))

  // 用自定义类型画一条：颜色/线宽/虚线都来自目录，并且都存进文件
  const customPath = drawPath(-200, 400, 300, 500)
  check('新路径的 type 就是自定义 ID', customPath.type === 'custom:highway', String(customPath.type))
  check(
    '画法参数来自目录（颜色/线宽/虚线）',
    customPath.color === '#00aa88' && customPath.width === 7 && JSON.stringify(customPath.dash) === JSON.stringify([12, 4]),
    JSON.stringify({ color: customPath.color, width: customPath.width, dash: customPath.dash }),
  )
  check('画布上用目录里的颜色描边', strokeColors().includes('#00aa88'), JSON.stringify(strokeColors()))

  // ---------------------------------------------------------- 图例跟随目录
  await plugin.setShowLegend(true)
  frame()
  const legendRows = () => collectByClass(wrapper, 'fc-legend-row')
  check(
    '图例里有自定义类型（只遍历内置会漏掉用户自己建的类型）',
    legendRows().some((row) => (row.textContent ?? '').includes('官道')),
    JSON.stringify(legendRows().map((row) => row.textContent)),
  )
  check(
    '图例里未知类型也在（按 ID 字母序排在内置之后）',
    legendRows().some((row) => (row.textContent ?? '').includes(unknownTypeLabel('spaceship-lane'))),
    JSON.stringify(legendRows().map((row) => row.textContent)),
  )
  check(
    '图例里内置类型仍按 PATH_TYPES 的顺序在前',
    legendRows()
      .filter((row) => row.dataset.kind === 'path')
      .map((row) => collectByClass(row, 'fc-legend-label')[0]?.textContent)
      .slice(0, 2)
      .join(',') === '河流,官道',
    JSON.stringify(legendRows().filter((row) => row.dataset.kind === 'path').map((row) => row.textContent)),
  )
  await plugin.setShowLegend(false)

  // ---------------------------------------------------------- 未知类型：画布回退 + 数据不丢
  check(
    '打开时未知类型的路径还在文档里',
    doc().paths.some((path) => path.type === 'spaceship-lane'),
    JSON.stringify(doc().paths.map((path) => path.type)),
  )
  check(
    '未知类型的路径照样被画出来（用的还是文件里存的那个颜色，不是被换成别的）',
    strokeColors().includes('#ff00ff'),
    JSON.stringify(strokeColors()),
  )
  store.scheduleSave(file, doc(), 'World', [canvasPath])
  await store.flush()
  await settleEvents()
  const savedText = app.vault.files.get(file.path) ?? ''
  check('落盘后的文件里仍然有未知类型', savedText.includes('spaceship-lane'), savedText.match(/"type":"[^"]*"/g)?.join(' ') ?? '')
  check('落盘后的文件里仍然有自定义类型', savedText.includes('custom:highway'))
  const reloaded = await store.load(file)
  check(
    '重新解析后两条路径一个都没少（这轮往返就是"保存会不会删数据"的答案）',
    reloaded.document?.paths.length === doc().paths.length &&
      reloaded.document?.paths.some((path) => path.type === 'spaceship-lane') &&
      reloaded.document?.paths.some((path) => path.type === 'custom:highway'),
    JSON.stringify(reloaded.document?.paths.map((path) => path.type)),
  )
  check(
    '重新解析时未知类型会给出可读告警（用户排查时看得见）',
    reloaded.issues.some((issue) => issue.level === 'warning' && issue.message.includes('已保留') && issue.message.includes('spaceship-lane')),
    JSON.stringify(reloaded.issues.map((issue) => issue.message)),
  )
  check(
    '端点/连接样式经文件往返仍然保留',
    reloaded.document?.paths.find((path) => path.type === 'custom:highway') !== undefined,
  )

  // ---------------------------------------------------------- Base 行也用目录里的名字
  {
    const registration = plugin.basesViews[0]?.registration
    const baseContainer = makeEl({ className: 'bases-view-container' })
    const baseView = registration.factory({ type: 'bases' }, baseContainer)
    baseView.config = makeBasesConfig({ mapFile: file.path, sortBy: 'name' })
    baseView.data = { data: [] }
    baseView.onDataUpdated()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const rowText = collectByClass(baseContainer, 'fc-base-row')
      .map((row) => row.textContent ?? '')
      .join(' | ')
    check('Base 行里显示的是目录里的显示名（不是冷冰冰的 custom:highway）', rowText.includes('官道'), rowText.slice(0, 300))
    check(
      'Base 行里未知类型显示为「未定义类型（ID）」（与图例同一套解析）',
      rowText.includes(unknownTypeLabel('spaceship-lane')),
      rowText.slice(0, 300),
    )
  }

  // ---------------------------------------------------------- 删除定义：数据不动，画布回退
  openDefModal()
  const deleteSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('官道') && (setting.buttons ?? []).some((button) => button.text === MODAL_ACTIONS.delete))
  check('自定义类型那两行里有一行带「删除」按钮（内置类型没有）', deleteSetting !== undefined)
  check(
    '内置类型行里没有「删除」按钮',
    !(FakeSetting.created.find((setting) => setting.info.name === '河流')?.buttons ?? []).some((button) => button.text === MODAL_ACTIONS.delete),
  )
  // 这条自定义类型**已经被画到地图上过**（上面那条 custom:highway），所以属于"有引用"：
  // A3 要求这时先弹影响面确认框；这里捕获它、看清影响面，再在框里确认删除。
  const deletes = captureDeleteModals(plugin)
  const optionsBeforeDelete = pathOptions().length
  await deleteSetting.buttons.find((button) => button.text === MODAL_ACTIONS.delete).click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('有地图引用它时先弹确认框，而不是直接删', deletes.opened.length === 1, `弹了 ${deletes.opened.length} 次`)
  check(
    '此刻定义**还没**被删（删不删由用户在对话框里决定）',
    plugin.getSettings().pathTypes.some((entry) => entry.id === 'custom:highway'),
    JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)),
  )
  const outcome = await deletes.last()?.onConfirm?.()
  check('在确认框里点删除之后才真的删掉', outcome?.ok === true, JSON.stringify(outcome))
  deletes.restore()
  check(
    '删除后设置里没有它了',
    plugin.getSettings().pathTypes.every((entry) => entry.id !== 'custom:highway'),
    JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)),
  )
  frame()
  check(
    '侧栏下拉里那条自定义类型已经消失（只剩内置 4 种 + 一条「未知」占位）',
    pathOptions().filter((option) => option.value !== 'custom:highway').length === optionsBeforeDelete - 1,
    `${optionsBeforeDelete} → ${pathOptions().map((option) => option.value).join(',')}`,
  )
  check(
    '当前类型被删掉后，下拉补一条「未定义类型（custom:highway）」并保持选中（不退回第一项）',
    pathSelect()?.value === 'custom:highway' && (pathOption('custom:highway')?.textContent ?? '').includes('未定义类型'),
    `${String(pathSelect()?.value)} / ${String(pathOption('custom:highway')?.textContent)}`,
  )
  check(
    '被删掉定义的路径仍然在文档里（数据没被连带删除）',
    doc().paths.some((path) => path.type === 'custom:highway'),
    JSON.stringify(doc().paths.map((path) => path.type)),
  )
  check(
    '已经画好的那条仍然用文件里的颜色画出来（数据驱动，不因为设置里没定义就消失）',
    strokeColors().includes('#00aa88'),
    JSON.stringify(strokeColors()),
  )
  check(
    '当前类型的色块换成回退色（未知类型也必须看得见，不能是透明）',
    pathSwatch()?.style.backgroundColor === FALLBACK_PATH_COLOR,
    String(pathSwatch()?.style.backgroundColor),
  )
  // 定义没了还接着画：新路径必须拿到**回退参数**（这是"未知类型不消失"的另一半）
  const orphanPath = drawPath(-700, 600, -300, 700)
  check(
    '定义被删掉后新画的路径用回退参数（颜色/线宽/虚线都来自目录的兜底）',
    orphanPath.type === 'custom:highway' &&
      orphanPath.color === FALLBACK_PATH_COLOR &&
      orphanPath.width === 4 &&
      JSON.stringify(orphanPath.dash) === JSON.stringify([12, 8]),
    JSON.stringify({ type: orphanPath.type, color: orphanPath.color, width: orphanPath.width, dash: orphanPath.dash }),
  )

  // ---------------------------------------------------------- 上限
  const atLimit = []
  for (let index = 0; plugin.getSettings().pathTypes.filter((entry) => entry.id.startsWith('custom:')).length < 32; index += 1) {
    atLimit.push(await plugin.addCustomPathType({ id: `filler${index}` }))
  }
  check('加到 32 个都成功', atLimit.every((result) => result.ok), JSON.stringify(atLimit.filter((result) => !result.ok)))
  const overflow = await plugin.addCustomPathType({ id: 'onemore' })
  check(
    '超过上限时给出明确原因（不静默失败）',
    overflow.ok === false && overflow.problem.includes('32'),
    JSON.stringify(overflow),
  )
  openDefModal()
  check(
    '达到上限时弹窗里写明「已达上限」',
    (settingNamed(DEFINITION_MODAL_LABELS.addPathType)?.info.desc ?? '').includes('已达上限'),
    settingNamed(DEFINITION_MODAL_LABELS.addPathType)?.info.desc,
  )

  plugin.onunload()
}

console.log('\n场景 35：旧 data.json 迁移到路径类型目录（用户没改过的东西视觉必须一模一样）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  // 上一代的设置：只有 pathColors / regionColors（各改过一个颜色），没有任何目录字段。
  // 区域那条是 ⑤-2 的迁移回归：旧字段只读一次，之后目录是唯一来源。
  plugin._data = JSON.stringify({
    labelScale: 1,
    pathColors: { river: '#ff0000', road: 'var(--x)' },
    regionColors: ['#111111', '#222222', '#333333'],
  })
  await plugin.onload()
  const settings = plugin.getSettings()
  const river = settings.pathTypes.find((entry) => entry.id === 'river')
  check('迁移后颜色进目录（老用户改过的颜色没丢）', river?.params.color === '#ff0000', JSON.stringify(river?.params))
  check('非法旧颜色回退出厂色', settings.pathTypes.find((entry) => entry.id === 'road')?.params.color === '#b08968')
  check(
    '结构字段仍取出厂值（迁移前后视觉一致）',
    river?.params.width === 8 && river?.params.taper === true && river?.params.smooth === true && river?.params.cap === 'round',
    JSON.stringify(river?.params),
  )
  check(
    '旧字段 pathColors 被镜像成同一份颜色（回退旧版插件也看得到）',
    settings.pathColors.river === '#ff0000' && settings.pathColors.border === '#b3452f',
    JSON.stringify(settings.pathColors),
  )
  // ---- 区域类型的迁移（⑤-2）----
  const duchy = settings.regionTypes.find((entry) => entry.id === 'duchy')
  check(
    '旧 regionColors 按下标迁进区域类型目录（老用户改过的区域颜色没丢）',
    settings.regionTypes[0]?.params.color === '#111111' &&
      settings.regionTypes[1]?.params.color === '#222222' &&
      duchy?.params.color === '#333333',
    JSON.stringify(settings.regionTypes.map((entry) => [entry.id, entry.params.color])),
  )
  check(
    '区域的结构字段仍取出厂值（迁移前后视觉一致：不透明度 0.22、边框宽 3、边框色跟随填充色）',
    duchy?.params.opacity === 0.22 &&
      duchy?.params.borderWidth === 3 &&
      duchy?.params.borderColor === null &&
      JSON.stringify(duchy?.params.borderDash) === '[]',
    JSON.stringify(duchy?.params),
  )
  check(
    '没写到的下标仍然是出厂色（迁移不会把别的类型一起改掉）',
    settings.regionTypes[5]?.params.color === '#4a9fd8',
    String(settings.regionTypes[5]?.params.color),
  )
  check(
    '旧字段 regionColors 被镜像成同一份颜色（长度 = 内置 6 种）',
    JSON.stringify(settings.regionColors) === JSON.stringify(['#111111', '#222222', '#333333', '#e0de71', '#8b8b8b', '#4a9fd8']),
    JSON.stringify(settings.regionColors),
  )
  await plugin.saveData(settings)
  const once = JSON.stringify(plugin.getSettings())
  // 再走一遍归一化（模拟"再次启动"）：必须完全相同（幂等）
  await plugin.onload()
  check('迁移是幂等的：第二次加载结果完全相同', JSON.stringify(plugin.getSettings()) === once)
  check('目录里内置 4 种齐全', plugin.getSettings().pathTypes.length === 4, JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)))
  check(
    '目录里内置 6 种区域类型齐全',
    plugin.getSettings().regionTypes.length === 6,
    JSON.stringify(plugin.getSettings().regionTypes.map((entry) => entry.id)),
  )
  plugin.onunload()
}

console.log('\n场景 36：定义文件的导入与导出（面板按钮 + 命令 → 库内文件 → 确认对话框 → 设置）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const commandById = (id) => plugin.commands.find((command) => command.id === id)
  const panelAction = (id) => plugin.getPanelActions().find((action) => action.id === id)
  const persisted = () => (plugin._data === null ? null : JSON.parse(plugin._data))
  const jsonFiles = () => [...app.vault.files.keys()].filter((key) => key.endsWith('.json'))
  const fileText = (path) => app.vault.files.get(path)
  const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  /** 替身选择器：记下 options，并按剧本回调（与场景 29 同一套路） */
  const makePickerDouble = (choice) => {
    const calls = []
    const factory = (_app, options) => {
      calls.push(options)
      return {
        open() {
          if (choice !== undefined) options.onChoose(choice)
        },
      }
    }
    return { factory, calls }
  }

  // ---- 入口：一个动作同时变成面板按钮与命令（不许两份实现） ----
  check('注册了「导出定义文件…」命令', commandById('export-resource-bundle') !== undefined)
  // 命令名是用户搜索与判断"导出带不带我那些定义"的唯一线索：加了新的一类定义却不写进名字里，
  // 用户就只能靠猜（区域类型这次就是这么被漏掉过一次）
  check(
    '导出命令的名字里列全了四类定义（含区域类型）',
    ['地形', '标记', '路径类型', '区域类型'].every((word) =>
      (commandById('export-resource-bundle')?.name ?? '').includes(word),
    ),
    String(commandById('export-resource-bundle')?.name),
  )
  check('注册了「导入定义文件…」命令', commandById('import-resource-bundle') !== undefined)
  check(
    'getPanelActions()（面板真正画的那一份）里已经没有这两个动作',
    plugin
      .getPanelActions()
      .every((action) => action.id !== 'export-resource-bundle' && action.id !== 'import-resource-bundle'),
    plugin.getPanelActions().filter((action) => action.group === 'file').map((action) => action.id).join(','),
  )
  check(
    '这两个动作不受"必须先启用地图层"的限制（它们只依赖设置，不需要打开 Canvas）',
    panelAction('export-resource-bundle')?.available === undefined &&
      panelAction('import-resource-bundle')?.available === undefined,
    'available 不该存在',
  )

  // ---- 新家：设置页「定义文件（导入 / 导出）」（施工文件 §F.2）----
  plugin.settingTabs[0].display()
  /** 每次现取：设置页是整页重建，旧的元素引用会变成挂在已卸载子树上的死节点 */
  const bundleRow = () =>
    collectByClass(plugin.settingTabs[0].containerEl, 'fc-settings-actions').find(
      (el) => el.dataset?.fcSettingsRole === 'bundle-actions',
    )
  const bundleButton = (role) =>
    collectByClass(bundleRow(), 'fc-settings-action').find((el) => el.dataset?.fcBundle === role)
  check('设置页画出了「定义文件（导入 / 导出）」那一行（两个动作的新家）', bundleRow() !== undefined)
  check(
    '导出 / 导入各有一个按钮，带稳定标记（断言不怕以后改文案）',
    bundleButton('export') !== undefined && bundleButton('import') !== undefined,
    `${String(bundleButton('export')?.textContent)} / ${String(bundleButton('import')?.textContent)}`,
  )
  const bundleHint = collectByClass(plugin.settingTabs[0].containerEl, 'fc-settings-note').find(
    (el) => el.dataset?.fcSettingsRole === 'bundle-hint',
  )
  check(
    '这一节写清了「导入只增不删」（与命令描述同一口径，用户不用点进去才知道）',
    (bundleHint?.textContent ?? '').includes('只增不删'),
    String(bundleHint?.textContent).slice(0, 140),
  )

  // ---- 一条自定义定义都没有时：不产出空文件（写出空文件会让人以为导出成功了） ----
  clearNotices()
  await runCommand(plugin, 'export-resource-bundle')
  await wait()
  check('没有可导出的定义时不产出文件', jsonFiles().length === 0, jsonFiles().join(','))
  // W4-3 改口：定义集里**总是**带着内置路径 / 区域类型，所以判据从"一条自定义都没有"换成
  // "整份跟出厂一模一样" —— 提示也要说清是哪一份（没有地图时导的是「新建地图的模板」那一份）
  check('并且给出一句可读提示', noticeLog.some((line) => line.includes('全是出厂定义')), noticeLog.join(' | '))
  check(
    '没有打开地图时，提示里说明白导的是「新建地图的模板」那一份（不让用户以为导的是某张图）',
    noticeLog.some((line) => line.includes('新建地图的模板')),
    noticeLog.join(' | '),
  )

  // ---- 造四条真实的自定义定义（走设置接口，与用户手点出来的一样） ----
  await plugin.addCustomTerrain({ id: 'swamp', label: '沼泽地', color: '#336655', glyph: 'forest' })
  await plugin.addCustomMarker({ id: 'lighthouse', label: '灯塔', icon: 'port', imagePath: 'Assets/lighthouse.png', mode: 'image' })
  await plugin.addCustomPathType({ id: 'highway', label: '官道', color: '#c9a227', width: 9, dash: [16, 6] })
  // 区域类型同样是用户自己建的数据：它必须跟着定义文件一起走（否则换库/分享时用户的区域类型凭空消失）
  const addedRegionType = await plugin.addCustomRegionType({
    id: 'march',
    label: '边疆',
    color: '#3355aa',
    opacity: 0.35,
    borderWidth: 5,
    borderDash: [10, 6],
  })
  check('前提：自定义区域类型建出来了（走的是设置接口）', addedRegionType.ok === true, JSON.stringify(addedRegionType))

  // ---- 导出 ----
  clearNotices()
  await runCommand(plugin, 'export-resource-bundle')
  await wait()
  const exported = jsonFiles()
  check(
    '导出到库根目录，文件名带日期（只用 ASCII）',
    exported.length === 1 && /^project-kaki-definitions-\d{8}-\d{4}\.json$/.test(exported[0]),
    exported.join(','),
  )
  const bundle = JSON.parse(fileText(exported[0]))
  check('文件里 version 是 2', bundle.version === 2, String(bundle.version))
  check(
    '四段齐全（terrains / markers / pathTypes / regionTypes）',
    Array.isArray(bundle.terrains) &&
      Array.isArray(bundle.markers) &&
      Array.isArray(bundle.pathTypes) &&
      Array.isArray(bundle.regionTypes),
    Object.keys(bundle).join(','),
  )
  check('自定义地形进了文件', bundle.terrains.map((item) => item.id).join(',') === 'custom:swamp', JSON.stringify(bundle.terrains))
  check(
    '标记的两套视觉都带走（切模式不会丢配置）',
    bundle.markers.length === 1 &&
      bundle.markers[0].icon === 'port' &&
      bundle.markers[0].imagePath === 'Assets/lighthouse.png' &&
      bundle.markers[0].mode === 'image',
    JSON.stringify(bundle.markers),
  )
  // W4-3 改口：内置的路径 / 区域类型**也进文件**（参数是每张地图各自一份，用户调得最勤的
  // 恰恰是内置那几种的线宽 / 填充）。代价是导入时每一条都是同名冲突、默认跳过 ——
  // 要带走参数就在确认对话框里逐项勾「覆盖」（下面那一段验的就是这条路）
  const highwayInFile = bundle.pathTypes.find((entry) => entry.id === 'custom:highway')
  check(
    '内置 4 种路径类型也进文件（要搬"我调好的线宽"就得连内置的一起走）',
    bundle.pathTypes.length === 5 &&
      bundle.pathTypes.slice(0, 4).every((entry) => !entry.id.startsWith('custom:')),
    JSON.stringify(bundle.pathTypes.map((entry) => entry.id)),
  )
  check(
    '自定义路径类型的参数完整（颜色/线宽/虚线/端点/连接）',
    highwayInFile?.params.color === '#c9a227' &&
      highwayInFile?.params.width === 9 &&
      JSON.stringify(highwayInFile?.params.dash) === JSON.stringify([16, 6]) &&
      typeof highwayInFile?.params.cap === 'string' &&
      typeof highwayInFile?.params.join === 'string',
    JSON.stringify(highwayInFile?.params),
  )
  check('提示里给出了落盘路径（用户不必去猜文件在哪）', noticeLog.some((line) => line.includes(exported[0])), noticeLog.join(' | '))
  check(
    '导出提示里写明了这几条数**含内置**（否则用户按"内置不该在文件里"去数会对不上）',
    noticeLog.some((line) => line.includes('路径类型 5（含内置）') && line.includes('区域类型 7（含内置）')),
    noticeLog.join(' | '),
  )
  const marchInFile = bundle.regionTypes.find((entry) => entry.id === 'custom:march')
  check(
    '内置 6 种区域类型也进文件（同一条改动、同一个理由）',
    bundle.regionTypes.length === 7 &&
      bundle.regionTypes.slice(0, 6).every((entry) => !entry.id.startsWith('custom:')),
    JSON.stringify(bundle.regionTypes.map((entry) => entry.id)),
  )
  check(
    '自定义区域类型的五个参数完整（颜色/不透明度/边框色/边框宽/边框虚线）',
    marchInFile?.params.color === '#3355aa' &&
      marchInFile?.params.opacity === 0.35 &&
      marchInFile?.params.borderColor === null &&
      marchInFile?.params.borderWidth === 5 &&
      JSON.stringify(marchInFile?.params.borderDash) === JSON.stringify([10, 6]),
    JSON.stringify(marchInFile?.params),
  )
  check('提示时长都在 6000ms 以内', Math.max(...noticeDurations) <= 6000, String(Math.max(...noticeDurations)))

  // ---- 重名不覆盖：再导一次应当另起名字 ----
  await runCommand(plugin, 'export-resource-bundle')
  await wait()
  const exported2 = jsonFiles()
  check(
    '同名时另起名字（-2），绝不覆盖上一份',
    exported2.length === 2 && exported2.some((path) => path.includes('-2.json')) && fileText(exported[0]) !== undefined,
    exported2.join(','),
  )

  // ---- 选择器：只列定义文件 ----
  app.vault.files.set('Notes/readme.md', '# 笔记')
  const capture = captureImportModals(plugin)

  /**
   * ---- 真实选择器：定义文件必须**真的出现在清单里** ----
   *
   * 这一段**不能用替身**。替身能替掉"用户选了哪一项"，却替不掉"清单被谁筛过" ——
   * 而缺陷恰恰就在那一层：`AssetSuggestModal.getItems()` 曾写死 `listImagePaths()`，
   * 于是 `.json` 全被图片白名单筛掉、选择器恒为空（用户实测："导入定义的 UI 不工作"）。
   * 当时所有导入断言都走替身，真实弹窗只被图片那一类验过，所以一条都不红（§5.30）。
   *
   * 默认工厂必须**在注入替身之前**读（同上面"真实弹窗自己的逻辑"那段注释里的坑）。
   */
  const defaultPickerBeforeInject = plugin.imagePickerFactory
  let capturedPicker = null
  plugin.setImagePickerFactory((pickerApp, pickerOptions) => {
    capturedPicker = defaultPickerBeforeInject(pickerApp, pickerOptions)
    return capturedPicker
  })
  clearNotices()
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  const realItems = capturedPicker?.getItems() ?? []
  check(
    '真实选择器里能看到导出的定义文件（.json 不被图片白名单筛掉）',
    realItems.includes(exported[0]),
    JSON.stringify(realItems),
  )
  check(
    '真实选择器里不混杂无关文件：候选**非空**且全部是 .json（不是"筛空了所以没混进别的"）',
    realItems.length > 0 && realItems.every((path) => path.endsWith('.json')),
    JSON.stringify(realItems),
  )
  capturedPicker?.onChooseItem(exported[0])
  await wait()
  check(
    '从真实选择器选中之后仍然走到确认对话框（整条链路通，不只是清单对了）',
    capture.last()?.source === exported[0],
    String(capture.last()?.source),
  )

  /*
   * W4-3 的造景：把这份文件里**内置「河流」的线宽**改掉（真实用法正是"导出 → 改一改 → 搬去另一张图"）。
   * 后面"点亮覆盖 → 确认"那一段要证明的是"勾了才把参数带过去"，所以文件里那一份必须与这张图不同 ——
   * 两边一样的话，那条断言在"根本没换"的实现上也照样绿。
   */
  const TWEAKED_RIVER_WIDTH = 17
  const tweakedBundle = JSON.parse(fileText(exported[0]))
  tweakedBundle.pathTypes = tweakedBundle.pathTypes.map((entry) =>
    entry.id === 'river' ? { ...entry, params: { ...entry.params, width: TWEAKED_RIVER_WIDTH } } : entry,
  )
  app.vault.files.set(exported[0], JSON.stringify(tweakedBundle))

  const picker = makePickerDouble(exported[0])
  plugin.setImagePickerFactory(picker.factory)
  clearNotices()
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  check(
    '选择器只列 .json（列出来的必须都是校验会接受的）',
    JSON.stringify(picker.calls[0]?.files) === JSON.stringify([...exported2].sort()),
    JSON.stringify(picker.calls[0]?.files),
  )
  check('弹窗标题是「导入定义文件」', picker.calls[0]?.title === DIALOG_LABELS.importDefinitions, String(picker.calls[0]?.title))

  // ---- 幂等：刚导出的文件立刻再导入 = 0 新增 ----
  const idempotent = capture.last()
  check('打开的是导入确认对话框', idempotent !== undefined)
  check('对话框里写明了来源文件', idempotent?.source === exported[0], String(idempotent?.source))
  check(
    '刚导出的文件再导入：一条都不新增（幂等）',
    /没有可导入的定义/.test(idempotent?.planText ?? ''),
    String(idempotent?.planText),
  )
  check(
    '同 ID 冲突逐条说明"保留现有的"',
    /保留现有的/.test(idempotent?.planText ?? ''),
    String(idempotent?.planText),
  )
  check('没有可新增条目时确认按钮是灰的（点不动比点了报错好）', idempotent?.canImport === false, String(idempotent?.canImport))
  // W4-3：因为文件里带着整套目录（含内置），"自己导出的文件再导入"必然是**满盘同名冲突** ——
  // 这条同时钉住"内置项的 ID 解析后没被改写成 custom:xxx"（否则它们会变成 14 条新增）
  const exportedConflicts = bundle.terrains.length + bundle.markers.length + bundle.pathTypes.length + bundle.regionTypes.length
  check(
    `同名冲突全部列出来（${exportedConflicts} 条：四类各一条不落）`,
    new RegExp(`同名冲突 ${exportedConflicts} 条`).test(idempotent?.planText ?? ''),
    String(idempotent?.planText).slice(0, 200),
  )

  // ---- 真对话框：假 DOM 里断言正文与按钮标记 ----
  const realFactory = capture.defaultFactory
  /**
   * 造一个真对话框来驱动。
   *
   * `options` 可能是 `undefined`（实现坏掉时"命令根本没打开对话框"）：这时**不要**去构造
   * 真对话框 —— 那会在 `onOpen` 里抛 TypeError 把整个场景打断，剩下的断言一条都不会跑，
   * 看起来像"测试脚本坏了"而不是"功能坏了"（鉴别力验证时当场踩到过）。
   */
  const openRealImportModal = (modalOptions) => {
    if (modalOptions === undefined) return null
    FakeSetting.created.length = 0
    const modal = realFactory(app, modalOptions)
    modal.open()
    return modal
  }
  /** 按钮桩 → 按 `dataset.fcImportRole` 取（稳定标记，不怕改文案） */
  const buttonByRole = (role) =>
    FakeSetting.created
      .flatMap((setting) => setting.buttons ?? [])
      .find((button) => button.buttonEl?.dataset?.fcImportRole === role)
  const idleModal = openRealImportModal(idempotent)
  check(
    '正文用 <pre> 呈现（多行原因要保留换行）',
    (collectByClass(idleModal?.contentEl, 'fc-import-plan')[0]?.textContent ?? '').includes('保留现有的'),
    String(collectByClass(idleModal?.contentEl, 'fc-import-plan')[0]?.textContent),
  )
  check('来源文件也显示在正文区之外（用户能确认自己选的是哪一份）', (collectByClass(idleModal?.contentEl, 'fc-import-source')[0]?.textContent ?? '').includes(exported[0]))
  check('确认按钮带稳定标记（断言不怕以后改文案）', buttonByRole('confirm') !== undefined)
  check('取消按钮带稳定标记', buttonByRole('cancel') !== undefined)
  check('灰掉的确认按钮 disabled 为真', buttonByRole('confirm')?.disabled === true, String(buttonByRole('confirm')?.disabled))
  /* ---- W4-3：同名冲突的逐条「覆盖」 ---- */
  const planTextOf = (modal) => collectByClass(modal?.contentEl, 'fc-import-plan')[0]?.textContent ?? ''
  check(
    '「导入到」写在最显眼处（导入改的是哪张图，先说在前面）',
    (collectByClass(idleModal?.contentEl, 'fc-import-target')[0]?.textContent ?? '').startsWith('导入到：'),
    String(collectByClass(idleModal?.contentEl, 'fc-import-target')[0]?.textContent),
  )
  const idleConflicts = collectByClass(idleModal?.contentEl, 'fc-import-conflict')
  check(
    '每条冲突各占一行（用户能逐条决定，而不是"一锅端"）',
    idleConflicts.length === exportedConflicts,
    String(idleConflicts.length),
  )
  check(
    '冲突行两侧各有一句人话（"这张图"现在是什么 / "文件里"会变成什么）',
    idleConflicts.every(
      (row) =>
        collectByClass(row, 'fc-import-conflict-current').length === 1 &&
        collectByClass(row, 'fc-import-conflict-incoming').length === 1,
    ),
  )
  const idleToggles = FakeSetting.created.filter((setting) => setting.toggle !== undefined)
  check(
    '每条冲突配一个「覆盖」开关，而且初始**全是关的**（覆盖必须由用户显式要求）',
    idleToggles.length === exportedConflicts && idleToggles.every((setting) => setting.toggle.value === false),
    String(idleToggles.length),
  )
  const coverAllButton = FakeSetting.created
    .flatMap((setting) => setting.buttons ?? [])
    .find((button) => button.text === DIALOG_LABELS.overwriteAll)
  check('有「全部设为覆盖」这一个快捷动作按钮（搬一整套线宽时用）', coverAllButton !== undefined)
  const riverWidthsBefore = plugin.getSettings().pathTypes.map((entry) => [entry.id, entry.params.width])
  const idsBefore = riverWidthsBefore.map(([id]) => id)
  await coverAllButton?.click()
  check(
    '点亮「全部设为覆盖」之后正文与按钮状态**一起**换（重算计划，不是本地改一段文本）',
    new RegExp(`将覆盖 ${exportedConflicts} 条`).test(planTextOf(idleModal)),
    planTextOf(idleModal).slice(0, 200),
  )
  check('确认按钮随之可点（有不覆盖就点不动的整条链路是通的）', buttonByRole('confirm')?.disabled === false, String(buttonByRole('confirm')?.disabled))
  check('上一步只是重算，**一个字节都还没改**（要等确认）', JSON.stringify(plugin.getSettings().pathTypes.map((entry) => [entry.id, entry.params.width])) === JSON.stringify(riverWidthsBefore))
  clearNotices()
  await buttonByRole('confirm')?.click()
  await wait()
  const afterCover = plugin.getSettings().pathTypes
  check(
    '覆盖真的落盘了：内置「河流」的线宽换成了文件里那一份（"搬我调好的线宽"这条用法成立）',
    afterCover.find((entry) => entry.id === 'river')?.params.width === TWEAKED_RIVER_WIDTH,
    JSON.stringify(afterCover.map((entry) => [entry.id, entry.params.width])),
  )
  check(
    '覆盖是"在原位换"：条目顺序（也就是用户的列表次序）一点没动',
    JSON.stringify(afterCover.map((entry) => entry.id)) === JSON.stringify(idsBefore),
    JSON.stringify(afterCover.map((entry) => entry.id)),
  )
  check('覆盖不等于新增：条数一条没多', afterCover.length === idsBefore.length, `${idsBefore.length} → ${afterCover.length}`)
  check(
    '导入结果提示里报出"覆盖 N 条"（用户知道刚才发生了覆盖，而不是只看到"新 0 条"）',
    noticeLog.some((line) => line.includes(`覆盖 ${exportedConflicts} 条`)),
    noticeLog.join(' | '),
  )

  // ---- 真的导入：一份"别人给的"文件（一条新增 + 一条同 ID 冲突） ----
  const incoming = JSON.stringify({
    version: 2,
    generator: 'someone-else',
    terrains: [
      { id: 'custom:volcano', label: '火山', color: '#aa4411', glyph: 'forest', imagePath: '', mode: 'color' },
    ],
    markers: [{ id: 'custom:lighthouse', label: '别人的灯塔', icon: 'city', imagePath: '', mode: 'glyph' }],
    pathTypes: [
      { id: 'custom:trail', label: '小径', kind: 'path', params: { color: '#7a5c3e', width: 3, dash: [6, 4] } },
    ],
    regionTypes: [
      { id: 'custom:oasis', label: '绿洲', params: { color: '#33aa88', opacity: 0.4, borderWidth: 0, borderDash: [] } },
    ],
  })
  app.vault.files.set('Shared/other.json', incoming)
  const settingsBefore = JSON.stringify(plugin.getSettings())
  const picker2 = makePickerDouble('Shared/other.json')
  plugin.setImagePickerFactory(picker2.factory)
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  const plan = capture.last()
  check(
    '正文报出新增条数（地形 1 · 标记 0 · 路径类型 1 · 区域类型 1）',
    /将新增 3 条/.test(plan?.planText ?? '') &&
      /custom:volcano/.test(plan?.planText ?? '') &&
      /custom:trail/.test(plan?.planText ?? '') &&
      /custom:oasis/.test(plan?.planText ?? ''),
    String(plan?.planText),
  )
  check('同 ID 的标记被列为"跳过"并说明原因', /跳过 1 条/.test(plan?.planText ?? '') && /custom:lighthouse/.test(plan?.planText ?? ''), String(plan?.planText))
  check('这一段文件里没有缺失提示（四段都在）', !/没有「/.test(plan?.planText ?? ''), String(plan?.planText))
  check('有东西可导入时确认按钮可用', plan?.canImport === true, String(plan?.canImport))
  check('打开对话框这一步还没有改任何设置（要等用户确认）', JSON.stringify(plugin.getSettings()) === settingsBefore)

  // 设置页正开着：先渲染一次作为"导入前"的样子（下面要验证导入之后它自己刷新了）
  const settingsHas = (text) => FakeSetting.created.some((setting) => (setting.info.name ?? '').includes(text))
  plugin.settingTabs[0].display()
  check('前提：导入前设置页里还没有这份文件带来的路径类型', !settingsHas('小径'), '设置页里不该已经出现小径')
  // A3：地形/标记的**定义**住在「地图定义」弹窗里，所以"导入前没有火山"要去那边看。
  // 注意顺序：下面 `openRealImportModal` 会清空并重建 `FakeSetting.created`（`buttonByRole` 依赖它）
  FakeSetting.created.length = 0
  openDefinitionManager(plugin)
  check('前提：「地图定义」弹窗里还没有火山的定义', !settingsHas('火山'), '弹窗里不该已经出现火山')

  const realModal = openRealImportModal(plan)
  check('真对话框的确认按钮此时可点', buttonByRole('confirm')?.disabled === false, String(buttonByRole('confirm')?.disabled))
  clearNotices()
  await buttonByRole('confirm')?.click()
  await wait()
  const after = plugin.getSettings()
  check('新地形进了设置', after.customTerrains.some((terrain) => terrain.id === 'custom:volcano'), JSON.stringify(after.customTerrains.map((t) => t.id)))
  check('新路径类型进了设置', after.pathTypes.some((entry) => entry.id === 'custom:trail'), JSON.stringify(after.pathTypes.map((e) => e.id)))
  check(
    '新区域类型进了设置，且参数是文件里那一份（不是出厂值）',
    after.regionTypes.some(
      (entry) =>
        entry.id === 'custom:oasis' &&
        entry.label === '绿洲' &&
        entry.params.color === '#33aa88' &&
        entry.params.opacity === 0.4 &&
        entry.params.borderWidth === 0 &&
        JSON.stringify(entry.params.borderDash) === JSON.stringify([]),
    ),
    JSON.stringify(after.regionTypes.filter((entry) => entry.id === 'custom:oasis')),
  )
  check(
    '导入没有动用户原有的区域类型（同 ID 之外的一条都没少、也没被改写）',
    after.regionTypes.some((entry) => entry.id === 'custom:march' && entry.label === '边疆'),
    JSON.stringify(after.regionTypes.map((entry) => [entry.id, entry.label])),
  )
  check(
    '导入的区域类型已落盘（不是只改了内存）',
    (persisted()?.regionTypes ?? []).some((entry) => entry.id === 'custom:oasis'),
    JSON.stringify(persisted()?.regionTypes),
  )
  check(
    '旧字段 regionColors 与目录里内置 6 种的颜色一致（镜像字段长度固定为 6，回退旧版插件也看得到）',
    persisted()?.regionColors?.length === 6 &&
      JSON.stringify(persisted()?.regionColors) ===
        JSON.stringify(
          plugin
            .getSettings()
            .regionTypes.filter((entry) => !entry.id.startsWith('custom:'))
            .map((entry) => entry.params.color),
        ),
    JSON.stringify(persisted()?.regionColors),
  )
  const keptLighthouse = after.customMarkers.find((marker) => marker.id === 'custom:lighthouse')
  check(
    '同 ID 的标记保留现有定义（标签 / 字形 / 图片都没被外来文件改掉）',
    keptLighthouse?.label === '灯塔' && keptLighthouse?.icon === 'port' && keptLighthouse?.imagePath === 'Assets/lighthouse.png',
    JSON.stringify(keptLighthouse),
  )
  check('导入结果已落盘（不是只改了内存）', (persisted()?.customTerrains ?? []).some((terrain) => terrain.id === 'custom:volcano'), JSON.stringify(persisted()?.customTerrains))
  check('旧字段 pathColors 与目录保持一致', persisted()?.pathColors?.river === plugin.getSettings().pathColors.river)
  check(
    '导入完成后给出一条短提示并报出新增数',
    noticeLog.some((line) => line.includes('已导入定义') && line.includes('新增 3 条') && line.includes('跳过 1 条')),
    noticeLog.join(' | '),
  )
  check('提示时长都在 6000ms 以内', Math.max(...noticeDurations) <= 6000, String(Math.max(...noticeDurations)))
  check('导入成功后对话框关闭了', collectByClass(realModal?.contentEl, 'fc-import-plan').length === 0)
  // 导入结果的三个"家"：地形 / 标记 / 路径类型 / 区域类型的**定义**都在「地图定义」弹窗里，
  // 所以"导入之后不用重开就能看到"这一条也去那里验（设置页此刻已经不摆这些定义行了 —— W4-1b）
  FakeSetting.created.length = 0
  openDefinitionManager(plugin)
  check(
    '导入之后定义弹窗里立刻能看到新的路径类型（导入后不必关掉再打开）',
    settingsHas('小径'),
    FakeSetting.created.map((setting) => setting.info.name).join(' | '),
  )
  check('同一份弹窗里也有新的区域类型', settingsHas('绿洲'))
  check(
    '导入进来的新地形在「地图定义」弹窗里（定义的新家）',
    settingsHas('火山'),
    FakeSetting.created.map((setting) => setting.info.name).join(' | '),
  )
  capture.restore()

  // ---- 取消 = 一个字节都不改 ----
  const snapshot = JSON.stringify(plugin.getSettings())
  const dataSnapshot = plugin._data
  app.vault.files.set('Shared/third.json', JSON.stringify({ version: 2, terrains: [{ id: 'custom:newone', label: '新地', color: '#123456' }] }))
  const capture2 = captureImportModals(plugin)
  plugin.setImagePickerFactory(makePickerDouble('Shared/third.json').factory)
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  const cancelModal = openRealImportModal(capture2.last())
  check('取消路径也拿到了导入计划（对话框确实打开了）', cancelModal !== null, '没有打开导入对话框')
  const cancelButton = FakeSetting.created
    .flatMap((setting) => setting.buttons ?? [])
    .find((button) => button.buttonEl?.dataset?.fcImportRole === 'cancel')
  check('取消按钮存在', cancelButton !== undefined)
  await cancelButton?.click()
  await wait()
  check(
    '取消之后设置逐字段不变（一个字节都没改）',
    JSON.stringify(plugin.getSettings()) === snapshot && plugin._data === dataSnapshot,
    '设置或落盘数据被改动了',
  )
  check('取消不会把那条地形偷偷加进来', !plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:newone'))

  // ---- v1 老文件（只有 terrains）：不许动用户的标记与路径类型 ----
  app.vault.files.set('Shared/legacy.json', JSON.stringify({ version: 1, terrains: [{ id: 'custom:old', label: '旧地形', color: '#336655' }] }))
  plugin.setImagePickerFactory(makePickerDouble('Shared/legacy.json').factory)
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  const legacyPlan = capture2.last()
  check('v1 文件照常能导入（老文件不许被判为非法）', legacyPlan !== undefined && legacyPlan.canImport === true, String(legacyPlan?.canImport))
  check(
    'v1 文件没有的段会被明说（否则用户以为标记也导进来了）',
    /没有「标记、路径类型、区域类型」一节/.test(legacyPlan?.planText ?? ''),
    String(legacyPlan?.planText),
  )
  const beforeLegacy = {
    markers: plugin.getSettings().customMarkers.length,
    pathTypes: plugin.getSettings().pathTypes.length,
    regionTypes: plugin.getSettings().regionTypes.length,
  }
  const capture3 = captureImportModals(plugin)
  plugin.setImagePickerFactory(makePickerDouble('Shared/legacy.json').factory)
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  const legacyModal = openRealImportModal(capture3.last())
  check(
    'v1 也能走到确认对话框（老文件不许被判为不可导入，否则这里根本没得点）',
    legacyModal !== null,
    '没有打开导入对话框',
  )
  await FakeSetting.created
    .flatMap((setting) => setting.buttons ?? [])
    .find((button) => button.buttonEl?.dataset?.fcImportRole === 'confirm')
    ?.click()
  await wait()
  check('v1 导入后标记定义一条都没少', plugin.getSettings().customMarkers.length === beforeLegacy.markers)
  check('v1 导入后路径类型定义一条都没少', plugin.getSettings().pathTypes.length === beforeLegacy.pathTypes)
  check(
    'v1 导入后区域类型定义一条都没少（"段缺失 ≠ 段为空"对新增的段同样成立）',
    plugin.getSettings().regionTypes.length === beforeLegacy.regionTypes,
    `${beforeLegacy.regionTypes} → ${plugin.getSettings().regionTypes.length}`,
  )
  check('v1 里的新地形确实进来了', plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:old'))
  check('v1 导入没把对话框留在原地', collectByClass(legacyModal?.contentEl, 'fc-import-plan').length === 0)

  // ---- 失败路径：坏文件必须给出可读原因，且**不打开确认对话框**、不改设置 ----
  const beforeBroken = JSON.stringify(plugin.getSettings())
  const capture4 = captureImportModals(plugin)
  const brokenCases = [
    ['Shared/broken.json', '{ 这不是 JSON', /JSON/],
    ['Shared/future.json', JSON.stringify({ version: 99, terrains: [] }), /更新|升级/],
    ['Shared/empty.json', JSON.stringify({ version: 2 }), /terrains|markers|pathTypes/],
  ]
  for (const [path, text, pattern] of brokenCases) {
    app.vault.files.set(path, text)
    plugin.setImagePickerFactory(makePickerDouble(path).factory)
    clearNotices()
    await runCommand(plugin, 'import-resource-bundle')
    await wait()
    check(
      `坏文件给出可读原因（${path}）`,
      noticeLog.some((line) => line.includes('无法导入') && pattern.test(line)),
      noticeLog.join(' | '),
    )
  }
  check('坏文件不会打开确认对话框（不让用户对着无效内容点确认）', capture4.opened.length === 0, String(capture4.opened.length))
  check('坏文件不会改动设置', JSON.stringify(plugin.getSettings()) === beforeBroken)
  check('坏文件的提示也在 6000ms 以内', Math.max(...noticeDurations) <= 6000, String(Math.max(...noticeDurations)))
  capture4.restore()

  // ---- 库里一份定义文件都没有：说清"去导出一份"，而不是弹一个空列表 ----
  for (const path of jsonFiles()) app.vault.files.delete(path)
  const pickerEmpty = makePickerDouble(undefined)
  plugin.setImagePickerFactory(pickerEmpty.factory)
  clearNotices()
  await runCommand(plugin, 'import-resource-bundle')
  await wait()
  check('库里没有定义文件时给出可操作的提示', noticeLog.some((line) => line.includes('没有找到定义文件')), noticeLog.join(' | '))
  check('这时根本不打开空的选择器', pickerEmpty.calls.length === 0, String(pickerEmpty.calls.length))

  // ---- 新家（设置页）那两个按钮点下去真的做事：与命令**同一个方法**，不是另起一条链路 ----
  clearNotices()
  fireEvent(bundleButton('export'), 'click')
  await wait()
  const fromSettings = jsonFiles()
  check(
    '设置页的「导出定义文件…」按钮真的写出文件（与命令走同一个方法）',
    fromSettings.length === 1 && /^project-kaki-definitions-\d{8}-\d{4}\.json$/.test(fromSettings[0]),
    fromSettings.join(','),
  )
  const capture5 = captureImportModals(plugin)
  const pickerFromSettings = makePickerDouble(fromSettings[0])
  plugin.setImagePickerFactory(pickerFromSettings.factory)
  fireEvent(bundleButton('import'), 'click')
  await wait()
  check(
    '设置页的「导入定义文件…」按钮打开的是同一个选择器（标题与候选都对）',
    pickerFromSettings.calls[0]?.title === DIALOG_LABELS.importDefinitions &&
      (pickerFromSettings.calls[0]?.files ?? []).includes(fromSettings[0]),
    `${String(pickerFromSettings.calls[0]?.title)} / ${JSON.stringify(pickerFromSettings.calls[0]?.files)}`,
  )
  check(
    '选中之后照样走到确认对话框（搬了家，链路没断）',
    capture5.last()?.source === fromSettings[0],
    String(capture5.last()?.source),
  )
  capture5.restore()

  plugin.onunload()
}

console.log('\n场景 37：区域类型目录（旧区域不变 → 工具条下拉 → 画布 → 文件 → 未知类型保留 → 图例）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  // 桩环境里只有一张画布（`Maps/World.canvas`），地图层只能挂到它上面
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'Regions', folder: 'Maps', canvasPath })
  /**
   * 文件里先塞两条区域，它们是本次增量的两条命根子回归：
   * - `r-legacy`：**升级前画的**，没有 `type` 字段，颜色 = 内置「王国」出厂色。
   *   它必须一字不变地读进来、写回去，图例里也仍然显示「王国」（按颜色反查）。
   * - `r-foreign`：**别的库/别的版本写的**未知类型。它必须仍然在、仍然画得出来，
   *   `type` 原样保留 —— 丢掉一条区域等于用户打开一次别人的库就永久丢数据。
   */
  const LEGACY_COLOR = '#44cf6e'
  const FOREIGN_COLOR = '#00ffcc'
  const FOREIGN_TYPE = 'alien-zone'
  const seeded = await store.load(file)
  seeded.document.regions.push(
    { id: 'r-legacy', label: '', pts: [[-900, -700], [-500, -700], [-500, -400]], color: LEGACY_COLOR, opacity: 0.2 },
    {
      id: 'r-foreign',
      label: '',
      pts: [[300, -700], [700, -700], [700, -400]],
      color: FOREIGN_COLOR,
      opacity: 0.2,
      type: FOREIGN_TYPE,
    },
  )
  await store.writeNow(file, seeded.document, 'Regions', [canvasPath])
  await settleEvents()

  const prompts = []
  plugin.setPromptModalFactory((_app, options, onSubmit) => {
    prompts.push({ options, onSubmit })
    return { open() {} }
  })
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const fakeDocument = wrapper.ownerDocument
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const doc = () => layers.getDocument(canvasPath)
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const clickAt = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
  }
  /** 画一个三角形区域（跳过命名），返回刚提交的那一个 */
  const drawRegion = (x0, y0, x1, y1) => {
    editor.setMode('paint')
    editor.setTool('region')
    clickAt({ x: x0, y: y0 })
    clickAt({ x: x1, y: y0 })
    clickAt({ x: x1, y: y1 })
    clickAt({ x: x1, y: y1 })
    flushFrames()
    prompts[prompts.length - 1].onSubmit('')
    flushFrames()
    return doc().regions[doc().regions.length - 1]
  }
  const openSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    noteHost = plugin.settingTabs[0].containerEl
    return FakeSetting.created
  }
  /**
   * 打开「地图定义」弹窗（A3：区域类型的**增删改**搬到了这里；
   * W4-1b：**参数行**也从设置页搬来了 —— 定义随图之后它们是"这张地图的那一套"）。
   *
   * 两侧各有一条 `dataset.fcNote === 'regionType'` 的就地提示，所以 `regionNote()`
   * 跟着最后一次打开的宿主走（与场景 34 的 `pathNote()` 同一处理）。
   */
  let noteHost = plugin.settingTabs[0].containerEl
  const openDefModal = () => {
    FakeSetting.created.length = 0
    const modal = openDefinitionManager(plugin)
    noteHost = modal.contentEl
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 当前宿主（设置页或弹窗）底部那一行区域类型就地提示（按 `dataset.fcNote` 取） */
  const regionNote = () =>
    collectByClass(noteHost, 'fc-settings-note').find((el) => el.dataset?.fcNote === 'regionType')?.textContent ?? ''
  // §F.2：区域类型也从自绘下拉换成侧栏里的原生 <select> + 当前类型的色块
  // （与路径那一节同一处理，理由见那里：自绘菜单与它的 document 捕获监听一并退休）
  const panel = await openMapPanel(app, plugin)
  const regionSelect = () => inPanel(panel, 'fc-panel-type-select').find((el) => el.dataset.fcRegionType === '1')
  const regionOptions = () => regionSelect()?.children ?? []
  const regionOption = (id) => regionOptions().find((option) => option.value === id)
  const regionSwatch = () => inPanel(panel, 'fc-panel-type-swatch').find((el) => el.dataset.fcRegionSwatch === '1')
  const entryOf = (id) => plugin.getSettings().regionTypes.find((entry) => entry.id === id)
  const legendRows = () => collectByClass(wrapper, 'fc-legend-row')
  const legendLabels = (kind) =>
    legendRows()
      .filter((row) => row.dataset.kind === kind)
      .map((row) => collectByClass(row, 'fc-legend-label')[0]?.textContent ?? '')

  // ---------------------------------------------------------- 旧区域：读进来、写回去都不变
  const legacy = doc().regions.find((region) => region.id === 'r-legacy')
  check('升级前画的区域（没有 type 字段）仍然在文档里', legacy !== undefined)
  check('它读进来之后仍然没有 type（不会被凭空补一个）', legacy !== undefined && !('type' in legacy))
  check('旧区域的颜色与不透明度一字未改', legacy?.color === LEGACY_COLOR && legacy?.opacity === 0.2, JSON.stringify(legacy))
  await store.writeNow(file, doc(), 'Regions', [canvasPath])
  await settleEvents()
  const reread = await store.load(file)
  const legacyAgain = reread.document.regions.find((region) => region.id === 'r-legacy')
  check(
    '保存再读回：旧区域仍然没有 type，颜色也没变（这条保证老地图文件不被升级改写）',
    legacyAgain !== undefined && !('type' in legacyAgain) && legacyAgain.color === LEGACY_COLOR,
    JSON.stringify(legacyAgain),
  )

  // ---------------------------------------------------------- 未知区域类型：不丢、不改写、看得见
  const foreign = doc().regions.find((region) => region.id === 'r-foreign')
  check('未知区域类型没有被丢掉（旧版本对路径就是这么丢整条的）', foreign !== undefined)
  check('未知区域类型的 type 原样保留', foreign?.type === FOREIGN_TYPE, String(foreign?.type))
  const loadIssues = (await store.load(file)).issues
  check(
    '未知区域类型给了一条可读的「已保留」告警',
    loadIssues.some((issue) => issue.message.includes('未知区域类型') && issue.message.includes('已保留')),
    JSON.stringify(loadIssues.map((issue) => issue.message)),
  )
  check(
    '未知区域仍然画出来了，而且用的是**文件里存的**颜色（不是回退色盖掉用户数据）',
    frame().fills.some((fill) => fill.fillStyle === FOREIGN_COLOR),
    JSON.stringify([...new Set(frame().fills.map((fill) => fill.fillStyle))]),
  )

  // ---------------------------------------------------------- 侧栏「工具」：区域类型下拉
  editor.setMode('paint')
  editor.setTool('region')
  flushFrames()
  check('区域工具下侧栏有一个区域类型下拉（不再是一排色块按钮）', regionSelect() !== undefined)
  check(
    '下拉里有内置 6 种（王国/帝国/公国/教区/荒原/海域）',
    ['realm', 'empire', 'duchy', 'diocese', 'wilderness', 'sea'].every((id) => regionOption(id) !== undefined),
    JSON.stringify(regionOptions().map((option) => option.value)),
  )
  check('下拉里没有那个外来类型（它只列设置里存在的选择）', regionOption(FOREIGN_TYPE) === undefined)
  // 用户操作就是原生 select 的 change（自绘菜单那套"展开/点外面收起/拦下那一击"随组件一起退休）
  regionSelect().value = 'empire'
  fireEvent(regionSelect(), 'change')
  check('选中「帝国」写进编辑器', editor.getStatus().regionType === 'empire', editor.getStatus().regionType)
  flushFrames()
  check(
    '当前类型的名字与色块都在（名字是下拉的选中项，色块在它旁边）',
    regionSelect()?.value === 'empire' &&
      (regionOption('empire')?.textContent ?? '') === '帝国' &&
      regionSwatch()?.style.backgroundColor === '#c94f4f',
    `${String(regionOption('empire')?.textContent)} / ${String(regionSwatch()?.style.backgroundColor)}`,
  )

  // ---------------------------------------------------------- 定义弹窗：区域类型参数
  // 与路径类型同理（W4-1b）：参数住在「地图定义」弹窗里，内置 6 种也可以改
  openDefModal()
  check(
    '内置 6 种区域各有参数行（颜色 + 不透明度 + 边框色）',
    ['王国', '帝国', '公国', '教区', '荒原', '海域'].every((label) => {
      const setting = FakeSetting.created.find((item) => item.info.name === DEFINITION_ROW_LABELS.fillBorder(label))
      return (setting?.colorPickers?.length ?? 0) === 1 && (setting?.texts?.length ?? 0) === 2
    }),
  )
  check(
    '第二行是「边框宽与虚线 · <名字>」（边框宽 + 边框虚线）',
    (settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts ?? []).length === 2,
    JSON.stringify((settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts ?? []).map((text) => text.value)),
  )
  check(
    '出厂值带出来了（不透明度 0.22、边框宽 3、边框色留空 = 跟随填充色、虚线留空 = 实线）',
    settingNamed(DEFINITION_ROW_LABELS.fillBorder('王国'))?.texts?.[0]?.value === '0.22' &&
      settingNamed(DEFINITION_ROW_LABELS.fillBorder('王国'))?.texts?.[1]?.value === '' &&
      settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts?.[0]?.value === '3' &&
      settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts?.[1]?.value === '',
    JSON.stringify([
      settingNamed(DEFINITION_ROW_LABELS.fillBorder('王国'))?.texts?.[0]?.value,
      settingNamed(DEFINITION_ROW_LABELS.fillBorder('王国'))?.texts?.[1]?.value,
      settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts?.[0]?.value,
      settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('王国'))?.texts?.[1]?.value,
    ]),
  )

  // ---- 改「帝国」的参数：只影响**之后**新画的区域 ----
  const beforeDraw = editor.getStatus()
  void beforeDraw
  await settingNamed(DEFINITION_ROW_LABELS.fillBorder('帝国')).texts[0].type('0.6')
  check('不透明度写进区域类型目录', entryOf('empire')?.params.opacity === 0.6, JSON.stringify(entryOf('empire')?.params))
  await settingNamed(DEFINITION_ROW_LABELS.fillBorder('帝国')).texts[1].type('#101010')
  check('边框色写进目录', entryOf('empire')?.params.borderColor === '#101010', JSON.stringify(entryOf('empire')?.params))
  await settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('帝国')).texts[0].type('9')
  check('边框宽写进目录', entryOf('empire')?.params.borderWidth === 9, JSON.stringify(entryOf('empire')?.params))
  await settingNamed(DEFINITION_ROW_LABELS.borderWidthDash('帝国')).texts[1].type('6,3')
  check('边框虚线写进目录', JSON.stringify(entryOf('empire')?.params.borderDash) === '[6,3]', JSON.stringify(entryOf('empire')?.params))

  editor.setRegionType('empire')
  const drawn = drawRegion(-300, 200, 100, 500)
  check('新画的区域记下了类型 ID', drawn.type === 'empire', String(drawn.type))
  check(
    '新画的区域把目录里的全部参数写进了文件',
    drawn.color === '#c94f4f' && drawn.opacity === 0.6 && drawn.borderWidth === 9 && JSON.stringify(drawn.borderDash) === '[6,3]',
    JSON.stringify(drawn),
  )
  check('边框色与填充色不同时才会写进文件（跟随填充色不写冗余字段）', drawn.borderColor === '#101010', String(drawn.borderColor))
  // 边框色 '#101010' 只属于刚画的那个区域，用它把这一笔从整帧里挑出来
  const empireBorders = frame().groups.filter((group) => group.strokeStyle === '#101010')
  check(
    '画布上真的按这条区域的虚线画了边框（6,3 按设备像素缩放后在 ctx 里生效）',
    empireBorders.length > 0 &&
      empireBorders.every((group) => group.lineDash.length === 2 && Math.abs(group.lineDash[0] / group.lineDash[1] - 2) < 0.01),
    JSON.stringify(empireBorders.map((group) => group.lineDash)),
  )
  check(
    '旧区域的边框是实线（它没有 borderDash 字段 → 升级前唯一的行为）',
    frame()
      .groups.filter((group) => group.strokeStyle === LEGACY_COLOR)
      .every((group) => group.lineDash.length === 0),
    JSON.stringify(frame().groups.map((group) => [group.strokeStyle, group.lineDash])),
  )
  check(
    '已经画好的旧区域不受设置影响（颜色仍是文件里那份）',
    doc().regions.find((region) => region.id === 'r-legacy')?.color === LEGACY_COLOR,
  )
  check(
    '旧区域的边框宽没有被新设置改掉（它压根没写这个字段 → 仍是升级前的 0 = 不画边框）',
    doc().regions.find((region) => region.id === 'r-legacy')?.borderWidth === undefined,
  )

  // ---------------------------------------------------------- 图例：旧区域标签必须还是「王国」
  await plugin.setShowLegend(true)
  flushFrames()
  check('图例里旧区域仍显示「王国」（按颜色反查，与升级前完全一致）', legendLabels('region').includes('王国'), JSON.stringify(legendLabels('region')))
  check(
    '图例里新画的区域显示它的类型名「帝国」',
    legendLabels('region').includes('帝国'),
    JSON.stringify(legendLabels('region')),
  )
  check(
    '图例里未知类型显示为「未定义类型（ID）」而不是空着或混进内置名',
    legendLabels('region').includes(unknownTypeLabel(FOREIGN_TYPE)),
    JSON.stringify(legendLabels('region')),
  )

  // ------------------------------- 自定义区域类型：新增 → 用 → 删（A3 搬到「地图定义」弹窗）
  openDefModal()
  const addSetting = settingNamed('新增自定义区域类型')
  check('「地图定义」弹窗里有「新增自定义区域类型」一节', addSetting !== undefined)
  check(
    '新增区有 ID / 显示名 / 不透明度 / 边框宽 / 边框虚线五个文本框 + 一个颜色选择器',
    (addSetting?.texts?.length ?? 0) === 5 && (addSetting?.colorPickers?.length ?? 0) === 1,
    `texts=${addSetting?.texts?.length} pickers=${addSetting?.colorPickers?.length}`,
  )
  await addSetting.texts[0].type('Bad Id!')
  check('非法区域类型 ID 就地给出可读原因', regionNote().includes('ID'), regionNote())
  await addSetting.texts[0].type('March')
  await addSetting.texts[1].type('边境侯国')
  await addSetting.colorPickers[0].pick('#00aa88')
  await addSetting.texts[2].type('0.35')
  await addSetting.texts[3].type('7')
  await addSetting.texts[4].type('10,4')
  await addSetting.button.click()
  check(
    '新增的自定义区域类型 ID 收敛为 custom:march（小写 + 自动前缀）',
    entryOf('custom:march') !== undefined,
    JSON.stringify(plugin.getSettings().regionTypes.map((entry) => entry.id)),
  )
  check(
    '自定义区域类型的参数按填的写进目录',
    JSON.stringify(entryOf('custom:march')?.params) ===
      JSON.stringify({ color: '#00aa88', opacity: 0.35, borderColor: null, borderWidth: 7, borderDash: [10, 4] }),
    JSON.stringify(entryOf('custom:march')?.params),
  )
  check(
    '旧字段 regionColors 与目录保持一致（回退到旧版插件仍看到自己改过的颜色）',
    plugin.getSettings().regionColors[1] === entryOf('empire')?.params.color &&
      plugin.getSettings().regionColors[5] === entryOf('sea')?.params.color,
    JSON.stringify([plugin.getSettings().regionColors, entryOf('empire')?.params.color]),
  )
  check('自定义区域类型已落盘（真实 JSON 往返）', JSON.parse(plugin._data).regionTypes.some((entry) => entry.id === 'custom:march'))

  editor.setMode('paint')
  editor.setTool('region')
  flushFrames()
  check(
    '侧栏区域下拉里立刻多出「边境侯国」（值就是它的 ID）',
    regionOption('custom:march') !== undefined && (regionOption('custom:march')?.textContent ?? '').includes('边境侯国'),
    JSON.stringify(regionOptions().map((option) => option.value)),
  )
  editor.setRegionType('custom:march')
  const custom = drawRegion(500, 200, 900, 500)
  check('用自定义类型画的区域写进文件的是 ID（不是显示名）', custom.type === 'custom:march', String(custom.type))
  check('自定义类型的颜色生效', custom.color === '#00aa88' && custom.opacity === 0.35, JSON.stringify(custom))

  // ---- 删掉自定义定义：地图数据不许被顺手删掉 ----
  // 先落盘：删除时的影响面统计是**读文件**算出来的，内存里刚画的区域还没写进去就不算引用
  //（否则这一节会静默走"没有引用 → 直接删"那条快路，确认框那几条断言就成了空转）
  store.scheduleSave(file, doc(), 'Regions', [canvasPath])
  await store.flush()
  await settleEvents()
  // 弹窗里「删除 / 改 ID」就在自定义类型自己那一行上（参数行住在设置页，那边没有删除按钮）
  openDefModal()
  const customSetting = FakeSetting.created.find(
    (item) => (item.info.name ?? '').includes('边境侯国') && (item.buttons ?? []).some((button) => button.text === MODAL_ACTIONS.delete),
  )
  check('自定义区域类型那一行有删除按钮', customSetting !== undefined)
  // 刚才用 custom:march 画过一个区域 → 属于"有引用"，A3 要求先弹影响面确认框
  const deletes = captureDeleteModals(plugin)
  await customSetting.buttons.find((button) => button.text === MODAL_ACTIONS.delete).click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('有地图引用它时先弹确认框，而不是直接删', deletes.opened.length === 1, `弹了 ${deletes.opened.length} 次`)
  const outcome = await deletes.last()?.onConfirm?.()
  check('在确认框里点删除之后才真的删掉', outcome?.ok === true, JSON.stringify(outcome))
  deletes.restore()
  check('定义被删掉了', entryOf('custom:march') === undefined)
  check(
    '但地图上的那个区域仍在、type 也没被改写（删定义 ≠ 删数据）',
    doc().regions.some((region) => region.id === custom.id && region.type === 'custom:march'),
    JSON.stringify(doc().regions.map((region) => [region.id, region.type])),
  )
  flushFrames()
  const orphan = drawRegion(-900, 200, -500, 500)
  check(
    '删掉定义之后再画同类型：拿到的是看得见的回退样式（颜色不是空的）',
    typeof orphan.color === 'string' && orphan.color.length > 0 && orphan.type === 'custom:march',
    JSON.stringify(orphan),
  )
  flushFrames()
  check(
    '侧栏下拉显示「未定义类型（custom:march）」而不是空着',
    regionSelect()?.value === 'custom:march' && (regionOption('custom:march')?.textContent ?? '') === unknownTypeLabel('custom:march'),
    `${String(regionSelect()?.value)} / ${String(regionOption('custom:march')?.textContent)}`,
  )

  // ------------------------- ID 留空 = 自动生成（用户实测：手打 ID 是没必要的负担）
  /**
   * 用户的反馈是"主要是需要自己手动输入各种 id、文件地址，输错也不知道怎么改"。
   * 这条链路要验的是：**一个字都不填也能建出来**，而且生成出来的 ID 可读、不撞车。
   */
  openDefModal()
  const autoForm = settingNamed('新增自定义区域类型')
  check(
    '新增区的说明里写明「ID 可以留空、留空就自动生成」',
    (autoForm?.info.desc ?? '').includes('可以留空') && (autoForm?.info.desc ?? '').includes('自动生成'),
    autoForm?.info.desc,
  )
  check(
    'ID 输入框的占位提示写着「留空 = 自动生成」',
    (autoForm?.texts ?? []).some((text) => (text.placeholder ?? '').includes('留空 = 自动生成')),
    JSON.stringify((autoForm?.texts ?? []).map((text) => text.placeholder)),
  )
  const autoLabel = (autoForm?.texts ?? []).find((text) => (text.placeholder ?? '').includes('显示名'))
  await autoLabel.type('后花园')
  await autoForm.button.click()
  const autoAdded = plugin.getSettings().regionTypes.filter((entry) => entry.label === '后花园')
  check(
    'ID 留空也能建出来，且 ID 是可读的短 ID custom:region1（不再要求用户手打）',
    autoAdded.length === 1 && autoAdded[0].id === 'custom:region1',
    JSON.stringify(autoAdded),
  )
  check('留空创建不留下"ID 不能为空"这类报错', !regionNote().includes('ID'), regionNote())

  openDefModal()
  const autoForm2 = settingNamed('新增自定义区域类型')
  await (autoForm2?.texts ?? []).find((text) => (text.placeholder ?? '').includes('显示名')).type('后花园')
  await autoForm2.button.click()
  check(
    '同一个显示名再建一次：自动换到 custom:region2（绝不撞车）',
    plugin.getSettings().regionTypes.filter((entry) => entry.label === '后花园').map((entry) => entry.id).join(',') === 'custom:region1,custom:region2',
    JSON.stringify(plugin.getSettings().regionTypes.filter((entry) => entry.label === '后花园').map((entry) => entry.id)),
  )

  openDefModal()
  const autoForm3 = settingNamed('新增自定义区域类型')
  await (autoForm3?.texts ?? []).find((text) => (text.placeholder ?? '').includes('显示名')).type('My Forest')
  await autoForm3.button.click()
  check(
    'ASCII 显示名生成可读 ID custom:my-forest',
    plugin.getSettings().regionTypes.some((entry) => entry.id === 'custom:my-forest' && entry.label === 'My Forest'),
    JSON.stringify(plugin.getSettings().regionTypes.map((entry) => [entry.id, entry.label])),
  )

  // ------------------- 重建整页不许把滚动位置弹回顶部（用户实测："按新增会跳到最顶上"）
  /**
   * 机制：每次改动都是整页重建，第一步 `containerEl.empty()` 会把滚动容器清空，
   * 浏览器随即把 `scrollTop` 钳回 0 —— 于是用户每改一项就被弹回顶部。
   * 桩里的 `empty()` 已如实模拟这一步（否则这条断言是空转的：什么都不做 scrollTop 也不会变）。
   *
   * A3：驱动这件事的按钮换了位置 —— 原来用的「设置页里的新增/删除定义」已经搬到
   * 「地图定义」弹窗，而弹窗是**局部重建**（自己 `contentEl.empty()`，不经过设置页这套滚动机制）。
   * 这里改用设置页里**仍然**走整页重建的入口：顶部「快速上手」的「不再显示」与「重新显示」
   * —— 隐藏/恢复都要立刻重画整页，跟当初的新增/删除是同一类重建。
   */
  const scrollHost = plugin.settingTabs[0].containerEl
  scrollHost.scrollHeight = 2000
  scrollHost.clientHeight = 600
  openSettings()
  scrollHost.scrollTop = 420
  const hideQuickStart = collectByClass(scrollHost, 'fc-quickstart-action')[0]
  check('前提：设置页顶部有「不再显示」按钮（滚动契约的驱动入口）', hideQuickStart !== undefined)
  fireEvent(hideQuickStart, 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '隐藏引导之后设置页没跳回顶部（重建前后保住了滚动位置）',
    scrollHost.scrollTop === 420,
    `scrollTop=${scrollHost.scrollTop}`,
  )
  // 反向：恢复显示走的是同一条整页重建（不是只给"隐藏"打补丁）
  const showQuickStart = collectByClass(scrollHost, 'fc-quickstart-action')[0]
  check('隐藏之后仍有一行「重新显示」可点回来（引导不是单向门）', showQuickStart !== undefined)
  scrollHost.scrollTop = 310
  fireEvent(showQuickStart, 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '恢复显示之后同样不跳回顶部（同一条入口，不是只给"隐藏"打补丁）',
    scrollHost.scrollTop === 310,
    `scrollTop=${scrollHost.scrollTop}`,
  )

  // ---------------------------------------------------------- 上限：明确提示，不静默失败
  for (let i = 0; i < 32; i += 1) {
    await plugin.addCustomRegionType({ id: `fill${i}`, label: `填充${i}`, color: '#123456' })
  }
  check(
    '加到 32 个自定义区域类型（内置 6 种不受影响）',
    plugin.getSettings().regionTypes.filter((entry) => entry.id.startsWith('custom:')).length === 32,
    String(plugin.getSettings().regionTypes.filter((entry) => entry.id.startsWith('custom:')).length),
  )
  openDefModal()
  const cappedSetting = settingNamed('新增自定义区域类型')
  check('达到上限时说明文字给出明确原因', (cappedSetting?.info.desc ?? '').includes('已达上限'), cappedSetting?.info.desc)
  await cappedSetting.texts[0].type('overflow')
  await cappedSetting.button.click()
  check(
    '超过上限时被拒绝并给出可读原因（不静默失败）',
    regionNote().includes('最多 32 个自定义区域类型'),
    regionNote(),
  )

  // ---------------------------------------------- 改 ID 并迁移地图里的引用
  /**
   * 这是**唯一会改动用户已有地图文件**的功能，所以断言必须盯住三件事：
   * 改之前说清影响面、改之后文件里真的换了、以及冲突时一个字节都不许动。
   */
  let renameReport = null
  plugin.setReportModalFactory((_app, options) => {
    renameReport = options
    return { open() {} }
  })
  const mapFile = plugin.store.listMapFiles().find((file) => file.path.endsWith('.map.md'))
  const renameSeed = await plugin.store.load(mapFile)
  /**
   * 种一条引用 `custom:renametest` 的标记。
   *
   * ⚠️ 改的是**画布上那一份活的文档**（`layers.getDocument`）而不是重新解析出来的副本：
   * 定义随图（W4-1b）之后，改名的扫描会把"内存里那份"与"盘上那份"对齐
   * （见 `renameCustomDefinition` 的 flush）—— 往副本里塞一条、盘上留着，两边就会打架。
   */
  const liveDoc = layers.getDocument(canvasPath)
  liveDoc.markers.push({ id: 'mk-rename', label: '待改名', p: [120, 120], icon: 'custom:renametest' })
  await plugin.store.writeNow(
    mapFile,
    liveDoc,
    renameSeed.frontmatter.name ?? 'World',
    renameSeed.frontmatter.canvases,
    renameSeed.frontmatter.rest,
  )
  await plugin.addCustomMarker({ id: 'renametest', label: '改名测试' })
  check(
    '地图文件里已经写进 custom:renametest（改名的前提）',
    String(app.vault.files.get(mapFile.path)).includes('custom:renametest'),
  )

  const preview = await plugin.previewDefinitionRename('marker', 'custom:renametest', 'renamed')
  check(
    '改 ID 之前先说清影响面（几张地图、几处引用）',
    preview.ok === true && preview.text.includes('1 张地图') && preview.text.includes('共 1 处'),
    JSON.stringify(preview),
  )
  check(
    '预览里写明"现在只是预览、点确认才写盘"',
    preview.ok === true && preview.text.includes('预览'),
    JSON.stringify(preview),
  )
  // 拍快照之前先把防抖窗口里的改动落盘：改名自己也会先 flush（见 `renameCustomDefinition`），
  // 不先对齐的话"只改了一处"这条断言会把那次合法的落盘算成"多改了东西"。
  // 之后再走一次"读 → 写"往返：序列化会把每个对象的字段顺序规范成**解析层那一套**，
  // 而改名走的正是"读回来 → 改 → 写回去"这条路 —— 不先规范化，
  // 这条断言会因为"同一个对象的键顺序不同"而误报（内容其实一个字没差）。
  await plugin.store.flush()
  {
    const round = await plugin.store.load(mapFile)
    await plugin.store.writeNow(
      mapFile,
      round.document,
      round.frontmatter.name ?? 'World',
      round.frontmatter.canvases,
      round.frontmatter.rest,
    )
  }
  const unchangedBeforeApply = String(app.vault.files.get(mapFile.path))
  const sameName = await plugin.previewDefinitionRename('marker', 'custom:renametest', 'renametest')
  check('新 ID 与旧 ID 相同时被拒绝（不是"改了 0 处的假成功"）', sameName.ok === false, JSON.stringify(sameName))

  const renamed = await plugin.renameCustomDefinition('marker', 'custom:renametest', 'renamed')
  check('改名执行成功', renamed.ok === true, JSON.stringify(renamed))
  const afterText = String(app.vault.files.get(mapFile.path))
  check(
    '地图文件里的引用被一起改掉（旧 ID 一处不留）',
    afterText.includes('custom:renamed') && !afterText.includes('custom:renametest'),
    afterText.slice(afterText.indexOf('custom:'), afterText.indexOf('custom:') + 120),
  )
  check(
    '设置里的定义 ID 也改了（否则地图会显示"未定义类型（旧 ID）"）',
    plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:renamed') &&
      !plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:renametest'),
    JSON.stringify(plugin.getSettings().customMarkers.map((marker) => marker.id)),
  )
  check(
    '结果走报告面板（多行影响面不塞进 Notice）',
    renameReport !== null && String(renameReport.text).includes('custom:renamed'),
    JSON.stringify(renameReport === null ? null : String(renameReport.text).slice(0, 80)),
  )
  check(
    '未受影响的地图内容没被动过（只改了该改的那一处）',
    unchangedBeforeApply.replaceAll('custom:renametest', 'custom:renamed') === afterText,
    (() => {
      const expected = unchangedBeforeApply.replaceAll('custom:renametest', 'custom:renamed')
      let i = 0
      while (i < expected.length && i < afterText.length && expected[i] === afterText[i]) i += 1
      return `首处差异 @${i}：期望=${JSON.stringify(expected.slice(Math.max(0, i - 60), i + 80))} 实际=${JSON.stringify(afterText.slice(Math.max(0, i - 60), i + 80))}`
    })(),
  )

  plugin.setReportModalFactory((app2, options) => new ReportModal(app2, options))

  console.log('\n场景 38：选中对象 + 侧栏检查器（点选 → 信息 → 改链接 → 撤销 → 高亮）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'Select', folder: 'Maps', canvasPath })

  /**
   * 种一张"每种对象都有一个"的地图：标记 / 名称 / 路径 / 区域 / 有地形的地块。
   * 这些点位互不重叠，于是"点哪里选中谁"可以被逐条钉住。
   */
  const seeded = await store.load(file)
  seeded.document.terrain[cellKey(6, 0)] = { t: 'forest' }
  seeded.document.markers.push({ id: 'mk-1', label: '港口', p: [0, 0], icon: 'town', link: 'Places/Port.md' })
  seeded.document.labels.push({ id: 'lb-1', text: '北境', p: [900, 0] })
  seeded.document.paths.push({ id: 'pa-1', type: 'river', pts: [[-800, 600], [-400, 600], [0, 600]], width: 8, color: '#2288ff' })
  seeded.document.regions.push({ id: 'rg-1', label: '王国', pts: [[-900, -800], [-300, -800], [-300, -400]], color: '#44cf6e', opacity: 0.2, type: 'realm' })
  await store.writeNow(file, seeded.document, 'Select', [canvasPath])
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const stats = () => layers.listStatus()[0].stats
  const clickWorld = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
    flushFrames()
  }
  const selectionOf = () => editor.getSelection()

  // ---- 打开侧栏面板（检查器就在里面）----
  plugin.ribbonIcons[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
  check('地图面板已打开（检查器挂在它顶部）', panel !== undefined, String(panel))
  const selectionEl = (cls) => collectByClass(panel.contentEl, cls)[0]
  const roleEl = (role) => collectByClass(panel.contentEl, 'fc-selection-input').find((el) => el.dataset?.fcRole === role)
  const buttonByRole = (role) =>
    collectByClass(panel.contentEl, 'fc-selection-button').find((el) => el.dataset?.fcRole === role)

  // ---- 没选中：必须有一句"怎么办"（用户抱怨过引导不清晰）----
  check(
    '没选中时检查器给出引导（"点一下地图上的对象"）',
    (selectionEl('fc-selection-hint')?.textContent ?? '').includes('点一下地图上的对象'),
    String(selectionEl('fc-selection-hint')?.textContent),
  )

  // ---- 点标记：选中 + 侧栏显示信息 + 画布画高亮 ----
  clickWorld({ x: 0, y: 0 })
  check('点标记选中了它', JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'marker', id: 'mk-1' }), JSON.stringify(selectionOf()))
  check('画布上真的画了选中高亮（统计字段可读，不靠肉眼看截图）', stats()?.lastHighlight?.kind === 'marker' && stats()?.lastHighlight?.id === 'mk-1', JSON.stringify(stats()?.lastHighlight))
  check('检查器显示种类（人话）', (selectionEl('fc-selection-kind')?.textContent ?? '') === '标记', String(selectionEl('fc-selection-kind')?.textContent))
  check('检查器显示名称', roleEl('name')?.value === '港口', String(roleEl('name')?.value))
  check('检查器显示当前链接的笔记', roleEl('link')?.value === 'Places/Port.md', String(roleEl('link')?.value))
  check('检查器显示只读 ID（文件里的标识）', (selectionEl('fc-selection-id')?.textContent ?? '').includes('custom') === false, String(selectionEl('fc-selection-id')?.textContent))
  check(
    '标记的检查器渲染了它的全部动作（名称 / 链接 / 删除）—— 动作集合来自描述表',
    collectByClass(panel.contentEl, 'fc-selection-button')
      .map((el) => el.dataset?.fcRole)
      .filter((role) => typeof role === 'string' && role.length > 0)
      .join(',') === 'pick-note,clear-link,delete',
    JSON.stringify(
      collectByClass(panel.contentEl, 'fc-selection-button').map((el) => el.dataset?.fcRole),
    ),
  )

  // ---- 按下标记**元素**（拖动走的那条路）也必须先选中 ----
  // 用户要的是"先选中、再操作"：若只有点画布能选中、按住图标拖动却不能，
  // 手感会变成"拖完才发现没选中它"。
  editor.clearSelection()
  flushFrames()
  const markerClient = canvas._clientFor({ x: 0, y: 0 })
  const markerEl = collectByClass(wrapper, 'fc-marker').find((el) => el.dataset?.fcId === 'mk-1')
  check('画布上有那个标记的 DOM 元素（拖动交互挂在它身上）', markerEl !== undefined)
  firePointer(markerEl, 'pointerdown', { clientX: markerClient.x, clientY: markerClient.y })
  check(
    '按住标记元素就先选中了它（不必先点一次再拖）',
    JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'marker', id: 'mk-1' }),
    JSON.stringify(selectionOf()),
  )
  // 收尾：抬手结束这次按下（否则拖动状态一直挂着），并刷一帧让检查器跟上
  firePointer(markerEl, 'pointerup', { clientX: markerClient.x, clientY: markerClient.y })
  flushFrames()

  // ---- 核心回归：改链接 → 写进文档 → 落盘 → Ctrl+Z 能撤销 ----
  const undoBefore = editor.getStatus().undo
  roleEl('link').value = 'Places/Harbor.md'
  fireEvent(roleEl('link'), 'keydown', { key: 'Enter' })
  flushFrames()
  // 文档内存里的值立刻就能读（这是用户当下看到的状态）；**落盘是防抖的**（400ms），
  // 所以"文件里有没有"要另走一步显式 flush —— 直接 await store.load() 会读到旧内容，
  // 那会变成一条永远红（或永远绿）的假断言。
  const docAfterLink = layers.getDocument(canvasPath)
  check(
    '文档里的 link 变成了新笔记',
    docAfterLink.markers.find((marker) => marker.id === 'mk-1')?.link === 'Places/Harbor.md',
    JSON.stringify(docAfterLink.markers.find((marker) => marker.id === 'mk-1')),
  )
  check(
    '这次修改进了撤销栈（可撤销，而不是"改了就没法回头"）',
    editor.getStatus().undo === undoBefore + 1,
    `${undoBefore} → ${editor.getStatus().undo}`,
  )
  await store.flush()
  check(
    '已经落盘到地图文件（显式 flush 之后，文件里就是新链接）',
    String(app.vault.files.get(file.path)).includes('Places/Harbor.md'),
    String(app.vault.files.get(file.path)).slice(0, 120),
  )

  editor.undo()
  const docAfterUndo = layers.getDocument(canvasPath)
  check(
    'Ctrl+Z 撤销后链接回到原值',
    docAfterUndo.markers.find((marker) => marker.id === 'mk-1')?.link === 'Places/Port.md',
    JSON.stringify(docAfterUndo.markers.find((marker) => marker.id === 'mk-1')),
  )
  editor.redo()
  const docAfterRedo = layers.getDocument(canvasPath)
  check(
    '重做之后又是新链接（撤销/重做对称）',
    docAfterRedo.markers.find((marker) => marker.id === 'mk-1')?.link === 'Places/Harbor.md',
    JSON.stringify(docAfterRedo.markers.find((marker) => marker.id === 'mk-1')),
  )

  // ---- 「选择笔记…」也走同一条路（复用同一份写入）----
  let picked = null
  plugin.setImagePickerFactory((_app, options) => {
    picked = options
    return { open() {} }
  })
  buttonByRole('pick-note').dispatchEvent({ type: 'click' })
  flushFrames()
  check('「选择笔记…」打开的是笔记选择器（kind = note）', picked?.kind === 'note', JSON.stringify(picked?.kind))
  check(
    '笔记选择器只列 .md（候选里没有图片/画布）',
    Array.isArray(picked?.files) && picked.files.every((path) => path.endsWith('.md')),
    JSON.stringify(picked?.files?.slice(0, 5)),
  )

  // ---- 删掉链接 ----
  buttonByRole('clear-link').dispatchEvent({ type: 'click' })
  flushFrames()
  const docAfterClear = layers.getDocument(canvasPath)
  check(
    '「清除链接」把 link 删掉了（而不是留下空串）',
    docAfterClear.markers.find((marker) => marker.id === 'mk-1')?.link === undefined,
    JSON.stringify(docAfterClear.markers.find((marker) => marker.id === 'mk-1')),
  )

  // ---- 点其它种类的对象 ----
  clickWorld({ x: 900, y: 0 })
  check('点名称选中它', JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'label', id: 'lb-1' }), JSON.stringify(selectionOf()))
  clickWorld({ x: -400, y: 600 })
  check('点路径选中它', JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'path', id: 'pa-1' }), JSON.stringify(selectionOf()))
  clickWorld({ x: -700, y: -700 })
  check('点区域选中它', JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'region', id: 'rg-1' }), JSON.stringify(selectionOf()))
  clickWorld(axialToWorld({ kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }, 6, 0))
  check(
    '点有地形的那一格选中地块',
    JSON.stringify(selectionOf()) === JSON.stringify({ kind: 'cell', id: cellKey(6, 0) }),
    JSON.stringify(selectionOf()),
  )
  // 动作按表渲染：地块的动作表里只有 delete，所以界面上就应当只有删除按钮
  const actionRoles = () =>
    collectByClass(panel.contentEl, 'fc-selection-button')
      .map((el) => el.dataset?.fcRole)
      .filter((role) => typeof role === 'string' && role.length > 0)
  check(
    '地块的检查器只渲染删除（动作表里就这一个）',
    actionRoles().join(',') === 'delete',
    JSON.stringify(actionRoles()),
  )
  check(
    '地块的检查器没有名称/链接栏（不是灰掉、而是根本不渲染 —— 动作由表决定）',
    roleEl('name') === undefined && roleEl('link') === undefined,
    JSON.stringify({ name: roleEl('name') === undefined, link: roleEl('link') === undefined }),
  )

  // ---- 点空白处清除选中 ----
  clickWorld({ x: 4000, y: 4000 })
  check('点空白处清空选中', selectionOf() === null, JSON.stringify(selectionOf()))
  flushFrames()
  check('没有选中时不再画高亮', stats()?.lastHighlight === null, JSON.stringify(stats()?.lastHighlight))

  // ---- Esc 清除选中（优先级：先清选中，再谈草稿）----
  clickWorld({ x: 0, y: 0 })
  check('先选中一个对象（为 Esc 做准备）', selectionOf() !== null, JSON.stringify(selectionOf()))
  const escEntry = app.keymap.activeScope?.registrations.find((item) => item.key === 'Escape')
  check('地图层注册了 Esc 处理', escEntry !== undefined)
  escEntry?.handler({ key: 'Escape' })
  check('Esc 清除了选中', selectionOf() === null, JSON.stringify(selectionOf()))
  check('Esc 之后仍在选择模式（没有顺手把模式也改掉）', editor.getStatus().mode === 'select', editor.getStatus().mode)

  // ---- 检查器的「删除」走既有删除实现（可撤销）----
  // ⚠️ 必须等过双击窗口（350ms）：同一坐标上连点两次是**重命名**手势，按设计不选中。
  //    这条是写这个场景时抓到的（第二次点击之前选中一直是 null，看着像"选中坏了"）。
  await new Promise((resolve) => setTimeout(resolve, 400))
  clickWorld({ x: 0, y: 0 })
  const undoBeforeDelete = editor.getStatus().undo
  buttonByRole('delete').dispatchEvent({ type: 'click' })
  flushFrames()
  const docAfterDelete = layers.getDocument(canvasPath)
  check('删除按钮真的删掉了标记', docAfterDelete.markers.every((marker) => marker.id !== 'mk-1'), JSON.stringify(docAfterDelete.markers.map((marker) => marker.id)))
  check('删除也进了撤销栈', editor.getStatus().undo === undoBeforeDelete + 1, `${undoBeforeDelete} → ${editor.getStatus().undo}`)
  check('删掉之后选中自动清空（不指向一个不存在的对象）', selectionOf() === null, JSON.stringify(selectionOf()))
  editor.undo()
  const docAfterRestore = layers.getDocument(canvasPath)
  check('撤销把标记变回来了', docAfterRestore.markers.some((marker) => marker.id === 'mk-1'), JSON.stringify(docAfterRestore.markers.map((marker) => marker.id)))

  plugin.onunload()
}

// ================================================== 场景 39：侧栏就地编辑（A2）
console.log('\n场景 39：侧栏就地编辑（类型 / 位置 / 外观，三组默认收起）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const file = await store.createMap({ name: 'Edit', folder: 'Maps', canvasPath })

  const seeded = await store.load(file)
  seeded.document.terrain[cellKey(6, 0)] = { t: 'forest' }
  seeded.document.markers.push({ id: 'mk-1', label: '港口', p: [0, 0], icon: 'town' })
  seeded.document.paths.push({ id: 'pa-1', type: 'river', pts: [[-800, 600], [-400, 600], [0, 600]], width: 8, color: '#2288ff' })
  // 本机没有定义的类型（模拟"别的库/别的版本写下的"）：必须原样保留，同时**允许用户改掉**
  seeded.document.paths.push({ id: 'pa-unknown', type: 'spaceship-lane', pts: [[-800, -600], [-400, -600]], width: 4, color: '#8888ff' })
  seeded.document.regions.push({ id: 'rg-1', label: '王国', pts: [[-900, -800], [-300, -800], [-300, -400]], color: '#44cf6e', opacity: 0.2, type: 'realm' })
  await store.writeNow(file, seeded.document, 'Edit', [canvasPath])
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const editor = layers.getEditor(canvasPath)
  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const doc = () => layers.getDocument(canvasPath)
  const clickWorld = (world) => {
    const client = canvas._clientFor(world)
    firePointer(host, 'pointerdown', { clientX: client.x, clientY: client.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: client.x, clientY: client.y, target: wrapper })
    flushFrames()
  }

  plugin.ribbonIcons[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0].view
  const groupEl = (role) => collectByClass(panel.contentEl, 'fc-selection-group').find((el) => el.dataset?.fcGroup === role)
  const fieldEl = (name) =>
    [
      ...collectByClass(panel.contentEl, 'fc-selection-select'),
      ...collectByClass(panel.contentEl, 'fc-selection-color'),
      ...collectByClass(panel.contentEl, 'fc-selection-input'),
      ...collectByClass(panel.contentEl, 'fc-selection-mini'),
      ...collectByClass(panel.contentEl, 'fc-selection-button'),
    ].find((el) => el.dataset?.fcField === name)
  const changeField = (name, value) => {
    const el = fieldEl(name)
    el.value = value
    el.dispatchEvent({ type: 'change' })
    el.dispatchEvent({ type: 'blur' })
    flushFrames()
  }
  const commitInput = (name, value) => {
    const el = fieldEl(name)
    el.value = value
    fireEvent(el, 'keydown', { key: 'Enter' })
    flushFrames()
  }

  // ---- 选中标记：三组默认收起（用户嫌"UI 太多"，首屏只留信息与动作）----
  clickWorld({ x: 0, y: 0 })
  check('选中了标记', JSON.stringify(editor.getSelection()) === JSON.stringify({ kind: 'marker', id: 'mk-1' }), JSON.stringify(editor.getSelection()))
  check(
    '首屏就有类型/位置/外观三组（默认收起，细节按需展开）',
    collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup).join(',') ===
      'type,position,appearance',
    JSON.stringify(collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup)),
  )
  check('类型组存在且默认收起', groupEl('type') !== undefined && groupEl('type').open === false, JSON.stringify(groupEl('type')?.open))
  check('位置组默认收起', groupEl('position') !== undefined && groupEl('position').open === false, JSON.stringify(groupEl('position')?.open))
  check('外观组默认收起', groupEl('appearance') !== undefined && groupEl('appearance').open === false, JSON.stringify(groupEl('appearance')?.open))

  // ---- 类型：下拉列出内置与自定义，改完只影响这一个对象 ----
  const typeSelect = fieldEl('type')
  check('类型下拉的当前值就是它的图标', typeSelect?.value === 'town', String(typeSelect?.value))
  check(
    '类型下拉列出了内置 9 种（不是空下拉）',
    (typeSelect?.children ?? []).length >= 9,
    String((typeSelect?.children ?? []).length),
  )
  const undoBeforeType = editor.getStatus().undo
  changeField('type', 'city')
  check('改类型写进了文档', doc().markers[0]?.icon === 'city', String(doc().markers[0]?.icon))
  check('改类型没有连带改别的字段（名称与链接不动）', doc().markers[0]?.label === '港口', JSON.stringify(doc().markers[0]))
  check('改类型进了一条历史', editor.getStatus().undo === undoBeforeType + 1, `${undoBeforeType} → ${editor.getStatus().undo}`)
  editor.undo()
  check('撤销把类型退回去了', doc().markers[0]?.icon === 'town', String(doc().markers[0]?.icon))
  flushFrames()

  // ---- 位置：点对象的坐标可编辑（一次提交 = 一条历史）----
  clickWorld({ x: 0, y: 0 })
  const undoBeforeMove = editor.getStatus().undo
  commitInput('x', '250')
  commitInput('y', '-75')
  check(
    '坐标输入写进了文档',
    JSON.stringify(doc().markers[0]?.p) === JSON.stringify([250, -75]),
    JSON.stringify(doc().markers[0]?.p),
  )
  check(
    '两次输入 = 两条历史（每个字段一次提交，不因按键逐字写盘）',
    editor.getStatus().undo === undoBeforeMove + 2,
    `${undoBeforeMove} → ${editor.getStatus().undo}`,
  )
  editor.undo()
  editor.undo()
  check('撤销两次回到原位', JSON.stringify(doc().markers[0]?.p) === JSON.stringify([0, 0]), JSON.stringify(doc().markers[0]?.p))
  flushFrames()

  // ---- 外观：颜色 / 虚线 / 越界值 ----
  clickWorld({ x: -400, y: 600 })
  check('选中了路径（形状命中）', JSON.stringify(editor.getSelection()) === JSON.stringify({ kind: 'path', id: 'pa-1' }), JSON.stringify(editor.getSelection()))
  changeField('field-color', '#ff00aa')
  check('改颜色写进了文档', doc().paths.find((item) => item.id === 'pa-1')?.color === '#ff00aa', String(doc().paths.find((item) => item.id === 'pa-1')?.color))
  commitInput('field-dash', '12,4')
  check(
    '虚线按"逗号分隔的数组"写进文档（沿用既有三态语义，不重新发明）',
    JSON.stringify(doc().paths.find((item) => item.id === 'pa-1')?.dash) === JSON.stringify([12, 4]),
    JSON.stringify(doc().paths.find((item) => item.id === 'pa-1')?.dash),
  )
  const undoBeforeBadWidth = editor.getStatus().undo
  commitInput('field-width', '99')
  check(
    '超出范围的线宽被拒绝，且**不写历史**（静默夹到 40 会让界面与文件不一致）',
    doc().paths.find((item) => item.id === 'pa-1')?.width === 8 && editor.getStatus().undo === undoBeforeBadWidth,
    `width=${String(doc().paths.find((item) => item.id === 'pa-1')?.width)} undo=${editor.getStatus().undo}`,
  )
  commitInput('field-dash', '')
  check(
    '虚线留空 = 删除该字段（回到类型默认，而不是写一个空数组）',
    doc().paths.find((item) => item.id === 'pa-1')?.dash === undefined,
    JSON.stringify(doc().paths.find((item) => item.id === 'pa-1')?.dash),
  )

  // ---- 未知类型：原样保留 + 可改成已知类型；改类型不许连带改它的参数 ----
  clickWorld({ x: -600, y: -600 })
  check('选中了那条"未知类型"的路径', JSON.stringify(editor.getSelection()) === JSON.stringify({ kind: 'path', id: 'pa-unknown' }), JSON.stringify(editor.getSelection()))
  const unknownSelect = fieldEl('type')
  check(
    '下拉里补了一条「未定义类型（spaceship-lane）」并保持为当前值（不改写用户数据）',
    unknownSelect?.value === 'spaceship-lane' &&
      (unknownSelect?.children ?? []).some((option) => (option.textContent ?? '').includes(unknownTypeLabel('spaceship-lane'))),
    `${String(unknownSelect?.value)} | ${JSON.stringify((unknownSelect?.children ?? []).map((option) => option.textContent))}`,
  )
  // ⚠️ 抓的是**快照值**而不是对象引用：拿引用比会在"实现把对象换掉"时照样通过（空转）。
  // 这条是跑鉴别力验证时抓出来的 —— 那次破坏只让"改颜色"那条红了，说明这里原来白测。
  const beforeUnknown = (() => {
    const path = doc().paths.find((item) => item.id === 'pa-unknown')
    return { color: path?.color, width: path?.width, points: path?.pts.length }
  })()
  changeField('type', 'road')
  const afterUnknown = (() => {
    const path = doc().paths.find((item) => item.id === 'pa-unknown')
    return { type: path?.type, color: path?.color, width: path?.width, points: path?.pts.length }
  })()
  check('可以把未知类型改成已知类型', afterUnknown.type === 'road', String(afterUnknown.type))
  check(
    '改类型没有连带改它的颜色与线宽（那些是对象自己的参数）',
    afterUnknown.color === beforeUnknown.color && afterUnknown.width === beforeUnknown.width,
    JSON.stringify({ before: beforeUnknown, after: afterUnknown }),
  )
  check('顶点数没变（改类型不动几何）', afterUnknown.points === beforeUnknown.points, JSON.stringify(afterUnknown))

  // ---- 移到视口中心（形状按包围盒中心平移，一条历史，可撤销）----
  const visible = layers.listStatus()[0].stats?.lastVisibleWorld
  const centerBefore = doc().regions[0]?.pts.map((point) => [...point])
  // ⚠️ 必须点在**区域内、且避开那条 y=-600 的路径**：路径的命中优先级高于区域，
  //    点在两者重叠处会选中路径 —— 这条是写这个场景时抓到的（"居中没生效"其实是选错了对象）。
  editor.selectAt({ x: -500, y: -700 }, 20)
  flushFrames()
  check('选中了区域（不是与它重叠的路径）', editor.getSelection()?.kind === 'region', JSON.stringify(editor.getSelection()))
  const undoBeforeCenter = editor.getStatus().undo
  const centerButton = fieldEl('center')
  check('形状的位置组给出了「移到视口中心」', centerButton !== undefined)
  centerButton.dispatchEvent({ type: 'click' })
  flushFrames()
  const moved = doc().regions[0]
  const movedMinX = Math.min(...(moved?.pts ?? []).map((point) => point[0]))
  const movedMaxX = Math.max(...(moved?.pts ?? []).map((point) => point[0]))
  const movedMinY = Math.min(...(moved?.pts ?? []).map((point) => point[1]))
  const movedMaxY = Math.max(...(moved?.pts ?? []).map((point) => point[1]))
  const expectedX = ((visible?.minX ?? 0) + (visible?.maxX ?? 0)) / 2
  const expectedY = ((visible?.minY ?? 0) + (visible?.maxY ?? 0)) / 2
  check(
    '区域被移到视口中心（按包围盒中心对齐，误差 < 1e-6）',
    Math.abs((movedMinX + movedMaxX) / 2 - expectedX) < 1e-6 && Math.abs((movedMinY + movedMaxY) / 2 - expectedY) < 1e-6,
    JSON.stringify({ got: [(movedMinX + movedMaxX) / 2, (movedMinY + movedMaxY) / 2], want: [expectedX, expectedY] }),
  )
  check('居中进了一条历史', editor.getStatus().undo === undoBeforeCenter + 1, `${undoBeforeCenter} → ${editor.getStatus().undo}`)
  editor.undo()
  check(
    '撤销把区域放回原位（顶点一个不差）',
    JSON.stringify(doc().regions[0]?.pts) === JSON.stringify(centerBefore),
    JSON.stringify(doc().regions[0]?.pts),
  )
  flushFrames()

  // ---- 单格叠加色：设了能清掉（清 = 删字段，不是写 null）----
  clickWorld({ x: 0, y: 0 })
  changeField('field-c', '#123456')
  check('单格叠加色写进了文档', doc().markers[0]?.c === '#123456', String(doc().markers[0]?.c))
  const clearButton = fieldEl('clear-c')
  check('有单格叠加色时「清除」可用', clearButton?.disabled === false, String(clearButton?.disabled))
  clearButton.dispatchEvent({ type: 'click' })
  flushFrames()
  check(
    '清除 = 删掉该字段（不是写一个 null 进去）',
    'c' in (doc().markers[0] ?? {}) === false,
    JSON.stringify(doc().markers[0]),
  )

  // ---- 地块：能改地形种类，但没有名称/链接，位置只读 ----
  clickWorld({ x: 0, y: 0 })
  const grid = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
  editor.selectAt(axialToWorld(grid, 6, 0), 20)
  flushFrames()
  check(
    '地块的类型组在（能改地形种类）',
    groupEl('type') !== undefined && fieldEl('type')?.value === 'forest',
    String(fieldEl('type')?.value),
  )
  check('地块没有名称栏与链接栏（动作表里只有删除）', fieldEl('name') === undefined && fieldEl('link') === undefined)
  check(
    '地块的位置是只读文字（不能搬地形）',
    (collectByClass(panel.contentEl, 'fc-selection-readonly')[0]?.textContent ?? '').includes('不能搬动'),
    String(collectByClass(panel.contentEl, 'fc-selection-readonly')[0]?.textContent),
  )
  changeField('type', 'mountain')
  check('改地形种类写进了文档', doc().terrain[cellKey(6, 0)]?.t === 'mountain', String(doc().terrain[cellKey(6, 0)]?.t))

  // ---- 数值图层：地块上的温度 / 深度（「一格多值」的前两个正式字段）----
  // 它们**不该**混进「外观」组：那句提示说的是"只影响这一个对象"，而温度是给覆盖层上色用的
  check(
    '地块多出一组「数值图层」，且没有污染「外观」组',
    groupEl('data') !== undefined &&
      collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup).join(',') ===
        'type,position,appearance,data',
    JSON.stringify(collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup)),
  )
  const undoBeforeTemp = editor.getStatus().undo
  groupEl('data').open = true // 模拟用户点开「数值图层」这一组
  commitInput('field-temp', '-12.5')
  check(
    '改完一个字段后，展开着的组仍然是展开的（不用每次重新点开）',
    groupEl('data')?.open === true,
    String(groupEl('data')?.open),
  )
  check(
    '没被展开过的组依旧收起（不是"一律展开"）',
    groupEl('appearance')?.open === false,
    String(groupEl('appearance')?.open),
  )
  check(
    '在检查器里改温度写进了文档',
    doc().terrain[cellKey(6, 0)]?.temp === -12.5,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )
  check(
    '改温度记了一条可撤销的历史',
    editor.getStatus().undo === undoBeforeTemp + 1,
    `${undoBeforeTemp} → ${editor.getStatus().undo}`,
  )
  editor.undo()
  flushFrames()
  check(
    '撤销后温度那个键被删掉（不是写成 0 —— "没有数据"与 0 ℃ 是两回事）',
    'temp' in (doc().terrain[cellKey(6, 0)] ?? {}) === false,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )
  const undoBeforeOutOfRange = editor.getStatus().undo
  commitInput('field-depth', '99999')
  check(
    '超出配色全部锚点的值照样写得进去（数值图层没有取值区间：配色两端只决定怎么染色）',
    doc().terrain[cellKey(6, 0)]?.depth === 99999 && editor.getStatus().undo === undoBeforeOutOfRange + 1,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )
  commitInput('field-depth', '3400')
  check(
    '深度可以再改成范围内的值（0 = 海平面，正 = 向下）',
    doc().terrain[cellKey(6, 0)]?.depth === 3400,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )

  // ---- 多对象选择：同类多选（UI 整理 W2-2 · §2.6「多个同类对象」）----
  // 三条边界一起验：只允许同类、逐项一行 + 可移除、公共字段（类型 / 链接 / 删除）。
  doc().markers.push({ id: 'mk-2', label: '灯塔', p: [60, 60], icon: 'town', link: 'Places/Lighthouse.md' })
  editor.setObjectSelection([
    { kind: 'marker', id: 'mk-1' },
    { kind: 'marker', id: 'mk-2' },
  ])
  flushFrames()
  const objectsHead = () => collectByClass(panel.contentEl, 'fc-selection-kind')[0]?.textContent ?? ''
  const objectsItems = () =>
    collectByClass(panel.contentEl, 'fc-object-item').map((row) => ({
      id: row.dataset.fcObjectItem,
      name: collectByClass(row, 'fc-object-item-name')[0]?.textContent ?? '',
      detail: collectByClass(row, 'fc-object-item-detail')[0]?.textContent ?? '',
    }))
  check('多选同类对象时，侧栏换成「已选 2 个标记」', objectsHead() === PANEL_TITLES.objectBatch(2, '标记'), objectsHead())
  check(
    '逐项一行：两个标记各一行，名称写人话（不是裸 ID）',
    objectsItems().map((item) => item.name).join('|') === '港口|灯塔',
    JSON.stringify(objectsItems()),
  )
  check('每一行都带一行补充信息（位置 / 图标）', objectsItems().every((item) => item.detail.length > 0), JSON.stringify(objectsItems()))
  check(
    '每一行都能「移除」（选择里逐项可去掉）',
    collectByClass(panel.contentEl, 'fc-object-remove').length === 2,
    String(collectByClass(panel.contentEl, 'fc-object-remove').length),
  )

  // 公共字段 ① 类型（图标）：共同值预填 → 改一次两个都变 → 一次撤销两个都回
  const objectsTypeSelect = () => collectByClass(panel.contentEl, 'fc-selection-select')[0]
  check('公共字段里有「类型」下拉，并预填**共同值** town', objectsTypeSelect()?.value === 'town', String(objectsTypeSelect()?.value))
  const undoBeforeObjectsType = editor.getStatus().undo
  objectsTypeSelect().value = 'city'
  fireEvent(objectsTypeSelect(), 'change')
  flushFrames()
  check(
    '改类型 → 两个对象一起改，而且只记**一条**历史',
    doc().markers.every((marker) => marker.icon === 'city') && editor.getStatus().undo === undoBeforeObjectsType + 1,
    `${JSON.stringify(doc().markers.map((marker) => marker.icon))} undo=${undoBeforeObjectsType} → ${editor.getStatus().undo}`,
  )
  editor.undo()
  flushFrames()
  check('撤销一次两个都回去（不是 N 条历史）', doc().markers.every((marker) => marker.icon === 'town'), JSON.stringify(doc().markers.map((marker) => marker.icon)))

  // 公共字段 ② 链接：各不相同 → 留空并写明，且失焦不会把它们统一成空
  const objectsLinkInput = () =>
    collectByClass(panel.contentEl, 'fc-selection-input').find((element) => element.dataset?.fcRole === 'objects-link')
  check(
    '链接各不相同 → 输入框留空并写明「各不相同」（**不猜共同值**）',
    (objectsLinkInput()?.value ?? 'x') === '' && (objectsLinkInput()?.placeholder ?? '').includes('各不相同'),
    String(objectsLinkInput()?.placeholder),
  )
  const linksBefore = JSON.stringify(doc().markers.map((marker) => marker.link ?? null))
  fireEvent(objectsLinkInput(), 'blur')
  flushFrames()
  check(
    '各不相同又没改：失焦不会把它们统一成空（**逐字比较**前后的链接）',
    JSON.stringify(doc().markers.map((marker) => marker.link ?? null)) === linksBefore,
    `${linksBefore} → ${JSON.stringify(doc().markers.map((marker) => marker.link ?? null))}`,
  )

  // ③ 「移除」只移出这次选择，不删对象
  fireEvent(collectByClass(panel.contentEl, 'fc-object-remove')[1], 'click')
  flushFrames()
  check(
    '「移除」只把它移出这次选择（对象还在文档里）',
    editor.getObjectSelection().length === 1 && doc().markers.length === 2,
    `${editor.getObjectSelection().length} / ${doc().markers.length}`,
  )
  check(
    '剩一个时回到单对象检查器（「已选 N 个」那一段消失）',
    objectsItems().length === 0 && objectsHead() !== PANEL_TITLES.objectBatch(2, '标记'),
    objectsHead(),
  )

  // ④ 公共字段 ③ 删除：一次提交 = 一条历史
  editor.setObjectSelection([
    { kind: 'marker', id: 'mk-1' },
    { kind: 'marker', id: 'mk-2' },
  ])
  flushFrames()
  const objectsDeleteButton = () =>
    collectByClass(panel.contentEl, 'fc-panel-button').find((button) =>
      (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes(PANEL_TITLES.deleteMany(2)),
    )
  check('公共字段里有「删除这 N 个」', objectsDeleteButton() !== undefined)
  fireEvent(objectsDeleteButton(), 'click')
  flushFrames()
  check('「删除这 N 个」把两个都删掉', doc().markers.length === 0, String(doc().markers.length))
  editor.undo()
  flushFrames()
  check('撤销一次两个都回来（一次提交 = 一条历史）', doc().markers.length === 2, String(doc().markers.length))

  // ⑤ 异类混选不做：交进去也会被归一化成"第一项那一类"
  editor.setObjectSelection([
    { kind: 'marker', id: 'mk-1' },
    { kind: 'path', id: 'no-such-path' },
  ])
  flushFrames()
  check(
    '异类混选被归一化掉（只留第一项那一类，§1 第 10 条"字段必须是共有"）',
    editor.getObjectSelection().every((item) => item.kind === 'marker'),
    JSON.stringify(editor.getObjectSelection()),
  )
  editor.clearAllSelection()
  flushFrames()

  // ---- 「撤销这些改动」那一行与它的按钮已删除（UI 整理 §2.7 方案 A）----
  // 它自己的注释就承认"与逐条 Ctrl+Z 一模一样"⇒ 多出一条撤销路径而已。
  // 保留的撤销路径：Ctrl/Cmd+Z · 画布浮窗撤销/重做 · 命令面板两条。
  // ⚠️ 这一段原来有 **4 条**断言（不是规划文件里写的 2 条）⇒ 冒烟 1450 → 1446。

  plugin.onunload()
}

console.log('\n场景 40：A3 —— 设置页瘦身、两份「快速上手」引导与「地图定义」的新家')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const canvasPath = 'Maps/World.canvas'
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

  const settingsRoot = plugin.settingTabs[0].containerEl
  const renderSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 设置页顶部那一份引导（隐藏后这里就没有了，改用 `fc-quickstart-restore` 那一行） */
  const quickStart = () => collectByClass(settingsRoot, 'fc-quickstart').find((el) => el.dataset?.fcQuickStart === 'settings')
  const restoreRow = () => collectByClass(settingsRoot, 'fc-quickstart-restore').find((el) => el.dataset?.fcQuickStart === 'settings-hidden')
  const settingsGroup = (role) => collectByClass(settingsRoot, 'fc-settings-group').find((el) => el.dataset?.fcGroup === role)
  const quickStartAction = (root, role) =>
    collectByClass(root, 'fc-quickstart-action').find((el) => el.dataset?.fcRole === role)
  const itemTitles = (block) => collectByClass(block, 'fc-quickstart-item-title').map((el) => el.textContent ?? '')
  const persisted = () => (plugin._data === null ? null : JSON.parse(plugin._data))

  // ---------------------------------------------------------- 1. 设置页顶部那份引导
  renderSettings()
  const block = quickStart()
  check('设置页顶部有「快速上手」清单', block !== undefined, `fc-quickstart=${String(block?.dataset?.fcQuickStart)}`)
  const items = collectByClass(block, 'fc-quickstart-item')
  check(
    '清单里每一条都有标题与一句说明（不是一串光秃秃的命令名）',
    items.length >= 4 &&
      items.every(
        (el) =>
          (collectByClass(el, 'fc-quickstart-item-title')[0]?.textContent ?? '').length > 0 &&
          (collectByClass(el, 'fc-quickstart-item-hint')[0]?.textContent ?? '').length > 0,
      ),
    `${items.length} 条`,
  )
  check(
    '设置页这份讲的是"设置页附近的入口"：里面写了定义的新家（面板 →「地图定义」）',
    (block?.textContent ?? '').includes('地图定义'),
    String(block?.textContent).slice(0, 160),
  )
  const settingsTitles = itemTitles(block)

  // ---------------------------------------------------------- 2. 可关闭、可逆、且落盘
  const hideSettings = quickStartAction(block, 'quickstart-hide')
  check('「不再显示」按钮带稳定标记（断言不怕以后改文案）', hideSettings !== undefined)
  fireEvent(hideSettings, 'click')
  await tick(40)
  check('点「不再显示」后清单真的消失了', quickStart() === undefined)
  check(
    '但留了一行「重新显示」（引导本身是"找不到入口"的解法，不能做成单向门）',
    restoreRow() !== undefined && (restoreRow()?.textContent ?? '').includes(SETTINGS_LABELS.quickStartShowAgain),
    String(restoreRow()?.textContent),
  )
  check('隐藏状态写进了设置并落盘', persisted()?.hideQuickStartSettings === true, String(plugin._data).slice(0, 160))
  check(
    '面板那份引导不受影响（两份各管各的，关一份不会顺手关另一份）',
    plugin.getSettings().hideQuickStartPanel === false && persisted()?.hideQuickStartPanel === false,
    String(persisted()?.hideQuickStartPanel),
  )
  fireEvent(quickStartAction(restoreRow(), 'quickstart-show'), 'click')
  await tick(40)
  check('点「重新显示」清单回来了（可逆）', quickStart() !== undefined)
  check('恢复也落了盘（下次打开设置页看到的是展开的）', persisted()?.hideQuickStartSettings === false, String(persisted()?.hideQuickStartSettings))

  // ---------------------------------------------------------- 3. 重区块默认收起
  renderSettings()
  const defaultsGroup = settingsGroup('defaults')
  check(
    // W1c：图层开关整组搬出设置页 ⇒ 这一页不再有「图层」这个折叠组
    '设置页里没有「图层」这个折叠组（开关的家在侧栏「底图」「地物」）',
    settingsGroup('layers') === undefined,
    String(settingsGroup('layers')?.tagName),
  )
  check(
    '「新对象默认值」还是个默认收起的折叠组（一屏不再摊开几十个输入框）',
    defaultsGroup?.tagName === 'DETAILS' && defaultsGroup.open === false,
    `tag=${String(defaultsGroup?.tagName)} open=${String(defaultsGroup?.open)}`,
  )
  check(
    '折叠只是"收起"，不是"拿掉"：这一组里仍然摆着名称字体那一行',
    FakeSetting.created.some((setting) => setting.containerEl === defaultsGroup && setting.info.name === SETTINGS_LABELS.labelFont),
    String(FakeSetting.created.filter((setting) => setting.containerEl === defaultsGroup).map((setting) => setting.info.name)),
  )
  check(
    // W4-1b（定义随图）：路径 / 区域类型的参数整节搬进「地图定义」弹窗，这一页不再有它们
    '路径 / 区域类型的参数已经不在这一组里（一个控件只有一个家）',
    !FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('线宽与虚线') || (setting.info.name ?? '').includes('边框宽与虚线')),
    String(FakeSetting.created.map((setting) => setting.info.name).filter((name) => String(name).includes('虚线'))),
  )

  // ---------------------------------------------------------- 4. 定义管理控件搬走了，但留了指路
  check('设置页里找不到「新增自定义地形」（已搬进弹窗）', settingNamed(DEFINITION_MODAL_LABELS.addTerrain) === undefined)
  check('设置页里找不到「新增自定义标记」（已搬进弹窗）', settingNamed(DEFINITION_MODAL_LABELS.addMarker) === undefined)
  const hint = collectByClass(settingsRoot, 'fc-settings-note').find((el) => el.dataset?.fcSettingsRole === 'definitions-hint')
  check(
    '设置页留了一行指路（告诉用户定义的新家在哪）',
    (hint?.textContent ?? '').includes('地图定义'),
    String(hint?.textContent).slice(0, 200),
  )

  // ---------------------------------------------------------- 5. 面板：动作组 + 面板那份引导
  plugin.ribbonIcons[0].callback()
  await tick(40)
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0].view
  const panelButton = (fragment) =>
    collectByClass(panel.contentEl, 'fc-panel-button').find((button) =>
      (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes(fragment),
    )
  const manage = plugin.getPanelActions().find((action) => action.id === 'manage-definitions')
  check(
    '动作表里有「管理地图定义…」，且它属于新的一组 `def`（与编辑/文件分开）',
    manage !== undefined && manage.group === 'def',
    JSON.stringify(manage),
  )
  check('面板里真的画出了这个按钮（命令面板与面板同一份定义）', panelButton('管理地图定义') !== undefined)
  check(
    '面板里不再画「导出定义文件」按钮（它搬去了设置页，见场景 36）',
    panelButton('导出定义文件') === undefined,
    String(panelButton('导出定义文件')?.textContent),
  )
  check(
    '面板里也不再画「导入定义文件」按钮（命令面板与设置页仍可点）',
    panelButton(DIALOG_LABELS.importDefinitions) === undefined,
    String(panelButton(DIALOG_LABELS.importDefinitions)?.textContent),
  )
  check(
    '面板里出现了「地图定义」这一组标题',
    collectByClass(panel.contentEl, 'fc-panel-group-title')
      .map((el) => el.textContent ?? '')
      .includes(DEFINITION_MODAL_LABELS.title),
    JSON.stringify(collectByClass(panel.contentEl, 'fc-panel-group-title').map((el) => el.textContent)),
  )

  const panelBlock = () => collectByClass(panel.contentEl, 'fc-quickstart').find((el) => el.dataset?.fcQuickStart === 'panel')
  const panelRestore = () =>
    collectByClass(panel.contentEl, 'fc-quickstart-restore').find((el) => el.dataset?.fcQuickStart === 'panel-hidden')
  check('面板里也有一份「快速上手」', panelBlock() !== undefined)
  check(
    '两份引导是**两份不同的文案**（各自介绍各自的用法，不是同一份复制粘贴）',
    JSON.stringify(itemTitles(panelBlock())) !== JSON.stringify(settingsTitles),
    JSON.stringify(itemTitles(panelBlock())),
  )
  fireEvent(quickStartAction(panelBlock(), 'quickstart-hide'), 'click')
  await tick(40)
  flushFrames()
  check('点面板那份的「不再显示」后它消失了', panelBlock() === undefined)
  check('面板也留了一行能点回来（同样是可逆的）', panelRestore() !== undefined, String(panelRestore()?.textContent))
  check('面板那份的隐藏状态同样落盘', persisted()?.hideQuickStartPanel === true, String(persisted()?.hideQuickStartPanel))
  check(
    '设置页那份不受影响（刚恢复过，仍是显示状态）',
    plugin.getSettings().hideQuickStartSettings === false,
    String(plugin.getSettings().hideQuickStartSettings),
  )
  fireEvent(quickStartAction(panelRestore(), 'quickstart-show'), 'click')
  await tick(40)
  flushFrames()
  check('点面板那行的「显示」后面板引导回来了', panelBlock() !== undefined)

  // ---------------------------------------------------------- 6. 弹窗：四组默认收起 + 改定义仍能落盘
  await plugin.addCustomTerrain({ id: 'reef', label: '礁石' })
  FakeSetting.created.length = 0
  const defModal = openDefinitionManager(plugin)
  const defGroups = collectByClass(defModal.contentEl, 'fc-defmodal-group')
  check(
    '弹窗里四类定义各有一组（地形 / 标记 / 路径类型 / 区域类型）',
    defGroups.map((el) => el.dataset?.fcGroup).join(',') === 'terrain,marker,pathType,regionType',
    JSON.stringify(defGroups.map((el) => el.dataset?.fcGroup)),
  )
  check(
    '四组都默认收起（首屏只有四行标题，不再是一大片输入框）',
    defGroups.length === 4 && defGroups.every((el) => el.tagName === 'DETAILS' && el.open === false),
    JSON.stringify(defGroups.map((el) => [el.tagName, el.open])),
  )
  const reefRow = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(DEFINITION_ROW_LABELS.terrainNameColor('礁石')))
  check('地形组里有这条定义的配色行（搬迁前后控件一个不少）', reefRow !== undefined)
  await reefRow.colorPickers[0].pick('#123456')
  await tick(30)
  check(
    '在弹窗里改颜色真的写进了设置',
    plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:reef')?.color === '#123456',
    JSON.stringify(plugin.getSettings().customTerrains),
  )
  check(
    '并落了盘（与设置页时代是同一条写入路径）',
    (persisted()?.customTerrains ?? []).some((terrain) => terrain.id === 'custom:reef' && terrain.color === '#123456'),
    JSON.stringify(persisted()?.customTerrains),
  )
  check(
    '弹窗里那条「改 ID…」按钮也在（定义管理只剩这一个住处）',
    (reefRow.buttons ?? []).some((button) => button.text === MODAL_ACTIONS.renameId) &&
      (reefRow.buttons ?? []).some((button) => button.text === MODAL_ACTIONS.delete),
    JSON.stringify((reefRow.buttons ?? []).map((button) => button.text)),
  )

  // ---------------------------------------------------------- 6b. W3-2：自带 / 自定义分区 + 每条收成一行
  // 用户口径（§5 第 3 条）：「自定义的和本身自带的混在一起，阅读量大且无用」。
  check(
    '四节各有「自定义（N）」分区标题（四类定义各一条）',
    collectByClass(defModal.contentEl, 'fc-defsection').filter((el) => el.dataset?.fcSection === 'custom').length === 4,
    JSON.stringify(collectByClass(defModal.contentEl, 'fc-defsection').map((el) => [el.dataset?.fcSection, el.textContent])),
  )
  const builtinLists = collectByClass(defModal.contentEl, 'fc-defbuiltin')
  check(
    '地形与标记各有「内置」只读清单，且都默认收起（不占首屏阅读量）',
    builtinLists.length === 2 && builtinLists.every((el) => el.open === false),
    JSON.stringify(builtinLists.map((el) => [el.dataset?.fcBuiltin, el.open])),
  )
  check(
    '内置清单只列名字，共 9 + 9 = 18 条（与目录同源，不是手抄一份）',
    collectByClass(defModal.contentEl, 'fc-defbuiltin-row').length === 18,
    String(collectByClass(defModal.contentEl, 'fc-defbuiltin-row').length),
  )
  check(
    // W4-1b：路径 / 区域类型的内置项**参数可改**，所以给它们开了入口 —— 做成可点开的条目，不是只读清单
    '路径 / 区域类型的内置项不是只读清单，而是可改参数的条目（内置 4 + 6 也给了入口）',
    collectByClass(defModal.contentEl, 'fc-defsection').filter((el) => el.dataset?.fcSection === 'builtin').length === 2 &&
      FakeSetting.created.some((setting) => setting.info.name === DEFINITION_ROW_LABELS.appearance('河流')) &&
      FakeSetting.created.some((setting) => setting.info.name === DEFINITION_ROW_LABELS.fillBorder('王国')),
    JSON.stringify(collectByClass(defModal.contentEl, 'fc-defsection').map((el) => [el.dataset?.fcSection, el.textContent])),
  )
  const defItems = collectByClass(defModal.contentEl, 'fc-defitem')
  check(
    '每条定义（自定义 + 可改参数的内置）各收成一个条目，且默认收起（点开才编辑）',
    defItems.length === 11 && defItems.every((el) => el.open === false),
    JSON.stringify(defItems.map((el) => [el.dataset?.fcDef, el.open])),
  )
  check(
    '条目标题行写的是「序号 + 显示名 + ID」，而不是把控件摊在标题上',
    (collectByClass(defItems[0] ?? defModal.contentEl, 'fc-defitem-name')[0]?.textContent ?? '') === '1. 礁石' &&
      (collectByClass(defItems[0] ?? defModal.contentEl, 'fc-defitem-id')[0]?.textContent ?? '') === 'custom:reef',
    JSON.stringify({
      name: collectByClass(defItems[0] ?? defModal.contentEl, 'fc-defitem-name')[0]?.textContent,
      id: collectByClass(defItems[0] ?? defModal.contentEl, 'fc-defitem-id')[0]?.textContent,
    }),
  )
  // 展开状态跨重建保留：打开它 → 切一次模式（会整块重建）→ 它应该还开着。
  // 不读回状态的话，用户"改一个值就要重新点开一次"（与 MapPanel 那个坑同一类）。
  defItems[0].open = true
  fireEvent(
    collectByClass(defItems[0], 'fc-terrain-mode-button').find((button) => button.dataset.mode === 'image'),
    'click',
  )
  await tick(40)
  check(
    '改一个值（切模式）之后那条定义仍然开着（不是"改一次就要重新点开一次"）',
    collectByClass(defModal.contentEl, 'fc-defitem').find((el) => el.dataset?.fcDef === 'custom:reef')?.open === true,
    JSON.stringify(collectByClass(defModal.contentEl, 'fc-defitem').map((el) => [el.dataset?.fcDef, el.open])),
  )

  // ---------------------------------------------------------- 7. 内置行不建按钮 + 新增流程真的能跑
  // 这两条是真实库里的现象逼出来的：内置类型的行上挂着**两个空按钮**（`addButton` 先建元素
  // 再回调，回调里提前 return 只做到了"不设文字"，按钮本身还在），而"新增"这条操作链
  // 在 A3 搬迁后**一条断言都没有**。
  // W3-2：地形 / 标记的内置定义**不再建成可编辑的行** —— 它们搬进了只读清单（纯文本行）。
  // 于是"内置行上有没有空按钮"这个老问题从根上没了：那里根本没有控件可留。
  // W4-1b 的例外：路径 / 区域类型的内置项**参数可改**（参数随图），所以它们是有控件的条目。
  const builtinListEl = collectByClass(defModal.contentEl, 'fc-defbuiltin').find(
    (el) => el.dataset?.fcBuiltin === 'terrain',
  )
  check(
    // W3-2：地形 / 标记的内置定义**不建成可编辑的行** —— 它们搬进了只读清单（纯文本行）。
    // W4-1b 的例外：路径 / 区域类型的内置项**参数可改**，所以它们是有控件的条目（见上一条）。
    '地形 / 标记的内置定义不建成可编辑行（它们是只读清单里的纯文本）',
    !FakeSetting.created.some((setting) => setting.info.name === '森林' || setting.info.name === '通用'),
    JSON.stringify(FakeSetting.created.map((s) => s.info.name).filter((name) => name === '森林' || name === '通用')),
  )
  check(
    '地形内置清单是纯文本行：名字 + ID（没有任何按钮可留）',
    builtinListEl !== undefined &&
      collectByClass(builtinListEl, 'fc-defbuiltin-row').length === 9 &&
      collectByClass(builtinListEl, 'fc-defbuiltin-name').every((el) => (el.textContent ?? '').length > 0),
    JSON.stringify(collectByClass(builtinListEl ?? defModal.contentEl, 'fc-defbuiltin-name').map((el) => el.textContent)),
  )
  check(
    '路径类型没有只读清单（它的内置项要能改参数）',
    collectByClass(defModal.contentEl, 'fc-defbuiltin').every((el) => el.dataset?.fcBuiltin !== 'pathType'),
    JSON.stringify(collectByClass(defModal.contentEl, 'fc-defbuiltin').map((el) => el.dataset?.fcBuiltin)),
  )

  const addPathRow = FakeSetting.created.find((setting) => setting.info.name === DEFINITION_MODAL_LABELS.addPathType)
  check(
    '新增自定义路径类型那一行有 ID 与显示名两个输入框',
    addPathRow !== undefined && (addPathRow.texts ?? []).length >= 2,
    String((addPathRow?.texts ?? []).length),
  )
  await addPathRow.texts[0].type('highway')
  await addPathRow.texts[1].type('商路')
  await addPathRow.buttons[0].click()
  await tick(30)
  check(
    '点「新增」真的新增了一条自定义路径类型（ID 自动补 custom: 前缀）',
    plugin.getSettings().pathTypes.some((entry) => entry.id === 'custom:highway' && entry.label === '商路'),
    JSON.stringify(plugin.getSettings().pathTypes.map((entry) => entry.id)),
  )
  // 名字就是显示名 —— 自定义与内置已经分在两个区里，不再需要「（自定义）」后缀区分
  // （W4-1b：这一行现在叫「名称 · 商路」—— 它同一行里还挂着参数入口之外的身份信息）
  const newPathRow = FakeSetting.created.find((setting) => setting.info.name === DEFINITION_ROW_LABELS.name('商路'))
  check(
    '新增出来的那一行带「改 ID…」与「删除」两个按钮',
    (newPathRow?.buttons ?? []).map((button) => button.text).join(',') === `${MODAL_ACTIONS.renameId},${MODAL_ACTIONS.delete}`,
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name).filter((name) => String(name).includes('商路'))),
  )

  // 「渲染失败不许只留空白」：让设置页中途抛一次异常，断言页面上出现了原因。
  // 这条是被真实库里的现象逼出来的 —— 中途抛异常时 Obsidian 只在控制台报一下，
  // 界面上就是"某个分组是空的"，用户只能猜"坏了"。
  const originalGetSettings = plugin.getSettings.bind(plugin)
  plugin.getSettings = () => {
    throw new Error('人造故障：渲染中途失败')
  }
  plugin.settingTabs[0].display()
  const errorBoxes = collectByClass(plugin.settingTabs[0].containerEl, 'fc-render-error')
  check(
    '渲染中途抛异常时，设置页把原因写在页面上（不是留一片空白）',
    errorBoxes.length === 1 && String(errorBoxes[0].textContent).includes('人造故障'),
    JSON.stringify(errorBoxes.map((el) => el.textContent)),
  )
  plugin.getSettings = originalGetSettings
  plugin.settingTabs[0].display()
  check(
    '恢复后设置页回到正常渲染（错误提示消失）',
    collectByClass(plugin.settingTabs[0].containerEl, 'fc-render-error').length === 0,
  )

  plugin.onunload()
}

console.log('\n场景 41：重刷地形不得抹掉格上其它键（F1 —— 未来「一格多值」的地基）')
{
  // 这是一条**数据保全**回归，不是新功能：
  // 格上除了 `t` 还可能有别的键（未来的温度 / 深度就挂在这里）。以前编辑器给所有格
  // 共用一个新建的 `{ t }`，而"有没有变化"只看 t/f/c —— 于是"用同一种地形重刷一遍"
  // 会把那些键抹掉，且**连撤销点都不产生**。这里从真实指针事件走一遍整条路径。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await tick(80)
  runCommand(plugin, 'toggle-edit-mode')
  await tick(20)

  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const editor = layers.getEditor(canvasPath)
  const document_ = layers.getDocument(canvasPath)
  const at = canvas._clientFor({ x: 0, y: 0 })
  const stroke = () => {
    firePointer(host, 'pointerdown', { clientX: at.x, clientY: at.y, target: wrapper })
    firePointer(host, 'pointerup', { clientX: at.x, clientY: at.y, target: wrapper })
  }

  editor.setBrushRadius(0)
  editor.setTerrainType('forest')
  stroke()
  await tick(20)
  check('先画一格森林作为地基', document_.terrain['0_0']?.t === 'forest', JSON.stringify(document_.terrain['0_0']))

  // 手工挂两样东西：一个"这一版不认识的键"（等价于别的版本写下的），一个**正式的**数值字段
  document_.terrain['0_0'].extra = { humidity: 20 }
  document_.terrain['0_0'].temp = -5
  const undoBefore = editor.getStatus().undo

  // ① 同一种地形重刷：内容没变 → 不该记历史，更不该抹掉那个键
  stroke()
  await tick(20)
  check(
    '重刷同一种地形后未知键仍在',
    document_.terrain['0_0']?.extra?.humidity === 20,
    JSON.stringify(document_.terrain['0_0']),
  )
  check(
    '重刷同一种地形后正式字段（温度）仍在',
    document_.terrain['0_0']?.temp === -5,
    JSON.stringify(document_.terrain['0_0']),
  )
  check(
    '重刷同一种地形不产生新历史（内容确实没变）',
    editor.getStatus().undo === undoBefore,
    `${undoBefore} → ${editor.getStatus().undo}`,
  )

  // ② 换成别的地形：应当记一条历史，未知键照样保留
  editor.setTerrainType('water')
  stroke()
  await tick(20)
  check('换成水域后地形确实变了', document_.terrain['0_0']?.t === 'water', JSON.stringify(document_.terrain['0_0']))
  check(
    '换地形重刷同样保住未知键',
    document_.terrain['0_0']?.extra?.humidity === 20,
    JSON.stringify(document_.terrain['0_0']),
  )
  check(
    '换地形重刷同样保住正式字段（温度）',
    document_.terrain['0_0']?.temp === -5,
    JSON.stringify(document_.terrain['0_0']),
  )
  check(
    '换地形确实记了一条历史',
    editor.getStatus().undo === undoBefore + 1,
    `${undoBefore} → ${editor.getStatus().undo}`,
  )

  // ③ 落盘：未知键必须**摊平**写回去（不是塞进 extra 嵌套层）
  await store.flush()
  const saved = app.vault.files.get(file.path) ?? ''
  check('落盘后文件里看得见那个键（摊平）', saved.includes('"humidity":20'), saved.slice(0, 120))
  check('落盘后温度也写进了文件（正式字段）', saved.includes('"temp":-5'), saved.slice(0, 120))
  check('落盘后文件里没有 extra 嵌套层', saved.includes('"extra"') === false, saved.slice(0, 120))

  // ④ 撤销回森林：这些值都不该被撤销带走
  editor.undo()
  await tick(20)
  check(
    '撤销回森林后未知键仍在',
    document_.terrain['0_0']?.t === 'forest' && document_.terrain['0_0']?.extra?.humidity === 20,
    JSON.stringify(document_.terrain['0_0']),
  )
  check(
    '撤销回森林后温度仍在',
    document_.terrain['0_0']?.temp === -5,
    JSON.stringify(document_.terrain['0_0']),
  )

  plugin.onunload()
}

console.log('\n场景 42：数值图层（温度覆盖层）—— 格上的值 → 配色 → 画布')
{
  // 这一场是"温度模板"的端到端：值进格 → 配色算色 → 画布画出色块 → 改设置立刻变 → 关层不画。
  // 深度与生物群系以后照抄这一套（字段表里加一行 + 图层表里加一行）。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }

  // 四格：两个在配色内（正好落在锚点上，颜色可精确断言）、一个低于下限、一个高于上限。
  // -200 刻意**同时**超出旧的 TEMP_RANGE（-100）：数值图层没有取值区间，越界只体现在颜色上。
  document_.terrain['0_0'] = { t: 'forest', temp: 15 }
  document_.terrain['1_0'] = { temp: -200 }
  document_.terrain['0_1'] = { t: 'plains', temp: 0 }
  // 200 越出上限一个配色跨度（75 ℃）以上 ⇒ 直接落在"极黑"那一档，颜色可逐字断言
  document_.terrain['2_0'] = { t: 'water', temp: 200 }
  check('第 2 格只有温度、没有地形（F2 之后这是合法状态）', document_.terrain['1_0'].t === undefined)

  // ---- 默认隐藏：数值图层不该在用户没要求时改变现有画面 ----
  frame()
  check(
    '出厂状态下温度层不在绘制序列里',
    stats().lastDrawOrder.includes('temperature') === false,
    stats().lastDrawOrder.join(','),
  )
  check('出厂状态下叠加层一格都没画', stats().lastOverlayDrawn === 0, String(stats().lastOverlayDrawn))

  // ---- 打开温度层 ----
  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  const overlayFrame = frame()
  check(
    '打开后温度层插在地形与网格之间（叠加层压在矢量对象之下）',
    stats().lastDrawOrder.join(',') === 'terrain,temperature,grid,regions,labels,paths,markers',
    stats().lastDrawOrder.join(','),
  )
  check('四格都画出了色块', stats().lastOverlayDrawn === 4, String(stats().lastOverlayDrawn))
  check('其中两格越界（低于下限 / 高于上限）', stats().lastOverlayOutOfRange === 2, String(stats().lastOverlayOutOfRange))
  check(
    '地形那一遍只画了有地形的三格（证明叠加层的取数与地形计划是两回事）',
    stats().lastCellCount === 3,
    String(stats().lastCellCount),
  )
  const overlayFills = () => overlayFrame.fills.filter((fill) => fill.alpha > 0 && fill.alpha < 1)
  const hasFill = (color) => overlayFills().some((fill) => fill.fillStyle === color)
  check('配色内的 15℃ 用的是 15 那个锚点的颜色', hasFill('#22c55e'), JSON.stringify(overlayFills().map((f) => f.fillStyle)))
  check('配色内的 0℃ 用的是 0 那个锚点的颜色', hasFill('#00c8c8'))
  // 越界不是"贴一个纯色"：刚出界是端色，越走越远渐变成极色（行程 = 一个配色跨度 = 75 ℃）。
  // -200℃ / 200℃ 都越出去一个跨度以上 ⇒ 直接落在两端极色上。
  check('远远低于下限的 -200℃ 渐变成纯白（under → 极白）', hasFill('#ffffff'))
  check('远远高于上限的 200℃ 渐变成纯黑（over → 极黑）', hasFill('#000000'))
  check(
    '色块按出厂不透明度 0.5 画（地形要能透出来）',
    overlayFills().every((fill) => Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify(overlayFills().map((f) => f.alpha)),
  )
  check(
    '只有温度没有地形的那一格也上了色（纯白那一笔就是它）',
    overlayFills().some((fill) => fill.fillStyle === '#ffffff'),
  )
  // 越界格**总是**写数值（即使"在每个格上写出数值"关着）：颜色只能表达"比上限还高"，
  // 表达不了"高多少"，而越界恰恰最需要读数。
  check(
    '两格越界格写出了数值，字色各自按底色挑（纯白底深字 / 纯黑底白字）',
    overlayFrame.texts.length === 2 &&
      overlayFrame.texts.every((item) =>
        item.text === '-200' ? item.fillStyle === '#111827' : item.fillStyle === '#ffffff',
      ),
    JSON.stringify(overlayFrame.texts.map((item) => `${item.text}@${item.fillStyle}`)),
  )
  check(
    '写出的是它们的实际数值（不是被夹到配色端点）',
    overlayFrame.texts.map((item) => item.text).sort().join(',') === '-200,200',
    overlayFrame.texts.map((item) => item.text).join(','),
  )
  check(
    '带内的两格没写数值（"在每个格上写出数值"默认是关的）',
    overlayFrame.texts.some((item) => item.text === '15' || item.text === '0') === false,
    JSON.stringify(overlayFrame.texts.map((item) => item.text)),
  )

  // ---- 图例：配色条目（有值格数 / 两端刻度 / 越界两项只在真有越界格时出现）----
  await plugin.setShowLegend(true)
  await tick(20)
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]
  const rampRows = () => collectByClass(legendEl(), 'fc-legend-row').filter((row) => row.dataset.kind === 'ramp')
  check('图例里出现一条配色（不是色块分类）', rampRows().length === 1, String(rampRows().length))
  check(
    '配色条目的名字带单位、次数是有值的格数',
    collectByClass(rampRows()[0], 'fc-legend-label')[0]?.textContent === '温度（℃）' &&
      collectByClass(rampRows()[0], 'fc-legend-count')[0]?.textContent === '4',
    `${collectByClass(rampRows()[0], 'fc-legend-label')[0]?.textContent} / ${collectByClass(rampRows()[0], 'fc-legend-count')[0]?.textContent}`,
  )
  const rampBar = () => collectByClass(rampRows()[0], 'fc-legend-ramp')[0]
  check(
    '渐变条按锚点画（两端就是配色的最低/最高锚点）',
    (rampBar()?.style.backgroundImage ?? '').includes('#0000ff 0.00%') &&
      (rampBar()?.style.backgroundImage ?? '').includes('#ff0000 100.00%'),
    String(rampBar()?.style.backgroundImage),
  )
  check(
    '渐变条两端写着刻度',
    collectByClass(rampBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / ') === '-30℃ / 45℃',
    collectByClass(rampBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / '),
  )
  const outItems = () => collectByClass(rampRows()[0], 'fc-legend-out-text').map((el) => el.textContent)
  check(
    '两端越界各列一条（数出的是真的越界格数）',
    outItems().join(' | ') === '< -30℃ · 1 格 | > 45℃ · 1 格',
    outItems().join(' | '),
  )

  // 改配色 → 图例里的渐变也得跟着变（签名必须单格叠加配色，否则会停在旧图上）
  const legendRamp = plugin.getSettings().overlays.temperature.ramp
  await plugin.setOverlayStyle('temperature', {
    ramp: { ...legendRamp, stops: legendRamp.stops.map((stop) => (stop.value === -30 ? { ...stop, color: '#0044ff' } : stop)) },
  })
  await tick(20)
  check('改锚点颜色后图例的渐变跟着变', (rampBar()?.style.backgroundImage ?? '').includes('#0044ff 0.00%'), String(rampBar()?.style.backgroundImage))

  // ---- 改设置：下一帧就是新颜色 / 新不透明度（不需要重开画布）----
  await plugin.setOverlayStyle('temperature', { opacity: 0.9 })
  await tick(20)
  const opacityFrame = frame()
  check(
    '改不透明度后下一帧就是 0.9',
    opacityFrame.fills.filter((fill) => fill.alpha > 0.5).length === 4,
    JSON.stringify(opacityFrame.fills.map((f) => f.alpha)),
  )
  await plugin.setOverlayStyle('temperature', { opacity: 0.5 })
  const ramp = plugin.getSettings().overlays.temperature.ramp
  await plugin.setOverlayStyle('temperature', {
    ramp: {
      ...ramp,
      stops: ramp.stops.map((stop) => (stop.value === 15 ? { ...stop, color: '#123456' } : stop)),
    },
  })
  await tick(20)
  check('改锚点颜色后同一格立刻换色', frame().fills.some((fill) => fill.fillStyle === '#123456'))

  // ---- 关掉这一层：色块消失，但文件里的数据一个字节都不动 ----
  await plugin.setLayerVisible('temperature', false)
  await tick(20)
  frame()
  check('关掉温度层后一格色块都不画', stats().lastOverlayDrawn === 0, String(stats().lastOverlayDrawn))
  check('关掉温度层后图例里的配色条目也跟着消失（图例与画布同一份开关）', rampRows().length === 0, String(rampRows().length))
  check(
    '关层不改数据：格上的温度仍在',
    document_.terrain['0_0'].temp === 15 && document_.terrain['1_0'].temp === -200,
    JSON.stringify(document_.terrain['0_0']),
  )
  await store.writeNow(file, document_, 'World', [canvasPath])
  const saved = app.vault.files.get(file.path) ?? ''
  check('落盘后温度写在地图文件里（正式字段）', saved.includes('"temp":15'), saved.slice(0, 160))

  // ---- 设置页「数值图层」一组：参数都在这里，且能改进去 ----
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const settingNamed = (fragment) =>
    FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  check('设置页有「温度层的不透明度」滑块', settingNamed(OVERLAY_CONTROL_LABELS.opacity('温度'))?.slider !== null)
  // ---- W2：配色改用「轴」编辑（一条轴 + 可拖动锚点 + 两端端帽）----
  // 逐行控件与「低于下限 / 高于上限」两个颜色选择器**已被轴取代**（同一件事不留两个家）
  const settingsRoot = plugin.settingTabs[0].containerEl
  const axisRoot = () => collectByClass(settingsRoot, 'fc-ramp').find((el) => el.dataset?.fcRampAxis === 'temperature')
  const axisPart = (className) => collectByClass(axisRoot(), className)
  const axisHandles = () => axisPart('fc-ramp-handle')
  const axisCap = (side) => axisPart('fc-ramp-cap').find((el) => el.dataset?.fcRampCap === side)
  const axisColors = () => axisPart('fc-ramp-color')
  const selectHandle = async (index) => {
    fireEvent(axisHandles()[index], 'click')
    await tick(20)
    flushFrames()
  }
  const commitAxisValue = async (value) => {
    const input = axisPart('fc-ramp-input')[0]
    input.value = String(value)
    fireEvent(input, 'change')
    await tick(20)
    flushFrames()
  }
  const commitAxisColor = async (picker, color) => {
    picker.value = color
    fireEvent(picker, 'change')
    await tick(20)
    flushFrames()
  }

  check(
    '配色现在是一条轴：5 个锚点**按值成比例**摆开（温度出厂 -30…45）',
    axisHandles().length === 5 &&
      axisHandles()[0].style.left === '0.00%' &&
      axisHandles()[2].style.left === '60.00%' &&
      axisHandles()[4].style.left === '100.00%',
    JSON.stringify(axisHandles().map((el) => el.style.left)),
  )
  check(
    '两端端帽画出"端色 → 极色"（远远更低渐成白、远远更高渐成黑）',
    String(axisCap('under')?.style?.backgroundImage).includes('#ffffff 0%') &&
      String(axisCap('under')?.style?.backgroundImage).includes('#0000ff 100%') &&
      String(axisCap('over')?.style?.backgroundImage).includes('#000000 100%'),
    `${String(axisCap('under')?.style?.backgroundImage)} | ${String(axisCap('over')?.style?.backgroundImage)}`,
  )
  check('轴上有「新建锚点」入口', axisPart('fc-ramp-add')[0] !== undefined)
  check('有「在每个格上写出数值」开关', settingNamed(OVERLAY_CONTROL_LABELS.showValues)?.toggle !== undefined)
  check('有「恢复出厂配色」按钮', settingNamed(OVERLAY_CONTROL_LABELS.resetRamp)?.button?.text === SETTINGS_LABELS.resetRampButton)

  // 连续改两个锚点：两次都要留下（用"渲染时的快照"写就会把前一次覆盖掉）
  await selectHandle(0)
  await commitAxisValue('-20')
  await selectHandle(1)
  await commitAxisValue('5')
  const edited = plugin.getSettings().overlays.temperature.ramp.stops
  check(
    '连续改两个锚点，两次改动都在',
    edited[0].value === -20 && edited[1].value === 5,
    JSON.stringify(edited.map((stop) => stop.value)),
  )
  await selectHandle(0)
  await commitAxisColor(axisColors()[0], '#0044ff')
  check('改锚点颜色写进设置', plugin.getSettings().overlays.temperature.ramp.stops[0].color === '#0044ff')

  // ---- 拖动：pointerdown → pointermove → pointerup。拖动中不落盘，抬手才写 -
  const dragBefore = plugin.getSettings().overlays.temperature.ramp.stops[2].value
  const trackEl = axisPart('fc-ramp-track')[0]
  trackEl._rect = { left: 0, top: 0, width: 100, height: 12 }
  const dragHandle = axisHandles()[2]
  fireEvent(dragHandle, 'pointerdown', { clientX: 60 })
  fireEvent(dragHandle, 'pointermove', { clientX: 60 })
  check(
    '拖动过程中不写设置（一次拖动只落一次盘）',
    plugin.getSettings().overlays.temperature.ramp.stops[2].value === dragBefore,
    String(plugin.getSettings().overlays.temperature.ramp.stops[2].value),
  )
  fireEvent(dragHandle, 'pointerup', {})
  await tick(20)
  flushFrames()
  check(
    '拖动锚点改的是它自己的值（位置按轴长换算：轴长 60% 处 = -20 + 0.6×65 = 19）',
    plugin.getSettings().overlays.temperature.ramp.stops[2].value !== dragBefore &&
      plugin.getSettings().overlays.temperature.ramp.stops[2].value === 19,
    `${dragBefore} → ${String(plugin.getSettings().overlays.temperature.ramp.stops[2].value)}`,
  )

  // 拖到邻居身上会被**挡住**（否则两条锚点会叠在一起，那一段的渐变率变成除零）
  fireEvent(axisHandles()[2], 'pointerdown', { clientX: 60 })
  fireEvent(axisHandles()[2], 'pointermove', { clientX: 2 })
  fireEvent(axisHandles()[2], 'pointerup', {})
  await tick(20)
  flushFrames()
  const clampedStops = plugin.getSettings().overlays.temperature.ramp.stops
  check(
    '拖过邻居会被挡住（夹取把值挡在邻居内侧，**邻居自己一个字节没动**）',
    // 只断言"仍落在邻居之间"是空转的：写入口会按值排序，去掉夹取照样满足。
    // 必须再钉一条"邻居没被换位"——去掉夹取时被拖的值会插到邻居左边，邻居就变成下一条了。
    clampedStops[1].value === 5 &&
      clampedStops[2].value > clampedStops[1].value &&
      clampedStops[2].value < clampedStops[3].value,
    JSON.stringify(clampedStops.map((stop) => stop.value)),
  )

  // ---- 端帽：改的是这张地图的限度值 + 越界两色（用户 m01702 第 2 条）----
  fireEvent(axisCap('under'), 'click')
  await tick(20)
  flushFrames()
  check('点端帽后检视行说的是"低于最低限度"', axisPart('fc-ramp-who')[0]?.textContent === RAMP_AXIS_LABELS.underMin)
  await commitAxisColor(axisColors()[0], '#00ff88')
  check('改端帽颜色写进设置', plugin.getSettings().overlays.temperature.ramp.under.color === '#00ff88')
  await commitAxisColor(axisColors()[1], '#112233')
  check(
    '改端帽的极色写进设置（W1 的 farColor 第一次有界面）',
    plugin.getSettings().overlays.temperature.ramp.under.farColor === '#112233',
  )
  await commitAxisValue('-40')
  check(
    '端帽改的是最低限度的**值**，不是端色（拖值不动色）',
    plugin.getSettings().overlays.temperature.ramp.stops[0].value === -40 &&
      plugin.getSettings().overlays.temperature.ramp.stops[0].color === '#0044ff',
  )

  // ---- 新建 / 删除 ----
  const beforeAdd = plugin.getSettings().overlays.temperature.ramp.stops.length
  fireEvent(axisPart('fc-ramp-add')[0], 'click')
  await tick(20)
  flushFrames()
  const addedStops = plugin.getSettings().overlays.temperature.ramp.stops
  check(
    '新建锚点插在最大缺口的中点，其它锚点不动',
    addedStops.length === beforeAdd + 1 && addedStops.some((stop) => stop.value === -17.5),
    JSON.stringify(addedStops.map((stop) => stop.value)),
  )
  for (let round = 0; round < 6; round += 1) {
    await selectHandle(0)
    const button = axisPart('fc-ramp-delete')[0]
    if (button === undefined || button.disabled) break
    fireEvent(button, 'click')
    await tick(20)
    flushFrames()
  }
  await selectHandle(0)
  check(
    '删到只剩两条锚点时删除入口被**禁用**（不是点了没反应）',
    plugin.getSettings().overlays.temperature.ramp.stops.length === 2 &&
      axisPart('fc-ramp-delete')[0]?.disabled === true,
    String(plugin.getSettings().overlays.temperature.ramp.stops.length),
  )
  await settingNamed(OVERLAY_CONTROL_LABELS.showValues).toggle.handler(true)
  await tick(20)
  check('打开"写出数值"写进设置', plugin.getSettings().overlays.temperature.showValues === true)
  await settingNamed(OVERLAY_CONTROL_LABELS.resetRamp).button.click()
  await tick(20)
  const restored = plugin.getSettings().overlays.temperature.ramp
  check(
    '恢复出厂配色：锚点与越界色都回出厂值',
    restored.stops[0].value === -30 && restored.stops[0].color === '#0000ff' && restored.under.color === '#0000ff',
    JSON.stringify(restored.stops.map((stop) => `${stop.value}:${stop.color}`)),
  )
  check('恢复出厂配色不动"写出数值"开关', plugin.getSettings().overlays.temperature.showValues === true)

  // ---- 打开"所有格写数值"之后：四格都写（越界那两格本来就写）----
  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  const allValuesFrame = frame()
  check(
    '打开后四格都写出数值',
    allValuesFrame.texts.length === 4,
    JSON.stringify(allValuesFrame.texts.map((item) => item.text)),
  )
  check(
    '带内格的数值用该底色上可读的文字色（不是一律白字）',
    allValuesFrame.texts.filter((item) => item.text === '15' || item.text === '0').every((item) => item.fillStyle !== '#ffffff'),
    JSON.stringify(allValuesFrame.texts.map((item) => `${item.text}@${item.fillStyle}`)),
  )

  plugin.onunload()
}

// ================================================== 场景 43：深度层 —— 配色 / 展示单位 / 标定
console.log('\n场景 43：深度层 —— 配色染色 → 展示单位换算 → 地图级海拔标定 → 关层不画')
{
  // 深度是"温度模板"的第二份：字段表加一行 + 图层表加一行，就有了完整的一条数值图层。
  // 这一场盯的是深度独有的那几件事：配色是"浅米→浅蓝→深蓝"、越界是白 / 近黑蓝（不是温度的蓝红）、
  // 数值与图例刻度按**展示单位**换算（米 / 千米 / 相对值）、标定写进地图文件（可撤销）。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const wrapper = canvas.wrapperEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const settingNamed = (fragment) =>
    FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 标定对话框的替身：拿到 options 就够（真实对话框的敲键由它自己去跑，这里只驱动结果） */
  let lastElevationOptions = null
  plugin.setElevationModalFactory((modalApp, options) => {
    lastElevationOptions = options
    return { open() {} }
  })

  // 三格：海平面 / 深海 / 高海拔（负 = 向上）。刻意含 0（海平面是合法值，不是"没有数据"）。
  document_.terrain['0_0'] = { t: 'water', depth: 0 }
  document_.terrain['1_0'] = { t: 'water', depth: 5000 }
  document_.terrain['0_1'] = { t: 'mountain', depth: -1500 }

  // ---- 出厂默认隐藏 ----
  frame()
  check('出厂状态下深度层不在绘制序列里', stats().lastDrawOrder.includes('depth') === false, stats().lastDrawOrder.join(','))

  // ---- 打开深度层：配色颜色 + 越界两端 + 深浅次序 ----
  await plugin.setLayerVisible('depth', true)
  await tick(20)
  const overlayFrame = frame()
  check(
    '打开后深度层插在网格之前（叠加层压在地形之上、矢量对象之下）；温度关着所以不在序列里',
    stats().lastDrawOrder.join(',') === 'terrain,depth,grid,regions,labels,paths,markers',
    stats().lastDrawOrder.join(','),
  )
  check('三格都画出了色块', stats().lastOverlayDrawn === 3, String(stats().lastOverlayDrawn))
  const fills = () => overlayFrame.fills.filter((fill) => fill.alpha > 0 && fill.alpha < 1)
  const hasFill = (color) => fills().some((fill) => fill.fillStyle === color)
  check('海平面（0）用出厂中灰锚点色', hasFill('#808080'), JSON.stringify(fills().map((f) => f.fillStyle)))
  // 5000 超过出厂上限 4000 → 高于上限的纯白；-1500 在带内（-4000..4000），在"黑 → 灰"那一段里
  check('深于上限（5000 > 4000）用纯白（over）', hasFill('#ffffff'))
  check(
    '色块按出厂不透明度 0.5 画',
    fills().every((fill) => Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify(fills().map((f) => f.alpha)),
  )

  // ---- 越界格总是写数值，数值按米（出厂展示单位）读 ----
  check(
    '越界格写出了数值（出厂是米读数），用 over 的文字色（纯白底 ⇒ 深字）',
    overlayFrame.texts.some((item) => item.text === '5000' && item.fillStyle === '#111827'),
    JSON.stringify(overlayFrame.texts.map((item) => `${item.text}@${item.fillStyle}`)),
  )
  check(
    '带内的格默认不写数值（"在每个格上写出数值"默认关）',
    overlayFrame.texts.some((item) => item.text === '0' || item.text === '-1500') === false,
    JSON.stringify(overlayFrame.texts.map((item) => item.text)),
  )

  // ---- 展示单位换 km：数值文字与图例刻度都跟着变（文件一个字节不动）----
  await plugin.setOverlayStyle('depth', { unit: 'km' })
  await tick(20)
  const kmFrame = frame()
  check(
    '换成千米后越界格读成 5 km（不是 5000）',
    kmFrame.texts.some((item) => item.text === '5'),
    JSON.stringify(kmFrame.texts.map((item) => item.text)),
  )

  // ---- 图例：单位标题、刻度按展示单位换算 ----
  await plugin.setShowLegend(true)
  await tick(20)
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]
  const rampRows = () => collectByClass(legendEl(), 'fc-legend-row').filter((row) => row.dataset.kind === 'ramp')
  check('图例里出现深度那一条配色（温度层关着，所以只有它）', rampRows().length === 1, String(rampRows().length))
  const depthRow = () => rampRows().find((row) => (collectByClass(row, 'fc-legend-label')[0]?.textContent ?? '').includes('深度'))
  check('深度条目的标题跟着展示单位走', (collectByClass(depthRow(), 'fc-legend-label')[0]?.textContent ?? '') === '深度 / 海拔（km）')
  const depthBar = () => collectByClass(depthRow(), 'fc-legend-ramp')[0]
  check(
    '深度条目的刻度按千米换算（-4 km / 4 km）',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / ') === '-4 km / 4 km',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / '),
  )
  check(
    '越界那端带单位（> 4 km · 1 格）',
    collectByClass(depthRow(), 'fc-legend-out-text').map((el) => el.textContent).join(' | ') === '> 4 km · 1 格',
    collectByClass(depthRow(), 'fc-legend-out-text').map((el) => el.textContent).join(' | '),
  )

  // ---- 展示单位换相对值：未标定时读数"未标定"，标定后读数变成 0–1 ----
  await plugin.setOverlayStyle('depth', { unit: 'rel' })
  await tick(20)
  const relUncalibrated = frame()
  check(
    '未标定时相对值读数显示"未标定"（不拿编造的尺度凑数）',
    relUncalibrated.texts.some((item) => item.text === '未标定'),
    JSON.stringify(relUncalibrated.texts.map((item) => item.text)),
  )
  check(
    '未标定时图例刻度的 min 端也显示"未标定"',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / ') === '未标定 / 未标定',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / '),
  )

  // ---- 设置海拔标定：写进地图文件、可撤销、读数立刻生效 ----
  const editor = layers.getEditor(canvasPath)
  check('命令走的是当前活动画布的那个编辑器', layers.getActiveEditor() === editor)
  const before = editor.getStatus().undo
  runCommand(plugin, 'set-elevation-calibration')
  check('「设置海拔标定…」命令打开了对话框（面板与命令面板同一个入口）', lastElevationOptions !== null)
  check(
    '弹窗拿到的当前值是 null（这张图还没标定）',
    lastElevationOptions?.current === null,
    JSON.stringify(lastElevationOptions),
  )
  lastElevationOptions?.onSubmit({ unit: 'm', maxDepth: 8000, maxHeight: 3000 })
  await tick(20)
  check('标定写进了文档（地图文件的那一段）', JSON.stringify(document_.elevation) === '{"unit":"m","maxDepth":8000,"maxHeight":3000}')
  check('标定记了一条可撤销的历史', editor.getStatus().undo === before + 1, String(editor.getStatus().undo))

  const relCalibrated = frame()
  check(
    '标定后相对值读数可算：5000 深 → (8000−5000)/11000 ≈ 0.27',
    relCalibrated.texts.some((item) => item.text === '0.27'),
    JSON.stringify(relCalibrated.texts.map((item) => item.text)),
  )
  check(
    '图例刻度也换成相对值（-4000 → 夹到 1；4000 → 0.36）',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / ') === '1 / 0.36',
    collectByClass(depthBar(), 'fc-legend-ramp-scale').map((el) => el.textContent).join(' / '),
  )

  // ---- 撤销标定：回到未标定，文件里那段被删掉 ----
  editor.undo()
  await tick(20)
  check('撤销后文档里没有 elevation 段了（回到老地图的形状）', document_.elevation === undefined)
  check('撤销后相对值读数又回到"未标定"', frame().texts.some((item) => item.text === '未标定'))

  // ---- 落盘：elevation 段写进地图文件，深度值也写进去 ----
  layers.getEditor(canvasPath).setElevationCalibration({ unit: 'm', maxDepth: 8000, maxHeight: 3000 })
  await store.writeNow(file, document_, 'World', [canvasPath])
  const saved = app.vault.files.get(file.path) ?? ''
  check('落盘后标定写在地图文件里', saved.includes('"elevation": {"unit":"m","maxDepth":8000,"maxHeight":3000}'), saved.slice(0, 200))
  check('落盘后深度值写在地图文件里（正式字段）', saved.includes('"depth":5000'), saved.slice(0, 200))

  // ---- 关层：色块消失、数据不动 ----
  await plugin.setLayerVisible('depth', false)
  await tick(20)
  frame()
  check('关掉深度层后一格色块都不画', stats().lastOverlayDrawn === 0, String(stats().lastOverlayDrawn))
  check('关层不改数据：格上的深度仍在', document_.terrain['1_0']?.depth === 5000, JSON.stringify(document_.terrain['1_0']))

  // ---- 设置页：深度有自己的展示单位下拉（温度没有） ----
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const depthUnitSetting = settingNamed('深度 / 海拔的展示单位')
  check('设置页有「深度 / 海拔的展示单位」下拉', depthUnitSetting?.dropdowns?.length === 1, String(depthUnitSetting?.dropdowns?.length))
  check(
    '下拉选项是米 / 千米 / 相对值，且当前选中相对值',
    depthUnitSetting?.dropdowns[0].options.map((option) => option.value).join(',') === 'm,km,rel' &&
      depthUnitSetting?.dropdowns[0].value === 'rel',
    JSON.stringify(depthUnitSetting?.dropdowns[0].options),
  )
  const temperatureUnitSetting = settingNamed('温度的展示单位')
  check('温度没有展示单位下拉（它不需要换算）', temperatureUnitSetting === undefined)

  // ---- 越界色回退用的是**深度自己的出厂值**（黑 / 白），不是温度的纯蓝 / 纯红 ----
  await plugin.setOverlayStyle('depth', { ramp: { ...plugin.getSettings().overlays.depth.ramp, stops: [] } })
  await tick(20)
  check(
    '深度配色坏掉时回退到深度自己的出厂（over 仍是纯白）',
    plugin.getSettings().overlays.depth.ramp.over.color === '#ffffff',
    plugin.getSettings().overlays.depth.ramp.over.color,
  )

  plugin.onunload()
}

// ================================================== 场景 44：连续场（等温线 / 等高线）
console.log('\n场景 44：数值图层的连续场 —— 插值 + 等值线 + 采样缓存')
{
  // 用户可见目标：数值图层不只"每格涂一块"，还能把格心值插成连续面并画等值线（不局限于六边形格）。
  // 这一场同时盯**缓存**：IDW 每帧重算是不可接受的，第二帧必须命中。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  /** 连续场的颜色面会新建一张离屏画布：`putImageData` 落在**它**身上（不是主画布那个上下文） */
  const rasterBaseline = createdCanvasContexts.length
  const rasterContexts = () => createdCanvasContexts.slice(rasterBaseline).filter((candidate) => candidate.calls.putImageData > 0)

  // 一条有梯度的温度带（连续场要有东西可插值）：-20 → 40
  for (let q = 0; q < 6; q += 1) document_.terrain[`${q}_0`] = { t: 'plains', temp: -20 + q * 12 }

  // ---- 逐格模式（出厂）：与改动前一致 —— 六边形色块、没有等值线 ----
  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  const cellFrame = frame()
  check(
    '逐格模式的统计：mode=cell、六块色块、没有等值线',
    stats().lastOverlayMode === 'cell' && stats().lastOverlayDrawn === 6 && stats().lastOverlayContours === 0,
    `${stats().lastOverlayMode}/${stats().lastOverlayDrawn}/${stats().lastOverlayContours}`,
  )
  check(
    '逐格模式的色块是六边形（6 个顶点）',
    cellFrame.fills.filter((fill) => fill.points.length === 6).length >= 6,
    String(cellFrame.fills.filter((fill) => fill.points.length === 6).length),
  )

  // ---- 切到连续场：连续填色片 + 等值线 ----
  const rampColors = plugin.getSettings().overlays.temperature.ramp.stops.map((stop) => stop.color)
  await plugin.setOverlayStyle('temperature', { mode: 'field', contourInterval: 20 })
  await tick(20)
  const fieldFrame = frame()
  check('切到连续场后模式统计变 field', stats().lastOverlayMode === 'field', String(stats().lastOverlayMode))
  check(
    '连续场的颜色面是**一张栅格**（色块数 = 1，而不是每格一个方块）',
    stats().lastOverlayDrawn === 1,
    String(stats().lastOverlayDrawn),
  )
  check(
    '栅格先落在离屏画布上（putImageData），再由主画布 drawImage 铺开 —— 缩放平滑才有连续渐变',
    rasterContexts().length === 1 && rasterContexts()[0].putImages[0].opaque > 0 && fieldFrame.images.length > 0,
    `离屏栅格=${rasterContexts().length} 实色像素=${rasterContexts()[0]?.putImages[0]?.opaque} 主画布 drawImage=${fieldFrame.images.length}`,
  )
  check(
    '那一帧里没有"每格一个方块"的残余（用户报的"方格状"就是它）',
    fieldFrame.fills.filter((fill) => fill.points.length === 4).length === 0,
    JSON.stringify(fieldFrame.fills.map((fill) => fill.points.length).slice(0, 8)),
  )
  check('连续场画出了等值线', stats().lastOverlayContours > 0, String(stats().lastOverlayContours))
  check(
    '等值线上有数值标注（用户实机要求"线上要有数字"）',
    stats().lastOverlayLabels > 0 && fieldFrame.texts.some((item) => /^-?\d+(\.\d+)?$/.test(item.text)),
    `${stats().lastOverlayLabels}/${JSON.stringify(fieldFrame.texts.map((item) => item.text).slice(0, 6))}`,
  )
  check(
    '等值线的标注带白边（不然压在彩色场上看不见）',
    fieldFrame.calls.strokeText > 0,
    String(fieldFrame.calls.strokeText),
  )
  check(
    '等值线的颜色来自配色（该值在配色里的颜色）',
    fieldFrame.groups.some((group) => rampColors.includes(group.strokeStyle)),
    JSON.stringify([...new Set(fieldFrame.groups.map((group) => group.strokeStyle))].slice(0, 8)),
  )
  check(
    '数值用等宽字体（用户实机要求"编程字体的数字"）',
    fieldFrame.texts.some((item) => String(item.font).includes('monospace')),
    JSON.stringify(fieldFrame.texts.map((item) => item.font).slice(0, 3)),
  )
  check(
    '等值线的数字**沿着线排列**（工程图样式：绕切线旋转，不是横排）',
    fieldFrame.texts.filter((item) => Number.isFinite(item.angle) && item.angle !== 0).length > 0,
    JSON.stringify(fieldFrame.texts.map((item) => item.angle)),
  )

  // ---- 缓存：同一视口的第二帧必须命中（不重新采样）----
  const buildsAfterSwitch = stats().lastOverlayFieldBuilds
  const hitsAfterSwitch = stats().lastOverlayFieldHits
  check('第一次进连续场时重算过采样网格', buildsAfterSwitch >= 1, String(buildsAfterSwitch))
  frame()
  check(
    '同一视口的第二帧命中缓存（没有重新采样）',
    stats().lastOverlayFieldBuilds === buildsAfterSwitch && stats().lastOverlayFieldHits > hitsAfterSwitch,
    `${stats().lastOverlayFieldBuilds}/${stats().lastOverlayFieldHits}`,
  )

  // ---- 平移：视口变了，但**采样不该重算**（缓存键不含视口 —— DATA-LAYER-PLAN §0 D2②）----
  const buildsBeforePan = stats().lastOverlayFieldBuilds
  const hitsBeforePan = stats().lastOverlayFieldHits
  canvas._applyViewport({ de: 48, df: 32, scaleFactor: 1 })
  frame()
  check(
    '平移一帧后没有重新采样（缓存键不含视口）',
    stats().lastOverlayFieldBuilds === buildsBeforePan && stats().lastOverlayFieldHits > hitsBeforePan,
    `builds ${buildsBeforePan}→${stats().lastOverlayFieldBuilds} / hits ${hitsBeforePan}→${stats().lastOverlayFieldHits}`,
  )

  // ---- 改一格的值：必须重算（否则"改了温度画面不变"）----
  document_.terrain['0_0'].temp = 33
  frame()
  check('改了某一格的值 → 缓存失效并重算', stats().lastOverlayFieldBuilds === buildsAfterSwitch + 1, String(stats().lastOverlayFieldBuilds))

  // ---- 数据全没了：不留残留 ----
  for (let q = 0; q < 6; q += 1) delete document_.terrain[`${q}_0`].temp
  frame()
  check(
    '数据改成"无值"后连续场不留残留（填色片与等值线都为 0）',
    stats().lastOverlayDrawn === 0 && stats().lastOverlayContours === 0,
    `${stats().lastOverlayDrawn}/${stats().lastOverlayContours}`,
  )

  // ---- 切回逐格：立刻恢复（不需要重载插件）----
  for (let q = 0; q < 6; q += 1) document_.terrain[`${q}_0`].temp = -20 + q * 12
  await plugin.setOverlayStyle('temperature', { mode: 'cell' })
  await tick(20)
  frame()
  check(
    '切回逐格后立刻恢复：mode=cell、色块回来、等值线为 0',
    stats().lastOverlayMode === 'cell' && stats().lastOverlayDrawn === 6 && stats().lastOverlayContours === 0,
    `${stats().lastOverlayMode}/${stats().lastOverlayDrawn}/${stats().lastOverlayContours}`,
  )

  // ---- 关掉这一层：两种模式都必须什么都不画 ----
  await plugin.setLayerVisible('temperature', false)
  await tick(20)
  frame()
  check('关掉温度层后连续场也一格不画（开关对两种模式都生效）', stats().lastOverlayDrawn === 0, String(stats().lastOverlayDrawn))

  // ---- 设置页：显示方式下拉 + 连续场参数只在连续场时出现 ----
  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const named = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  check(
    '设置页有「温度的显示方式」下拉，选项是逐格 / 连续场',
    (named(OVERLAY_CONTROL_LABELS.mode('温度'))?.dropdowns?.[0]?.options ?? []).map((option) => option.value).join(',') === 'cell,field',
    JSON.stringify(named(OVERLAY_CONTROL_LABELS.mode('温度'))?.dropdowns?.[0]?.options),
  )
  check('逐格模式下不显示等值线间距（参数只在需要时出现）', named(OVERLAY_CONTROL_LABELS.contourInterval('温度')) === undefined)
  await named(OVERLAY_CONTROL_LABELS.mode('温度')).dropdowns[0].select('field')
  await tick(20)
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  check('切到连续场后设置里出现等值线间距', named(OVERLAY_CONTROL_LABELS.contourInterval('温度')) !== undefined)
  await named(OVERLAY_CONTROL_LABELS.contourInterval('温度')).texts[0].type('5')
  await tick(20)
  check('等值线间距写进设置', plugin.getSettings().overlays.temperature.contourInterval === 5, String(plugin.getSettings().overlays.temperature.contourInterval))

  plugin.onunload()
}

// ================================================== 场景 45：导出 / Base 缩略图带上叠加层
console.log('\n场景 45：导出（SVG / PNG）带上数值图层叠加层 —— 与画布同一份几何')
{
  // 工单 D 的验收：图层开关生效、形状与画布一致、越界色一致、导出里默认不写数值。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const svgPath = 'Maps/World.svg'
  const exportedSvg = async () => {
    app.vault.files.delete(svgPath)
    await runCommand(plugin, 'export-map-svg')
    await tick(60)
    return app.vault.files.get(svgPath) ?? ''
  }
  const countOf = (text, pattern) => (text.match(pattern) ?? []).length

  // 四格数据：三格带内（15）、一格越界（80 > 45 → 走 over 的纯红）。
  // 三格同值沿 r 方向铺开是**故意的**：连续场的数据范围由样本包围盒决定，
  // 样本只排一行时等值线只有两格长（连"标数字最小长度"都够不上，见 `fieldPlan` 的 ×4 门槛）。
  document_.terrain['0_0'] = { t: 'forest', temp: 15 }
  document_.terrain['0_1'] = { t: 'plains', temp: 15 }
  document_.terrain['0_2'] = { t: 'plains', temp: 15 }
  document_.terrain['1_0'] = { t: 'water', temp: 80 }

  // ---- 图层关着：导出里不该有叠加层（开关与画布同一份）----
  const without = await exportedSvg()
  check('温度层关着时导出里没有温度段', without.includes('data-fc-overlay="temperature"') === false)

  // ---- 打开温度层（逐格）：段出现，图元数与画布一致 ----
  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  const cellFrame = frame()
  const cellSvg = await exportedSvg()
  check('打开温度层后导出里出现温度段', cellSvg.includes('data-fc-overlay="temperature"'), cellSvg.slice(0, 120))
  check(
    '导出与画布画同样多的色块（几何只有一份）',
    countOf(cellSvg, /data-fc-primitive="polygon"/g) + countOf(cellSvg, /data-fc-primitive="raster"/g) ===
      stats().lastOverlayDrawn,
    `导出 ${countOf(cellSvg, /data-fc-primitive="polygon"/g)} / 画布 ${stats().lastOverlayDrawn}`,
  )
  // 这一格是 80℃（越出上限 35℃，落在"纯红 → 极黑"的途中），所以**不能写死某一个端色** ——
  // 直接跟画布比"填充色集合"，两边必须逐一对上（同一份配色 + 同一份越界口径）。
  const canvasCellFills = [...new Set(cellFrame.fills.filter((fill) => fill.alpha > 0 && fill.alpha < 1).map((fill) => fill.fillStyle))].sort()
  const exportCellFills = [
    ...new Set(
      (cellSvg.match(/data-fc-primitive="polygon"[^>]*?fill="#[0-9a-fA-F]{6}"/g) ?? []).map((tag) =>
        (tag.match(/fill="(#[0-9a-fA-F]{6})"/) ?? [])[1],
      ),
    ),
  ].sort()
  check(
    '导出里每格的填充色与画布逐一对上（含越界那格的渐变途中色）',
    JSON.stringify(exportCellFills) === JSON.stringify(canvasCellFills),
    `导出 ${JSON.stringify(exportCellFills)} / 画布 ${JSON.stringify(canvasCellFills)}`,
  )
  check('导出里默认不写数值（导出要能看清地形）', cellSvg.includes('>80<') === false && cellSvg.includes('>15<') === false)

  // ---- 连续场：导出与画布的等值线数一致 ----
  await plugin.setOverlayStyle('temperature', { mode: 'field', contourInterval: 20 })
  await tick(20)
  frame()
  const fieldSvg = await exportedSvg()
  check('连续场的等值线也进了导出', countOf(fieldSvg, /data-fc-primitive="polyline"/g) > 0)
  check(
    '导出与画布的等值线数一致',
    countOf(fieldSvg, /data-fc-primitive="polyline"/g) === stats().lastOverlayContours,
    `导出 ${countOf(fieldSvg, /data-fc-primitive="polyline"/g)} / 画布 ${stats().lastOverlayContours}`,
  )
  check(
    '连续场的颜色面在导出里是内联 PNG（同一份像素，所以不会"画布连续、导出方格"）',
    countOf(fieldSvg, /data-fc-primitive="raster"/g) === 1 && fieldSvg.includes('data:image/png;base64,'),
    String(fieldSvg.length),
  )
  check(
    '等值线的数值标注也进了导出（它不是"逐格数值"，不受那一档开关管）',
    countOf(fieldSvg, /data-fc-primitive="text"/g) === stats().lastOverlayLabels && stats().lastOverlayLabels > 0,
    `导出 ${countOf(fieldSvg, /data-fc-primitive="text"/g)} / 画布 ${stats().lastOverlayLabels}`,
  )
  {
    // 导出提示必须写明颜色面走了哪条路（内联栅格 / 超上限退回矢量）：
    // 否则"导出的图是矢量兜底"这件事用户永远看不见（DATA-LAYER-PLAN §0 D1 a3）
    const exportNotice = noticeLog.filter((line) => line.includes(NOTICES.svgExportedPrefix)).at(-1) ?? ''
    check(
      '导出提示里写明颜色面走了哪条路（含体积）',
      exportNotice.includes('数值图层导出：温度：内联栅格（') && exportNotice.includes('KiB'),
      exportNotice.replace(/\n/g, ' ⏎ '),
    )
  }
  {
    // ---- 工程图样式：数字沿线排列（rotate），且线在数字处**真的断开** ----
    // 这一对断言是"假断线"的照妖镜：拿背景色盖住的做法会让折线照样穿过标注点。
    const polylines = [...fieldSvg.matchAll(/<polyline data-fc-primitive="polyline" points="([^"]+)"/g)].map((match) =>
      match[1].split(' ').map((pair) => pair.split(',').map(Number)),
    )
    const anchors = [...fieldSvg.matchAll(/<text data-fc-primitive="text" x="([-\d.]+)" y="([-\d.]+)"/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ])
    const onSegment = (points, [x, y]) => {
      for (let index = 1; index < points.length; index += 1) {
        const [ax, ay] = points[index - 1]
        const [bx, by] = points[index]
        const dx = bx - ax
        const dy = by - ay
        const lengthSquared = dx * dx + dy * dy
        if (lengthSquared === 0) continue
        const t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared
        if (t < 0 || t > 1) continue
        if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) < 1e-3) return true
      }
      return false
    }
    check(
      '导出的标注带 rotate（数字沿线排列，与画布同一条口径）',
      /data-fc-primitive="text"[^>]*transform="rotate\(/.test(fieldSvg),
      String(anchors.length),
    )
    check(
      '导出的等值线在数字处**真的断开**（没有任何折线穿过标注点）',
      anchors.length > 0 && anchors.every((anchor) => !polylines.some((points) => onSegment(points, anchor))),
      `折线 ${polylines.length} / 标注 ${anchors.length}`,
    )
  }

  // ---- PNG 复用同一份 SVG（不单独写绘制）----
  const seenSvgs = []
  plugin.setPngRasterizer({
    createImage: () => ({ src: '', complete: false, naturalWidth: 8, onload: null, onerror: null }),
    waitForImage: async (image) => {
      seenSvgs.push(image.src)
      return true
    },
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    toBlob: async () => ({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer.slice(0) }),
  })
  await runCommand(plugin, 'export-map-png')
  await tick(60)
  const pngSvg = decodeURIComponent(seenSvgs[0] ?? '')
  check('PNG 走的是同一张 SVG（叠加层也在里面）', pngSvg.includes('data-fc-overlay="temperature"'), String(seenSvgs[0]).slice(0, 60))
  plugin.setPngRasterizer(null)

  // ---- 关掉图层再导一次：段消失（不是"只在第一次生效"）----
  await plugin.setLayerVisible('temperature', false)
  await tick(20)
  const offAgain = await exportedSvg()
  check('再关掉温度层，导出里的温度段跟着消失', offAgain.includes('data-fc-overlay="temperature"') === false)

  plugin.onunload()
}

// ================================================== 场景 46：数值图层每格默认值（§B）
console.log('\n场景 46：每格默认值 —— 兜底只影响渲染、真值优先、清空即删键')
{
  // 用户可见目标（原话）："如果有地方没有温度和深度的话就没有渲染，我认为每个格子初始应该自带一个值，
  // 这个定义值就放在定义里面。" —— 于是本场盯：兜底格有颜色、格上不写数值、文件里的格不动、
  // 改完立刻生效、清空后文件里连键都不留（§B.5）。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const file = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const editor = layers.getEditor(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const textOf = (frameCtx) => frameCtx.texts.map((item) => item.text)
  /** 打开对话框并把它建出来的那些 Setting 收回来（真实对话框，不是替身） */
  const openDefaultsModal = () => {
    FakeSetting.created.length = 0
    runCommand(plugin, 'set-data-defaults')
    return {
      rows: FakeSetting.created.filter((setting) => /（℃）|（m）/.test(String(setting.info.name ?? ''))),
      buttonOf: (label) =>
        FakeSetting.created
          .flatMap((setting) => setting.buttons ?? [])
          .find((button) => button.text === label),
      noteOf: () =>
        FakeSetting.created
          .flatMap((setting) => collectByClass(setting.containerEl, 'fc-settings-note'))
          .find((el) => el.dataset?.fcDataDefault === 'note'),
    }
  }

  // 三格：① 地形 + 真温度 ② 只有真温度、没有地形 ③ 只有地形、没有温度（这格该被兜底）
  document_.terrain['0_0'] = { t: 'forest', temp: 15 }
  document_.terrain['1_0'] = { temp: -40 }
  document_.terrain['2_0'] = { t: 'plains' }

  await plugin.setLayerVisible('temperature', true)
  await tick(20)
  const before = frame()
  check(
    '没有默认值时只有 2 格画出温度（这就是用户报的"有地方没有渲染"）',
    stats().lastOverlayDrawn === 2 && textOf(before).includes('30') === false,
    String(stats().lastOverlayDrawn),
  )

  // ---- 命令打开**真实**对话框：行由字段表派生 ----
  const modal = openDefaultsModal()
  check(
    '对话框的行由字段表派生（温度 ℃ / 深度 m），一行都不是手写的',
    modal.rows.map((setting) => setting.info.name).join('|') === '温度（℃）|深度 / 海拔（m）',
    modal.rows.map((setting) => setting.info.name).join('|'),
  )
  const tempInput = modal.rows[0]?.text
  check(
    '输入框带稳定标记 fcDataDefault=<cellKey>',
    tempInput?.inputEl?.dataset?.fcDataDefault === 'temp',
    String(tempInput?.inputEl?.dataset?.fcDataDefault),
  )
  check('对话框里有「保存」与「清空全部」', modal.buttonOf(MODAL_ACTIONS.save) !== undefined && modal.buttonOf(MODAL_ACTIONS.clearAll) !== undefined)
  check(
    '说明里写明"只影响渲染、不改地图文件"',
    modal.rows[0]?.info.desc?.includes('留空 = 这一层不兜底') === true,
    String(modal.rows[0]?.info.desc),
  )

  // ---- 非法值：保存禁用 + 原因在旁（不悄悄当成 0）----
  await tempInput.type('abc')
  check(
    '填了非数字：保存被禁用，原因写在旁边',
    modal.buttonOf(MODAL_ACTIONS.save).buttonEl.disabled === true && /必须是一个数字/.test(modal.noteOf()?.textContent ?? ''),
    `${modal.buttonOf(MODAL_ACTIONS.save).buttonEl.disabled} / ${modal.noteOf()?.textContent ?? ''}`,
  )
  await tempInput.type('30')
  check('改成合法值后保存又可用了', modal.buttonOf(MODAL_ACTIONS.save).buttonEl.disabled === false)

  // ---- 保存：写进地图文件那一段，且一次提交 = 一条历史 ----
  const undoBefore = editor.getStatus().undo
  await modal.buttonOf(MODAL_ACTIONS.save).click()
  await tick(20)
  check('默认值写进了地图文件的那一段', JSON.stringify(document_.dataDefaults) === '{"temp":30}', JSON.stringify(document_.dataDefaults))
  check('一次提交 = 一条历史（Ctrl+Z 能回去）', editor.getStatus().undo === undoBefore + 1, String(editor.getStatus().undo))

  // ---- 兜底只影响渲染：那格有颜色了，但格上仍然没有 temp ----
  const fallbackFrame = frame()
  check('兜底格也画出来了（"画过的地方整片都有颜色"）', stats().lastOverlayDrawn === 3, String(stats().lastOverlayDrawn))
  check(
    '兜底格用的是**默认值在配色里的颜色**（30 ℃ → 橙 #f59e0b）',
    fallbackFrame.fills.some((fill) => fill.fillStyle === '#f59e0b' && Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify([...new Set(fallbackFrame.fills.map((fill) => fill.fillStyle))]),
  )
  check('文件里的格一个字节都没改（格上仍然没有 temp 这个键）', 'temp' in document_.terrain['2_0'] === false)
  check('兜底格也不写数值（它只是这张图的基线，不是量出来的数据）', textOf(fallbackFrame).includes('30') === false, JSON.stringify(textOf(fallbackFrame)))

  // ---- 开"每格写数值"：只有真值格有字 ----
  await plugin.setOverlayStyle('temperature', { showValues: true })
  await tick(20)
  const labelled = frame()
  check(
    '开"每格写数值"后：真值格有字（15 / -40），兜底格仍然没有',
    textOf(labelled).filter((text) => text === '15').length === 1 &&
      textOf(labelled).includes('-40') &&
      textOf(labelled).includes('30') === false,
    JSON.stringify(textOf(labelled)),
  )
  await plugin.setOverlayStyle('temperature', { showValues: false })
  await tick(20)

  // ---- 落盘：文件里真有这一段 ----
  await store.writeNow(file, document_, 'World', [canvasPath])
  const saved = app.vault.files.get(file.path) ?? ''
  check('落盘后文件里有 dataDefaults（键按字典序）', saved.includes('"dataDefaults": {"temp":30}'), saved.slice(0, 240))

  // ---- 撤销 / 重做：整段对调（与海拔标定同一条路）----
  editor.undo()
  await tick(20)
  check('撤销后文档里没有这一段了（回到"不兜底"）', document_.dataDefaults === undefined)
  frame()
  check('撤销后那格又回到不画', stats().lastOverlayDrawn === 2, String(stats().lastOverlayDrawn))
  check('重做能把整段装回来', editor.redo() === true && JSON.stringify(document_.dataDefaults) === '{"temp":30}')

  // ---- 「清空全部」：删掉整段，文件里不留空对象（§B.5）----
  const clearing = openDefaultsModal()
  check('对话框回显了当前的默认值（30）', clearing.rows[0]?.text?.value === '30', String(clearing.rows[0]?.text?.value))
  await clearing.buttonOf(MODAL_ACTIONS.clearAll).click()
  await tick(20)
  check('清空后文档里没有这一段', document_.dataDefaults === undefined)
  await store.writeNow(file, document_, 'World', [canvasPath])
  const afterClear = app.vault.files.get(file.path) ?? ''
  check(
    '清空后文件里连键都不留（不是 `"dataDefaults": {}`）',
    afterClear.includes('dataDefaults') === false,
    afterClear.slice(0, 240),
  )
  frame()
  check('清空后那格又回到不画', stats().lastOverlayDrawn === 2, String(stats().lastOverlayDrawn))

  plugin.onunload()
}

// ================================================== 场景 47：等值线数字的颜色 / 字号 / 重复（ISSUES-001）
console.log('\n场景 47：等值线数字 —— 描边与字色相反、字号比格心读数小、沿线按间隔重复')
{
  // 用户报的三条（原话）："等高线数字没弄好，还是黑色的，很大不跟着线走。" + 追加要求"每隔多少距离重复一次数字"。
  // 复诊结论：看到的是**等值线标签**（压在线上、线在数字处断开），旋转其实生效；
  // 真正要修的是**颜色口径**（描边写死白色）+ **字号**（与格心读数同大）+ **取点**（每层只有 3 个）。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const pxOf = (textItem) => Number((/([\d.]+)px/.exec(String(textItem.font)) ?? [])[1] ?? Number.NaN)

  // 一条跨度很大的温度带：从极寒（纯蓝，暗）到温热（绿/橙，亮）——
  // 两端都要有数字，才能同时验"深底白字配深边"与"浅底深字配浅边"。
  // 铺 4 行是**故意的**：连续场的数据范围由样本包围盒决定，只铺一行时等值线只有两三格长，
  // "沿线重复"根本没地方放第二个数字（场景 45 踩过同一个坑）。
  for (let q = 0; q < 6; q += 1) {
    for (let r = 0; r < 4; r += 1) document_.terrain[`${q}_${r}`] = { t: 'plains', temp: -50 + q * 18 }
  }

  // ---- ① 字号：等值线数字必须**小于**格心读数（同一条数据、同一个视口下比）----
  await plugin.setLayerVisible('temperature', true)
  await plugin.setOverlayStyle('temperature', { showValues: true })
  await tick(20)
  const cellFrame = frame()
  const cellPx = pxOf(cellFrame.texts.find((item) => item.kind === 'fill') ?? { font: '' })
  // 间距取 10：配色两端都落在层级上（-30 = 纯蓝 → 白字；40 附近 → 深字），
  // 这样"深底白字配深边 / 浅底深字配浅边"两种情况都能在同一帧里出现
  await plugin.setOverlayStyle('temperature', { mode: 'field', contourInterval: 10 })
  await tick(20)
  const fieldFrame = frame()
  const contourPx = pxOf(fieldFrame.texts.find((item) => item.kind === 'fill') ?? { font: '' })
  check(
    '等值线数字比格心读数小一档（0.35 / 0.5 = 0.7 倍）',
    Number.isFinite(cellPx) && Number.isFinite(contourPx) && contourPx < cellPx * 0.95,
    `格心 ${cellPx}px vs 等值线 ${contourPx}px`,
  )
  check('前提：这一帧确实有等值线数字', stats().lastOverlayLabels > 0, String(stats().lastOverlayLabels))

  // ---- ② 描边与字色相反：桩记得下 strokeStyle 才断言得了（旧桩只记 fillStyle，这条永远看不到东西）----
  const pairs = []
  for (let index = 0; index < fieldFrame.texts.length; index += 1) {
    const stroke = fieldFrame.texts[index]
    const fill = fieldFrame.texts[index + 1]
    if (stroke?.kind === 'stroke' && fill?.kind === 'fill' && stroke.text === fill.text) {
      pairs.push({ text: stroke.text, halo: stroke.strokeStyle, color: fill.fillStyle })
    }
  }
  check('每一处等值线数字都是"先描边、后填字"（顺序错了会盖住字）', pairs.length > 0, String(pairs.length))
  check(
    '描边颜色与字色**相反**（白字配深边 / 深字配浅边）',
    pairs.every((pair) => pair.halo !== pair.color && ['#ffffff', '#111827'].includes(pair.halo)),
    JSON.stringify(pairs.slice(0, 6)),
  )
  check(
    '深色底上的数字是白字 + 深边（旧口径写死白边 ⇒ 白字配白边等于没描边）',
    pairs.some((pair) => pair.color === '#ffffff' && pair.halo === '#111827'),
    JSON.stringify(pairs.slice(0, 6)),
  )

  // ---- ③ 旋转：斜的线上数字跟着斜（水平段为 0 属正常）----
  check(
    '等值线数字带着该处的切线角（不是一律水平）',
    fieldFrame.texts.some((item) => item.kind === 'fill' && item.angle !== 0),
    JSON.stringify(fieldFrame.texts.map((item) => item.angle).slice(0, 8)),
  )

  // ---- ④ 重复间隔：调小 ⇒ 数字当场变密，并且**采样缓存重算**（间隔进键）----
  const beforeDense = stats().lastOverlayLabels
  const buildsBefore = stats().lastOverlayFieldBuilds
  await plugin.setOverlayStyle('temperature', { contourLabelSpacing: 1.5 })
  await tick(20)
  const denseFrame = frame()
  check(
    '把「重复间隔」调小之后数字变多（沿等值线重复）',
    stats().lastOverlayLabels > beforeDense,
    `${beforeDense} → ${stats().lastOverlayLabels}`,
  )
  check(
    '重复间隔进缓存键（调完当场重算，不是等下次数据变化）',
    stats().lastOverlayFieldBuilds === buildsBefore + 1,
    `${buildsBefore} → ${stats().lastOverlayFieldBuilds}`,
  )
  check('密起来之后每一层仍有上限（不爆炸）', stats().lastOverlayLabels <= 12 * 4, String(stats().lastOverlayLabels))
  const denseCounts = denseFrame.texts.filter((item) => item.kind === 'fill').map((item) => item.text)
  check('变密后同一个读数在线上重复出现', new Set(denseCounts).size < denseCounts.length, JSON.stringify(denseCounts))

  // ---- ⑤ 断线仍然是"真的断开"（多切点之后也不能漏）----
  const feeds = denseFrame.groups.filter((group) => group.points.length >= 2)
  check('多切点之后折线段数 > 数字数（N 个数字切出 N+1 段）', feeds.length > denseFrame.texts.filter((i) => i.kind === 'fill').length, `${feeds.length}`)

  plugin.onunload()
}

// ================================================== 场景 48：选择系统（施工文件 §C）
console.log('\n场景 48：选择系统 —— 框选 / Shift 加选 / Alt 取消 / 笔迹框选 / 连通扩展 / 规则筛选器')
{
  // 这一层最容易悄悄变的是**语义**而不是崩溃：Alt 变成"集合取补"、Shift 把原选择冲掉、
  // 框选把空白区也算进来。所以断言直接看"选中了哪些格"，而不是"看起来有没有高亮"。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const wrapper = canvas.wrapperEl
  const toolbarEl = wrapper.children.find((child) => child.className === 'fc-toolbar')
  const editor = layers.getEditor(canvasPath)
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const selected = () => [...editor.getCellSelection()]
  const frame = () => {
    canvas.markViewportChanged()
    flushFrames()
  }
  const press = (element) => element.dispatchEvent({ type: 'click' })

  // 一片 4×3 的森林 + 两格水（水既"挡路"，也证明扩展不会顺手把别的地形收进来）
  for (let q = 0; q < 4; q += 1) for (let r = 0; r < 3; r += 1) document_.terrain[`${q}_${r}`] = { t: 'forest' }
  document_.terrain['4_0'] = { t: 'water' }
  document_.terrain['0_3'] = { t: 'water' }

  const origin = canvas._clientFor({ x: 0, y: 0 }) // 世界原点 = 格 0_0
  const farA = canvas._clientFor({ x: -4000, y: -4000 }) // 覆盖整张图的左上角
  const farB = canvas._clientFor({ x: 4000, y: 4000 }) // 右下角
  let pointerSeq = 20
  const down = (at, modifiers = {}) => {
    pointerSeq += 1
    firePointer(host, 'pointerdown', { clientX: at.x, clientY: at.y, target: wrapper, pointerId: pointerSeq, ...modifiers })
    return pointerSeq
  }
  const move = (at, pointerId, modifiers = {}) =>
    firePointer(host, 'pointermove', { clientX: at.x, clientY: at.y, target: wrapper, pointerId, ...modifiers })
  const up = (at, pointerId) => firePointer(host, 'pointerup', { clientX: at.x, clientY: at.y, target: wrapper, pointerId })
  const drag = (from, to, modifiers = {}) => {
    const id = down(from, modifiers)
    move(to, id, modifiers)
    up(to, id)
  }

  const cardEl = () => collectByClass(wrapper, 'fc-selection-card')[0]
  const statusEl = () => collectByClass(toolbarEl, 'fc-toolbar-status')[0]
    // ISSUE-004：框的「身份」在标题行（`fc-toolbar-title`），旧断言绑在副行上会误报 —— 这里补一个取标题的辅助
    const titleEl = () => collectByClass(toolbarEl, 'fc-toolbar-title')[0]
  const cardRows = () => {
    const map = new Map()
    for (const row of collectByClass(cardEl(), 'fc-selection-card-row')) {
      map.set(row.children[0]?.textContent, row.children[1]?.textContent)
    }
    return map
  }
  /** 按前缀找一行（字段的显示名里带单位，写死全名会让断言跟着文案一起漂） */
  const rowStartingWith = (prefix) => {
    for (const [label, value] of cardRows()) if (String(label).startsWith(prefix)) return value
    return undefined
  }

  // ---- ① 矩形框选（替换）：**指针按住不放**，先验"进行中"的卡片 ----
  const dragId = down(farA)
  move(farB, dragId)
  check('框选整张图：14 格全选中（12 森林 + 2 水；只收地图里已有的格）', selected().length === 14, String(selected().length))
  frame()
  check('格选择真的画出来了（有可读的统计）', stats().lastCellHighlight === 14, String(stats().lastCellHighlight))

  // ---- ①b 框选**进行中**：右上角信息卡给统计（§2.6"卡片只做进行中的事"）----
  check('框选进行中时信息卡显示出来', cardEl() !== undefined && cardEl().classList.contains('is-empty') === false)
  check('卡片标题是总格数', collectByClass(cardEl(), 'fc-selection-card-title')[0]?.textContent === SELECTION_TEXT.multiTitle(14), collectByClass(cardEl(), 'fc-selection-card-title')[0]?.textContent)
  check(
    '卡片的"地形种类"把 ID 翻成显示名并带个数（森林 12 · 水域 2）',
    /森林 12/.test(cardRows().get('地形种类') ?? '') && /水域 2/.test(cardRows().get('地形种类') ?? ''),
    String(cardRows().get('地形种类')),
  )
  check('卡片给出坐标范围', /^q 0–4 · r 0–3$/.test(cardRows().get(SELECTION_TEXT.rangeLabel) ?? ''), String(cardRows().get(SELECTION_TEXT.rangeLabel)))
  check(
    '卡片说明"有几格没有数据"（这一片全部没有温度）',
    /14 格/.test(cardRows().get('温度 缺数据') ?? ''),
    String(cardRows().get('温度 缺数据')),
  )
  check(
    '标题行写清"当前是哪种框选、选了多少格"（ISSUE-004：信息在标题行）',
    titleEl()?.textContent === TOOLBAR_TEXT.selection(SELECTION_MODE_LABELS.rect, 14),
    String(statusEl()?.textContent),
  )
  up(farB, dragId)
  flushFrames()
  check(
    '抬手之后卡片收起（选择已确定 ⇒ 那一份统计归侧栏「数据显示」）',
    cardEl().classList.contains('is-empty') === true,
    String(cardEl()?.className),
  )

  // ---- ①c 整批编辑（§C.5）：一次提交 = 一条历史、不预填共同值 ----
  plugin.ribbonIcons[0].callback()
  await tick(30)
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
  const batchGroup = () => collectByClass(panel.contentEl, 'fc-panel-batch')[0]
  const batchTitle = () => collectByClass(batchGroup(), 'fc-panel-group-title')[0]?.textContent ?? ''
  const batchInput = (key) =>
    collectByClass(panel.contentEl, 'fc-selection-input').find(
      (el) => el.dataset?.fcRole === 'batch-input' && el.dataset?.fcField === key,
    )
  const batchClear = (key) =>
    collectByClass(panel.contentEl, 'fc-selection-button').find(
      (el) => el.dataset?.fcRole === 'batch-clear' && el.dataset?.fcField === key,
    )
  const batchDetail = (prefix) => {
    for (const row of collectByClass(panel.contentEl, 'fc-batch-detail-row')) {
      const label = collectByClass(row, 'fc-batch-detail-label')[0]?.textContent ?? ''
      if (label.startsWith(prefix)) return collectByClass(row, 'fc-batch-detail-value')[0]?.textContent ?? ''
    }
    return undefined
  }

  // ---- ①b-2 卡片降级之后，那份统计**必须**在侧栏（用户验收时说"并没有收进侧栏里"）----
  check('侧栏「整批编辑」里有坐标范围（卡片原来那一行）', /^q 0–4 · r 0–3$/.test(batchDetail(SELECTION_TEXT.rangeLabel) ?? ''), String(batchDetail(SELECTION_TEXT.rangeLabel)))
  check('侧栏里有温度众数 / 平均数（§C.4 那份统计的核心）', batchDetail('温度 众数') !== undefined && batchDetail('温度 平均') !== undefined, `${String(batchDetail('温度 众数'))} / ${String(batchDetail('温度 平均'))}`)
  check('侧栏里也说明"有几格没有数据"', /14 格/.test(batchDetail('温度 缺数据') ?? ''), String(batchDetail('温度 缺数据')))
  const tempOf = () => Object.values(document_.terrain).filter((cell) => cell.temp === 25).length
  const anyTemp = () => Object.values(document_.terrain).some((cell) => cell.temp !== undefined)

  check('多选时侧栏换成「整批编辑（14 格）」', batchTitle() === PANEL_TITLES.batchEdit(14), batchTitle())
  check(
    '每个字段一行、输入框**初始留空**（不预填共同值）',
    batchInput('temp') !== undefined && batchInput('temp').value === '',
    String(batchInput('temp')?.value),
  )
  check(
    '说明里点出"这批里有 14 格没有数据"（不猜共同值）',
    collectByClass(panel.contentEl, 'fc-selection-hintline').some((el) => /这批里有 14 格没有数据/.test(el.textContent ?? '')),
    JSON.stringify(collectByClass(panel.contentEl, 'fc-selection-hintline').map((el) => el.textContent)),
  )

  batchInput('temp').value = '25'
  batchInput('temp').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} })
  await tick(20)
  check('整批写入：14 格都拿到温度 25', tempOf() === 14, String(tempOf()))
  check('一次提交 = 一条历史（Ctrl+Z 一次全部回退）', editor.getStatus().undo === 1, String(editor.getStatus().undo))

  batchClear('temp').dispatchEvent({ type: 'click' })
  await tick(20)
  check('「清除该值」把字段整个删掉（不是写一个 0 进去）', anyTemp() === false)
  check('清除也是一条历史', editor.getStatus().undo === 2, String(editor.getStatus().undo))

  editor.undo()
  check('撤销一次回到"整批写入之后"（14 格仍是 25）', tempOf() === 14, String(tempOf()))
  editor.undo()
  check('再撤销一次回到"完全没有温度"', anyTemp() === false)

  // ---- ② Alt + 单击 = 只取消这一格 ----
  {
    const id = down(origin, { altKey: true })
    up(origin, id)
  }
  check(
    'Alt + 单击 = 只取消这一格（不是集合取补）',
    selected().length === 13 && selected().includes('0_0') === false,
    JSON.stringify(selected()),
  )

  // ---- ③ Shift + 拖动 = 并入选择 ----
  drag(farA, farB, { shiftKey: true })
  check('Shift + 拖动 = 并入选择（原有 13 格一个都不掉）', selected().length === 14, String(selected().length))

  // ---- ④ Alt + 拖动 = 移出一片 ----
  drag(farA, farB, { altKey: true })
  check('Alt + 拖动 = 从选择里移出这一片', selected().length === 0, String(selected().length))

  // ---- ⑤ 笔迹框选：切换模式走**侧栏里的真实按钮**（§F.2 之后选择方式在侧栏）----
  flushFrames()
  const brushSelectButton = () => inPanel(panel, 'fc-panel-selection-mode-button').find((el) => el.dataset.fcSelectionMode === 'brush')
  check('选择方式那一组在侧栏（矩形 / 笔迹框选）', brushSelectButton() !== undefined)
  press(brushSelectButton())
  check('点「笔迹框选」切换了选择子模式', editor.getStatus().selectionMode === 'brush', editor.getStatus().selectionMode)

  const nearB = canvas._clientFor({ x: 60, y: 0 })
  drag(origin, nearB)
  check(
    '笔迹框选：笔迹扫过的格被选中（世界原点 0_0 起、60 世界单位处是 1_0）',
    selected().length >= 1 && selected().includes('0_0'),
    JSON.stringify(selected()),
  )

  // ---- ⑥ 连通扩展：同地形六邻域，水挡住去路 ----
  flushFrames()
  const expandButton = () => inPanel(panel, 'fc-panel-selection-expand')[0]
  check(
    '有选择时「连通扩展」是可用的（没选择时才置灰 —— 点了没反应最容易被当成坏了）',
    expandButton()?.disabled === false,
    String(expandButton()?.disabled),
  )
  press(expandButton())
  check(
    '连通扩展：从种子扩到整片森林（12 格），两格水不进选择',
    selected().length === 12 && selected().includes('4_0') === false && selected().includes('0_3') === false,
    JSON.stringify(selected()),
  )

  // ---- ⑦ 规则筛选器：真实对话框（命令入口），条件行由**规则表**派生 ----
  const before = selected().length
  runCommand(plugin, 'filter-selection')
  const modal = fakeObsidian.Modal.lastAny
  const clausesEl = collectByClass(modal?.contentEl, 'fc-filter-clauses')[0]
  check('命令能打开筛选器对话框', modal !== null && modal !== undefined && clausesEl !== undefined)
  check(
    '对话框里一开始没有条件（空规则不匹配任何格，不会把选择清空）',
    (clausesEl?.children ?? []).length === 1 && selected().length === before,
    JSON.stringify((clausesEl?.children ?? []).map((child) => child.textContent)),
  )

  // ISSUE-003 的主因：组完条件得不到反馈。于是**结果在顶部**，而且算的是"会选中什么"
  const resultEl = collectByClass(modal?.contentEl, 'fc-filter-result')[0]
  check(
    '结果行在**最上面**（排在条件列表之前）',
    resultEl !== undefined && modal.contentEl.children.indexOf(resultEl) < modal.contentEl.children.indexOf(clausesEl),
    String(modal?.contentEl?.children?.map((child) => child.className ?? child.tagName).slice(0, 4)),
  )
  check(
    '还没有可用的条件时结果行如实说（不是"当前选择 N 格"）',
    /还没有可用的条件/.test(resultEl?.textContent ?? ''),
    String(resultEl?.textContent),
  )

  // 「+ 再加一个条件」是 Setting 按钮（`dataset.fcFilter = 'add'`）
  const addClauseButton = FakeSetting.created
    .flatMap((setting) => setting.buttons ?? [])
    .find((button) => button.buttonEl?.dataset?.fcFilter === 'add')
  check('「+ 再加一个条件」按钮存在', addClauseButton !== undefined)
  await addClauseButton.click()
  const rows = collectByClass(clausesEl, 'fc-filter-row')
  check('加了一条条件：规则 / 运算符 / 值三个控件都在', rows.length === 1, String(rows.length))
  // 控件**函数现取**：换规则 / 换运算符都会重建整行（与场景 50 同一条纪律）
  const rowSelects = () =>
    (collectByClass(clausesEl, 'fc-filter-row')[0]?.children ?? []).filter((child) => child.tagName === 'SELECT')
  const selectsInRow = rowSelects()
  check(
    '条件的控件由**规则表**派生（规则下拉里的选项 = 登记表里的规则，含自动生成的数值规则）',
    selectsInRow.length === 3 &&
      selectsInRow[0].children.length >= 3 &&
      selectsInRow[0].children.map((option) => option.value).includes('temp') &&
      selectsInRow[0].children.map((option) => option.value).includes('depth'),
    `${selectsInRow.length} · ${JSON.stringify(selectsInRow[0]?.children?.map((option) => option.value))}`,
  )
  // ISSUE-003 的第一条硬证据：运算符下拉以前直接显示 `in` / `between` / `exists`
  const opLabels = () => rowSelects()[1]?.children?.map((option) => option.textContent)
  check(
    '运算符下拉写的是**中文显示名**（值仍是 IR 里的 token）',
    JSON.stringify(opLabels()) === JSON.stringify(['等于', '不等于', '属于其中之一', '有 / 没有这个数据']),
    JSON.stringify(opLabels()),
  )
  // 值控件是**枚举下拉**（地形），候选项带显示名（不能拿 slug 当名字给用户看）
  check(
    '枚举规则的值渲染成带显示名的下拉',
    rowSelects()[2]?.children?.some((option) => option.value === 'forest' && option.textContent === '森林') === true,
    JSON.stringify(rowSelects()[2]?.children?.map((option) => `${option.value}:${option.textContent}`)),
  )

  const echo = collectByClass(modal?.contentEl, 'fc-filter-echo')[0]
  // 默认那一行是"地形 = 第一个地形"；把它改成森林（真实用户的操作路径）
  rowSelects()[2].value = 'forest'
  rowSelects()[2].dispatchEvent({ type: 'change' })
  check(
    '人话回显把 ID 翻成了显示名（"地形 = 森林"，不是 "地形 = forest"）',
    /地形 = 森林/.test(echo?.textContent ?? ''),
    String(echo?.textContent),
  )

  // 顶部大字 = **试算**结果（这条规则命中的正是那 12 格森林），动作按钮写着前后格数
  check(
    '顶部大字给的是结果（"按这些条件会选中 12 格"）',
    resultEl?.textContent === '按这些条件会选中 12 格',
    String(resultEl?.textContent),
  )
  const actionButton = (key) =>
    collectByClass(modal?.contentEl, 'fc-filter-action').find((button) => button.dataset.fcFilter === key)
  check(
    '动作按钮写着**前后格数**（替换 / 并入 / 移出 / 内筛）',
    ['apply-replace', 'apply-add', 'apply-remove', 'apply-inside']
      .map((key) => actionButton(key)?.textContent)
      .join('|') ===
      [`替换（→12 格）`, `并入（${before} → 12 格）`, `移出（${before} → 0 格）`, `在当前选择内筛（${before} → 12 格）`].join('|'),
    ['apply-replace', 'apply-add', 'apply-remove', 'apply-inside'].map((key) => actionButton(key)?.textContent).join(' | '),
  )
  check(
    '整个对话框里不出现 in / between / exists 这类英文 token',
    /\b(in|between|exists)\b/.test(modal?.contentEl?.textContent ?? '') === false,
    String(modal?.contentEl?.textContent).slice(0, 240),
  )

  // 按"地形 = 森林"**替换**选择：与连通扩展的结果应当一致（12 格森林）
  press(actionButton('apply-replace'))
  check(
    '「替换选择」按规则选出 12 格森林',
    selected().length === 12 && selected().includes('0_0') && selected().includes('3_2'),
    JSON.stringify(selected()),
  )
  check(
    '按下之后按钮上的"前后"跟着更新（当前选择已经变成那 12 格）',
    actionButton('apply-add')?.textContent === '并入（12 → 12 格）' &&
      actionButton('apply-remove')?.textContent === '移出（12 → 0 格）',
    `${actionButton('apply-add')?.textContent} · ${actionButton('apply-remove')?.textContent}`,
  )

  // 「在当前选择内筛」= 同一条规则 ∩ 当前选择：结果仍是那 12 格森林
  // （"当前选择内"依赖选择本身 → 它是**动作**而不是规则，见 §C.2 末尾那条分工）
  press(actionButton('apply-inside'))
  check('「在当前选择内筛」（地形 = 森林 ∩ 当前选择）结果仍是 12 格', selected().length === 12, String(selected().length))

  check(
    '筛选器**不改地图数据、不进撤销栈**（选择只是"在看哪些格"）',
    editor.getStatus().undo === 0,
    String(editor.getStatus().undo),
  )

  // ---- ⑦b "其中 N 格没有温度"：换成「温度 · 没有这个数据」把话说死（命中数必须 = 缺数据数）----
  rowSelects()[0].value = 'temp'
  rowSelects()[0].dispatchEvent({ type: 'change' })
  check(
    '换规则后运算符换成该规则那一套（温度：等于 / 不等于 / > / ≥ / < / ≤ / 介于…之间 / 有 / 没有这个数据）',
    JSON.stringify(opLabels()) === JSON.stringify(['等于', '不等于', '>', '≥', '<', '≤', '介于…之间', '有 / 没有这个数据']),
    JSON.stringify(opLabels()),
  )
  // 行元素也要**现取**：换规则会重建整行（旧引用上没有 is-invalid）
  const invalidRow = collectByClass(clausesEl, 'fc-filter-row')[0]
  check(
    '数值条件还没填数时标红、且不算数（结果行退回"还没有可用的条件"）',
    invalidRow?.classList?.contains('is-invalid') === true && /还没有可用的条件/.test(resultEl?.textContent ?? ''),
    `${invalidRow?.classList?.contains('is-invalid')} · ${resultEl?.textContent}`,
  )
  rowSelects()[1].value = 'exists'
  rowSelects()[1].dispatchEvent({ type: 'change' })
  check(
    '"有 / 没有这个数据"的值控件是两选（有 / 没有）',
    JSON.stringify(rowSelects()[2]?.children?.map((option) => option.textContent)) === JSON.stringify(['有', '没有']),
    JSON.stringify(rowSelects()[2]?.children?.map((option) => option.textContent)),
  )
  rowSelects()[2].value = 'false'
  rowSelects()[2].dispatchEvent({ type: 'change' })
  const missingHeadline = String(resultEl?.textContent)
  const missingMatch = /^按这些条件会选中 (\d+) 格，其中 (\d+) 格没有温度$/.exec(missingHeadline)
  check(
    '命中格全部没温度时，结果行写成"…会选中 N 格，其中 N 格没有温度"',
    missingMatch !== null && missingMatch[1] === missingMatch[2],
    missingHeadline,
  )
  press(actionButton('apply-replace'))
  check(
    '试算的格数与"真的应用一次"完全一致（预览不会与结果分叉）',
    selected().length === Number(missingMatch?.[1] ?? -1),
    `${selected().length} vs ${missingMatch?.[1]}`,
  )

  // ---- ⑧ 悬停读数：卡片只做**进行中**的事（§2.6）----
  // 卡片不再显示"已确定的选择"（那一份归侧栏「数据显示」），所以这里用**指针悬停**驱动它。
  const hoverWorld = canvas._clientFor({ x: 0, y: 0 })
  const hoverMove = (target = wrapper, client = hoverWorld) =>
    firePointer(host, 'pointermove', { clientX: client.x, clientY: client.y, target, pointerId: 777 })
  hoverMove()
  flushFrames()
  check('悬停在一格上时，卡片给出那一格的详情', cardRows().get('坐标') === '(0, 0)', String(cardRows().get('坐标')))
  check('详情里的地形是显示名', cardRows().get('地形') === '森林', String(cardRows().get('地形')))
  check(
    '没有的字段写"未填"，不猜 0（0 ℃ / 海平面都是合法读数）',
    rowStartingWith('温度') === SELECTION_TEXT.unfilled && cardRows().get('生物群系') === SELECTION_TEXT.unfilled,
    `${String(rowStartingWith('温度'))} / ${String(cardRows().get('生物群系'))}`,
  )

  // 命中对象优先：同一坐标上放一个标记，悬停应报**对象名**而不是它下面那一格的地形
  document_.markers.push({ id: 'mk-hover', label: '悬停点', p: [0, 0], icon: 'town' })
  hoverMove()
  flushFrames()
  check(
    '悬停压在标记上时报**对象名**，而不是它下面那一格的地形（§2.6 那条"命中对象优先"）',
    collectByClass(cardEl(), 'fc-selection-card-title')[0]?.textContent === SELECTION_TEXT.objectTitle('标记', '悬停点'),
    String(collectByClass(cardEl(), 'fc-selection-card-title')[0]?.textContent),
  )
  document_.markers.pop()

  // 指针移出画布 → 读数清空；此时"已确定的选择"也不该占着卡片（那一份归侧栏）
  hoverMove(makeEl({ tagName: 'div', className: '' }))
  editor.setCellSelection(['0_0'])
  flushFrames()
  check(
    '已确定的选择不再占着卡片（归侧栏「数据显示」），卡片整张收起',
    cardEl().classList.contains('is-empty') === true,
    String(cardEl()?.className),
  )

  // ---- ⑨ Esc 先清空选择：卡片整张收起、状态条回到"空闲" ----
  editor.clearAllSelection()
  check('一键清空后选择为空', selected().length === 0 && editor.getSelection() === null)
  check('没有选择时整张卡片收起（不是显示一张空的）', cardEl().classList.contains('is-empty') === true)
  check(
      '标题行回到"空闲"（副行整行隐藏，不再重复同一句话）',
      titleEl()?.textContent === TOOLBAR_TEXT.idle && statusEl()?.style.display === 'none',
      `${String(titleEl()?.textContent)} / display=${String(statusEl()?.style.display)}`,
    )

  console.log('  （场景 48 结束）')
  plugin.onunload()
}

console.log('\n场景 49：生物群系（§D 分类字段）与数值图层笔刷（§E）—— 逐格纯色 / 设为 ID / ＋−×÷')
{
  // §D 与 §E 的共同点：**语义**比崩溃更容易悄悄变（分类值被插值成渐变、"没量过"被当成 0、
  // 换一层之后笔上还带着上一层的数）。所以断言直接看「格上写了什么」与「画布上什么颜色」，
  // 而不是"有没有崩"。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const wrapper = canvas.wrapperEl
  const host = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const layerCanvas = canvas.canvasEl.children[0].children[0]
  attachFaithfulRect(layerCanvas, canvas)
  const ctx = layerCanvas._ctx
  const toolbarEl = wrapper.children.find((child) => child.className === 'fc-toolbar')
  const editor = layers.getEditor(canvasPath)
  const document_ = layers.getDocument(canvasPath)
  const stats = () => layers.listStatus()[0].stats
  const frame = () => {
    ctx.resetCalls()
    canvas.markViewportChanged()
    flushFrames()
    return ctx
  }
  const press = (element) => fireEvent(element, 'click')
  /** 格心世界坐标（用**网格换算**，不写死像素：写死的数会随 grid.size 漂走） */
  const worldOf = (q, r) => axialToWorld(document_.grid, q, r)

  // 真实指针：绘制模式下按下即起笔、抬手即收笔 —— §E 的"一笔 = 一条历史"靠它验证
  let pointerSeq = 80
  const strokeThrough = (from, to) => {
    const a = canvas._clientFor(from)
    const b = canvas._clientFor(to)
    pointerSeq += 1
    firePointer(host, 'pointerdown', { clientX: a.x, clientY: a.y, target: wrapper, pointerId: pointerSeq })
    firePointer(host, 'pointermove', { clientX: b.x, clientY: b.y, target: wrapper, pointerId: pointerSeq })
    firePointer(host, 'pointerup', { clientX: b.x, clientY: b.y, target: wrapper, pointerId: pointerSeq })
  }
  const strokeAt = (world) => strokeThrough(world, world)

  // 侧栏「笔刷」里的**真实控件**（§E 的三条硬口径都长在这里，所以断言必须经过它们）。
  //
  // ⚠️ 两处与浮窗时期不同、必须照做的地方：
  // 1. 面板是**整块重建**式重绘，控件元素每次重绘都是新的 —— 所以这里一律**现取**
  //    （`brushValueInput()` 而不是一个常量），否则读到的是已经脱离 DOM 的旧元素；
  // 2. 改完状态要 `flushFrames()` 面板才会重绘（排队在可控 rAF 里）。
  const panel = await openMapPanel(app, plugin)
  const brushFieldSelect = () => inPanel(panel, 'fc-panel-brush-field')[0]
  const brushValueInput = () => inPanel(panel, 'fc-panel-brush-value')[0]
  const brushBiomeSelect = () => inPanel(panel, 'fc-panel-brush-biome')[0]
  const brushOpButton = (op) => inPanel(panel, 'fc-panel-brush-op').find((el) => el.dataset.fcBrushOp === op)
  /** 数值字段才有 ＋−×÷（分类字段整组不渲染 —— 摆着点不动只会让人以为坏了） */
  const brushOpCount = () => inPanel(panel, 'fc-panel-brush-op').length
  const statusEl = collectByClass(toolbarEl, 'fc-toolbar-status')[0]
  const titleEl = collectByClass(toolbarEl, 'fc-toolbar-title')[0]
  const chooseField = (value) => {
    brushFieldSelect().value = value
    fireEvent(brushFieldSelect(), 'change')
    flushFrames()
  }
  /** 用户按回车 / 点开别处 = 确认这个数 */
  const commitValue = (text) => {
    brushValueInput().value = text
    fireEvent(brushValueInput(), 'change')
    flushFrames()
  }
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]
  const legendRows = (kind) => collectByClass(legendEl(), 'fc-legend-row').filter((row) => row.dataset.kind === kind)
  const rowOf = (row) => ({
    label: collectByClass(row, 'fc-legend-label')[0]?.textContent ?? '',
    count: collectByClass(row, 'fc-legend-count')[0]?.textContent ?? '',
    color: collectByClass(row, 'fc-legend-swatch')[0]?.style.backgroundColor ?? '',
  })
  const overlayFills = (frameCtx) => frameCtx.fills.filter((fill) => fill.alpha > 0 && fill.alpha < 1)

  // 两格有地形：0_0 是笔刷的落点，1_0 刻意**一直不填值**（验证 ×/÷ 会跳过它）
  document_.terrain[cellKey(0, 0)] = { t: 'forest' }
  document_.terrain[cellKey(1, 0)] = { t: 'plains' }

  // ---- ① 图层登记表：生物群系是一层，出厂默认关 ----
  check(
    '生物群系在图层设置里、出厂默认关（新功能不该改变用户现有画面）',
    plugin.getSettings().layers.biome === false,
    String(plugin.getSettings().layers.biome),
  )

  // ---- ② 笔刷那一节的"层"下拉由**字段表**派生 ----
  press(collectByClass(toolbarEl, 'fc-toolbar-mode')[0])
  check('点浮窗上的模式按钮真的进了绘制模式', editor.getStatus().mode === 'paint', editor.getStatus().mode)
  flushFrames()
  check(
    '侧栏「笔刷」的层下拉 = 地形 + 字段表里每一层（加一层只加一行，不手抄选项）',
    brushFieldSelect().children.map((option) => option.value).join(',') === ',temperature,depth,biome',
    brushFieldSelect().children.map((option) => option.value).join(','),
  )

  // ---- ③ 数值档：留空不生效 + 状态条说清原因（§E 第 2 条）----
  chooseField('temperature')
  check('切到温度层后数值框是**空的**（不预填）', brushValueInput()?.value === '', String(brushValueInput()?.value))
  check('数值字段才有那五个算法按钮（＝ ＋ − × ÷）', brushOpCount() === 5, String(brushOpCount()))
  check('群系下拉在温度层下不渲染（不是"渲染了再藏"）', brushBiomeSelect() === undefined, String(brushBiomeSelect()))
  check(
    '状态条说清"为什么刷不动"（不是让用户猜）',
    statusEl.textContent === TOOLBAR_TEXT.fieldBrushBlocked(BRUSH_REASONS.noValue),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check(
    '留空时一笔都不落（**不是**画成 0 —— 0 ℃ 是合法读数）',
    document_.terrain[cellKey(0, 0)]?.temp === undefined && editor.getStatus().undo === 0,
    JSON.stringify(document_.terrain[cellKey(0, 0)]),
  )

  // ---- ④ 只键入还没回车：值不生效，而且**打字不会被冲掉** ----
  brushValueInput().focus()
  brushValueInput().value = '12'
  fireEvent(brushValueInput(), 'input')
  check('键入把笔刷打回"未确认"（值不生效）', editor.getStatus().brushValueConfirmed === false)
  // 面板这一版是"重建时把焦点与文字放回去"（`MapPanel.captureFocusedInput`）：
  // 键入会写编辑器状态、可能触发重绘，光"有焦点就别改它的字"不够 —— 元素本身会被换掉。
  flushFrames()
  check(
    '重建不会把用户正打的字冲掉（文字与焦点都放回去）',
    brushValueInput()?.value === '12',
    String(brushValueInput()?.value),
  )
  brushValueInput().blur()
  strokeAt(worldOf(0, 0))
  check('没确认时也不落笔', document_.terrain[cellKey(0, 0)]?.temp === undefined)

  // ---- ⑤ 回车确认 → 生效；一笔 = 一条历史 ----
  commitValue('12')
  check(
    '确认后状态条写清"刷哪一层、怎么刷"',
    statusEl.textContent === TOOLBAR_TEXT.fieldBrush('温度', TOOLBAR_TEXT.brushOpLabel('set'), 12),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check('刷上了 12', document_.terrain[cellKey(0, 0)]?.temp === 12, JSON.stringify(document_.terrain[cellKey(0, 0)]))
  check('一笔 = 一条历史（Ctrl+Z 一次回到笔画前）', editor.getStatus().undo === 1, String(editor.getStatus().undo))

  // ---- ⑤b 已确认之后再打字：打回未确认，且**重建时不会把用户打的字冲掉** ----
  // 这才是 `MapPanel.captureFocusedInput` 真正要处理的那条路：键入把已确认的值清成未确认，
  // 签名因此变了 → 面板重建（元素被换掉）→ 必须把文字与焦点放回新元素上。
  brushValueInput().focus()
  brushValueInput().value = '24'
  fireEvent(brushValueInput(), 'input')
  check(
    '再打字会把已确认的值打回未确认（笔刷不生效，值也不是 24）',
    editor.getStatus().brushValueConfirmed === false && editor.getStatus().brushValue === null,
    JSON.stringify({ confirmed: editor.getStatus().brushValueConfirmed, value: editor.getStatus().brushValue }),
  )
  flushFrames()
  check(
    '重建后输入框里仍是用户打的那几个字，且焦点还在它上面',
    brushValueInput()?.value === '24' && fakeDocument.activeElement === brushValueInput(),
    `${String(brushValueInput()?.value)} / focused=${fakeDocument.activeElement === brushValueInput()}`,
  )
  // 把状态放回 ⑥ 期望的样子（12 已确认）
  commitValue('12')

  // ---- ⑥ 换算法 → 打回未确认：数字保留，但笔要再"确认"一次（§E 第 3 条）----
  press(brushOpButton('+'))
  flushFrames()
  check('换算法后数值**保留**（不用重打）', brushValueInput()?.value === '12', String(brushValueInput()?.value))
  check(
    '但笔刷被标成"未确认"，状态条提示回车',
    (statusEl.textContent ?? '').includes(BRUSH_REASONS.unconfirmedValue),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check('未确认时这一笔不生效（12 还是 12）', document_.terrain[cellKey(0, 0)]?.temp === 12)
  commitValue('12')
  check(
    '回车确认后状态条变成 ＋',
    statusEl.textContent === TOOLBAR_TEXT.fieldBrush('温度', TOOLBAR_TEXT.brushOpLabel('+'), 12),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check('12 + 12 = 24', document_.terrain[cellKey(0, 0)]?.temp === 24, JSON.stringify(document_.terrain[cellKey(0, 0)]))

  // ---- ⑥b 换**层**（不是换算法）同样打回未确认 —— 这才是最容易出事故的那一种：
  //          温度层上还留着"刚给深度填的数"，不确认就刷会把温度整片刷错 ----
  chooseField('depth')
  check(
    '换层后数字保留、但打回未确认（状态条提示回车）',
    brushValueInput()?.value === '12' && /按回车确认这个数值后笔刷才生效/.test(statusEl.textContent ?? ''),
    `${String(brushValueInput()?.value)} / ${statusEl.textContent}`,
  )
  strokeAt(worldOf(0, 0))
  check(
    '换层后没确认时一笔都不落（温度也没被顺手改掉）',
    document_.terrain[cellKey(0, 0)]?.depth === undefined && document_.terrain[cellKey(0, 0)]?.temp === 24,
    JSON.stringify(document_.terrain[cellKey(0, 0)]),
  )
  chooseField('temperature')
  commitValue('12')

  // ---- ⑦ ×/÷：无值格**跳过**（不是当成 0）、÷0 整笔拒绝 ----
  press(brushOpButton('×'))
  commitValue('2')
  strokeThrough(worldOf(0, 0), worldOf(1, 0))
  check('有值的格乘 2（24 → 48）', document_.terrain[cellKey(0, 0)]?.temp === 48, String(document_.terrain[cellKey(0, 0)]?.temp))
  check(
    '无值的格**跳过**（不是拿 0 去乘 —— 那会凭空造出一个读数）',
    document_.terrain[cellKey(1, 0)]?.temp === undefined,
    JSON.stringify(document_.terrain[cellKey(1, 0)]),
  )

  press(brushOpButton('÷'))
  commitValue('0')
  const undoBefore = editor.getStatus().undo
  check(
    '÷0 在整笔上就被拦下（状态条说明原因）',
    (statusEl.textContent ?? '').includes(BRUSH_REASONS.divideByZero),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check(
    '÷0 不生效，也不会写出 Infinity',
    document_.terrain[cellKey(0, 0)]?.temp === 48 && editor.getStatus().undo === undoBefore,
    `${String(document_.terrain[cellKey(0, 0)]?.temp)} / undo=${editor.getStatus().undo}`,
  )
  editor.undo()
  check('撤销一笔回到"乘 2 之前"（48 → 24）', document_.terrain[cellKey(0, 0)]?.temp === 24)

  // ---- ⑧ 生物群系笔刷：设为某个 ID，且不动别的键 ----
  chooseField('biome')
  check('分类字段没有 ＋−×÷（整组不渲染）', brushOpCount() === 0, String(brushOpCount()))
  check('分类字段没有"数值"框', brushValueInput() === undefined, String(brushValueInput()))
  check('分类字段才显示群系下拉', brushBiomeSelect() !== undefined)
  check(
    '没选群系就刷不动，状态条说明',
    statusEl.textContent === TOOLBAR_TEXT.fieldBrushBlocked(BRUSH_REASONS.noBiome),
    statusEl.textContent,
  )
  strokeAt(worldOf(0, 0))
  check('未选群系时一笔都不落', document_.terrain[cellKey(0, 0)]?.biome === undefined)

  const biomeOptions = brushBiomeSelect().children
  check(
    '群系下拉的选项由**现读的目录**给出（内置 34 条 + 一个占位项）',
    biomeOptions.length === 35 && biomeOptions[1]?.value !== '',
    String(biomeOptions.length),
  )
  check(
    '选项显示的是中文名、值是稳定 ID（用户看到"沙漠"，文件里写 desert）',
    biomeOptions.some((option) => option.value === 'desert' && option.textContent === '沙漠'),
    JSON.stringify(biomeOptions.filter((option) => ['ice-cap', 'desert'].includes(option.value)).map((o) => `${o.value}:${o.textContent}`)),
  )

  brushBiomeSelect().value = 'desert'
  fireEvent(brushBiomeSelect(), 'change')
  flushFrames()
  check(
    '选完群系，状态条报出它的显示名',
    statusEl.textContent === TOOLBAR_TEXT.categoryBrush('生物群系', '沙漠'),
    statusEl.textContent,
  )

  // ---- ⑦e（ISSUE-008）：刷的是**被关掉的**数据图层 ⇒ 必须说清"看不见"，而不是静默 ----
  // 用户原话是"笔刷工作不正常 / 刷了没反应"：数据真的写进去了，但那一层没画出来，
  // 于是屏幕上什么都不变。这几条钉的是"提示而不拦"这条决定 —— 下面那条"刷上了沙漠"同时证明
  // **提示不等于拦下**（隐藏状态下照旧写得进文件）。
  const hintEl = () => collectByClass(toolbarEl, 'fc-toolbar-hint')[0]
  check(
    '提示行说清"这一层现在隐藏着"（而不是只列按键 —— 那会让人以为笔刷坏了）',
    hintEl()?.textContent === `${BRUSH_NOTES.hiddenLayer} · Esc 退出`,
    String(hintEl()?.textContent),
  )
  check(
    '侧栏「笔刷」一节共读同一句（两处各写一份必然分叉）',
    inPanel(panel, 'fc-panel-hint').some((el) => el.textContent === `笔刷能用，但看不到结果：${BRUSH_NOTES.hiddenLayer}。`),
    inPanel(panel, 'fc-panel-hint').map((el) => el.textContent).join(' | '),
  )
  strokeAt(worldOf(0, 0))
  check('刷上了沙漠', document_.terrain[cellKey(0, 0)]?.biome === 'desert', JSON.stringify(document_.terrain[cellKey(0, 0)]))
  check('一格多值：刷生物群系**不碰温度**（24 还在）', document_.terrain[cellKey(0, 0)]?.temp === 24)

  // ---- ⑨ 画布：逐格纯色（不插值、不写数值）----
  await plugin.setLayerVisible('biome', true)
  await tick(20)
  // 图层是**从插件 API**改的（不是面板上那个开关），所以面板不会自己重绘 ——
  // 手动请它重绘一次再读 DOM（与"改完状态要 flushFrames()"同一条纪律）
  plugin.refreshPanel()
  flushFrames()
  check(
    '打开这一层之后那句提示**自己消失**（提示跟着状态走，不是一次性弹窗）',
    hintEl()?.textContent.includes(BRUSH_NOTES.hiddenLayer) === false &&
      inPanel(panel, 'fc-panel-hint').some((el) => String(el.textContent).includes(BRUSH_NOTES.hiddenLayer)) === false,
    `${String(hintEl()?.textContent)} | ${inPanel(panel, 'fc-panel-hint').map((el) => el.textContent).join(' | ')}`,
  )
  const biomeFrame = frame()
  check('生物群系层进了绘制序列', stats().lastDrawOrder.includes('biome'), stats().lastDrawOrder.join(','))
  check('只画有群系的那一格（没填的格不画，而不是画成某个颜色）', stats().lastOverlayDrawn === 1, String(stats().lastOverlayDrawn))
  check(
    '颜色取自目录里那一条（沙漠 = #e0c477），按出厂不透明度 0.5 画',
    biomeFrame.fills.some((fill) => fill.fillStyle === '#e0c477' && Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify(overlayFills(biomeFrame).map((fill) => `${fill.fillStyle}@${fill.alpha}`)),
  )
  check('分类字段不写数值文字（它的值不是数）', stats().lastOverlayLabels === 0, String(stats().lastOverlayLabels))
  check('分类字段没有等值线', stats().lastOverlayContours === 0, String(stats().lastOverlayContours))

  // ---- ⑩ 图例：逐个群系一行（不是一条配色）----
  await plugin.setShowLegend(true)
  await tick(20)
  check('图例里没有生物群系的配色条目（分类值之间没有高低）', legendRows('ramp').every((row) => !rowOf(row).label.includes('生物群系')))
  check(
    '图例里逐个群系一行：显示名 + 格数 + 目录色',
    legendRows('biome').length === 1 &&
      rowOf(legendRows('biome')[0]).label === '沙漠' &&
      rowOf(legendRows('biome')[0]).count === '1' &&
      rowOf(legendRows('biome')[0]).color === '#e0c477',
    JSON.stringify(legendRows('biome').map(rowOf)),
  )

  // ---- ⑪ 认不出的 ID 也要看得见（§5.11：不能变成空白）----
  document_.terrain[cellKey(2, 0)] = { t: 'forest', biome: '别处的群系' }
  layers.setLayers()
  await tick(20)
  const unknownRow = legendRows('biome').find((row) => rowOf(row).label === '别处的群系')
  check('别的库写的 ID 在图例里也有一行，显示名就是 ID 本身', unknownRow !== undefined)
  check(
    '它的颜色是中性灰（一眼看出"这里没有本机定义"，而不是被误读成某个群系）',
    rowOf(unknownRow).color === '#8b8f96',
    rowOf(unknownRow).color,
  )
  const unknownFrame = frame()
  check(
    '画布上也照画中性灰',
    unknownFrame.fills.some((fill) => fill.fillStyle === '#8b8f96'),
    JSON.stringify(overlayFills(unknownFrame).map((fill) => fill.fillStyle)),
  )

  // ---- ⑫ 设置页：分类字段是"逐条颜色"，不是配色 ----
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const biomeColorSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').startsWith('沙漠（'))
  check('设置页里只列**地图上真的出现**的群系（34 条全列会把设置页撑成一面墙）', biomeColorSetting !== undefined)
  check('这一行认得出是哪个 ID', biomeColorSetting?.text?.inputEl?.dataset?.fcBiomeColor === 'desert')
  check(
    '占位文字就是目录色（用户看得见"不改会是什么颜色"）',
    biomeColorSetting?.text?.placeholder === '#e0c477',
    String(biomeColorSetting?.text?.placeholder),
  )

  await biomeColorSetting.text.type('#ff0000')
  await tick(20)
  check(
    '改这一条的颜色 → 只存**改过的那一条**（其余仍走目录）',
    plugin.getSettings().overlays.biome.categoryColors?.desert === '#ff0000',
    JSON.stringify(plugin.getSettings().overlays.biome.categoryColors),
  )
  check(
    '图例那一行的色块跟着变（设置与图例同一份来源）',
    rowOf(legendRows('biome').find((row) => rowOf(row).label === '沙漠')).color === '#ff0000',
    rowOf(legendRows('biome').find((row) => rowOf(row).label === '沙漠')).color,
  )
  await biomeColorSetting.text.type('')
  await tick(20)
  check(
    '清空输入框 = 删掉这条覆盖（键被删，不是写一个空颜色进去）',
    'desert' in (plugin.getSettings().overlays.biome.categoryColors ?? {}) === false,
    JSON.stringify(plugin.getSettings().overlays.biome.categoryColors),
  )

  // ---- ⑬ 信息卡里的显示名与图例同源 ----
  // 卡片现在只显示**悬停读数**（§2.6：已确定的选择归侧栏），而悬停读数只在选择模式下产出
  editor.setMode('select')
  editor.setCellSelection([cellKey(0, 0)])
  const hoverCell = canvas._clientFor({ x: 0, y: 0 })
  firePointer(host, 'pointermove', { clientX: hoverCell.x, clientY: hoverCell.y, target: wrapper, pointerId: 992 })
  flushFrames()
  const cardRows = new Map()
  for (const row of collectByClass(collectByClass(wrapper, 'fc-selection-card')[0], 'fc-selection-card-row')) {
    cardRows.set(row.children[0]?.textContent, row.children[1]?.textContent)
  }
  check(
    '信息卡里写的是"沙漠"而不是裸 ID（三处答案同源）',
    cardRows.get('生物群系') === '沙漠',
    String(cardRows.get('生物群系')),
  )

  // ---- ⑭ 三节可折叠：默认只展开"跟当前工具相关"的那一节（用户实测："侧边栏 UI 一大坨"）
  //
  // 纪律与场景 48/50 相同：面板整块重建 ⇒ 控件元素一律**现取**，改完状态要 `flushFrames()`。
  const sectionOf = (cls) => inPanel(panel, cls)[0]
  const toolSectionEl = () => sectionOf('fc-panel-tools')
  const brushSectionEl = () => sectionOf('fc-panel-brush')
  const selectionSectionEl = () => sectionOf('fc-panel-selection-mode')
  const tagNames = () => [toolSectionEl(), brushSectionEl(), selectionSectionEl()].map((el) => el?.tagName).join('/')
  check(
    '三节（工具 / 笔刷 / 选择方式）都是可折叠的 <details>，不再是永远铺开的 div',
    [toolSectionEl(), brushSectionEl(), selectionSectionEl()].every((el) => el?.tagName === 'DETAILS'),
    tagNames(),
  )
  editor.setMode('paint')
  editor.setTool('brush')
  flushFrames()
  check(
    '绘制 + 笔刷：工具与笔刷两节都展开（这会儿真的要用的就在眼前）',
    toolSectionEl()?.open === true && brushSectionEl()?.open === true,
    `工具=${toolSectionEl()?.open} 笔刷=${brushSectionEl()?.open}`,
  )
  check(
    '绘制 + 笔刷：选择方式收起（它的按钮这会儿全是灰的）',
    selectionSectionEl()?.open === false,
    String(selectionSectionEl()?.open),
  )
  editor.setTool('marker')
  flushFrames()
  check(
    '换成标记工具：笔刷节自己收起（那一节最长，用不上时不该占着一屏）',
    brushSectionEl()?.open === false && toolSectionEl()?.open === true,
    `工具=${toolSectionEl()?.open} 笔刷=${brushSectionEl()?.open}`,
  )
  // 手动开合要盖过默认：手动展开之后，再切工具也不该把它收回去
  brushSectionEl().open = true
  brushSectionEl().dispatchEvent({ type: 'toggle' })
  editor.setTool('brush')
  flushFrames()
  check('手动展开过就听用户的（切工具不会再把它收起来）', brushSectionEl()?.open === true, String(brushSectionEl()?.open))
  brushSectionEl().open = false
  brushSectionEl().dispatchEvent({ type: 'toggle' })
  editor.setTool('marker')
  flushFrames()
  editor.setTool('brush')
  flushFrames()
  check(
    '手动收起过也听用户的（切回笔刷工具不会自己弹开）',
    brushSectionEl()?.open === false,
    String(brushSectionEl()?.open),
  )
  // 选择模式：反过来（这节本来只在"选择"这一档有意义）
  editor.setMode('select')
  flushFrames()
  check(
    '切到选择模式：选择方式节展开、笔刷节收起',
    selectionSectionEl()?.open === true && brushSectionEl()?.open === false,
    `选择方式=${selectionSectionEl()?.open} 笔刷=${brushSectionEl()?.open}`,
  )
  editor.setMode('paint')
  flushFrames()

  // ---- ⑮ 整块重建不许把滚动位置弹回顶部（用户实测："每次按工具按钮就要跳到最上面"）----
  const scrollHost = panel.contentEl
  scrollHost.scrollHeight = 2000
  scrollHost.clientHeight = 600
  // 反例控制：桩里的 `empty()` 如实模拟"内容被清空 ⇒ 浏览器把 scrollTop 钳回 0"
  // （不模拟的话，下面那两条断言就是空转的：什么都不做 scrollTop 也不会变）
  scrollHost.scrollTop = 420
  scrollHost.empty()
  check(
    '前提：桩里清空内容确实会把 scrollTop 钳回 0（否则下面两条是空转的）',
    scrollHost.scrollTop === 0,
    `scrollTop=${scrollHost.scrollTop}`,
  )
  scrollHost.scrollTop = 420
  editor.setTool('marker') // 改一次编辑器状态 = 面板整块重建
  flushFrames()
  check(
    '改状态重建之后侧栏没跳回顶部（滚到哪儿就还在哪儿）',
    scrollHost.scrollTop === 420,
    `scrollTop=${scrollHost.scrollTop}`,
  )
  scrollHost.scrollTop = 700
  press(inPanel(panel, 'fc-panel-tool').find((el) => el.dataset.fcTool === 'brush'))
  flushFrames()
  check(
    '点侧栏里真实的工具按钮同样不跳顶（不是只给 setTool 那条路径打补丁）',
    scrollHost.scrollTop === 700,
    `scrollTop=${scrollHost.scrollTop}`,
  )
  editor.setTool('brush')
  flushFrames()

  console.log('  （场景 49 结束）')
  plugin.onunload()
}

console.log('\n场景 50：侧栏「视图」与面板定稿顺序（§F.1 + UI 整理 W1④）—— 每个开关只出现一次 + 每层的「画法」跟着层走')
{
  // 这一场的重点不是"有没有画出来"，而是**同一件事只有一个入口**、且**位置符合用户口径**：
  // 分组来自图层登记表的一列、图例开关只挂在地物组里、数值图层参数与设置页是同一份渲染，
  // 而「视图」一节把底图 / 地物两小组折进去、每一层的「画法」长在它自己那一行里。
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await tick(80)

  const wrapper = canvas.wrapperEl
  const document_ = layers.getDocument(canvasPath)
  // 一格生物群系：数值图层那一组只列"地图上真的出现过"的分类
  document_.terrain[cellKey(0, 0)] = { t: 'forest', biome: 'desert' }
  // 另两格给"多格摘要"用（其中 1_0 **一个数据字段都没有**，看摘要有没有如实报出来）
  document_.terrain[cellKey(1, 0)] = { t: 'water' }
  document_.terrain[cellKey(2, 0)] = { t: 'water', temp: 12 }

  // 面板这一节创建的 Setting 要能与设置页逐名对比，所以先把账本清空
  FakeSetting.created.length = 0
  plugin.ribbonIcons[0].callback()
  await tick(40)
  flushFrames()
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
  const groupOf = (name) => collectByClass(panel.contentEl, 'fc-panel-layers').find((el) => el.dataset?.fcDisplayGroup === name)
  const keysIn = (group) => collectByClass(group, 'fc-layer-toggle').map((el) => el.dataset.layer)
  const legendToggle = () => collectByClass(panel.contentEl, 'fc-legend-toggle')[0]
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]

  // ---- ① 「视图」一节：保留底图 / 地物二分类（分组来自 LAYER_TABLE 的 displayGroup 一列）----
  const viewGroup = () => collectByClass(panel.contentEl, 'fc-panel-view')[0]
  check(
    '图层开关折进一个「视图」折叠组（§2.4 第 4 项：视图类按钮按现有二分类折进「视图」）',
    viewGroup()?.tagName === 'DETAILS',
    String(viewGroup()?.tagName),
  )
  check(
    '它默认展开（图层开关是高频使用的功能，进来先看见"现在显示着什么"）',
    viewGroup()?.open === true,
    String(viewGroup()?.open),
  )
  check(
    '「视图」里还是底图 / 地物两个小组（二分类保留，不是被合并掉）',
    collectByClass(viewGroup(), 'fc-panel-layers').map((el) => el.dataset?.fcDisplayGroup).join(',') === 'base,feature',
    collectByClass(viewGroup(), 'fc-panel-layers').map((el) => el.dataset?.fcDisplayGroup).join(','),
  )
  check(
    '「底图」组里是地形 / 温度 / 深度 / 生物群系 / 网格',
    keysIn(groupOf('base')).join(',') === 'terrain,temperature,depth,biome,grid',
    keysIn(groupOf('base')).join(','),
  )
  check(
    '「地物」组里是区域 / 路径 / 标记 / 名称',
    keysIn(groupOf('feature')).join(',') === 'regions,paths,markers,labels',
    keysIn(groupOf('feature')).join(','),
  )
  const allKeys = collectByClass(panel.contentEl, 'fc-layer-toggle').map((el) => el.dataset.layer)
  check(
    '九个图层开关一个不多一个不少，而且**每个 key 只出现一次**（同一件事不挂两处）',
    allKeys.length === 9 && new Set(allKeys).size === 9,
    allKeys.join(','),
  )

  // ---- ② 「显示图例」跟着地物组，且它不是图层开关 ----
  check(
    '「显示图例」在「地物」组里',
    collectByClass(groupOf('feature'), 'fc-legend-toggle').length === 1,
    String(collectByClass(groupOf('feature'), 'fc-legend-toggle').length),
  )
  check(
    '它**不算**图层开关（那条"九个"的断言按 class 数数，混进来就再也发现不了"加了第十层"）',
    legendToggle()?.classList.contains('fc-layer-toggle') === false,
  )
  check('图例出厂关着（它属于"要看的时候才看"）', legendToggle()?.classList.contains('is-active') === false)

  fireEvent(legendToggle(), 'click')
  await tick(30)
  flushFrames()
  check(
    '点它 → 设置真的开了，画布右下角的图例也真的露出来了',
    plugin.getSettings().showLegend === true && legendEl()?.style.display !== 'none',
    `${String(plugin.getSettings().showLegend)} / ${String(legendEl()?.style.display)}`,
  )
  check('按钮自己也跟着亮', legendToggle()?.classList.contains('is-active') === true)
  fireEvent(legendToggle(), 'click')
  await tick(30)
  flushFrames()
  check('再点一次就关回去（同一个入口开、也由它关）', plugin.getSettings().showLegend === false)

  // ---- ③ 数值图层的「画法」**跟着它那一层走**（用户本轮口径：折进「视图」里跟着层走）----
  const rowOf = (key) => collectByClass(panel.contentEl, 'fc-layer-row').find((el) => el.dataset?.fcLayerRow === key)
  const drawToggle = (key) => collectByClass(rowOf(key), 'fc-layer-draw-toggle')[0]
  const drawBody = (key) => collectByClass(rowOf(key), 'fc-layer-draw-body')[0]
  const dataFields = ['temperature', 'depth', 'biome']
  const plainLayers = ['terrain', 'grid', 'regions', 'paths', 'markers', 'labels']
  check(
    '「画法」只长在数值图层那三行上（其余六层没有可调的东西，不摆一个点了没反应的）',
    dataFields.every((key) => drawToggle(key) !== undefined) && plainLayers.every((key) => drawToggle(key) === undefined),
    `${dataFields.filter((key) => drawToggle(key) !== undefined).join(',')} / ${plainLayers.filter((key) => drawToggle(key) !== undefined).join(',')}`,
  )
  check(
    '默认收起：一个画法控件都没有（面板首屏不被配色锚点占满）',
    collectByClass(panel.contentEl, 'fc-layer-draw-body').length === 0,
    String(collectByClass(panel.contentEl, 'fc-layer-draw-body').length),
  )

  // 展开温度那一行：控件必须长在**它自己那一行**里，而不是面板末尾另起一组
  // （面板这一层创建的 Setting 要能与设置页逐名对比，所以边展开边把账本攒起来）
  const panelSettingNames = []
  FakeSetting.created.length = 0
  fireEvent(drawToggle('temperature'), 'click')
  await tick(30)
  flushFrames()
  check(
    '展开「画法」后，控件长在温度自己那一行里（不是"开关在上面、画法在下面另一组"）',
    drawBody('temperature')?.dataset?.fcOverlayField === 'temperature' &&
      drawBody('temperature')?.dataset?.fcDrawBody === 'temperature',
    String(drawBody('temperature')?.dataset?.fcOverlayField),
  )
  check(
    '展开的那一行独占整行（半个格子放不下那条轴 + 取色器）',
    rowOf('temperature')?.dataset?.fcDrawOpen === '1',
    String(rowOf('temperature')?.dataset?.fcDrawOpen),
  )
  check('别的层没跟着展开（展开是逐层的，不是一整节）', drawBody('depth') === undefined && drawBody('biome') === undefined)
  panelSettingNames.push(...FakeSetting.created.map((setting) => setting.info.name ?? ''))
  check(
    '侧栏「画法」只留配色的轴：出厂数值类（不透明度 / 显示方式）不在这里再摆一份（m01430 第二项）',
    collectByClass(drawBody('temperature'), 'fc-ramp').some((el) => el.dataset?.fcRampAxis === 'temperature') &&
      [OVERLAY_CONTROL_LABELS.opacity('温度'), OVERLAY_CONTROL_LABELS.mode('温度')].every((name) => panelSettingNames.includes(name) === false) &&
      (collectByClass(drawBody('temperature'), 'fc-settings-note')[0]?.textContent ?? '').includes('在设置页'),
    JSON.stringify(panelSettingNames.slice(0, 6)),
  )
  check(
    '展开状态跨整块重建保留（改一个值之后不用重新点开一次）',
    (() => {
      panel.render(true)
      return drawBody('temperature') !== undefined && rowOf('temperature')?.dataset?.fcDrawOpen === '1'
    })(),
  )

  // 分类字段那一支：逐条颜色，没有配色锚点
  FakeSetting.created.length = 0
  fireEvent(drawToggle('biome'), 'click')
  await tick(30)
  flushFrames()
  const biomeNames = FakeSetting.created.map((setting) => setting.info.name ?? '')
  panelSettingNames.push(...biomeNames)
  check(
    '分类字段那一节是**逐条颜色**、没有配色锚点（分类值之间没有高低）',
    FakeSetting.created.some((setting) => setting.text?.inputEl?.dataset?.fcBiomeColor === 'desert') &&
      biomeNames.some((name) => name.includes('生物群系的逐条颜色')) &&
      collectByClass(drawBody('biome'), 'fc-ramp').length === 0,
    JSON.stringify(biomeNames.filter((name) => name.includes('生物群系')).slice(0, 4)),
  )

  // ---- ④ 面板这一份是**能改的**（不是只读的摆设）：改一个锚点值 → 设置真的变 ----
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const settingsNames = FakeSetting.created.map((setting) => setting.info.name ?? '')
  check(
    '同一份渲染：配色的轴两侧共用；出厂数值类只在设置页（面板里没有、设置页里有）',
    ['生物群系的逐条颜色'].every(
      (name) => panelSettingNames.includes(name) && settingsNames.includes(name),
    ) &&
      collectByClass(panel.contentEl, 'fc-ramp').some((el) => el.dataset?.fcRampAxis === 'temperature') &&
      collectByClass(plugin.settingTabs[0].containerEl, 'fc-ramp').some((el) => el.dataset?.fcRampAxis === 'temperature') &&
      panelSettingNames.includes(OVERLAY_CONTROL_LABELS.opacity('温度')) === false &&
      settingsNames.includes(OVERLAY_CONTROL_LABELS.opacity('温度')),
    JSON.stringify(settingsNames.filter((name) => name.includes('不透明度')).slice(0, 2)),
  )

  panel.render(true)
  const panelAxis = () => collectByClass(panel.contentEl, 'fc-ramp').find((el) => el.dataset?.fcRampAxis === 'temperature')
  const panelHandle = (index) => collectByClass(panelAxis(), 'fc-ramp-handle')[index]
  const before = plugin.getSettings().overlays.temperature.ramp.stops[0].value
  fireEvent(panelHandle(0), 'click')
  await tick(20)
  flushFrames()
  const panelValueInput = collectByClass(panelAxis(), 'fc-ramp-input')[0]
  panelValueInput.value = String(before - 5)
  fireEvent(panelValueInput, 'change')
  await tick(20)
  flushFrames()
  check(
    '在侧栏的轴上改锚点 → 插件设置真的跟着变（面板不是只读镜像）',
    plugin.getSettings().overlays.temperature.ramp.stops[0].value === before - 5,
    `${before} → ${String(plugin.getSettings().overlays.temperature.ramp.stops[0].value)}`,
  )

  // ---- ⑤ 数据显示面板：常驻、置顶、内容区留好整块（§2.4 第 1 项）----
  const selectionPanel = () => collectByClass(panel.contentEl, 'fc-panel-selection')[0]
  check(
    '数据显示面板常驻：现在没有选中任何东西，它仍然在，并写清"怎么办"',
    selectionPanel() !== undefined &&
      collectByClass(selectionPanel(), 'fc-panel-group-title')[0]?.textContent === PANEL_SECTION_TITLES.data &&
      collectByClass(selectionPanel(), 'fc-selection-hint').length === 1,
    String(collectByClass(selectionPanel(), 'fc-panel-group-title')[0]?.textContent),
  )
  check(
    '内容区有独立的容器（`fc-selection-body`，CSS 给它固定最小高度 ⇒ 选中/不选中不上下缩动）',
    collectByClass(selectionPanel(), 'fc-selection-body').length === 1,
  )

  // ---- ⑥ 从上到下的定稿顺序（§2.4）：数据显示 → 工具 / 笔刷 / 选择方式 / 编辑 → 视图 → 动作组 ----
  const topLevelOrder = () => {
    const out = []
    for (const child of panel.contentEl.children ?? []) {
      const cls = child.className ?? ''
      // ⚠️ 先判 `fc-panel-selection-mode`：`fc-panel-selection` 是它的子串，
      // 顺序反过来会把"选择方式"那一节误认成"数据显示"（这条断言自己踩过一次）
      if (cls.includes('fc-panel-selection-mode')) out.push(PANEL_SECTION_TITLES.selectionMode)
      else if (cls.includes('fc-panel-selection')) out.push(PANEL_SECTION_TITLES.data)
      else if (cls.includes('fc-panel-tools')) out.push(PANEL_SECTION_TITLES.tools)
      else if (cls.includes('fc-panel-brush')) out.push(PANEL_SECTION_TITLES.brush)
      else if (cls.includes('fc-panel-view')) out.push(PANEL_SECTION_TITLES.view)
      else if (cls.includes('fc-panel-group')) {
        const title = collectByClass(child, 'fc-panel-group-title')[0]?.textContent ?? ''
        if (title.length > 0) out.push(title)
      }
    }
    return out
  }
  check(
    '面板从上到下就是定稿顺序：数据显示 → 工具 → 笔刷 → 选择方式 → 编辑 → 视图 → 地图层 → 地图定义 → 文件与导出',
    topLevelOrder().join('>') === [PANEL_SECTION_TITLES.data, PANEL_SECTION_TITLES.tools, PANEL_SECTION_TITLES.brush, PANEL_SECTION_TITLES.selectionMode, PANEL_SECTION_TITLES.edit, PANEL_SECTION_TITLES.view, PANEL_SECTION_TITLES.mapLayers, PANEL_SECTION_TITLES.definitions, PANEL_SECTION_TITLES.fileExport].join('>'),
    topLevelOrder().join('>'),
  )

  // ---- ⑦ 筛选归「编辑」组，不再挂在地图层下面（用户 m01803 第 3 条）----
  const groupTitled = (title) =>
    collectByClass(panel.contentEl, 'fc-panel-group').find(
      (el) => collectByClass(el, 'fc-panel-group-title')[0]?.textContent === title,
    )
  const buttonInGroup = (title, fragment) =>
    collectByClass(groupTitled(title), 'fc-panel-button').find((button) =>
      (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes(fragment),
    )
  check(
    '「按规则筛选选择…」归「编辑」组（用户："筛选错误的放进了地图层里面，这个应该是编辑工具"）',
    buttonInGroup(PANEL_SECTION_TITLES.edit, '按规则筛选选择') !== undefined && buttonInGroup(PANEL_SECTION_TITLES.mapLayers, '按规则筛选选择') === undefined,
    `编辑组=${buttonInGroup(PANEL_SECTION_TITLES.edit, '按规则筛选选择') !== undefined} 地图层组=${buttonInGroup(PANEL_SECTION_TITLES.mapLayers, '按规则筛选选择') !== undefined}`,
  )
  check(
    '「地图层」组只剩地图级的东西（启用/停用地图层、海拔标定、数值图层默认值）',
    collectByClass(groupTitled(PANEL_SECTION_TITLES.mapLayers), 'fc-panel-button-label')
      .map((el) => el.textContent ?? '')
      .join('|')
      .includes(COMMAND_NAMES.toggleLayer),
    collectByClass(groupTitled(PANEL_SECTION_TITLES.mapLayers), 'fc-panel-button-label').map((el) => el.textContent ?? '').join('|'),
  )

  // ---- ⑧ 单选一格：先给读数、再给编辑（§2.6 形态 3）----
  const editor = layers.getInspectorEditor()
  editor.setCellSelection([cellKey(0, 0)])
  // 卡片那边同时悬停在同一格上：它现在只显示**悬停读数**（已确定的选择归侧栏），
  // 下面那条"同源"断言就是拿侧栏的读数与卡片的悬停读数逐字比
  const cardHost = app.workspace.getLeavesOfType('canvas')[0].view.containerEl
  const hoverClient = canvas._clientFor({ x: 0, y: 0 })
  firePointer(cardHost, 'pointermove', { clientX: hoverClient.x, clientY: hoverClient.y, target: wrapper, pointerId: 991 })
  flushFrames()
  const readingRows = () =>
    collectByClass(selectionPanel(), 'fc-selection-reading').map((row) => ({
      label: collectByClass(row, 'fc-selection-reading-label')[0]?.textContent ?? '',
      value: collectByClass(row, 'fc-selection-reading-value')[0]?.textContent ?? '',
    }))
  check(
    '选中一格时，「数据显示」给出温度 / 深度 / 生物群系三行读数（不用展开任何折叠组就能看见值）',
    // 只钉"有哪三行"与首尾两个标签；深度那一行的标签把两个单位名都写进去了，
    // 写死它会变成"改文案就红"（下面那条同源断言按**实际标签**取，不写死）
    readingRows().length === 3 &&
      readingRows()[0]?.label === '温度' &&
      readingRows()[2]?.label === '生物群系',
    readingRows().map((row) => row.label).join(','),
  )
  check(
    '没有值的字段写「未填」，**不猜 0**（0 ℃ / 海平面都是合法读数，猜出来的 0 与"没量过"是两回事）',
    readingRows().filter((row) => row.value === SELECTION_TEXT.unfilled).length === 2,
    JSON.stringify(readingRows()),
  )
  check(
    '读数里的生物群系是**显示名**而不是裸 ID（与信息卡、图例同一份解析）',
    readingRows().find((row) => row.label === '生物群系')?.value === '沙漠',
    String(readingRows().find((row) => row.label === '生物群系')?.value),
  )
  const cardValueOf = (label) =>
    collectByClass(collectByClass(wrapper, 'fc-selection-card')[0], 'fc-selection-card-row')
      .map((row) => ({
        label: collectByClass(row, 'fc-selection-card-label')[0]?.textContent ?? '',
        value: collectByClass(row, 'fc-selection-card-value')[0]?.textContent ?? '',
      }))
      .find((row) => row.label === label)?.value
  const depthLabel = readingRows()[1]?.label ?? ''
  check(
    '两处读数**同源**（都调 `describeCellReadings`）：深度那一行面板与画布信息卡一字不差',
    depthLabel.length > 0 &&
      readingRows()[1]?.value === cardValueOf(depthLabel),
    `标签=${depthLabel} 面板=${String(readingRows()[1]?.value)} 卡片=${String(cardValueOf(depthLabel))}`,
  )

  // ---- ⑨ 「清空选择」在侧栏（§2.6：侧栏是"选择"的唯一家）----
  const clearButton = () => collectByClass(selectionPanel(), 'fc-selection-clear')[0]
  check('「数据显示」标题旁边有「清空选择」', clearButton() !== undefined)
  check('有选择时它是可点的', clearButton()?.disabled === false, String(clearButton()?.disabled))
  check(
    '面板里只有**一个**「清空选择」（整批编辑那一块不再重复挂一个 —— 同一件事只出现一次）',
    collectByClass(panel.contentEl, 'fc-selection-clear').length === 1,
    String(collectByClass(panel.contentEl, 'fc-selection-clear').length),
  )
  fireEvent(clearButton(), 'click')
  flushFrames()
  check(
    '点它 → 对象与格一起清空（与 Esc 的第一步同一件事）',
    editor.getCellSelection().length === 0 && editor.getSelection() === null,
    `格=${editor.getCellSelection().length} 对象=${String(editor.getSelection())}`,
  )
  check('清空后按钮**灰掉**而不是消失（没选择时它点了也不会有任何变化）', clearButton()?.disabled === true, String(clearButton()?.disabled))
  check('读数行也跟着消失（已经不是"恰好一格"这一形态了）', collectByClass(selectionPanel(), 'fc-selection-reading').length === 0)

  // ---- ⑩ 多格：整批编辑头部有一行摘要，不是"裸着"（用户 m01930 追加口径 · §2.6）----
  editor.setCellSelection([cellKey(0, 0), cellKey(1, 0), cellKey(2, 0)])
  flushFrames()
  const batchSummary = () => collectByClass(selectionPanel(), 'fc-batch-summary')[0]?.textContent ?? ''
  check('多格时「整批编辑」头部有一行摘要（不是"进去就是一片输入框"）', batchSummary().length > 0, batchSummary())
  check(
    '摘要写地形构成、按格数降序、用**显示名**：水域 2 · 森林 1',
    batchSummary().startsWith('水域 2 · 森林 1'),
    batchSummary(),
  )
  check(
    '摘要点出"有几格一个数据字段都没有"（三格里只有 1_0 全空）',
    batchSummary().includes('1 格没有数据'),
    batchSummary(),
  )
  check('多格时不再显示单格那三行读数（形态之间不混着来）', collectByClass(selectionPanel(), 'fc-selection-reading').length === 0)

  console.log('  （场景 50 结束）')
  plugin.onunload()
}

console.log('\n场景 51：定义随图（W4-1b）—— 图里那一份说了算，本机设置里没有它也能画出来')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'

  /**
   * 造一张"别人给的图"：**文件里自带一套定义**，而库级设置里没有它。
   *
   * 这正是方案 B 要解决的那件事（用户 m01845：「分享一张图对方就能拿到完整定义」）——
   * 所以断言必须落在"本机没有这条定义，但打开这张图仍然画得对"上。
   */
  const gift = await store.createMap({ name: 'Gift', folder: 'Maps', canvasPath })
  const giftLoaded = await store.load(gift)
  const giftDoc = giftLoaded.document
  giftDoc.definitions = {
    terrains: [{ id: 'custom:alien', label: '外星地形', color: '#ff00ff' }],
    markers: [],
    biomes: [],
    pathTypes: [],
    regionTypes: [],
  }
  giftDoc.terrain['0_0'] = { t: 'custom:alien' }
  await store.writeNow(
    gift,
    giftDoc,
    giftLoaded.frontmatter.name ?? 'Gift',
    giftLoaded.frontmatter.canvases,
    giftLoaded.frontmatter.rest,
  )
  await settleEvents()

  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 90))

  check(
    '前提：库级设置里**没有**这条自定义地形（否则下面证不出"看的是图里那一份"）',
    !plugin.getSettings().customTerrains.some((terrain) => terrain.id === 'custom:alien'),
    JSON.stringify(plugin.getSettings().customTerrains.map((terrain) => terrain.id)),
  )
  check(
    '定义解析按**文档**走：同一份文档算出来的定义集里有它（不是本机设置那一份）',
    plugin.definitionsOf(layers.getDocument(canvasPath)).terrains.some((terrain) => terrain.id === 'custom:alien'),
    JSON.stringify(plugin.definitionsOf(layers.getDocument(canvasPath)).terrains.map((terrain) => terrain.id)),
  )
  const legend = layers.buildLegendFor(canvasPath)
  check(
    '图例用的是文件里那一份定义（名字来自地图文件，不是本机设置）',
    legend.some((entry) => entry.label === '外星地形'),
    JSON.stringify(legend.slice(0, 6).map((entry) => entry.label)),
  )

  // ---- 写：改动落在**这张图的文件**里，同时同步"新建地图的模板" ----
  // 按 **ID** 改（不是下标）：弹窗渲染的那份与"点下去那一刻的活动地图"未必同一份，
  // 按 ID 最坏只是"这条不在这一份里 → 什么也不做"，不会改错条目
  await plugin.updateCustomTerrain('custom:alien', { color: '#00ff00' })
  // 有地图层时走编辑器的 `setDefinitions`（可撤销），落盘是防抖的 —— 断文件之前先把它冲出来
  await store.flush()
  const giftText = String(app.vault.files.get(gift.path))
  check(
    '改定义写进了**这张图的文件**（v2 的 definitions 段里能看到新颜色）',
    giftText.includes('"definitions"') && giftText.includes('#00ff00'),
    giftText.slice(giftText.indexOf('"definitions"'), giftText.indexOf('"definitions"') + 200),
  )
  check(
    '同一份改动也同步进了库级模板（它是"新建地图的模板"，不跟上就会出现"新图还是旧定义"）',
    plugin.getSettings().customTerrains.find((terrain) => terrain.id === 'custom:alien')?.color === '#00ff00',
    JSON.stringify(plugin.getSettings().customTerrains),
  )
  check(
    '新颜色立刻在这张图上生效（图例跟着换，不需要重开画布）',
    layers.buildLegendFor(canvasPath).some((entry) => entry.label === '外星地形' && entry.color === '#00ff00'),
    JSON.stringify(layers.buildLegendFor(canvasPath).slice(0, 6)),
  )

  // ---- 另一张图有自己的 definitions ⇒ 库级模板那条**不会**渗过去 ----
  const other = await store.createMap({ name: 'Other', folder: 'Maps' })
  const otherLoaded = await store.load(other)
  otherLoaded.document.definitions = { terrains: [], markers: [], biomes: [], pathTypes: [], regionTypes: [] }
  await store.writeNow(
    other,
    otherLoaded.document,
    otherLoaded.frontmatter.name ?? 'Other',
    otherLoaded.frontmatter.canvases,
    otherLoaded.frontmatter.rest,
  )
  check(
    '库级模板里有 custom:alien，但另一张图写明了"没有自定义地形" ⇒ 读出来就是空的（不渗过去）',
    plugin.definitionsOf(otherLoaded.document).terrains.length === 0,
    JSON.stringify(plugin.definitionsOf(otherLoaded.document).terrains),
  )

  // ---- 按 ID 定位的安全边界（弹窗开着时活动地图可能已经换过）----
  const beforeAlien = JSON.stringify(plugin.getSettings().customTerrains)
  await plugin.updateCustomTerrain('custom:does-not-exist', { color: '#000000' })
  await plugin.removeCustomTerrain('custom:does-not-exist')
  check(
    '给不存在的 ID 发补丁 / 删除 ⇒ 一个字节都不改（按 ID 定位最坏只是"没这条"，绝不会改错条目）',
    JSON.stringify(plugin.getSettings().customTerrains) === beforeAlien,
    JSON.stringify(plugin.getSettings().customTerrains),
  )

  plugin.onunload()
}

console.log('\n场景 52：视图偏好按地图分份（W4-2）—— 每张图一份，缺则回落「新建地图的模板」')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  /**
   * 预置一份 data.json：模板里网格开着、温度不透明度 0.9；而**另一张图**（`Maps/Other.map.md`）
   * 单独关过网格、把温度不透明度调成 0.2。
   *
   * 这正是 W4-2 要区分的那件事：库级那三份是"新建地图的初值"，某张图单独调过之后是**它自己那一份**。
   */
  const PluginClass = loadBundleAsCjs()
  const plugin = new PluginClass(app, { id: 'project-kaki' })
  plugin._data = JSON.stringify({
    layers: { grid: true },
    overlays: { temperature: { opacity: 0.9 } },
    mapViews: {
      'Maps/Other.map.md': { layers: { grid: false }, overlays: { temperature: { opacity: 0.2 } } },
    },
  })
  await plugin.onload()
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const world = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  // 往这张图里放一格地形（下面要验"关掉地形层 ⇒ 图例里就没有它"）
  const loaded = await store.load(world)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  await store.writeNow(
    world,
    loaded.document,
    loaded.frontmatter.name ?? 'World',
    loaded.frontmatter.canvases,
    loaded.frontmatter.rest,
  )
  await settleEvents()
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 90))

  check(
    '模板与「另一张图自己那一份」解析出不同结果（这才是按地图分份，不是一个全局值）',
    plugin.layersFor('Maps/Other.map.md').grid === false &&
      plugin.layersFor('Maps/World.map.md').grid === true &&
      plugin.overlaysFor('Maps/Other.map.md').temperature.opacity === 0.2 &&
      plugin.overlaysFor('Maps/World.map.md').temperature.opacity === 0.9,
    JSON.stringify({
      otherGrid: plugin.layersFor('Maps/Other.map.md').grid,
      worldGrid: plugin.layersFor('Maps/World.map.md').grid,
      otherOpacity: plugin.overlaysFor('Maps/Other.map.md').temperature.opacity,
      worldOpacity: plugin.overlaysFor('Maps/World.map.md').temperature.opacity,
    }),
  )
  check(
    '迁移没往表里多塞条目（只有 data.json 里本来就写着的那一张图）',
    Object.keys(plugin.getSettings().mapViews).join(',') === 'Maps/Other.map.md',
    JSON.stringify(Object.keys(plugin.getSettings().mapViews)),
  )

  // ---- 画布那一侧真的按"这张图"解析：关掉地形层 ⇒ 图例里不再有它 ----
  const beforeLegend = layers.buildLegendFor(canvasPath).length
  await plugin.setLayerVisible('terrain', false)
  const afterLegend = layers.buildLegendFor(canvasPath).length
  check(
    '画布 / 图例那一侧按这张图解析（关掉地形层之后，图例里地形那一行没了）',
    beforeLegend > 0 && afterLegend < beforeLegend,
    `before=${beforeLegend} after=${afterLegend}`,
  )

  // ---- 写：进这张图那一份 + 镜像模板 + 不动别的图 ----
  const settings = plugin.getSettings()
  check(
    '写进的是**这张图**那一份（`mapViews[当前地图路径]`）',
    settings.mapViews['Maps/World.map.md']?.layers?.terrain === false,
    JSON.stringify(settings.mapViews),
  )
  check(
    '模板同步跟上（它是"新建地图的初值"，不跟上就会"新图打回出厂"）',
    settings.layers.terrain === false,
    JSON.stringify(settings.layers),
  )
  check(
    '另一张图那一份没被动过（它自己那条里地形仍是默认开）',
    settings.mapViews['Maps/Other.map.md']?.layers?.terrain === true &&
      settings.mapViews['Maps/Other.map.md']?.layers?.grid === false,
    JSON.stringify(settings.mapViews['Maps/Other.map.md']),
  )

  // ---- 边界：视图偏好**不进地图文件**（它是"怎么画"，不是"世界里有什么"）----
  await store.flush()
  check(
    '视图偏好没有写进地图文件（分享一张图不该把对方的看法一起改掉）',
    !String(app.vault.files.get(world.path)).includes('mapViews'),
    String(app.vault.files.get(world.path)).slice(0, 80),
  )

  plugin.onunload()
}

// ---------------------------------------------- 场景 53：离开 Canvas 之后面板不再工作（ISSUE-007）

/**
 * 用户报的"致命问题"：「侧边栏离开原本的 canvas 文件过后还可以接着在其他的文件里面用，
 * 而且状态是保存的。」
 *
 * 根因是两处"退路"都只问"哪张画布开着"、从不问"用户在看什么"：
 * ① `activeCanvasHandle()` 的 `?? handles[0]`（活动叶子变成笔记时，退回后台那张画布）；
 * ② `getInspectorEditor()` 自带的三级回落（面板的"当前编辑器"正是取它）。
 * 修法给两处都加了一道"用户在别的文档上"的闸，并让空态文案分家。
 *
 * 这条场景的造景就是缺陷的现场：**画布仍开在后台标签页里**，只是活动叶子换成了一篇笔记。
 * 破坏性验证：去掉 `CanvasAdapter.ts` 里那道闸（或 `getInspectorEditor` 开头那两行），
 * 下面"检查器为 null / 三节空态 / 开关置灰"的断言必须变红。
 */
console.log('\n场景 53：离开 Canvas 之后面板不再是"上一张图的操作台"（ISSUE-007）')
{
  const app = makeApp(makeCanvas())
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const world = await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  const loaded = await store.load(world)
  loaded.document.terrain['0_0'] = { t: 'forest' }
  await store.writeNow(world, loaded.document, loaded.frontmatter.name ?? 'World', loaded.frontmatter.canvases, loaded.frontmatter.rest)
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 90))
  const panel = await openMapPanel(app, plugin)
  flushFrames()

  // ---- 前提：画布在前台时面板是"能用的"（否则下面"变空"证不出是被切走导致的）----
  check(
    '前提：画布在前台时面板可用（笔刷一节列出了 9 种地形）',
    inPanel(panel, 'fc-panel-terrain').length === 9,
    String(inPanel(panel, 'fc-panel-terrain').length),
  )
  check('前提：画布在前台时检查器拿得到当前编辑器', layers.getInspectorEditor() !== null)
  const togglesWhenActive = inPanel(panel, 'fc-layer-toggle')
  check(
    '前提：画布在前台时图层开关可点（9 个，且都不是灰的）',
    togglesWhenActive.length === 9 && togglesWhenActive.every((button) => button.disabled !== true),
    `${togglesWhenActive.length}/${togglesWhenActive.filter((button) => button.disabled === true).length} 灰`,
  )

  // ---- 用户切到一篇普通笔记：活动叶子换成 markdown，画布仍开在后台 ----
  const noteLeaf = { view: { file: new FakeTFile('Notes/a.md'), getViewType: () => 'markdown' } }
  app.workspace.getMostRecentLeaf = () => noteLeaf
  app.workspace.activeLeaf = noteLeaf
  plugin.refreshPanel()
  flushFrames()

  check('画布仍开着（不是"一张 canvas 都没有"那条降级路）', app.workspace.getLeavesOfType('canvas').length === 1)
  check('"当前编辑器"变成 null：所有写入口一起失效', layers.getInspectorEditor() === null)
  check('"当前地图文档"也变成 null（读数 / 标定弹窗的回显不会指向后台那张图）', layers.getActiveDocument() === null)
  check(
    '工具一项不再列上一张图的地形按钮',
    inPanel(panel, 'fc-panel-terrain').length === 0,
    String(inPanel(panel, 'fc-panel-terrain').length),
  )
  check(
    '选择方式一项不再有可点的按钮',
    inPanel(panel, 'fc-panel-selection-mode-button').length === 0,
    String(inPanel(panel, 'fc-panel-selection-mode-button').length),
  )
  const emptyHintOf = (cls) => collectByClass(inPanel(panel, cls)[0], 'fc-panel-hint')[0]?.textContent
  check(
    '三节都改成「当前没有打开的地图」',
    ['fc-panel-tools', 'fc-panel-brush', 'fc-panel-selection-mode'].every(
      (cls) => emptyHintOf(cls) === PANEL_EMPTY_HINTS.noActiveMap,
    ),
    ['fc-panel-tools', 'fc-panel-brush', 'fc-panel-selection-mode'].map((cls) => `${cls}=${emptyHintOf(cls)}`).join(' | '),
  )
  check(
    '「视图」一节也说同一句（它同样没有可操作的对象了）',
    emptyHintOf('fc-panel-view') === PANEL_EMPTY_HINTS.noActiveMap,
    String(emptyHintOf('fc-panel-view')),
  )
  check(
    '面板里一处都不再说"没有启用的地图层"（在这种情况下那是假话）',
    !collectByClass(panel.contentEl, 'fc-panel-hint').some((el) => el.textContent === PANEL_EMPTY_HINTS.noLayer),
    collectByClass(panel.contentEl, 'fc-panel-hint').map((el) => el.textContent).join(' | '),
  )
  const togglesWhenNote = inPanel(panel, 'fc-layer-toggle')
  check(
    '图层开关还在（不消失），但整排置灰 = 点不动',
    togglesWhenNote.length === 9 && togglesWhenNote.every((button) => button.disabled === true),
    `${togglesWhenNote.length}/${togglesWhenNote.filter((button) => button.disabled === true).length} 灰`,
  )
  check(
    '「显示图例」开关同样置灰',
    inPanel(panel, 'fc-legend-toggle').length > 0 && inPanel(panel, 'fc-legend-toggle').every((button) => button.disabled === true),
    String(inPanel(panel, 'fc-legend-toggle').map((button) => button.disabled).join(',')),
  )
  check(
    '「画法」展开项也置灰（数值图层的配色不该在没有地图时可改）',
    inPanel(panel, 'fc-layer-draw-toggle').every((button) => button.disabled === true),
    String(inPanel(panel, 'fc-layer-draw-toggle').map((button) => button.disabled).join(',')),
  )
  const summaryWhenNote = inPanel(panel, 'fc-panel-summary-body')[0]?.textContent ?? ''
  check('顶部状态行不再说"地图层已启用"', !summaryWhenNote.includes('地图层已启用'), summaryWhenNote)
  check(
    '依赖当前地图的动作按钮全部变灰（例如「导出地图…」）',
    inPanel(panel, 'fc-panel-button')
      .filter((button) => button.disabled === true)
      .some((button) => (button.textContent ?? '').includes('导出地图')),
    inPanel(panel, 'fc-panel-button').filter((button) => button.disabled === true).map((button) => button.textContent).join(' | '),
  )

  // ---- 切回 Canvas：面板立刻恢复（不需要重开面板）----
  const canvasLeaf = app.workspace.getLeavesOfType('canvas')[0]
  app.workspace.getMostRecentLeaf = () => canvasLeaf
  app.workspace.activeLeaf = canvasLeaf
  plugin.refreshPanel()
  flushFrames()
  check('切回 Canvas 后检查器立刻回来（没有重开面板）', layers.getInspectorEditor() !== null)
  check(
    '切回 Canvas 后笔刷一节又列出地形',
    inPanel(panel, 'fc-panel-terrain').length === 9,
    String(inPanel(panel, 'fc-panel-terrain').length),
  )
  check(
    '切回 Canvas 后图层开关恢复可点',
    inPanel(panel, 'fc-layer-toggle').every((button) => button.disabled !== true),
    String(inPanel(panel, 'fc-layer-toggle').map((button) => button.disabled).join(',')),
  )

  plugin.onunload()
}

// ---------------------------------------------- 场景 54：地形标签（BORROWED-IDEAS §0.2）

/**
 * 「所有水域」本该是**一个词**的事：9 种内置地形逐个勾很麻烦，而沼泽既是水域又是湿地 ——
 * 单值枚举字段根本表达不了。这一轮按群系那条现成的路（`BIOME_TAGS` + `biomeTag` 规则）做了
 * `TERRAIN_TAGS` + `terrainTag` 规则，并让**自定义地形也能打标签**（定义弹窗里一排 chip）。
 *
 * 破坏性验证（三处都能让下面的断言变红）：
 * ① 规则登记表里去掉 `TERRAIN_TAG_RULE` ⇒ 规则下拉里就没有「地形标签」；
 * ② `BUILTIN_TERRAIN_TAGS.swamp` 去掉 `aquatic` ⇒ "所有水域"少一格；
 * ③ `updateCustomTerrain` 不把 `tags` 带上 ⇒ 定义弹窗里点 chip 不生效。
 */
console.log('\n场景 54：地形标签 —— 「所有水域」一个词管到底（BORROWED-IDEAS §0.2）')
{
  const canvas = makeCanvas()
  const app = makeApp(canvas)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPath = 'Maps/World.canvas'
  const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath })
  runCommand(plugin, 'toggle-map-layer')
  await tick(90)
  const editor = layers.getEditor(canvasPath)
  const doc = () => layers.getDocument(canvasPath)
  const selected = () => [...editor.getCellSelection()].sort()
  const press = (element) => element.dispatchEvent({ type: 'click' })

  // 自定义地形也能打标签（本批口径）：暗礁 = 水域
  const added = await plugin.addCustomTerrain({ id: 'reef', label: '暗礁', color: '#2f6f8f', tags: ['aquatic'] })
  check('自定义地形可以带标签（标签是定义的一部分，不进格数据）', added.ok === true, JSON.stringify(added))

  // 四格：森林 / 水 / 沼泽 / 自定义暗礁 ——「所有水域」应当命中**后三格**
  doc().terrain['0_0'] = { t: 'forest' }
  doc().terrain['1_0'] = { t: 'water' }
  doc().terrain['2_0'] = { t: 'swamp' }
  doc().terrain['3_0'] = { t: 'custom:reef' }

  runCommand(plugin, 'filter-selection')
  const modal = fakeObsidian.Modal.lastAny
  const clausesEl = collectByClass(modal?.contentEl, 'fc-filter-clauses')[0]
  const addClauseButton = FakeSetting.created
    .flatMap((setting) => setting.buttons ?? [])
    .find((button) => button.buttonEl?.dataset?.fcFilter === 'add')
  await addClauseButton.click()
  // 控件**现取**：换规则 / 换运算符都会重建整行（与场景 48 / 50 同一条纪律）
  const rowSelects = () =>
    (collectByClass(clausesEl, 'fc-filter-row')[0]?.children ?? []).filter((child) => child.tagName === 'SELECT')
  const resultEl = () => collectByClass(modal?.contentEl, 'fc-filter-result')[0]
  const echo = () => collectByClass(modal?.contentEl, 'fc-filter-echo')[0]

  const ruleSelect = rowSelects()[0]
  check(
    '规则下拉里有「地形标签」（加一条规则 = 加一行）',
    ruleSelect.children.some((option) => option.value === 'terrainTag' && option.textContent === '地形标签'),
    JSON.stringify(ruleSelect.children.map((option) => `${option.value}:${option.textContent}`)),
  )
  ruleSelect.value = 'terrainTag'
  ruleSelect.dispatchEvent({ type: 'change' })

  check('运算符默认是「属于其中之一」（标签本来就是一组）', rowSelects()[1]?.value === 'in', String(rowSelects()[1]?.value))
  const valueSelect = rowSelects()[2]
  check(
    '值控件是**多选**，列出的正是地形标签那一批（与 `TERRAIN_TAGS` 同源）',
    valueSelect.multiple === true && valueSelect.children.length === TERRAIN_TAGS.length,
    `multiple=${String(valueSelect.multiple)} 选项=${valueSelect.children.length} 期望=${TERRAIN_TAGS.length}`,
  )
  check(
    '刚换成「地形标签」时一个标签都没预选，所以这一条**不算数**（不会悄悄筛出全部）',
    valueSelect.children.every((option) => option.selected !== true) && /还没有可用的条件/.test(resultEl()?.textContent ?? ''),
    String(resultEl()?.textContent),
  )

  // 勾「水域」（真实用户路径：在多选里点一下）
  valueSelect.children.find((option) => option.value === 'aquatic').selected = true
  valueSelect.dispatchEvent({ type: 'change' })

  check(
    '顶部结果：按「水域」会选中 3 格（水 / 沼泽 / 自定义暗礁）',
    resultEl()?.textContent === '按这些条件会选中 3 格',
    String(resultEl()?.textContent),
  )
  check(
    '人话回显把标签翻成显示名（不是 aquatic）',
    /特殊·水域 类的地形/.test(echo()?.textContent ?? '') && !(echo()?.textContent ?? '').includes('aquatic'),
    String(echo()?.textContent),
  )

  const actionButton = (key) =>
    collectByClass(modal?.contentEl, 'fc-filter-action').find((button) => button.dataset.fcFilter === key)
  // 先记一笔：这个场景里**改定义**（上面那条 addCustomTerrain）本身是进撤销栈的，
  // 所以要证明的是"筛选**没有再加**一条历史"，而不是"撤销栈为空"
  const undoBefore = editor.getStatus().undo
  press(actionButton('apply-replace'))
  check(
    '「替换选择」选中的正是那三格（森林没被收进来）',
    JSON.stringify(selected()) === JSON.stringify(['1_0', '2_0', '3_0']),
    JSON.stringify(selected()),
  )
  check('标签筛选同样不改地图数据、不进撤销栈', editor.getStatus().undo === undoBefore, `${undoBefore} → ${editor.getStatus().undo}`)

  // ---- 定义弹窗：一排 chip，点亮 = 属于这一组 ----
  openDefinitionManager(plugin)
  const tagSetting = FakeSetting.created
    .filter((setting) => setting.info.name === DEFINITION_ROW_LABELS.tags('暗礁'))
    .at(-1)
  check('自定义地形多了一行「标签 · 暗礁」', tagSetting !== undefined)
  const chips = () => collectByClass(tagSetting?.controlEl, 'fc-terrain-tag')
  check(
    '一排 chip = 地形标签那一批（与筛选器那张下拉同源）',
    chips().length === TERRAIN_TAGS.length,
    `${chips().length} / ${TERRAIN_TAGS.length}`,
  )
  check(
    '「水域」是点亮的（这条地形本来就带 aquatic）',
    chips().find((chip) => chip.dataset.fcTerrainTag === 'aquatic')?.classList.contains('is-active') === true,
    chips().map((chip) => `${chip.dataset.fcTerrainTag}:${chip.classList.contains('is-active') ? 'on' : 'off'}`).join(' '),
  )

  const reefTags = () =>
    plugin.activeDefinitions().terrains.find((terrain) => terrain.id === 'custom:reef')?.tags ?? []
  press(chips().find((chip) => chip.dataset.fcTerrainTag === 'forest'))
  await tick(40)
  check('点一下 chip 就写进定义（暗礁 = 水域 + 森林）', JSON.stringify(reefTags()) === JSON.stringify(['aquatic', 'forest']), JSON.stringify(reefTags()))
  await plugin.updateCustomTerrain('custom:reef', { color: '#123456' })
  check(
    '改颜色**不会**把标签弄丢（补丁不传 tags 就原样保留）',
    JSON.stringify(reefTags()) === JSON.stringify(['aquatic', 'forest']),
    JSON.stringify(reefTags()),
  )

  // ---- 标签的落点：进**定义段**（搬运工具要带走它），不进**格数据** ----
  check(
    '标签不住在格上（一格的字段仍然只有 t / 温度 / 深度这些）',
    Object.keys(doc().terrain['3_0']).join(',') === 't',
    JSON.stringify(doc().terrain['3_0']),
  )
  await store.flush()
  const mapText = String(app.vault.files.get('Maps/World.map.md'))
  check(
    '标签随定义写进地图文件（定义随图：分享一张图，对方拿到的筛选口径也是完整的）',
    mapText.includes('aquatic'),
    mapText.slice(0, 100),
  )

  plugin.onunload()
}

// ---------------------------------------------- 场景 55：多画布 —— 状态行只说"活动这张画布"的事

/**
 * FEATURE-AUDIT §1.1 **B2**：侧栏顶部状态行以前按"**库里有没有**启用的地图层"判断，
 * 于是同时开着两张画布、切到那张**没绑定地图**的上面时，它还在说"地图层已启用"——同一族的假话
 * （ISSUE-007 是"面板还能操作"，这一条是"状态行说谎"）。
 *
 * 这条场景同时补上一直缺的**多画布覆盖**：桩里让 `getLeavesOfType('canvas')` 返回**两张**画布叶子。
 * 破坏性验证：把 `describePanelSummary` 里的 `.find((item) => item.canvasPath === canvasPath)`
 * 改回 `.find((item) => item.attached)` ⇒ 下面第 2 条必须变红。
 */
console.log('\n场景 55：多画布 —— 顶部状态行只说"活动这张画布"的事（FEATURE-AUDIT §1.1 B2）')
{
  const canvasA = makeCanvas()
  const app = makeApp(canvasA)
  const plugin = await loadPlugin(app)
  const store = plugin.getStore()
  const layers = plugin.getLayerManager()
  const canvasPathA = 'Maps/World.canvas'
  const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  await store.createMap({ name: 'World', folder: 'Maps', canvasPath: canvasPathA })
  runCommand(plugin, 'toggle-map-layer')
  await tick(90)
  check('前提：A 这张画布启用了地图层', layers.isEnabled(canvasPathA) === true)

  // 第二张画布：**没有绑定地图**（于是它不可能"已启用"）
  const canvasB = makeCanvas()
  const leafB = {
    isDeferred: false,
    view: { canvas: canvasB, file: new FakeTFile('Maps/Other.canvas'), getViewType: () => 'canvas' },
  }
  const leafA = app.workspace.getLeavesOfType('canvas')[0]
  const originalGetLeaves = app.workspace.getLeavesOfType
  // 只改 canvas 那一支，别的视图类型照旧走原实现（否则 `openMapPanel` 找不到侧栏叶子）
  app.workspace.getLeavesOfType = (type) => (type === 'canvas' ? [leafA, leafB] : originalGetLeaves(type))

  const panel = await openMapPanel(app, plugin)
  const summary = () => inPanel(panel, 'fc-panel-summary-body')[0]?.textContent ?? ''
  flushFrames()
  check('活动叶子是 A 时，状态行说"地图层已启用"', summary().includes('地图层已启用'), summary())

  app.workspace.getMostRecentLeaf = () => leafB
  app.workspace.activeLeaf = leafB
  plugin.refreshPanel()
  flushFrames()
  check('切到没绑定地图的 B：状态行**不再**说"已启用"', !summary().includes('地图层已启用'), summary())
  check('而且说清是"这一张还没绑定地图"', summary().includes('尚未绑定地图'), summary())
  check('切视图不会顺手把 A 的地图层关掉（图层只属于它自己那张画布）', layers.isEnabled(canvasPathA) === true)

  app.workspace.getMostRecentLeaf = () => leafA
  app.workspace.activeLeaf = leafA
  plugin.refreshPanel()
  flushFrames()
  check('切回 A：状态行又变回"地图层已启用"', summary().includes('地图层已启用'), summary())

  plugin.onunload()
}

// ---------------------------------------------- 文档基线自检（防止基线漂移）
  /**
   * 文档里写着"本次冒烟有多少条断言"，这里让它自己对一次账。
   *
   * 为什么要有这条：这条基线在本项目里漂过**至少两次** ——
   * 一次是手写错成 278（用 dot reporter 的点数"数行数"），一次是改了断言却没同步文档。
   * "去读汇总行、不要目测"这条纪律靠人记总会漏，让脚本自己报错成本更低。
   *
   * ⚠️ 自指：这条 `check` 本身也会计进 `assertions`，所以比的是 `assertions + 1`。
   * ⚠️ 加了新断言之后，请同步 `docs/ENGINEERING-NOTES.md` 与 `docs/HANDOFF.md` 里的基线数字
   *   （两处都写在"冒烟测试"那一行），否则这条会红 —— 这正是它的用途。
   */
  const documented = readDocumentedAssertionCounts()
  const expectedTotal = assertions + 1
  const documentedText = documented.map((entry) => `${entry.file}=${entry.value}`).join(' · ')
  check(
    `文档里的基线数字与实测一致（${documentedText}）`,
    documented.length > 0 && documented.every((entry) => entry.value === expectedTotal),
    `实测（含本条）= ${expectedTotal}；文档 = ${documentedText || '（一处都没找到）'}`,
  )

  plugin.onunload()
}

if (failures === 0) {
  console.log(`✓ 冒烟测试全部通过（${assertions} 条断言）`)
} else {
  console.log(`✖ 冒烟测试失败 ${failures} / ${assertions} 条断言`)
  process.exitCode = 1
}
