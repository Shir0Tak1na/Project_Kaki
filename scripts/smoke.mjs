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
 * 只认诊断报告的前缀（`# Project Kaki — Phase 0`），状态报告不在其列。
 */
const consoleLines = []
const realConsoleLog = console.log.bind(console)
console.log = (first, ...rest) => {
  if (typeof first === 'string') consoleLines.push(first)
  if (typeof first === 'string' && first.startsWith('# Project Kaki — Phase 0')) {
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
      texts.push({ kind: 'stroke', text, x: tx + x, y: ty + y, angle, font: context.font, fillStyle: context.fillStyle })
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
    },
    blur() {
      if (el.doc.activeElement === el) el.doc.activeElement = null
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
         * 直接读 DOM（「设置海拔标定」与「设置数据层默认值」对话框都是先拿 `inputEl` 再读 `.value`）。
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
    async createFolder() {},
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
function firePointer(element, type, { clientX = 0, clientY = 0, button = 0, pointerId = 1, target = null } = {}) {
  let prevented = false
  let stopped = false
  const event = {
    type,
    clientX,
    clientY,
    button,
    pointerId,
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
  if (element === undefined || element === null) return { prevented, stopped }
  element.dispatchEvent(event)
  return { prevented, stopped }
}

// ---------------------------------------------------------------- 执行

console.log('Project Kaki — 运行时冒烟测试\n')

console.log('场景 1：真实结构与对抗性 tx/ty（tx/ty 故意不等于视口中心）')
{
  const app = makeApp(makeCanvas())
  const { report } = await runDiagnostics(app)
  check('报告已生成并被捕获', report.length > 0)
  check('报告包含 Canvas 叶子小节', report.includes('## 1. Canvas 叶子'), report.slice(0, 60))
  check('报告列出了活动画布路径', report.includes('Maps/World.canvas'))

  check('识别出 zoom 是 tZoom 的别名', report.includes('`zoom` 是 `tZoom` 的**别名**'))
  check('识别出 scale = 2^tZoom', report.includes('线性比例用 `scale` 字段最直接'))

  check('挂载点判定为 div.canvas', report.includes('世界层挂载点 = `div.canvas`'), report.match(/世界层挂载点[^\n]*/)?.[0] ?? '(缺少判定行)')
  check('挂载点不是卡片菜单或节点', !/世界层挂载点 = `div\.canvas-(card-menu|node|controls|control)/.test(report))
  check('候选表标记出了 ★ 世界层', report.includes('| ★ |'))
  check('候选表列出了菜单与节点的矩阵', report.includes('canvas-card-menu') && report.includes('canvas-node'))

  // 量化探测：桩环境按 1 CSS 像素取整（实测结论），且 dpr=1.65 ≠ 1
  check('识别出 posFromEvt 存在量化', report.includes('存在量化'), report.match(/判定：[^\n]*/)?.[0] ?? '')
  check('量子被识别为 1 CSS px', /量子 = \*\*1\.0000\d\d CSS px\*\*/.test(report), report.match(/量子 =[^\n]*/)?.[0] ?? '')
  check(
    '正确判定量化粒度是 CSS 像素而非设备像素',
    report.includes('量化粒度是 **CSS 像素**'),
    report.match(/换算到设备像素[^\n]*/)?.[0] ?? '',
  )
  check('给出量化噪声上界', /二维合成 [\d.]+ 世界单位/.test(report))

  // 多点标定：应把真实原点还原到半个量子（0.5 CSS px）以内
  const calibrationMatch = report.match(/多点标定：(\d+) 点中位数 → 原点 \(([\d.-]+), ([\d.-]+)\)/)
  check('报告给出了多点标定结果', calibrationMatch !== null)
  if (calibrationMatch) {
    const sampleCount = Number(calibrationMatch[1])
    const calibrated = { x: Number(calibrationMatch[2]), y: Number(calibrationMatch[3]) }
    const trueOrigin = { x: REAL.wrapperRect.left + REAL.matrixE, y: REAL.wrapperRect.top + REAL.matrixF }
    const error = Math.hypot(calibrated.x - trueOrigin.x, calibrated.y - trueOrigin.y)
    check(`标定用满 ${sampleCount} 个样本`, sampleCount === 25, `实际 ${sampleCount}`)
    check(
      `标定原点误差 ${error.toFixed(4)} px 在半个量子内`,
      error <= REAL.quantumCssPx / 2 + 0.05,
      `标定 (${calibrated.x}, ${calibrated.y}) vs 真实 (${trueOrigin.x}, ${trueOrigin.y})`,
    )
  }

  check('留出样本残差已到达量化精度极限', report.includes('已经到达可分辨精度的极限'), report.match(/留出样本残差[^\n]*/)?.[0] ?? '')
  check('运行时不施加偏差修正（差异在噪声内）', report.includes('不构成闭式关系有偏的证据'), report.match(/标定原点与闭式原点的差异[^\n]*/)?.[0] ?? '')
  check('对抗性 tx/ty 下中心公式被判为不可用', report.includes('❌ 中心公式与 posFromEvt 不一致'), report.match(/中心公式判定[^\n]*/)?.[0] ?? '')
  check('结论为可进入 Phase 1', report.includes('可进入 Phase 1'))
  // 诊断命令现在**只**打开报告面板：不再自动复制剪贴板、也不再自动写库内文件。
  // 那两件事是面板上的两个按钮（用户自己决定要不要做）—— 自动复制对"只想看一眼"的人是噪音，
  // 自动写文件则在库里留下没人清理的 FC-diagnostics.md。
  check('诊断命令不再自动写库内文件（写文件是面板上的按钮）', app.vault.files.has('FC-diagnostics.md') === false)
  check('诊断命令不再自动写剪贴板', clipboardWrites.length === 0, clipboardWrites.join(' | ').slice(0, 80))
}

console.log('\n场景 1b：闭式关系被人为偏移时应判为「可能有系统偏差」（鉴别力对照）')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ closedFormOffset: { x: 4, y: -3 } })))
  check(
    '判为超出量化噪声上界',
    report.includes('超出量化噪声上界') && report.includes('可能有系统偏差'),
    report.match(/标定原点与闭式原点的差异[^\n]*/)?.[0] ?? '',
  )
}

console.log('\n场景 2：tx/ty 恰好等于视口中心时应判中心公式可用（证明探针有鉴别力）')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ txTyAtViewportCenter: true })))
  check(
    '中心公式在量化噪声内被判为成立',
    report.includes('✅ 与 posFromEvt 的偏差在量化步长') || report.includes('✅ 中心公式与 posFromEvt 一致'),
    report.match(/中心公式判定[^\n]*/)?.[0] ?? '',
  )
  check('投影可用且未判为失败', !report.includes('❌ 仍有偏差'))
}

console.log('\n场景 3：矩阵缩放与 tZoom 字段不一致时应报警，且结构证据仍能找到挂载点')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ scale: REAL.scale, matrixScale: 0.65 })))
  check('报出矩阵缩放与 tZoom 推算不一致', report.includes('与 tZoom 推算') && report.includes('不一致'), report.match(/矩阵缩放[^\n]*/)?.[0] ?? '')
  check('仍靠结构证据选中 div.canvas', report.includes('世界层挂载点 = `div.canvas`'))
  check('投影仍以矩阵缩放为准', report.includes('缩放=变换矩阵 a 分量'))
}

console.log('\n场景 4：不量化时应判为连续输出（对照组，避免量化探测误报）')
{
  const { report } = await runDiagnostics(makeApp(makeCanvas({ quantize: false })))
  check('未观察到量化', report.includes('未观察到量化'), report.match(/判定：[^\n]*/)?.[0] ?? '')
}

console.log('\n场景 4：视口事件去重统计与补丁还原')
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
  check('事件总数统计为 4', stopNotice.includes('事件 4 次'), stopNotice)
  check('有效变化统计为 2（首次 + 真实变化）', stopNotice.includes('有效视口变化 2 次'), stopNotice)
  check('去重比例被算出', stopNotice.includes('重复 50%'), stopNotice)
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
  check('启用命令报告成功', message.includes('已启用地图层'), message.slice(0, 100))
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
  check('工具条列出了 9 种地形', collectByClass(toolbarEl, 'fc-toolbar-terrain').length === 9, String(collectByClass(toolbarEl, 'fc-toolbar-terrain').length))
  check('工具条含撤销/重做按钮', collectByClass(toolbarEl, 'fc-toolbar-button').length >= 12, String(collectByClass(toolbarEl, 'fc-toolbar-button').length))

  // 根因回归：覆盖层位于命中测试最底层，因此它必须**始终** pointer-events: none，
  // 绘制手势改在视图容器上以捕获阶段监听（下一条断言验证监听确实在容器上）。
  check('覆盖层始终保持 pointer-events: none（不做命中测试）', overlayContainer.style.pointerEvents !== 'auto', String(overlayContainer.style.pointerEvents))
  check('指针监听挂在视图容器上（捕获阶段）', host._listeners.get('pointerdown')?.size === 1, String(host._listeners.get('pointerdown')?.size))

  // 选择模式下左键必须原样放行（原生框选不受影响）
  const idlePoint = canvas._clientFor({ x: 0, y: 0 })
  const idleDown = firePointer(host, 'pointerdown', { clientX: idlePoint.x, clientY: idlePoint.y, target: wrapper })
  check('选择模式下左键不被拦截', idleDown.stopped === false && idleDown.prevented === false)

  // 进入绘制模式（用命令路径）
  const toggleMode = plugin.commands.find((c) => c.id === 'toggle-edit-mode')
  runCommand(plugin, 'toggle-edit-mode')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const editor = layers.getEditor(canvasPath)
  check('编辑器已创建并进入绘制模式', editor !== null && editor.mode === 'paint', String(editor?.mode))
  check('工具条显示为绘制中', toolbarEl.children[0].textContent.includes('绘制'), toolbarEl.children[0].textContent)
  check('进入绘制模式后覆盖层仍不参与命中测试', overlayContainer.style.pointerEvents !== 'auto')

  // 工具条的点击必须放行：它和 canvas 在同一个视图容器里，
  // 若不过滤，捕获阶段的 stopImmediatePropagation 会把按钮点击整个吃掉。
  // 注意先做这些检查：下面的"拦截"断言本身会真的开始一笔笔画。
  const start = canvas._clientFor({ x: 0, y: 0 })
  const terrainButtons = collectByClass(toolbarEl, 'fc-toolbar-terrain')
  const terrainButton = terrainButtons[2]
  const toolbarDown = firePointer(host, 'pointerdown', { clientX: start.x, clientY: start.y, target: terrainButton })
  check('工具条上的指针事件不被拦截', toolbarDown.stopped === false && toolbarDown.prevented === false)

  const terrainBefore = editor.terrainType
  fireEvent(terrainButton, 'click')
  check('点击工具条能切换地形', editor.terrainType !== terrainBefore, `${terrainBefore} → ${editor.terrainType}`)
  check('点击工具条不会在画布上落笔', Object.keys(layers.getDocument(canvasPath).terrain).length === 0)

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
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const nameButton = collectByClass(toolbarEl, 'fc-toolbar-names')[0]
  check('工具条上有"名称"开关', nameButton !== undefined)
  check('名称图层初始是打开的', plugin.getSettings().layers.labels === true, JSON.stringify(plugin.getSettings().layers))
  fireEvent(nameButton, 'click')
  // 刻意**不 await**：点一下必须当场生效（广播在落盘之前），
  // 否则会出现"点了之后下一帧还画着名称"
  check(
    '点击名称开关改的是图层设置（不是编辑器里的一份私有状态）',
    plugin.getSettings().layers.labels === false,
    JSON.stringify(plugin.getSettings().layers),
  )
  check('按钮的高亮读的是设置，当场跟着变', nameButton.textContent === '名称', String(nameButton.textContent))
  calls = frame()
  check(
    '隐藏名称后不画任何形状文字',
    calls.fillText === 0 && calls.strokeText === 0,
    `strokeText=${calls.strokeText} fillText=${calls.fillText}`,
  )
  check('区域本身照常绘制（只是没有名字）', calls.fill >= 1, String(calls.fill))
  fireEvent(nameButton, 'click')
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
  // A3：设置页原来那一行「显示六边形网格」已撤掉 —— 它和图层开关是**同一个值**（`setLayerVisible`
  // 是唯一入口），留两个入口只会让人以为是两件事。现在网格开关只出现在「图层」折叠组里
  // （工具条上还有同一个开关，那是画图时手边需要的那个）。
  const legacyGrid = FakeSetting.created.find((setting) => setting.info.name === '显示六边形网格')
  check('设置页里不再有重复的「显示六边形网格」那一行（它并入了图层开关）', legacyGrid === undefined)
  const gridSetting = FakeSetting.created.find((setting) => setting.info.name === '显示网格')
  check('设置页的网格开关带出当前值（默认显示）', gridSetting?.toggle?.value === true, String(gridSetting?.toggle?.value))
  check(
    '图层开关住在默认收起的「图层」折叠组里（首屏留给出引导与最常用的两项）',
    gridSetting?.containerEl?.tagName === 'DETAILS' &&
      gridSetting?.containerEl?.open === false &&
      gridSetting?.containerEl?.dataset?.fcGroup === 'layers',
    JSON.stringify({
      tag: gridSetting?.containerEl?.tagName,
      open: gridSetting?.containerEl?.open,
      role: gridSetting?.containerEl?.dataset?.fcGroup,
    }),
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
    FakeSetting.created.find((setting) => setting.info.name === '当前实际字号') === undefined,
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name).filter((name) => name === '当前实际字号')),
  )
  // 打开开发者模式后它才出现（用户 2026-09-27 的要求：把它移进开发者选项里）
  await plugin.setDeveloperMode(true)
  plugin.settingTabs[0].display()
  const liveInfo = FakeSetting.created.find((setting) => setting.info.name === '当前实际字号')
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
    dragonRows.length === 2 && dragonRows.some((cells) => cells[2] === '笔记') && dragonRows.some((cells) => cells[2] === '地图'),
    JSON.stringify(dragonRows),
  )
  check('区域行来自地图文档', byName.get('北境领')?.[1] === '区域', JSON.stringify(byName.get('北境领')))
  check('没有坐标的笔记仍然入表', byName.get('无名地')?.[3] === '—', JSON.stringify(byName.get('无名地')))
  check('坐标写错的笔记被标记出来', byName.get('荒村') && rows.find((r) => r.children[0]?.textContent === '荒村')?.classList.contains('is-invalid'))
  check('表格按名称排序（缺坐标的不影响排序）', rows[0]?.children[0]?.textContent !== undefined)

  const summaryText = collectByClass(container, 'fc-base-summary')[0]?.children.map((c) => c.textContent).join(' | ') ?? ''
  check('摘要显示地图路径与计数', summaryText.includes(mapPath) && /笔记 4/.test(summaryText) && /地图条目 2/.test(summaryText), summaryText)

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
  check('已存在时不覆盖', noticeLog.some((line) => line.includes('已存在同名 Base 文件')), noticeLog.join(' | '))

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
    noticeLog.some((line) => line.includes('没有可导出的地图') || line.includes('已启用地图层')),
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

console.log('\n场景 21：路径与区域的两种几何模式（沿格边 / 穿内部）')
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

  // ---- 工具栏按钮 ----
  editor.setMode('paint')
  editor.setTool('region')
  const geometryButtons = collectByClass(toolbarEl, 'fc-toolbar-geometry')
  check('工具条有「沿格边 / 逐边 / 穿内部」三个按钮', geometryButtons.length === 3, String(geometryButtons.length))
  check(
    '三个模式的标签齐全',
    ['沿格边', '逐边', '穿内部'].every((label) => geometryButtons.some((button) => button.textContent === label)),
    geometryButtons.map((button) => button.textContent).join(', '),
  )
  check('默认是穿内部模式', editor.geometryMode === 'interior', editor.geometryMode)
  fireEvent(geometryButtons[0], 'click')
  check('点击后切到沿格边模式', editor.geometryMode === 'edge', editor.geometryMode)
  check('按钮高亮跟随模式', geometryButtons[0].classList.contains('is-active') && !geometryButtons[1].classList.contains('is-active'))

  // ---- 沿格边模式：区域 ----
  prompts.length = 0
  clickAt({ x: -400, y: 300 })
  clickAt({ x: 100, y: 300 })
  clickAt({ x: 100, y: 600 })
  clickAt({ x: -400, y: 600 })
  clickAt({ x: -400, y: 600 })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()

  const region = layers.getDocument(canvasPath).regions[0]
  check('区域已提交', region !== undefined)
  check('区域记录了沿格边模式', region.mode === 'edge', String(region.mode))
  check(
    '区域的每一段都是格边',
    allEdges(region.pts),
    `段长 ${segmentLengths(region.pts).map((n) => n.toFixed(1)).join(', ')} / 边长 ${grid().size}`,
  )
  // 数据里不重复存起点；隐式闭合的那条边也必须沿格边
  const regionClose = Math.hypot(region.pts[0][0] - region.pts[region.pts.length - 1][0], region.pts[0][1] - region.pts[region.pts.length - 1][1])
  check('不重复存起点的同时，隐式闭合边也是格边', Math.abs(regionClose - grid().size) < 1e-6, String(regionClose))
  check('顶点数多于点击次数（中间补了沿边顶点）', region.pts.length > 4, String(region.pts.length))

  // ---- 沿格边模式：区域命中测试仍然有效（点在图内应能删掉）----
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
    '沿格边的区域仍能被右键命中并删除',
    hit.stopped === true && layers.getDocument(canvasPath).regions.length === before - 1,
    `拦截=${hit.stopped} 区域数 ${before} → ${layers.getDocument(canvasPath).regions.length}`,
  )
  editor.undo()
  check('删除区域可撤销（区域回来且模式还在）', layers.getDocument(canvasPath).regions[0]?.mode === 'edge')

  // ---- 沿格边模式：路径（河流不再平滑，否则等于把格边抹掉）----
  editor.setMode('paint')
  editor.setTool('path')
  editor.setPathType('river')
  clickAt({ x: -300, y: -200 })
  clickAt({ x: 0, y: -200 })
  clickAt({ x: 0, y: 100 })
  const enterHandler = app.keymap.activeScope.registrations.find((item) => item.key === 'Enter')
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()

  const edgePath = layers.getDocument(canvasPath).paths[0]
  check('路径记录了沿格边模式', edgePath.mode === 'edge', String(edgePath.mode))
  check('沿格边的路径不平滑（平滑会把格边抹成曲线）', edgePath.smooth === undefined, String(edgePath.smooth))
  check('沿格边的路径每一段都是格边', allEdges(edgePath.pts), `段长 ${segmentLengths(edgePath.pts).map((n) => n.toFixed(1)).join(', ')}`)

  // ---- 草稿预览：光标那一端也要沿格边走（所见即所得）----
  editor.setTool('region')
  clickAt({ x: -600, y: 200 })
  clickAt({ x: -300, y: 200 })
  const beforeCursor = editor.getDraft().points.length
  moveTo({ x: -100, y: 500 })
  const withCursor = editor.getDraft()
  check('预览里光标那一端沿格边走（点数变多）', withCursor.points.length > beforeCursor, `${beforeCursor} → ${withCursor.points.length}`)
  check('预览的每一段也都是格边', allEdges(withCursor.points), `段长 ${segmentLengths(withCursor.points).map((n) => n.toFixed(1)).join(', ')}`)
  check('预览不再使用橡皮筋直线（cursor 已并入点序列）', withCursor.cursor === null, String(withCursor.cursor))

  // 换模式会取消草稿：否则会出现"前几个顶点沿格边、后面穿内部"的混合形状
  editor.setGeometryMode('interior')
  check('切换模式会取消进行中的草稿', editor.isDrafting() === false)
  check('模式已切回穿内部', editor.geometryMode === 'interior')

  // ---- 穿内部模式：对照组（段长不应全部等于边长）----
  const undoBefore = editor.getStatus().undo
  editor.setTool('path')
  clickAt({ x: -300, y: -200 })
  clickAt({ x: -37, y: 41 })
  enterHandler.handler({ key: 'Enter' })
  flushFrames()
  prompts[prompts.length - 1].onSubmit(null)
  flushFrames()
  const freePath = layers.getDocument(canvasPath).paths[1]
  check('穿内部模式记录在数据里', freePath.mode === 'interior', String(freePath.mode))
  check('穿内部模式保留了河流的平滑', freePath.smooth === true, String(freePath.smooth))
  check('穿内部模式只有点击的两个顶点', freePath.pts.length === 2, String(freePath.pts.length))
  check('穿内部模式产生了一条可撤销历史', editor.getStatus().undo > undoBefore)

  // ---- 落盘往返：模式要写进文件并读回来 ----
  await store.flush()
  const saved = app.vault.files.get('Maps/World.map.md') ?? ''
  check('沿格边模式写进了文件', saved.includes('"mode": "edge"') || saved.includes('"mode":"edge"'), saved.slice(0, 160))
  const reloaded = await store.load(app.vault.getAbstractFileByPath('Maps/World.map.md'))
  check(
    '重新解析后模式仍然保留',
    reloaded.document.paths.some((path) => path.mode === 'edge') && reloaded.document.regions.some((region) => region.mode === 'edge'),
    JSON.stringify(reloaded.document.paths.map((path) => path.mode)),
  )
  check('旧数据缺 mode 字段时默认按穿内部处理', reloaded.document.paths.every((path) => path.mode === 'edge' || path.mode === 'interior'))

  // ---- 逐边模式：一次只画一条边 ----
  editor.setMode('paint')
  editor.setTool('region')
  const stepButton = geometryButtons.find((button) => button.textContent === '逐边')
  check('工具条有「逐边」按钮', stepButton !== undefined, geometryButtons.map((b) => b.textContent).join(', '))
  fireEvent(stepButton, 'click')
  check('已切到逐边模式', editor.geometryMode === 'edge-step', editor.geometryMode)

  // 沿着一个方向连续点：每次点击都应正好前进一条边
  const stepStart = { x: 600, y: -600 }
  clickAt(stepStart)
  const draftAfterFirst = editor.getDraft()
  check('逐边模式起点也吸附到顶点', draftAfterFirst.points.length === 1, String(draftAfterFirst.points.length))

  const directions = [
    { x: stepStart.x + 200, y: stepStart.y },
    { x: stepStart.x + 400, y: stepStart.y },
    { x: stepStart.x + 600, y: stepStart.y },
  ]
  for (const target of directions) clickAt(target)
  const stepped = editor.getDraft()
  check('三次点击 = 三个顶点（每次只走一条边）', stepped.points.length === 4, String(stepped.points.length))
  check(
    '逐边走过的每一段都是格边',
    allEdges(stepped.points),
    `段长 ${segmentLengths(stepped.points).map((n) => n.toFixed(1)).join(', ')}`,
  )
  // 预览：只显示"接下来那一条边"
  moveTo({ x: stepStart.x + 900, y: stepStart.y })
  const steppedPreview = editor.getDraft()
  check('逐边预览只多出一条边', steppedPreview.points.length === 5, String(steppedPreview.points.length))
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
  check('逐边模式画出的区域已提交', steppedRegion !== undefined)
  check('区域记录了逐边模式', steppedRegion.mode === 'edge-step', String(steppedRegion.mode))
  check('逐边区域每一段都是格边', allEdges(steppedRegion.pts), `顶点 ${steppedRegion.pts.length}`)
  const steppedClose = Math.hypot(
    steppedRegion.pts[0][0] - steppedRegion.pts[steppedRegion.pts.length - 1][0],
    steppedRegion.pts[0][1] - steppedRegion.pts[steppedRegion.pts.length - 1][1],
  )
  check('逐边区域的闭合边也是格边', Math.abs(steppedClose - grid().size) < 1e-6, String(steppedClose))
  // 逐边记录的顶点必须与画出来的完全一致（前缀核对）；多出来的只能是**闭合回程**的顶点
  // —— 区域必须闭合，而逐边模式下最后一点通常离起点还很远，那段回程同样沿格边走。
  const traced = afterTurn.map((point) => ({ x: point.x, y: point.y }))
  const prefixMatches = traced.every((point, index) => {
    const actual = steppedRegion.pts[index]
    return actual !== undefined && Math.abs(actual[0] - point.x) < 1e-6 && Math.abs(actual[1] - point.y) < 1e-6
  })
  check(
    '逐边记录的顶点与描出来的完全一致（不做自动补点）',
    prefixMatches && steppedRegion.pts.length >= traced.length,
    `描了 ${traced.length} 个，区域共 ${steppedRegion.pts.length} 个`,
  )
  check(
    '多出的顶点只来自闭合回程（很少）',
    steppedRegion.pts.length - traced.length <= 6,
    `闭合回程补了 ${steppedRegion.pts.length - traced.length} 个顶点`,
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
    ['启用/停用当前 Canvas 的地图层', '导出当前地图为 SVG', '创建地图 Base 文件（表格视图）'].every((name) =>
      buttonLabels().some((label) => label.includes(name)),
    ),
    buttonLabels().join(' | '),
  )
  check('每个按钮都有悬停提示（描述不再占一行，避免侧栏拥挤）', buttons().every((button) => (button.title ?? '').length > 0), buttons()[0]?.title ?? '')
  check('顶部显示了当前地图状态', (collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent ?? '').length > 0)

  // 未启用地图层的动作应被禁用（而不是点了报错）
  check('依赖地图层的动作在未启用时被禁用', buttonByLabel('导出当前地图为 SVG')?.disabled === true, String(buttonByLabel('导出当前地图为 SVG')?.disabled))

  // ---- 开发者模式：默认关闭 ----
  check('默认关闭开发者模式', plugin.getSettings().developerMode === false, String(plugin.getSettings().developerMode))
  check('开发用命令默认不出现在命令面板里', commandById('diagnose-canvas') !== undefined && commandAvailable('diagnose-canvas') === false)
  check('监视视口的命令同样被隐藏', commandAvailable('toggle-viewport-watch') === false)
  check(
    '面板里也没有「开发工具」一组',
    buttonLabels().every((label) => !label.includes('诊断当前 Canvas')) && !groupTitles().some((title) => title.includes('开发者模式')),
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
  check('分组标题注明了"仅开发者模式"', groupTitles().some((title) => title.includes('开发者模式')), groupTitles().join(' | '))
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
  const layerButton = () => buttonByLabel('启用/停用当前 Canvas 的地图层')
  check('地图层按钮可用', layerButton()?.disabled === false, String(layerButton()?.disabled))
  fireEvent(layerButton(), 'click')
  await new Promise((resolve) => setTimeout(resolve, 80))
  flushFrames()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('点面板按钮真的启用了地图层', layers.listStatus().some((status) => status.attached), JSON.stringify(layers.listStatus().map((s) => s.attached)))
  check('面板状态行随之更新', (collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent ?? '').includes('Maps/World.map.md'), collectByClass(panel.contentEl, 'fc-panel-summary-body')[0]?.textContent)
  check('启用后导出按钮变成可用', buttonByLabel('导出当前地图为 SVG')?.disabled === false, String(buttonByLabel('导出当前地图为 SVG')?.disabled))

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

console.log('\n场景 23：样式设置（路径/区域颜色、名称字体族）与"只影响新对象"的边界')
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
  const pickerNamed = (fragment) =>
    FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.colorPicker
  const textNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.text
  const buttonNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))?.button

  // ---- 先画一条路径，用来验证"改设置不会动已有对象" ----
  const beforePath = drawPath(-500, -200)
  const defaultRiver = '#4a9fd8'

  // ---- 设置界面 ----
  // ⑤-1 起"路径颜色"那种一行一个色块的做法换成**每种类型一条参数行**：
  // 名字就是类型名（内置 4 种没有后缀），第二行是"线宽与虚线 · <名字>"。
  openSettings()
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  const riverPicker = pickerNamed('河流')
  // ⑤-2 起区域也是"每种类型一条参数行"：名字就是区域类型名（内置 6 种没有后缀），
  // 第二行是"边框 · <名字>"。所以取色器不再叫"区域颜色 · 公国"，而是"公国"。
  const regionPicker = pickerNamed('公国')
  const fontText = textNamed('名称字体族')
  check(
    '设置页有每种路径类型的参数行（含颜色选择器）',
    pickerNamed('河流') !== undefined && pickerNamed('边界') !== undefined && pickerNamed('贸易路线') !== undefined ? true : false,
  )
  check('设置页有每种区域类型的颜色选择器', pickerNamed('王国') !== undefined && pickerNamed('海域') !== undefined)
  check(
    '区域类型的第二行是「边框 · <名字>」（与路径类型的「线宽与虚线」同构）',
    settingNamed('边框 · 公国') !== undefined &&
      (settingNamed('边框 · 公国')?.texts ?? []).length === 2,
    JSON.stringify((settingNamed('边框 · 公国')?.texts ?? []).map((text) => text.placeholder)),
  )
  check('设置页有名称字体族输入框', fontText !== undefined && fontText.placeholder === '留空 = 跟随主题', String(fontText?.placeholder))
  check('选择器带出当前值（出厂默认）', riverPicker?.value === defaultRiver, String(riverPicker?.value))
  check('字体族默认为空（= 跟随主题）', fontText?.value === '', JSON.stringify(fontText?.value))
  check(
    '每种路径类型都有端点与连接两个下拉（都要带出当前值）',
    (settingNamed('河流')?.dropdowns ?? []).map((dropdown) => dropdown.value).join(',') === 'round,round',
    JSON.stringify((settingNamed('河流')?.dropdowns ?? []).map((dropdown) => dropdown.value)),
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

  // ---- 工具条下拉：色块跟随设置，且**不重建 DOM** ----
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const pathOptionBefore = collectByClass(toolbarEl, 'fc-toolbar-path-option').find((button) => button.dataset.pathType === 'river')
  const swatchBefore = collectByClass(pathOptionBefore, 'fc-toolbar-swatch')[0]
  check('工具条下拉里的色块已变成新颜色', swatchBefore?.style.backgroundColor === '#ff0000', String(swatchBefore?.style.backgroundColor))
  check(
    '色块刷新是原地改样式，没有重建选项',
    collectByClass(toolbarEl, 'fc-toolbar-path-option').find((button) => button.dataset.pathType === 'river') === pathOptionBefore,
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

  // ---- 名称字体族：必须真的出现在 ctx.font 里，且不能带 var() ----
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

  // ---- 恢复默认 ----
  await buttonNamed('恢复出厂样式').click()
  const restored = plugin.getSettings()
  check(
    '「恢复默认」把路径类型参数、区域类型参数与字体都还原',
    restored.pathTypes.find((entry) => entry.id === 'river')?.params.color === defaultRiver &&
      restored.labelFontFamily === '' &&
      restored.regionTypes.find((entry) => entry.id === 'duchy')?.params.color === '#a882ff',
    JSON.stringify({
      river: restored.pathTypes.find((entry) => entry.id === 'river')?.params.color,
      font: restored.labelFontFamily,
      duchy: restored.regionTypes.find((entry) => entry.id === 'duchy')?.params.color,
    }),
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
  const addSetting = settingNamed('新增自定义地形')
  check('「地图定义」弹窗里有「新增自定义地形」一节（A3：它已经从设置页搬走了）', addSetting !== undefined)
  check(
    '新增区有 ID、显示名、颜色三个控件（ID 与显示名必须分开，否则又会被耦合在一起）',
    (addSetting?.texts?.length ?? 0) === 2 && addSetting?.colorPicker !== undefined,
    `texts=${addSetting?.texts?.length} picker=${String(addSetting?.colorPicker !== undefined)}`,
  )
  check('新增区的说明里写清了 ID 规则与自动前缀', (addSetting?.info.desc ?? '').includes('custom:'), addSetting?.info.desc)

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
  const addDup = settingNamed('新增自定义地形')
  await addDup.texts[0].type('MARSH')
  await addDup.button.click()
  check('重复 ID（大小写不同）被拒绝', plugin.getSettings().customTerrains.length === 1, JSON.stringify(plugin.getSettings().customTerrains))

  // 再建两个：一个带存在的图片，一个带不存在的图片
  openSettings()
  const addReef = settingNamed('新增自定义地形')
  await addReef.texts[0].type('reef')
  await addReef.texts[1].type('礁石')
  await addReef.button.click()
  openSettings()
  const addGhost = settingNamed('新增自定义地形')
  await addGhost.texts[0].type('ghost')
  await addGhost.texts[1].type('幽灵地')
  await addGhost.button.click()
  openSettings()
  const addBroken = settingNamed('新增自定义地形')
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
  const reefRow = settingNamed('图片 · 礁石')
  await reefRow.texts[0].type('Assets\\marsh.png')
  check(
    '图片路径写进设置（Windows 反斜杠被统一为正斜杠）',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png',
    JSON.stringify(plugin.getSettings().customTerrains[1]),
  )
  openSettings()
  const ghostRow = settingNamed('图片 · 幽灵地')
  await ghostRow.texts[0].type('Assets/does-not-exist.png')
  check(
    '指向不存在文件的路径**合法**（存不存在只有加载器知道），照样写进设置 —— 回退由绘制层负责',
    plugin.getSettings().customTerrains[2]?.imagePath === 'Assets/does-not-exist.png',
    JSON.stringify(plugin.getSettings().customTerrains[2]),
  )
  openSettings()
  const brokenRow = settingNamed('图片 · 破碎地')
  await brokenRow.texts[0].type('Assets/broken.png')
  check(
    '存在但解不开的图片路径也照样写进设置（解不开是运行期的事）',
    plugin.getSettings().customTerrains[3]?.imagePath === 'Assets/broken.png',
    JSON.stringify(plugin.getSettings().customTerrains[3]),
  )
  openSettings()
  const reefRow2 = settingNamed('图片 · 礁石')
  await reefRow2.texts[0].type('http://example.com/a.png')
  check(
    '非法图片路径被拒绝并就地给出原因',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png' && noteText().includes('网址'),
    `路径=${plugin.getSettings().customTerrains[1]?.imagePath} 提示=${noteText()}`,
  )
  check(
    '字形下拉框列出「通用」+ 内置 9 种（借字形是个可选项，不是隐藏功能）',
    (settingNamed('字形 · 沼泽地')?.dropdown?.options?.length ?? 0) === 10,
    JSON.stringify(settingNamed('字形 · 沼泽地')?.dropdown?.options?.map((option) => option.value)),
  )

  // ---------------------------------------------------------- 工具条
  const toolbarEl = () => collectByClass(wrapper, 'fc-toolbar')[0]
  const terrainButtons = () => collectByClass(toolbarEl(), 'fc-toolbar-terrain')
  /** 地形按钮的可见文字：结构是「色块 span + 名称 span」 */
  const terrainLabels = () => terrainButtons().map((button) => button.children[1]?.textContent ?? button.textContent ?? '')
  editor.setMode('paint')
  editor.setTool('brush')
  check('工具条出现内置 9 种 + 4 个自定义地形', terrainButtons().length === 13, terrainLabels().join(','))
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
    collectByClass(terrainButtons()[9], 'fc-toolbar-swatch')[0]?.style.backgroundColor === '#336655',
    String(collectByClass(terrainButtons()[9], 'fc-toolbar-swatch')[0]?.style.backgroundColor),
  )
  check(
    '自定义地形的悬停提示里带着完整 ID（界面上要能分清哪个是哪个）',
    (terrainButtons()[9]?.title ?? '').includes('custom:marsh'),
    terrainButtons()[9]?.title,
  )

  // 点工具条上的自定义地形 → 编辑器切过去 → 画上去 → 文件里是自定义 ID
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
  await settingNamed('图片 · 礁石').texts[0].type('Assets/reef2.png')
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
    await settingNamed('名称与颜色 · 沼泽地').button.click()
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
    check('工具条随之少一个按钮', terrainButtons().length === 12, String(terrainButtons().length))
    const afterDelete = frame()
    check(
      '被删掉定义的那些格子仍在绘制（回退视觉，而不是消失）',
      afterDelete.calls.drawImage === Object.keys(doc().terrain).length,
      `文档格数=${Object.keys(doc().terrain).length} drawImage=${afterDelete.calls.drawImage}`,
    )

    // 对照组：一条**从没被画过**的定义 → 不弹框，直接删（这条断言在"总是拦一下"的写法上会失败）
    const openedBefore = deletes.opened.length
    openSettings()
    await settingNamed('名称与颜色 · 幽灵地').button.click()
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
  check(
    '工具条「名称」按钮的高亮读的是设置（不是它自己的状态）',
    (collectByClass(wrapper, 'fc-toolbar-names')[0]?.textContent ?? '') === '名称',
    String(collectByClass(wrapper, 'fc-toolbar-names')[0]?.textContent),
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

  // ---- 工具条入口 ----
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const legendButton = collectByClass(toolbarEl, 'fc-toolbar-legend')[0]
  check('工具条上有「图例」按钮', legendButton !== undefined)
  fireEvent(legendButton, 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('点工具条按钮会把图例设置写回', plugin.getSettings().showLegend === false, String(plugin.getSettings().showLegend))
  frame()
  check('并且图例真的收起来了', legendEl().style.display === 'none', String(legendEl().style.display))

  const nameButton = collectByClass(toolbarEl, 'fc-toolbar-names')[0]
  fireEvent(nameButton, 'click')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '工具条「名称」按钮写的是图层设置（不是编辑器里的一份私有状态）',
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
  check('设置页有六个图层开关', ['显示地形', '显示网格', '显示区域', '显示路径', '显示标记', '显示名称'].every((name) => settingNamed(name)?.toggle !== undefined), String(FakeSetting.created.length))
  check('设置页有图例开关', settingNamed('显示图例')?.toggle !== undefined)
  check(
    '设置页的开关反映当前值（名称刚被工具条关掉）',
    settingNamed('显示名称')?.toggle.value === false && settingNamed('显示路径')?.toggle.value === true,
    JSON.stringify({ name: settingNamed('显示名称')?.toggle.value, path: settingNamed('显示路径')?.toggle.value }),
  )
  settingNamed('显示网格').toggle.handler(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('设置页关掉网格 → 图层设置里网格是关的', plugin.getSettings().layers.grid === false, JSON.stringify(plugin.getSettings().layers))
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
    statusText.includes('图层：') && statusText.includes('路径') && statusText.includes('名称'),
    statusText.slice(0, 200),
  )
  check(
    '状态命令列出图例条目（从地图实际内容生成）',
    statusText.includes('图例：') && statusText.includes('森林') && statusText.includes('王国'),
    statusText.slice(0, 300),
  )
  await plugin.setLayerVisible('paths', true)
  await plugin.setLayerVisible('labels', true)
  // 网格在前面的设置页步骤里被关掉了：这里显式恢复，才能断言"全部显示"这句话
  await plugin.setLayerVisible('grid', true)
  // 温度 / 深度两条数据层出厂默认都是**关**的（数据层不该在用户没要求时改变现有画面）：
  // 所以只想看"全部显示"那句话，就得连它们一起打开 —— 隐藏清单里会如实写着它们。
  await plugin.setLayerVisible('temperature', true)
  await plugin.setLayerVisible('depth', true)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('全部显示时状态命令这么说', layerCapture.text().includes('图层：全部显示'), layerCapture.text().slice(0, 200))
  await plugin.setLayerVisible('temperature', false)
  await plugin.setLayerVisible('depth', false)
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(
    '数据层默认关着这件事在状态命令里可查（"地图怎么没有颜色"有一个可读答案）',
    layerCapture.text().includes('已隐藏 温度 / 深度'),
    layerCapture.text().slice(0, 200),
  )
  layerCapture.restore()

  // ---- 重开地图层：新建的工具条必须与设置一致 ----
  // 这是"两份状态"最容易露馅的地方：如果名称开关还存在每张画布的运行时状态里，
  // 重开之后按钮显示的就是默认值，而设置里却是另一个值 —— 用户看到的就是"我明明关了它又开了"。
  await plugin.setLayerVisible('labels', false)
  layers.disable(canvasPath)
  runCommand(plugin, 'toggle-map-layer')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const nameButtonAfterReopen = () => collectByClass(canvas.wrapperEl, 'fc-toolbar-names')[0]
  check(
    '重开地图层后，名称按钮仍然显示设置里的状态（关闭）',
    nameButtonAfterReopen()?.textContent === '名称',
    String(nameButtonAfterReopen()?.textContent),
  )
  await plugin.setLayerVisible('labels', true)
  check(
    '在设置侧打开后，重开的按钮也跟着打开',
    nameButtonAfterReopen()?.textContent === '名称 ✓',
    String(nameButtonAfterReopen()?.textContent),
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
    noticeLog.some((line) => line.includes('没有可导出的地图') || line.includes('已启用地图层')),
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
  const failedNotice = noticeLog.find((line) => line.includes('导出 PNG 失败')) ?? ''
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
    noticeLog.some((line) => line.includes('导出 PNG 失败') && line.includes('toBlob')) &&
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
    noticeLog.some((line) => line.includes('导出 PNG 失败')),
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
    '工具条上没有任何按钮的文字是「地图层」',
    collectByClass(toolbarEl, 'fc-toolbar-button').every((button) => (button.textContent ?? '') !== '地图层'),
    collectByClass(toolbarEl, 'fc-toolbar-button').map((button) => button.textContent).join(','),
  )

  // ---- 面板：六个图层开关 ----
  plugin.ribbonIcons[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const panel = app.workspace.getLeavesOfType('fictional-cartographer-panel')[0]?.view
  check('面板已打开', panel !== undefined)
  const toggleEls = () => collectByClass(panel.contentEl, 'fc-layer-toggle')
  const toggleFor = (key) => toggleEls().find((element) => element.dataset.layer === key)
  check('面板里有八个图层开关（六层 + 温度、深度两条数据层）', toggleEls().length === 8, String(toggleEls().length))
  const panelLayerOrder = toggleEls().map((element) => element.dataset.layer).join(',')
  check(
    '八个开关的 key 与图层登记表一致（表驱动，顺序就是表里的行序）',
    panelLayerOrder === 'terrain,temperature,depth,grid,regions,paths,markers,labels',
    panelLayerOrder,
  )
  check(
    '开关显示的是中文层名',
    collectByClass(panel.contentEl, 'fc-layer-toggle-label').map((el) => el.textContent).join(',') ===
      '地形,温度,深度,网格,区域,路径,标记,名称',
    collectByClass(panel.contentEl, 'fc-layer-toggle-label').map((el) => el.textContent).join(','),
  )
  const dataLayerKeys = ['temperature', 'depth']
  check(
    '除数据层外默认都是"开"（温度 / 深度出厂是关的：新功能不该改变现有画面）',
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
      (collectByClass(button, 'fc-panel-button-label')[0]?.textContent ?? '').includes('启用/停用当前 Canvas 的地图层'),
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
  check('而面板还在（所以关掉之后仍有入口 —— 这正是把按钮从工具条拿掉的前提）', collectByClass(panel.contentEl, 'fc-layer-toggle').length === 8)

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
    (report?.text ?? '').includes('图层：') && (report?.text ?? '').includes('图例：'),
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
    collectByClass(realModal.contentEl, 'fc-report-title')[0]?.textContent === '地图状态报告',
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
  const imageRow = () => settingNamed('图片 · 沼泽地')
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
    imageRow() !== undefined && imageRow()?.button !== undefined && settingNamed('字形 · 沼泽地') !== undefined,
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
    realBundle.placeholder === '选择定义文件…',
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
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('字形 · 礁石')) &&
      FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('图片 · 礁石')),
    JSON.stringify(FakeSetting.created.map((setting) => setting.info.name)),
  )

  const customButton = () => collectByClass(wrapper, 'fc-toolbar-terrain')[9]
  check('工具条上出现了自定义地形的按钮（排在内置 9 种之后）', customButton() !== undefined)
  fireEvent(customButton(), 'click')
  editor.setMode('paint')
  editor.setTool('brush')
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
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('图片 · 礁石')) &&
      !FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('字形 · 礁石')),
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
    noticeLog.some((line) => line.includes('没有可导出的地图') || line.includes('已启用地图层')),
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
  const defaultPreview = options?.describe({ kind: 'all' }, 'svg')
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
  const summaryEl = (modal) => collectByClass(modal.contentEl, 'fc-export-summary')[0]
  const exportButton = () =>
    FakeSetting.created.flatMap((setting) => setting.buttons ?? []).find((button) => (button.text ?? '').includes('导出'))
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
    noticeLog.some((line) => line.includes('北境领') && line.includes('已导出地图 SVG')),
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
    viewportOptions?.describe({ kind: 'viewport' }, 'svg')?.ok === true,
    JSON.stringify(viewportOptions?.describe({ kind: 'viewport' }, 'svg')),
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
  const failNotices = noticeLog.filter((line) => line.includes('导出 PNG 失败'))
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
  await guardOptions.onExport({ kind: 'region', regionId: 'gone' }, 'svg')
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(
    '区域已被删掉时给出可读原因（找不到，而不是堆栈）',
    noticeLog.some((line) => line.includes('无法导出') && line.includes('找不到') && !/undefined|Error\b/.test(line)),
    noticeLog.join(' | '),
  )
  check('这种失败不产生文件', svgFiles().length === beforeGuard, svgFiles().join(','))
  const badPreview = guardOptions.describe({ kind: 'region', regionId: 'gone' }, 'svg')
  check(
    '对话框侧同样判为不可导出（按钮会变灰）',
    badPreview?.ok === false && /找不到/.test(badPreview.reason),
    JSON.stringify(badPreview),
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
  await emptyOptions.onExport({ kind: 'region' }, 'svg')
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(
    '没有区域时按区域导出：给出可读原因，且不产出文件',
    noticeLog.some((line) => line.includes('无法导出') && line.includes('还没有区域')) && svgFiles().length === beforeEmptyGuard,
    noticeLog.join(' | '),
  )
  doc().regions.push(...regionsBackup)

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
  const iconButtons = () => collectByClass(wrapper, 'fc-toolbar-icon')
  const frame = () => {
    canvas.markViewportChanged()
    flushFrames()
  }

  // ------------------------------------------- 「地图定义」弹窗：新增（A3 从设置页搬来）
  openSettings()
  const addMarkerSetting = settingNamed('新增自定义标记')
  check('「地图定义」弹窗里有「新增自定义标记」一节', addMarkerSetting !== undefined)
  check(
    '新增区有 ID 与显示名两个控件',
    (addMarkerSetting?.texts?.length ?? 0) === 2,
    `texts=${addMarkerSetting?.texts?.length}`,
  )
  check(
    '新增区的说明里写清了 ID 规则与自动前缀',
    (addMarkerSetting?.info.desc ?? '').includes('custom:'),
    addMarkerSetting?.info.desc,
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
  const addDupMarker = settingNamed('新增自定义标记')
  await addDupMarker.texts[0].type('LIGHTHOUSE')
  await addDupMarker.button.click()
  check(
    '重复 ID（大小写不同）被拒绝',
    plugin.getSettings().customMarkers.length === 1,
    JSON.stringify(plugin.getSettings().customMarkers),
  )

  // 第二个标记：用来走图片模式（含"从字形切到图片"的自动切换）
  openSettings()
  const addMarker2 = settingNamed('新增自定义标记')
  await addMarker2.texts[0].type('beacon')
  await addMarker2.texts[1].type('灯标')
  await addMarker2.button.click()
  check('两个自定义标记都在设置里', plugin.getSettings().customMarkers.length === 2, JSON.stringify(plugin.getSettings().customMarkers.map((m) => m.id)))

  // 字形一栏与图片一栏在**两种模式下都要在**（藏起来用户就找不到入口 —— 实测反馈过）
  openSettings()
  check(
    '字形模式下同时显示字形与图片入口',
    FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('字形 · 灯塔')) &&
      FakeSetting.created.some((setting) => (setting.info.name ?? '').includes('图片 · 灯塔')),
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
  const glyphSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('字形 · 灯塔'))
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

  // ---------------------------------------------------------- 工具条
  check(
    '工具条出现内置 9 种 + 2 个自定义标记',
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
    collectByClass(iconButtons()[9], 'fc-toolbar-icon-glyph').length === 1 &&
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
    (placeDropdown?.options ?? []).some((option) => option.value === 'custom:gone' && /未知/.test(option.label)) &&
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
    .filter((setting) => (setting.info.name ?? '').includes('图片 · 灯标'))
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
    .filter((setting) => (setting.info.name ?? '').includes('图片 · 灯标'))
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
  const deleteSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('名称 · 灯塔'))
  const beforeDeleteIcons = iconButtons().length
  await deleteSetting.buttons.find((button) => button.text === '删除').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    '删除定义后设置里没有它了',
    !plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:lighthouse'),
    JSON.stringify(plugin.getSettings().customMarkers.map((marker) => marker.id)),
  )
  check('工具条按钮跟着减少', iconButtons().length === beforeDeleteIcons - 1, `${beforeDeleteIcons} → ${iconButtons().length}`)
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
  const toolbarEl = () => collectByClass(wrapper, 'fc-toolbar')[0]
  const pathOptions = () => collectByClass(toolbarEl(), 'fc-toolbar-path-option')
  const pathOption = (id) => pathOptions().find((button) => button.dataset.pathType === id)
  const pathTrigger = () => collectByClass(toolbarEl(), 'fc-toolbar-path-trigger')[0]
  const pathMenu = () => collectByClass(toolbarEl(), 'fc-toolbar-path-menu')[0]
  const triggerSwatch = () => collectByClass(pathTrigger(), 'fc-toolbar-swatch')[0]
  const optionSwatch = (id) => collectByClass(pathOption(id), 'fc-toolbar-swatch')[0]
  const entryOf = (id) => plugin.getSettings().pathTypes.find((entry) => entry.id === id)
  /** 某一帧里所有描边中用到的颜色（用来断言"这条路径画成了什么颜色"） */
  const strokeColors = () => frame().groups.map((group) => group.strokeStyle)

  // ---------------------------------------------------------- 设置页：内置 4 种都有参数行
  openSettings()
  check(
    '内置 4 种路径各有参数行（颜色 + 端点 + 连接）',
    ['河流', '道路', '贸易路线', '边界'].every((label) => {
      const setting = FakeSetting.created.find((item) => item.info.name === label)
      return (setting?.colorPickers?.length ?? 0) === 1 && (setting?.dropdowns?.length ?? 0) === 2
    }),
  )
  check(
    '端点/连接下拉带出当前值（出厂 round/round）',
    (settingNamed('河流')?.dropdowns ?? []).map((dropdown) => dropdown.value).join(',') === 'round,round',
    JSON.stringify((settingNamed('河流')?.dropdowns ?? []).map((dropdown) => dropdown.value)),
  )
  check(
    '端点下拉里有三个选项（平头/圆头/方头）',
    (settingNamed('河流')?.dropdowns?.[0]?.options ?? []).map((option) => option.value).join(',') === 'butt,round,square',
    JSON.stringify(settingNamed('河流')?.dropdowns?.[0]?.options),
  )
  check(
    '线宽/虚线两行带出当前值（河流：8、实线）',
    settingNamed('线宽与虚线 · 河流')?.texts?.[0]?.value === '8' && settingNamed('线宽与虚线 · 河流')?.texts?.[1]?.value === '',
    `${String(settingNamed('线宽与虚线 · 河流')?.texts?.[0]?.value)} / ${String(settingNamed('线宽与虚线 · 河流')?.texts?.[1]?.value)}`,
  )
  check('道路的虚线带出来了（14,10）', settingNamed('线宽与虚线 · 道路')?.texts?.[1]?.value === '14,10', String(settingNamed('线宽与虚线 · 道路')?.texts?.[1]?.value))

  // ---------------------------------------------------------- 改参数 → 只影响之后新画的
  await settingNamed('线宽与虚线 · 河流').texts[0].type('20')
  check('线宽写进目录', entryOf('river')?.params.width === 20, JSON.stringify(entryOf('river')?.params))
  await settingNamed('河流').dropdowns[0].select('butt')
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
  openSettings()
  const riverDashBefore = entryOf('river')?.params.dash.join(',')
  await settingNamed('线宽与虚线 · 河流').texts[1].type('1')
  check('奇数段虚线被拒绝并给出原因', pathNote().includes('偶数'), pathNote())
  check('非法虚线没有改写目录', entryOf('river')?.params.dash.join(',') === riverDashBefore, String(entryOf('river')?.params.dash.join(',')))

  // ------------------------------- 自定义路径类型：新增（A3 从设置页搬进「地图定义」弹窗）
  openDefModal()
  const addSetting = settingNamed('新增自定义路径类型')
  check('「地图定义」弹窗里有「新增自定义路径类型」一节', addSetting !== undefined)
  check('新增区有 ID / 显示名 / 线宽 / 虚线四个文本框 + 一个颜色选择器', (addSetting?.texts?.length ?? 0) === 4 && (addSetting?.colorPickers?.length ?? 0) === 1, `texts=${addSetting?.texts?.length} pickers=${addSetting?.colorPickers?.length}`)
  check('新增区的说明写清了 ID 规则与自动前缀', (addSetting?.info.desc ?? '').includes('custom:'), addSetting?.info.desc)

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
  await settingNamed('新增自定义路径类型').texts[0].type('highway')
  await settingNamed('新增自定义路径类型').button.click()
  check('重复 ID 被拒绝', plugin.getSettings().pathTypes.filter((entry) => entry.id === 'custom:highway').length === 1)

  // ---------------------------------------------------------- 工具条下拉
  editor.setMode('paint')
  editor.setTool('path')
  frame()
  check(
    '工具条下拉里是内置 4 种 + 自定义（数一数）',
    pathOptions().length === 5,
    JSON.stringify(pathOptions().map((button) => button.dataset.pathType)),
  )
  check(
    '下拉项用 ID 索引、显示名可读（界面文字与数据解耦）',
    pathOption('custom:highway') !== undefined && (pathOption('custom:highway').textContent ?? '').includes('官道'),
    String(pathOption('custom:highway')?.textContent),
  )
  check('下拉项带自己的颜色小色块', optionSwatch('custom:highway')?.style.backgroundColor === '#00aa88', String(optionSwatch('custom:highway')?.style.backgroundColor))
  check('展开前下拉是收起的（不挡画布）', pathMenu()?.style.display === 'none', String(pathMenu()?.style.display))
  fireEvent(pathTrigger(), 'click')
  check('点触发按钮后下拉展开', pathMenu()?.style.display === '' , String(pathMenu()?.style.display))
  check(
    '展开时往 document 上挂了「点外面收起」的监听',
    (fakeDocument._listeners.get('pointerdown')?.size ?? 0) === 1,
    String(fakeDocument._listeners.get('pointerdown')?.size),
  )
  // 真实浏览器里画布上的 pointerdown 会先经过 document 的捕获阶段；假 DOM 不模拟事件传播，
  // 所以用 firePointerThroughDocument 按真实顺序走两跳（document → 画布），并尊重 stopPropagation。
  const outsideClient = canvas._clientFor({ x: -200, y: 640 })
  const outsideStrike = firePointerThroughDocument(fakeDocument, host, {
    clientX: outsideClient.x,
    clientY: outsideClient.y,
    target: wrapper,
  })
  check('点在画布上（下拉外面）时下拉收起', pathMenu()?.style.display === 'none', String(pathMenu()?.style.display))
  check(
    '这一击被拦下了 —— 没有落到画布上（否则用户只想收下拉，却顺手画出一个路径顶点）',
    outsideStrike.reachedCanvas === false && editor.isDrafting() === false,
    `reachedCanvas=${outsideStrike.reachedCanvas} drafting=${editor.isDrafting()}`,
  )
  check(
    '收起之后监听被摘掉（不留全局残留）',
    (fakeDocument._listeners.get('pointerdown')?.size ?? 0) === 0,
    String(fakeDocument._listeners.get('pointerdown')?.size),
  )
  // 反向对照：下拉**没有**展开时，同样的一击必须正常到达画布。
  // 没有这一条，上一条断言在「函数永远返回 reachedCanvas=false」时也会绿（空转）。
  const controlStrike = firePointerThroughDocument(fakeDocument, host, {
    clientX: outsideClient.x,
    clientY: outsideClient.y,
    target: wrapper,
  })
  check(
    '反向对照：下拉收起时同一击会正常落到画布（证明上一条不是空转）',
    controlStrike.reachedCanvas === true && editor.getStatus().draftPoints === 1,
    `reachedCanvas=${controlStrike.reachedCanvas} draftPoints=${editor.getStatus().draftPoints}`,
  )
  editor.cancelDraft()
  flushFrames()
  check('对照用的顶点已被清掉，不影响后续断言', editor.isDrafting() === false)
  fireEvent(pathTrigger(), 'click')
  check('再点一次又展开', pathMenu()?.style.display === '', String(pathMenu()?.style.display))
  fakeDocument.dispatchEvent({ type: 'pointerdown', target: pathOption('river'), stopPropagation() {} })
  check('点在下拉**内部**时不收起（由选项自己的 handler 负责）', pathMenu()?.style.display === '', String(pathMenu()?.style.display))
  fireEvent(pathOption('custom:highway'), 'click')
  check('选中后下拉自动收起', pathMenu()?.style.display === 'none', String(pathMenu()?.style.display))
  check('选中项就是编辑器当前类型', editor.getStatus().pathType === 'custom:highway', editor.getStatus().pathType)
  frame()
  check('触发按钮上写的是当前类型的名字', (pathTrigger().textContent ?? '').includes('官道'), String(pathTrigger().textContent))
  check('触发按钮上的色块是当前类型的颜色', triggerSwatch()?.style.backgroundColor === '#00aa88', String(triggerSwatch()?.style.backgroundColor))
  check('当前类型在下拉里高亮', pathOption('custom:highway')?.classList.contains('is-active') === true)
  check('其它类型没有高亮', pathOption('river')?.classList.contains('is-active') === false)

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
    legendRows().some((row) => (row.textContent ?? '').includes('未知（spaceship-lane）')),
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
      'Base 行里未知类型显示为「未知（ID）」（与图例同一套解析）',
      rowText.includes('未知（spaceship-lane）'),
      rowText.slice(0, 300),
    )
  }

  // ---------------------------------------------------------- 删除定义：数据不动，画布回退
  openDefModal()
  const deleteSetting = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('官道') && (setting.buttons ?? []).some((button) => button.text === '删除'))
  check('自定义类型那两行里有一行带「删除」按钮（内置类型没有）', deleteSetting !== undefined)
  check(
    '内置类型行里没有「删除」按钮',
    !(FakeSetting.created.find((setting) => setting.info.name === '河流')?.buttons ?? []).some((button) => button.text === '删除'),
  )
  // 这条自定义类型**已经被画到地图上过**（上面那条 custom:highway），所以属于"有引用"：
  // A3 要求这时先弹影响面确认框；这里捕获它、看清影响面，再在框里确认删除。
  const deletes = captureDeleteModals(plugin)
  const optionsBeforeDelete = pathOptions().length
  await deleteSetting.buttons.find((button) => button.text === '删除').click()
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
  check('工具条选项跟着减少', pathOptions().length === optionsBeforeDelete - 1, `${optionsBeforeDelete} → ${pathOptions().length}`)
  check(
    '当前类型被删掉后，触发按钮显示「未知（custom:highway）」而不是空着',
    (pathTrigger().textContent ?? '').includes('未知'),
    String(pathTrigger().textContent),
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
    '触发按钮的色块换成回退色（未知类型也必须看得见，不能是透明）',
    triggerSwatch()?.style.backgroundColor === FALLBACK_PATH_COLOR,
    String(triggerSwatch()?.style.backgroundColor),
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
    (settingNamed('新增自定义路径类型')?.info.desc ?? '').includes('已达上限'),
    settingNamed('新增自定义路径类型')?.info.desc,
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
    '两个动作都在地图面板的「文件与导出」组里（面板按钮与命令来自同一份定义）',
    panelAction('export-resource-bundle')?.group === 'file' && panelAction('import-resource-bundle')?.group === 'file',
    `${panelAction('export-resource-bundle')?.group} / ${panelAction('import-resource-bundle')?.group}`,
  )
  check(
    '这两个动作不受"必须先启用地图层"的限制（它们只依赖设置，不需要打开 Canvas）',
    panelAction('export-resource-bundle')?.available === undefined &&
      panelAction('import-resource-bundle')?.available === undefined,
    'available 不该存在',
  )

  // ---- 一条自定义定义都没有时：不产出空文件（写出空文件会让人以为导出成功了） ----
  clearNotices()
  await runCommand(plugin, 'export-resource-bundle')
  await wait()
  check('没有可导出的定义时不产出文件', jsonFiles().length === 0, jsonFiles().join(','))
  check('并且给出一句可读提示', noticeLog.some((line) => line.includes('还没有自定义')), noticeLog.join(' | '))

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
  check(
    '内置 4 种路径类型不进文件（带过去只会得到一串"同 ID 已存在"）',
    bundle.pathTypes.length === 1 && bundle.pathTypes[0].id === 'custom:highway',
    JSON.stringify(bundle.pathTypes.map((entry) => entry.id)),
  )
  check(
    '路径类型的参数完整（颜色/线宽/虚线/端点/连接）',
    bundle.pathTypes[0].params.color === '#c9a227' &&
      bundle.pathTypes[0].params.width === 9 &&
      JSON.stringify(bundle.pathTypes[0].params.dash) === JSON.stringify([16, 6]) &&
      typeof bundle.pathTypes[0].params.cap === 'string' &&
      typeof bundle.pathTypes[0].params.join === 'string',
    JSON.stringify(bundle.pathTypes[0].params),
  )
  check('提示里给出了落盘路径（用户不必去猜文件在哪）', noticeLog.some((line) => line.includes(exported[0])), noticeLog.join(' | '))
  check(
    '内置 6 种区域类型不进文件（带过去只会得到一串"同 ID 已存在"）',
    bundle.regionTypes.length === 1 && bundle.regionTypes[0].id === 'custom:march',
    JSON.stringify(bundle.regionTypes.map((entry) => entry.id)),
  )
  check(
    '区域类型的五个参数完整（颜色/不透明度/边框色/边框宽/边框虚线）',
    bundle.regionTypes[0].params.color === '#3355aa' &&
      bundle.regionTypes[0].params.opacity === 0.35 &&
      bundle.regionTypes[0].params.borderColor === null &&
      bundle.regionTypes[0].params.borderWidth === 5 &&
      JSON.stringify(bundle.regionTypes[0].params.borderDash) === JSON.stringify([10, 6]),
    JSON.stringify(bundle.regionTypes[0].params),
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
  check('弹窗标题是「导入定义文件」', picker.calls[0]?.title === '导入定义文件', String(picker.calls[0]?.title))

  // ---- 幂等：刚导出的文件立刻再导入 = 0 新增 ----
  const idempotent = capture.last()
  check('打开的是导入确认对话框', idempotent !== undefined)
  check('对话框里写明了来源文件', idempotent?.source === exported[0], String(idempotent?.source))
  check(
    '刚导出的文件再导入：一条都不新增（幂等）',
    /没有可新增的定义/.test(idempotent?.planText ?? ''),
    String(idempotent?.planText),
  )
  check(
    '同 ID 冲突逐条说明"保留现有的"',
    /保留现有的/.test(idempotent?.planText ?? ''),
    String(idempotent?.planText),
  )
  check('没有可新增条目时确认按钮是灰的（点不动比点了报错好）', idempotent?.canImport === false, String(idempotent?.canImport))

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
  check(
    '导入之后已打开的设置页自己刷新了（不需要用户关掉再打开设置）',
    settingsHas('小径'),
    FakeSetting.created.map((setting) => setting.info.name).join(' | '),
  )
  check('刷新后的设置页里也有新的区域类型（导入后不必关掉设置再打开）', settingsHas('绿洲'))
  // 地形定义的新家：弹窗那边也应该看得到导入进来的火山（重开一次即可看到，数据已经写进去了）
  FakeSetting.created.length = 0
  openDefinitionManager(plugin)
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
   * 打开「地图定义」弹窗（A3：区域类型的**增删改**搬到了这里；**参数行**仍在设置页）。
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
  const toolbarEl = () => collectByClass(wrapper, 'fc-toolbar')[0]
  const regionOptions = () => collectByClass(toolbarEl(), 'fc-toolbar-region-option')
  const regionOption = (id) => regionOptions().find((button) => button.dataset.regionType === id)
  const regionTrigger = () => collectByClass(toolbarEl(), 'fc-toolbar-region-trigger')[0]
  const regionMenu = () => collectByClass(toolbarEl(), 'fc-toolbar-region-menu')[0]
  const triggerSwatch = () => collectByClass(regionTrigger(), 'fc-toolbar-swatch')[0]
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

  // ---------------------------------------------------------- 工具条：区域类型下拉
  editor.setMode('paint')
  editor.setTool('region')
  flushFrames()
  check('区域工具下有一个区域类型下拉（不再是一排色块按钮）', regionTrigger() !== undefined && regionMenu() !== undefined)
  check(
    '下拉里有内置 6 种（王国/帝国/公国/教区/荒原/海域）',
    ['realm', 'empire', 'duchy', 'diocese', 'wilderness', 'sea'].every((id) => regionOption(id) !== undefined),
    JSON.stringify(regionOptions().map((button) => button.dataset.regionType)),
  )
  check('下拉里没有「未知类型」这种选项（它只列设置里存在的选择）', regionOption(FOREIGN_TYPE) === undefined)
  fireEvent(regionTrigger(), 'click')
  check('点触发按钮展开菜单', regionMenu().style.display !== 'none', String(regionMenu().style.display))
  fireEvent(regionOption('empire'), 'click')
  check('选中「帝国」后菜单自动收起', regionMenu().style.display === 'none', String(regionMenu().style.display))
  check(
    '触发按钮显示当前类型的名字与色块',
    collectByClass(regionTrigger(), 'fc-toolbar-region-label')[0]?.textContent === '帝国' &&
      triggerSwatch()?.style.backgroundColor === '#c94f4f',
    `${collectByClass(regionTrigger(), 'fc-toolbar-region-label')[0]?.textContent} / ${String(triggerSwatch()?.style.backgroundColor)}`,
  )

  // 真实浏览器里画布上的 pointerdown 会先经过 document 的捕获阶段；假 DOM 不模拟事件传播，
  // 所以用 firePointerThroughDocument 按真实顺序走两跳（document → 画布），并尊重 stopPropagation。
  // 区域这条路径尤其重要：多出一个**区域顶点**比多出一个路径顶点更难发现（形状会悄悄变形）。
  fireEvent(regionTrigger(), 'click')
  const outsideClient = canvas._clientFor({ x: -100, y: 600 })
  const outsideStrike = firePointerThroughDocument(fakeDocument, host, {
    clientX: outsideClient.x,
    clientY: outsideClient.y,
    target: wrapper,
  })
  check('点在画布上（下拉外面）时区域菜单收起', regionMenu().style.display === 'none', String(regionMenu().style.display))
  check(
    '这一击被拦下了 —— 没有落到画布上（否则用户只想收菜单，却顺手多一个区域顶点）',
    outsideStrike.reachedCanvas === false && editor.isDrafting() === false,
  )
  // 反向对照：菜单**没有**展开时，同样的一击必须正常到达画布。
  // 没有这一条，上一条在「reachedCanvas 永远是 false」时也会绿（空转断言）。
  const controlStrike = firePointerThroughDocument(fakeDocument, host, {
    clientX: outsideClient.x,
    clientY: outsideClient.y,
    target: wrapper,
  })
  check(
    '反向对照：菜单收起时同一击会正常落到画布（证明上一条不是空转）',
    controlStrike.reachedCanvas === true && editor.getStatus().draftPoints === 1,
    `reachedCanvas=${controlStrike.reachedCanvas} draftPoints=${editor.getStatus().draftPoints}`,
  )
  editor.cancelDraft()

  // ---------------------------------------------------------- 设置页：区域类型参数
  openSettings()
  check(
    '内置 6 种区域各有参数行（颜色 + 不透明度 + 边框色）',
    ['王国', '帝国', '公国', '教区', '荒原', '海域'].every((label) => {
      const setting = FakeSetting.created.find((item) => item.info.name === label)
      return (setting?.colorPickers?.length ?? 0) === 1 && (setting?.texts?.length ?? 0) === 2
    }),
  )
  check(
    '第二行是「边框 · <名字>」（边框宽 + 边框虚线）',
    (settingNamed('边框 · 王国')?.texts ?? []).length === 2,
    JSON.stringify((settingNamed('边框 · 王国')?.texts ?? []).map((text) => text.value)),
  )
  check(
    '出厂值带出来了（不透明度 0.22、边框宽 3、边框色留空 = 跟随填充色、虚线留空 = 实线）',
    settingNamed('王国')?.texts?.[0]?.value === '0.22' &&
      settingNamed('王国')?.texts?.[1]?.value === '' &&
      settingNamed('边框 · 王国')?.texts?.[0]?.value === '3' &&
      settingNamed('边框 · 王国')?.texts?.[1]?.value === '',
    JSON.stringify([
      settingNamed('王国')?.texts?.[0]?.value,
      settingNamed('王国')?.texts?.[1]?.value,
      settingNamed('边框 · 王国')?.texts?.[0]?.value,
      settingNamed('边框 · 王国')?.texts?.[1]?.value,
    ]),
  )

  // ---- 改「帝国」的参数：只影响**之后**新画的区域 ----
  const beforeDraw = editor.getStatus()
  void beforeDraw
  await settingNamed('帝国').texts[0].type('0.6')
  check('不透明度写进区域类型目录', entryOf('empire')?.params.opacity === 0.6, JSON.stringify(entryOf('empire')?.params))
  await settingNamed('帝国').texts[1].type('#101010')
  check('边框色写进目录', entryOf('empire')?.params.borderColor === '#101010', JSON.stringify(entryOf('empire')?.params))
  await settingNamed('边框 · 帝国').texts[0].type('9')
  check('边框宽写进目录', entryOf('empire')?.params.borderWidth === 9, JSON.stringify(entryOf('empire')?.params))
  await settingNamed('边框 · 帝国').texts[1].type('6,3')
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
    '图例里未知类型显示为「未知（ID）」而不是空着或混进内置名',
    legendLabels('region').includes(`未知（${FOREIGN_TYPE}）`),
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
    '工具条区域下拉里立刻多出「边境侯国」（带自己的 ID 索引）',
    regionOption('custom:march') !== undefined,
    JSON.stringify(regionOptions().map((button) => button.dataset.regionType)),
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
    (item) => (item.info.name ?? '').includes('边境侯国') && (item.buttons ?? []).some((button) => button.text === '删除'),
  )
  check('自定义区域类型那一行有删除按钮', customSetting !== undefined)
  // 刚才用 custom:march 画过一个区域 → 属于"有引用"，A3 要求先弹影响面确认框
  const deletes = captureDeleteModals(plugin)
  await customSetting.buttons.find((button) => button.text === '删除').click()
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
  check(
    '工具条触发按钮显示「未知（custom:march）」而不是空着',
    collectByClass(regionTrigger(), 'fc-toolbar-region-label')[0]?.textContent === '未知（custom:march）',
    String(collectByClass(regionTrigger(), 'fc-toolbar-region-label')[0]?.textContent),
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
  const seededDoc = renameSeed.document
  seededDoc.markers.push({ id: 'mk-rename', label: '待改名', p: [120, 120], icon: 'custom:renametest' })
  await plugin.store.writeNow(
    mapFile,
    seededDoc,
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
    '设置里的定义 ID 也改了（否则地图会显示"未知（旧 ID）"）',
    plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:renamed') &&
      !plugin.getSettings().customMarkers.some((marker) => marker.id === 'custom:renametest'),
    JSON.stringify(plugin.getSettings().customMarkers.map((marker) => marker.id)),
  )
  check(
    '结果走报告面板（多行影响面不塞进 Notice）',
    renameReport !== null && String(renameReport.text).includes('custom:renamed'),
    JSON.stringify(renameReport === null ? null : String(renameReport.text).slice(0, 80)),
  )
  check('未受影响的地图内容没被动过（只改了该改的那一处）', unchangedBeforeApply.replace('custom:renametest', 'custom:renamed') === afterText)

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
    '下拉里补了一条「未知（spaceship-lane）」并保持为当前值（不改写用户数据）',
    unknownSelect?.value === 'spaceship-lane' &&
      (unknownSelect?.children ?? []).some((option) => (option.textContent ?? '').includes('未知（spaceship-lane）')),
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

  // ---- 覆盖色：设了能清掉（清 = 删字段，不是写 null）----
  clickWorld({ x: 0, y: 0 })
  changeField('field-c', '#123456')
  check('覆盖色写进了文档', doc().markers[0]?.c === '#123456', String(doc().markers[0]?.c))
  const clearButton = fieldEl('clear-c')
  check('有覆盖色时「清除」可用', clearButton?.disabled === false, String(clearButton?.disabled))
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

  // ---- 数据层：地块上的温度 / 深度（「一格多值」的前两个正式字段）----
  // 它们**不该**混进「外观」组：那句提示说的是"只影响这一个对象"，而温度是给覆盖层上色用的
  check(
    '地块多出一组「数据层」，且没有污染「外观」组',
    groupEl('data') !== undefined &&
      collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup).join(',') ===
        'type,position,appearance,data',
    JSON.stringify(collectByClass(panel.contentEl, 'fc-selection-group').map((el) => el.dataset?.fcGroup)),
  )
  const undoBeforeTemp = editor.getStatus().undo
  groupEl('data').open = true // 模拟用户点开「数据层」这一组
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
    '超出色带全部锚点的值照样写得进去（数据层没有取值区间：色带两端只决定怎么染色）',
    doc().terrain[cellKey(6, 0)]?.depth === 99999 && editor.getStatus().undo === undoBeforeOutOfRange + 1,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )
  commitInput('field-depth', '3400')
  check(
    '深度可以再改成范围内的值（0 = 海平面，正 = 向下）',
    doc().terrain[cellKey(6, 0)]?.depth === 3400,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )

  // ---- 「撤销这些改动」：用户要的"确认改动"按钮（走 A：逐条撤销回到选中那一刻）----
  commitInput('field-temp', '-8')
  const editsRow = collectByClass(panel.contentEl, 'fc-selection-edits')[0]
  check(
    // 4 处 = 本次选中之后依次改了：地形种类（mountain）、深度 99999、深度 3400、温度 -8
    '改过之后出现「本次选中已改 N 处」',
    editsRow !== undefined && String(editsRow.textContent).includes('已改 4 处'),
    String(editsRow?.textContent),
  )
  const undoEditsButton = fieldEl('undo-selection-edits')
  check(
    '撤销按钮在（面板上那个后悔按钮）',
    undoEditsButton?.textContent === '撤销这些改动',
    String(undoEditsButton?.textContent),
  )
  undoEditsButton.dispatchEvent({ type: 'click' })
  flushFrames()
  check(
    '点它 = 逐条撤销到选中那一刻（温度与深度两个键都没了）',
    'temp' in (doc().terrain[cellKey(6, 0)] ?? {}) === false &&
      'depth' in (doc().terrain[cellKey(6, 0)] ?? {}) === false,
    JSON.stringify(doc().terrain[cellKey(6, 0)]),
  )
  check(
    '撤销完那一行自己消失（回到 0 处，不再占位置）',
    collectByClass(panel.contentEl, 'fc-selection-edits').length === 0,
    String(collectByClass(panel.contentEl, 'fc-selection-edits').length),
  )

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
    restoreRow() !== undefined && (restoreRow()?.textContent ?? '').includes('重新显示'),
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
  const layersGroup = settingsGroup('layers')
  const defaultsGroup = settingsGroup('defaults')
  check(
    '「图层」是个默认收起的折叠组',
    layersGroup?.tagName === 'DETAILS' && layersGroup.open === false,
    `tag=${String(layersGroup?.tagName)} open=${String(layersGroup?.open)}`,
  )
  check(
    '「新对象默认值」也是个默认收起的折叠组（一屏不再摊开几十个输入框）',
    defaultsGroup?.tagName === 'DETAILS' && defaultsGroup.open === false,
    `tag=${String(defaultsGroup?.tagName)} open=${String(defaultsGroup?.open)}`,
  )
  check(
    '折叠只是"收起"，不是"拿掉"：网格开关仍然挂在这个组里（改的还是 `layers.grid` 那一份设置）',
    FakeSetting.created.find((setting) => setting.info.name === '显示网格')?.containerEl === layersGroup,
    String(FakeSetting.created.find((setting) => setting.info.name === '显示网格')?.containerEl?.tagName),
  )

  // ---------------------------------------------------------- 4. 定义管理控件搬走了，但留了指路
  check('设置页里找不到「新增自定义地形」（已搬进弹窗）', settingNamed('新增自定义地形') === undefined)
  check('设置页里找不到「新增自定义标记」（已搬进弹窗）', settingNamed('新增自定义标记') === undefined)
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
    '面板里出现了「地图定义」这一组标题',
    collectByClass(panel.contentEl, 'fc-panel-group-title')
      .map((el) => el.textContent ?? '')
      .includes('地图定义'),
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
  const reefRow = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('名称与颜色 · 礁石'))
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
    (reefRow.buttons ?? []).some((button) => button.text === '改 ID…') &&
      (reefRow.buttons ?? []).some((button) => button.text === '删除'),
    JSON.stringify((reefRow.buttons ?? []).map((button) => button.text)),
  )

  // ---------------------------------------------------------- 7. 内置行不建按钮 + 新增流程真的能跑
  // 这两条是真实库里的现象逼出来的：内置类型的行上挂着**两个空按钮**（`addButton` 先建元素
  // 再回调，回调里提前 return 只做到了"不设文字"，按钮本身还在），而"新增"这条操作链
  // 在 A3 搬迁后**一条断言都没有**。
  const builtinRows = ['河流', '王国'].map((label) =>
    FakeSetting.created.find((setting) => setting.info.name === label),
  )
  check(
    '内置类型的行上没有任何按钮（不许留下空按钮）',
    builtinRows.every((row) => row !== undefined && (row.buttons ?? []).length === 0),
    JSON.stringify(builtinRows.map((row) => (row?.buttons ?? []).map((button) => button.text))),
  )

  const addPathRow = FakeSetting.created.find((setting) => setting.info.name === '新增自定义路径类型')
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
  const newPathRow = FakeSetting.created.find((setting) => (setting.info.name ?? '').includes('商路（自定义）'))
  check(
    '新增出来的那一行带「改 ID…」与「删除」两个按钮',
    (newPathRow?.buttons ?? []).map((button) => button.text).join(',') === '改 ID…,删除',
    JSON.stringify((newPathRow?.buttons ?? []).map((button) => button.text)),
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

console.log('\n场景 42：数据层（温度覆盖层）—— 格上的值 → 色带 → 画布')
{
  // 这一场是"温度模板"的端到端：值进格 → 色带算色 → 画布画出色块 → 改设置立刻变 → 关层不画。
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

  // 四格：两个在色带内（正好落在锚点上，颜色可精确断言）、一个低于下限、一个高于上限。
  // -200 刻意**同时**超出旧的 TEMP_RANGE（-100）：数据层没有取值区间，越界只体现在颜色上。
  document_.terrain['0_0'] = { t: 'forest', temp: 15 }
  document_.terrain['1_0'] = { temp: -200 }
  document_.terrain['0_1'] = { t: 'plains', temp: 0 }
  document_.terrain['2_0'] = { t: 'water', temp: 60 }
  check('第 2 格只有温度、没有地形（F2 之后这是合法状态）', document_.terrain['1_0'].t === undefined)

  // ---- 默认隐藏：数据层不该在用户没要求时改变现有画面 ----
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
  check('色带内的 15℃ 用的是 15 那个锚点的颜色', hasFill('#22c55e'), JSON.stringify(overlayFills().map((f) => f.fillStyle)))
  check('色带内的 0℃ 用的是 0 那个锚点的颜色', hasFill('#00c8c8'))
  check('低于下限的 -200℃ 用纯蓝（under）', hasFill('#0000ff'))
  check('高于上限的 60℃ 用纯红（over）', hasFill('#ff0000'))
  check(
    '色块按出厂不透明度 0.5 画（地形要能透出来）',
    overlayFills().every((fill) => Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify(overlayFills().map((f) => f.alpha)),
  )
  check(
    '只有温度没有地形的那一格也上了色（纯蓝那一笔就是它）',
    overlayFills().some((fill) => fill.fillStyle === '#0000ff'),
  )
  // 越界格**总是**写数值（即使"在每个格上写出数值"关着）：颜色只能表达"比上限还高"，
  // 表达不了"高多少"，而越界恰恰最需要读数。
  check(
    '两格越界格写出了数值，且是白字（纯蓝/纯红底白字）',
    overlayFrame.texts.length === 2 && overlayFrame.texts.every((item) => item.fillStyle === '#ffffff'),
    JSON.stringify(overlayFrame.texts.map((item) => `${item.text}@${item.fillStyle}`)),
  )
  check(
    '写出的是它们的实际数值（不是被夹到色带端点）',
    overlayFrame.texts.map((item) => item.text).sort().join(',') === '-200,60',
    overlayFrame.texts.map((item) => item.text).join(','),
  )
  check(
    '带内的两格没写数值（"在每个格上写出数值"默认是关的）',
    overlayFrame.texts.some((item) => item.text === '15' || item.text === '0') === false,
    JSON.stringify(overlayFrame.texts.map((item) => item.text)),
  )

  // ---- 图例：色带条目（有值格数 / 两端刻度 / 越界两项只在真有越界格时出现）----
  await plugin.setShowLegend(true)
  await tick(20)
  const legendEl = () => collectByClass(wrapper, 'fc-legend')[0]
  const rampRows = () => collectByClass(legendEl(), 'fc-legend-row').filter((row) => row.dataset.kind === 'ramp')
  check('图例里出现一条色带（不是色块分类）', rampRows().length === 1, String(rampRows().length))
  check(
    '色带条目的名字带单位、次数是有值的格数',
    collectByClass(rampRows()[0], 'fc-legend-label')[0]?.textContent === '温度（℃）' &&
      collectByClass(rampRows()[0], 'fc-legend-count')[0]?.textContent === '4',
    `${collectByClass(rampRows()[0], 'fc-legend-label')[0]?.textContent} / ${collectByClass(rampRows()[0], 'fc-legend-count')[0]?.textContent}`,
  )
  const rampBar = () => collectByClass(rampRows()[0], 'fc-legend-ramp')[0]
  check(
    '渐变条按锚点画（两端就是色带的最低/最高锚点）',
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

  // 改色带 → 图例里的渐变也得跟着变（签名必须覆盖色带，否则会停在旧图上）
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
  check('关掉温度层后图例里的色带条目也跟着消失（图例与画布同一份开关）', rampRows().length === 0, String(rampRows().length))
  check(
    '关层不改数据：格上的温度仍在',
    document_.terrain['0_0'].temp === 15 && document_.terrain['1_0'].temp === -200,
    JSON.stringify(document_.terrain['0_0']),
  )
  await store.writeNow(file, document_, 'World', [canvasPath])
  const saved = app.vault.files.get(file.path) ?? ''
  check('落盘后温度写在地图文件里（正式字段）', saved.includes('"temp":15'), saved.slice(0, 160))

  // ---- 设置页「数据层」一组：参数都在这里，且能改进去 ----
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  const settingNamed = (fragment) =>
    FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  check('设置页有「温度层的不透明度」滑块', settingNamed('温度层的不透明度')?.slider !== null)
  check(
    '五个色带锚点各自可改值 + 改色',
    settingNamed('温度色带锚点 1（最低）')?.texts?.length === 1 &&
      settingNamed('温度色带锚点 1（最低）')?.colorPickers?.length === 1 &&
      settingNamed('温度色带锚点 5（最高）')?.texts?.length === 1,
    String(FakeSetting.created.length),
  )
  check('越界两端各有颜色选择器（低于下限 / 高于上限）', settingNamed('低于下限')?.colorPicker !== undefined && settingNamed('高于上限')?.colorPicker !== undefined)
  check('有「在每个格上写出数值」开关', settingNamed('在每个格上写出数值')?.toggle !== undefined)
  check('有「恢复出厂色带」按钮', settingNamed('恢复出厂色带')?.button?.text === '恢复默认')

  // 连续改两个锚点：两次都要留下（用"渲染时的快照"写就会把前一次覆盖掉）
  await settingNamed('温度色带锚点 1（最低）').texts[0].type('-20')
  await settingNamed('温度色带锚点 2').texts[0].type('5')
  await tick(20)
  const edited = plugin.getSettings().overlays.temperature.ramp.stops
  check(
    '连续改两个锚点，两次改动都在',
    edited[0].value === -20 && edited[1].value === 5,
    JSON.stringify(edited.map((stop) => stop.value)),
  )
  await settingNamed('温度色带锚点 1（最低）').colorPickers[0].pick('#0044ff')
  await tick(20)
  check('改锚点颜色写进设置', plugin.getSettings().overlays.temperature.ramp.stops[0].color === '#0044ff')
  await settingNamed('低于下限').colorPicker.pick('#00ff88')
  await tick(20)
  check('改越界色写进设置', plugin.getSettings().overlays.temperature.ramp.under.color === '#00ff88')
  await settingNamed('在每个格上写出数值').toggle.handler(true)
  await tick(20)
  check('打开"写出数值"写进设置', plugin.getSettings().overlays.temperature.showValues === true)
  await settingNamed('恢复出厂色带').button.click()
  await tick(20)
  const restored = plugin.getSettings().overlays.temperature.ramp
  check(
    '恢复出厂色带：锚点与越界色都回出厂值',
    restored.stops[0].value === -30 && restored.stops[0].color === '#0000ff' && restored.under.color === '#0000ff',
    JSON.stringify(restored.stops.map((stop) => `${stop.value}:${stop.color}`)),
  )
  check('恢复出厂色带不动"写出数值"开关', plugin.getSettings().overlays.temperature.showValues === true)

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

// ================================================== 场景 43：深度层 —— 色带 / 展示单位 / 标定
console.log('\n场景 43：深度层 —— 色带染色 → 展示单位换算 → 地图级海拔标定 → 关层不画')
{
  // 深度是"温度模板"的第二份：字段表加一行 + 图层表加一行，就有了完整的一条数据层。
  // 这一场盯的是深度独有的那几件事：色带是"浅米→浅蓝→深蓝"、越界是白 / 近黑蓝（不是温度的蓝红）、
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

  // ---- 打开深度层：色带颜色 + 越界两端 + 深浅次序 ----
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
  check('海平面（0）用浅蓝锚点色', hasFill('#7dd3fc'), JSON.stringify(fills().map((f) => f.fillStyle)))
  // 5000 超过出厂上限 4000 → 高于上限的近黑蓝；-1500 在带内（-4000..4000），插值结果在浅米一侧
  check('深于上限（5000 > 4000）用近黑蓝（over）', hasFill('#0b1f4b'))
  check(
    '色块按出厂不透明度 0.5 画',
    fills().every((fill) => Math.abs(fill.alpha - 0.5) < 1e-9),
    JSON.stringify(fills().map((f) => f.alpha)),
  )

  // ---- 越界格总是写数值，数值按米（出厂展示单位）读 ----
  check(
    '越界格写出了数值（出厂是米读数），用 over 的文字色',
    overlayFrame.texts.some((item) => item.text === '5000' && item.fillStyle === '#ffffff'),
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
  check('图例里出现深度那一条色带（温度层关着，所以只有它）', rampRows().length === 1, String(rampRows().length))
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

  // ---- 越界色回退用的是**深度自己的出厂值**（白 / 近黑蓝），不是温度的纯蓝 / 纯红 ----
  await plugin.setOverlayStyle('depth', { ramp: { ...plugin.getSettings().overlays.depth.ramp, stops: [] } })
  await tick(20)
  check(
    '深度色带坏掉时回退到深度自己的出厂（over 仍是近黑蓝）',
    plugin.getSettings().overlays.depth.ramp.over.color === '#0b1f4b',
    plugin.getSettings().overlays.depth.ramp.over.color,
  )

  plugin.onunload()
}

// ================================================== 场景 44：连续场（等温线 / 等高线）
console.log('\n场景 44：数据层的连续场 —— 插值 + 等值线 + 采样缓存')
{
  // 用户可见目标：数据层不只"每格涂一块"，还能把格心值插成连续面并画等值线（不局限于六边形格）。
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
    '等值线的颜色来自色带（该值在色带里的颜色）',
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
    (named('温度的显示方式')?.dropdowns?.[0]?.options ?? []).map((option) => option.value).join(',') === 'cell,field',
    JSON.stringify(named('温度的显示方式')?.dropdowns?.[0]?.options),
  )
  check('逐格模式下不显示等值线间距（参数只在需要时出现）', named('温度的等值线间距') === undefined)
  await named('温度的显示方式').dropdowns[0].select('field')
  await tick(20)
  FakeSetting.created.length = 0
  plugin.settingTabs[0].display()
  check('切到连续场后设置里出现等值线间距', named('温度的等值线间距') !== undefined)
  await named('温度的等值线间距').texts[0].type('5')
  await tick(20)
  check('等值线间距写进设置', plugin.getSettings().overlays.temperature.contourInterval === 5, String(plugin.getSettings().overlays.temperature.contourInterval))

  plugin.onunload()
}

// ================================================== 场景 45：导出 / Base 缩略图带上叠加层
console.log('\n场景 45：导出（SVG / PNG）带上数据层叠加层 —— 与画布同一份几何')
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
  frame()
  const cellSvg = await exportedSvg()
  check('打开温度层后导出里出现温度段', cellSvg.includes('data-fc-overlay="temperature"'), cellSvg.slice(0, 120))
  check(
    '导出与画布画同样多的色块（几何只有一份）',
    countOf(cellSvg, /data-fc-primitive="polygon"/g) + countOf(cellSvg, /data-fc-primitive="raster"/g) ===
      stats().lastOverlayDrawn,
    `导出 ${countOf(cellSvg, /data-fc-primitive="polygon"/g)} / 画布 ${stats().lastOverlayDrawn}`,
  )
  check('越界格在导出里是 over 的纯红（与画布一致）', cellSvg.includes('fill="#ff0000"'), cellSvg.slice(0, 200))
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
    const exportNotice = noticeLog.filter((line) => line.includes('已导出地图 SVG')).at(-1) ?? ''
    check(
      '导出提示里写明颜色面走了哪条路（含体积）',
      exportNotice.includes('数据层导出：温度：内联栅格（') && exportNotice.includes('KiB'),
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

// ================================================== 场景 46：数据层每格默认值（§B）
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
  check('对话框里有「保存」与「清空全部」', modal.buttonOf('保存') !== undefined && modal.buttonOf('清空全部') !== undefined)
  check(
    '说明里写明"只影响渲染、不改地图文件"',
    modal.rows[0]?.info.desc?.includes('留空 = 这一层不兜底') === true,
    String(modal.rows[0]?.info.desc),
  )

  // ---- 非法值：保存禁用 + 原因在旁（不悄悄当成 0）----
  await tempInput.type('abc')
  check(
    '填了非数字：保存被禁用，原因写在旁边',
    modal.buttonOf('保存').buttonEl.disabled === true && /必须是一个数字/.test(modal.noteOf()?.textContent ?? ''),
    `${modal.buttonOf('保存').buttonEl.disabled} / ${modal.noteOf()?.textContent ?? ''}`,
  )
  await tempInput.type('30')
  check('改成合法值后保存又可用了', modal.buttonOf('保存').buttonEl.disabled === false)

  // ---- 保存：写进地图文件那一段，且一次提交 = 一条历史 ----
  const undoBefore = editor.getStatus().undo
  await modal.buttonOf('保存').click()
  await tick(20)
  check('默认值写进了地图文件的那一段', JSON.stringify(document_.dataDefaults) === '{"temp":30}', JSON.stringify(document_.dataDefaults))
  check('一次提交 = 一条历史（Ctrl+Z 能回去）', editor.getStatus().undo === undoBefore + 1, String(editor.getStatus().undo))

  // ---- 兜底只影响渲染：那格有颜色了，但格上仍然没有 temp ----
  const fallbackFrame = frame()
  check('兜底格也画出来了（"画过的地方整片都有颜色"）', stats().lastOverlayDrawn === 3, String(stats().lastOverlayDrawn))
  check(
    '兜底格用的是**默认值在色带里的颜色**（30 ℃ → 橙 #f59e0b）',
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
  await clearing.buttonOf('清空全部').click()
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
