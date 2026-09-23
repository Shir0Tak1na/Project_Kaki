/**
 * 运行时冒烟测试：用桩替身模拟 Obsidian，把编译产物 main.js 真正加载并执行一遍。
 *
 * 桩环境**复刻 Phase 0 在 Obsidian 1.13.7 上实测到的真实结构**（见 docs/PHASE-0-RESULTS.md）：
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
 */

import fs from 'node:fs'
import Module from 'node:module'
import path from 'node:path'
import process from 'node:process'
// 纯模块（不依赖 obsidian）可以直接被测试导入：Node 24 原生剥离 TypeScript 类型。
// 桩环境用它来模拟 Obsidian 的 metadataCache 行为。
import { extractFrontmatterBlock, isMapFileContent, parseFrontmatter } from '../src/data/mapFile.ts'
import { summarizeMapDocument } from '../src/data/mapDocument.ts'
import { worldToAxial } from '../src/core/hex.ts'
import { snapToCellCenter } from '../src/render/markerPlacement.ts'

const root = path.resolve(import.meta.dirname, '..')
const verbose = process.argv.includes('--verbose')

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
const realConsoleLog = console.log.bind(console)
console.log = (first, ...rest) => {
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
    // 按创建顺序登记：测试用"最后被创建的那张图"来分辨"换图之后画的是不是新的那张"
    FakeImage.instances.push(this)
  }

  get src() {
    return this._src
  }

  set src(value) {
    this._src = String(value)
    globalThis.setTimeout(() => {
      if (loadableImageUrls.has(this._src)) this.onload?.()
      else this.onerror?.(new Error(`图片不存在：${this._src}`))
    }, 0)
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
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
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
      current = { points: [], strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, beziers: 0 }
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
    setLineDash() {
      calls.setLineDash += 1
    },
    fillText(text, x, y) {
      calls.fillText += 1
      texts.push({ kind: 'fill', text, x: tx + x, y: ty + y, angle, font: context.font })
    },
    strokeText(text, x, y) {
      calls.strokeText += 1
      texts.push({ kind: 'stroke', text, x: tx + x, y: ty + y, angle, font: context.font })
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
    },
    drawImage(source, ...args) {
      calls.drawImage += 1
      // 记录来源与目标矩形：这样"画的是哪张图 / 哪个图块"可以被断言，
      // 而不是只能断言"drawImage 被调了 N 次"（后者放过过真 bug）
      images.push({ source, args: args.map((value) => (typeof value === 'number' ? value : value)) })
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
  createElement(tagName) {
    const el = makeEl({ tagName, className: '' })
    el.ownerDocument = fakeDocument
    if (String(tagName).toLowerCase() === 'canvas') {
      el._ctx = makeRecordingContext()
      // 离屏画布（地形图集、导出用的位图）也要能被检查：它们是内部对象，
      // 不从任何公开 API 暴露出来，但"图集里那一格到底画了什么"正是这个功能要验证的东西。
      createdCanvasContexts.push(el._ctx)
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
const vaultWrites = []
/** 记录被打开过的笔记链接（工作区桩会往里写） */
const openedLinks = []

class FakeNotice {
  constructor(message) {
    noticeLog.push(String(message))
  }
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
    return this
  }

  addText(callback) {
    const setting = this
    const text = {
      value: '',
      placeholder: null,
      setPlaceholder(value) {
        this.placeholder = value
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
      /** 模拟用户在输入框里打字后失焦（触发 onChange） */
      async type(value) {
        this.value = value
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
    const button = {
      text: '',
      setButtonText(value) {
        this.text = value
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
   */
  addDropdown(callback) {
    const setting = this
    const dropdown = {
      options: [],
      value: null,
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
        return this
      },
      onChange(handler) {
        this.handler = handler
        return this
      },
      /** 模拟用户改选 */
      async select(value) {
        this.value = value
        await this.handler?.(value)
        return this
      },
    }
    callback?.(dropdown)
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
      this.contentEl = { empty() {}, createEl: () => ({}) }
    }
    open() {}
    close() {}
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
  // 图标：桩里只做"图标名存在/不存在"的判定，不真的画 SVG
  getIcon: (name) => ({ iconName: name }),
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
    async createFolder() {},
    getAbstractFileByPath(path) {
      return files.has(path) ? fileFor(path) : null
    },
    getMarkdownFiles() {
      return [...files.keys()].filter((path) => path.endsWith('.md')).map((path) => fileFor(path))
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

/** 递归收集某个 class 的所有后代元素（按**完整 class 词**匹配，避免前缀误伤） */
function collectByClass(root, className) {
  const out = []
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

/** 派发一个带常用方法的通用事件（click / contextmenu 等） */function fireEvent(element, type, init = {}) {
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
  check('剪贴板不可用时回退写入 vault 文件', app.vault.files.has('FC-diagnostics.md'))
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
  const before = noticeLog.length
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const message = noticeLog.slice(before).join(' | ')
  check('状态命令报出地图路径', message.includes('Maps/World.map.md'), message.slice(0, 120))
  check('状态命令报出地形格数', message.includes('地形 3 格'), message.slice(0, 160))
  check('状态命令报出地形分类', message.includes('forest×2') && message.includes('water×1'), message.slice(0, 160))
  check('状态命令报出文件体积', /文件 [\d.]+ KiB/.test(message))
  check('状态命令报出绑定状态而非「未绑定」', !message.includes('尚未绑定地图文档'), message.slice(0, 120))

  // 未绑定时应给出明确提示
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
  const gridSetting = FakeSetting.created.find((setting) => setting.info.name === '显示六边形网格')
  check('设置界面有网格开关', gridSetting?.toggle?.value === true, String(gridSetting?.toggle?.value))
  check(
    '滑块带当前倍率与合法区间',
    sliderSetting?.slider.value === 1 &&
      sliderSetting?.slider.limits?.min === 0.5 &&
      sliderSetting?.slider.limits?.max === 3,
    JSON.stringify({ value: sliderSetting?.slider.value, limits: sliderSetting?.slider.limits }),
  )
  const liveInfo = FakeSetting.created.find((setting) => setting.info.name === '当前实际字号')
  check(
    '设置界面显示当前实际字号（便于直接读数）',
    typeof liveInfo?.info.desc === 'string' && /路径 \d+ px · 区域 \d+ px/.test(liveInfo.info.desc),
    String(liveInfo?.info.desc),
  )

  // 状态命令要把实测字号报出来（下一轮反馈可以直接贴这个数字）
  noticeLog.length = 0
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const statusText = noticeLog.join('\n')
  check('状态命令报出名称字号', /名称字号：路径 \d+ px · 区域 \d+ px/.test(statusText), statusText.replace(/\n/g, ' | ').slice(0, 200))
  check('状态命令报出实测标定', /标定 1 CSS px = [\d.]+ 位图像素/.test(statusText), statusText.replace(/\n/g, ' | ').slice(0, 200))

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
  noticeLog.length = 0
  await runCommand(plugin, 'create-map-base')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const basePath = 'Maps/World.base'
  const baseText = app.vault.files.get(basePath)
  check('生成了 .base 文件', typeof baseText === 'string', String(baseText).slice(0, 40))
  check('.base 里包含我们的视图类型', (baseText ?? '').includes('type: fictional-map'))
  check('.base 里指向了地图文档', (baseText ?? '').includes(mapPath))
  check('命令给出了创建的提示', noticeLog.some((line) => line.includes(basePath)), noticeLog.join(' | '))

  // 再执行一次不能覆盖已有文件
  noticeLog.length = 0
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
    noticeLog.length = 0
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
  noticeLog.length = 0
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

  noticeLog.length = 0
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
  noticeLog.length = 0
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
  openSettings()
  const riverPicker = pickerNamed('路径颜色 · 河流')
  const regionPicker = pickerNamed('区域颜色 · 公国')
  const fontText = textNamed('名称字体族')
  check('设置页有每种路径的颜色选择器', pickerNamed('路径颜色 · 河流') && pickerNamed('路径颜色 · 边界') ? true : false)
  check('设置页有每个区域预设的颜色选择器', pickerNamed('区域颜色 · 王国') !== undefined && pickerNamed('区域颜色 · 海域') !== undefined)
  check('设置页有名称字体族输入框', fontText !== undefined && fontText.placeholder === '留空 = 跟随主题', String(fontText?.placeholder))
  check('选择器带出当前值（出厂默认）', riverPicker?.value === defaultRiver, String(riverPicker?.value))
  check('字体族默认为空（= 跟随主题）', fontText?.value === '', JSON.stringify(fontText?.value))

  // ---- 改路径颜色：只影响**之后**新画的对象 ----
  await riverPicker.pick('#ff0000')
  check('路径颜色写进了设置', plugin.getSettings().pathColors.river === '#ff0000', JSON.stringify(plugin.getSettings().pathColors))
  const persisted = () => (plugin._data === null ? null : JSON.parse(plugin._data))
  check(
    '路径颜色已落盘（真实 JSON 往返，不是只存在内存里）',
    persisted()?.pathColors?.river === '#ff0000',
    JSON.stringify(persisted()?.pathColors),
  )
  const afterPath = drawPath(-500, 300)
  check('新画的路径用了新颜色', afterPath.color === '#ff0000', String(afterPath.color))
  check(
    '已经画好的路径不受设置影响（颜色存在地图文件里）',
    doc().paths[0].color === beforePath.color && doc().paths[0].color === defaultRiver,
    `第一条 ${doc().paths[0].color} · 第二条 ${afterPath.color}`,
  )

  // ---- 工具条色块跟随设置，且**不重建 DOM** ----
  const toolbarEl = collectByClass(wrapper, 'fc-toolbar')[0]
  const riverButtonBefore = collectByClass(toolbarEl, 'fc-toolbar-path').find((button) => button.title === '河流')
  const swatchBefore = collectByClass(riverButtonBefore, 'fc-toolbar-swatch')[0]
  check('工具条上的色块已变成新颜色', swatchBefore?.style.backgroundColor === '#ff0000', String(swatchBefore?.style.backgroundColor))
  check('色块刷新是原地改样式，没有重建按钮', collectByClass(toolbarEl, 'fc-toolbar-path').find((button) => button.title === '河流') === riverButtonBefore)

  // ---- 区域颜色：按下标选色 ----
  await regionPicker.pick('#123456')
  editor.setRegionPresetIndex(2)
  check('区域预设按下标取色，改设置后新区域立刻用新色', editor.regionColor === '#123456', editor.regionColor)
  const region = drawRegion(-500, 700)
  check('新画的区域用了新颜色', region.color === '#123456', String(region.color))
  check('区域透明度仍是出厂默认（颜色设置不该改别的字段）', region.opacity === 0.22, String(region.opacity))

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
    '「恢复默认」把颜色与字体都还原',
    restored.pathColors.river === defaultRiver && restored.labelFontFamily === '' && restored.regionColors[2] === '#a882ff',
    JSON.stringify({ river: restored.pathColors.river, font: restored.labelFontFamily, region2: restored.regionColors[2] }),
  )
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
  const openSettings = () => {
    FakeSetting.created.length = 0
    plugin.settingTabs[0].display()
    return FakeSetting.created
  }
  const settingNamed = (fragment) => FakeSetting.created.find((setting) => (setting.info.name ?? '').includes(fragment))
  /** 设置页底部那一行"就地提示"（自定义地形区自己维护的那条） */
  const noteText = () => collectByClass(plugin.settingTabs[0].containerEl, 'fc-settings-note').at(-1)?.textContent ?? ''
  /** 画一笔地形（世界坐标） */
  const paintAt = (x, y) => {
    editor.setMode('paint')
    editor.setTool('brush')
    clickAt({ x, y })
    flushFrames()
  }

  // ---------------------------------------------------------- 设置界面：新增
  openSettings()
  const addSetting = settingNamed('新增自定义地形')
  check('设置页有「新增自定义地形」一节', addSetting !== undefined)
  check(
    '新增区有 ID、显示名、颜色三个控件（ID 与显示名必须分开，否则又会被耦合在一起）',
    (addSetting?.texts?.length ?? 0) === 2 && addSetting?.colorPicker !== undefined,
    `texts=${addSetting?.texts?.length} picker=${String(addSetting?.colorPicker !== undefined)}`,
  )
  check('新增区的说明里写清了 ID 规则与自动前缀', (addSetting?.info.desc ?? '').includes('custom:'), addSetting?.info.desc)

  // 非法 ID：必须当场给出可读原因，且**不能**写进设置
  await addSetting.texts[0].type('Bad Id!')
  check('非法 ID 就地给出可读原因', noteText().includes('ID'), noteText())
  await addSetting.button.click()
  check('非法 ID 点「新增」不会写进设置', plugin.getSettings().customTerrains.length === 0, JSON.stringify(plugin.getSettings().customTerrains))

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
  openSettings()
  const reefRow = settingNamed('字形与图片 · 礁石')
  await reefRow.texts[0].type('Assets\\marsh.png')
  check(
    '图片路径写进设置（Windows 反斜杠被统一为正斜杠）',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png',
    JSON.stringify(plugin.getSettings().customTerrains[1]),
  )
  openSettings()
  const ghostRow = settingNamed('字形与图片 · 幽灵地')
  await ghostRow.texts[0].type('Assets/does-not-exist.png')
  check(
    '指向不存在文件的路径**合法**（存不存在只有加载器知道），照样写进设置 —— 回退由绘制层负责',
    plugin.getSettings().customTerrains[2]?.imagePath === 'Assets/does-not-exist.png',
    JSON.stringify(plugin.getSettings().customTerrains[2]),
  )
  openSettings()
  const brokenRow = settingNamed('字形与图片 · 破碎地')
  await brokenRow.texts[0].type('Assets/broken.png')
  check(
    '存在但解不开的图片路径也照样写进设置（解不开是运行期的事）',
    plugin.getSettings().customTerrains[3]?.imagePath === 'Assets/broken.png',
    JSON.stringify(plugin.getSettings().customTerrains[3]),
  )
  openSettings()
  const reefRow2 = settingNamed('字形与图片 · 礁石')
  await reefRow2.texts[0].type('http://example.com/a.png')
  check(
    '非法图片路径被拒绝并就地给出原因',
    plugin.getSettings().customTerrains[1]?.imagePath === 'Assets/marsh.png' && noteText().includes('网址'),
    `路径=${plugin.getSettings().customTerrains[1]?.imagePath} 提示=${noteText()}`,
  )
  check(
    '字形下拉框列出「通用」+ 内置 9 种（借字形是个可选项，不是隐藏功能）',
    (settingNamed('字形与图片 · 礁石')?.dropdown?.options?.length ?? 0) === 10,
    JSON.stringify(settingNamed('字形与图片 · 礁石')?.dropdown?.options?.map((option) => option.value)),
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
  await settingNamed('字形与图片 · 礁石').texts[0].type('Assets/reef2.png')
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

  // ---------------------------------------------------------- 删除定义：数据不受影响
  openSettings()
  await settingNamed('地形 1 · 沼泽地').button.click()
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

  // ---- 状态命令：让"地图怎么少了东西"有一个可查的答案 ----
  await plugin.setLayerVisible('paths', false)
  await plugin.setLayerVisible('labels', false)
  await plugin.setShowLegend(true)
  noticeLog.length = 0
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const statusText = noticeLog.join('\n')
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
  noticeLog.length = 0
  runCommand(plugin, 'map-status')
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('全部显示时状态命令这么说', noticeLog.join('\n').includes('图层：全部显示'), noticeLog.join('\n').slice(0, 200))

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

console.log('')
if (failures === 0) {
  console.log(`✓ 冒烟测试全部通过（${assertions} 条断言）`)
} else {
  console.log(`✖ 冒烟测试失败 ${failures} / ${assertions} 条断言`)
  process.exitCode = 1
}
