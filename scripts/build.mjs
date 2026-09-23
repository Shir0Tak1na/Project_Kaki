/**
 * 构建脚本：把 src/ 编译并打包成 Obsidian 需要的单个 main.js。
 *
 * 为什么不用 esbuild：原生 esbuild 需要 spawn 子进程并用命名管道通信，
 * 在只允许写工作区的受限沙箱里会被拒绝（spawn EPERM），esbuild 的 WASM 版在
 * Node 下同样要 spawn。这里改用 **TypeScript 编译器 API + 自写内联**：
 *
 *   1. 用 ts.createProgram() 在**当前进程内**编译（同时也是类型检查）；
 *   2. 把 tsc 产出的每个 CommonJS 模块内联进一张模块表，生成单文件 main.js。
 *
 * 不 spawn 任何子进程、不需要额外权限，产出与 esbuild 打包结果等价。
 * （机器上没有沙箱限制时，仍可用 npm run build:esbuild 走原生 esbuild。）
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const buildDir = path.join(root, '.build')
const outFile = path.join(root, 'main.js')
const entryId = 'main.js'
const watchMode = process.argv.includes('--watch')

const banner = `/*
Project Kaki — 生成文件，请勿手工编辑。
源码在 src/，由 scripts/build.mjs 编译打包（tsc 编译器 API + 模块内联）。
*/`

// ---------------------------------------------------------------- 编译

function compile() {
  const configPath = path.join(root, 'tsconfig.build.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const emitResult = program.emit()

  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]
  if (diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
  }
}

// ---------------------------------------------------------------- 模块收集

function walkJsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJsFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function toId(filePath) {
  return path.relative(buildDir, filePath).split(path.sep).join('/')
}

const REQUIRE_RE = /require\(\s*(["'])([^"']+)\1\s*\)/g

function collectModules() {
  /** @type {Map<string, string>} */
  const modules = new Map()
  for (const file of walkJsFiles(buildDir)) {
    modules.set(toId(file), fs.readFileSync(file, 'utf8'))
  }
  return modules
}

/** 把 `./core/hex.js` 这类相对说明符解析成模块 id */
function resolveSpecifier(modules, fromId, spec) {
  const base = path.posix.dirname(fromId)
  const target = path.posix.normalize(path.posix.join(base, spec))
  for (const candidate of [target, `${target}.js`, `${target}/index.js`]) {
    if (modules.has(candidate)) return candidate
  }
  return null
}

function buildDependencyMap(modules) {
  /** @type {Record<string, Record<string, string>>} */
  const deps = {}
  const unresolved = []

  for (const [id, source] of modules) {
    const perModule = {}
    for (const match of source.matchAll(REQUIRE_RE)) {
      const spec = match[2]
      if (!spec.startsWith('.')) continue // 外部依赖（obsidian 等）交给宿主 require
      const resolved = resolveSpecifier(modules, id, spec)
      if (resolved === null) unresolved.push(`${id} → ${spec}`)
      else perModule[spec] = resolved
    }
    deps[id] = perModule
  }

  if (unresolved.length > 0) {
    throw new Error(`存在无法解析的模块引用：\n  ${unresolved.join('\n  ')}`)
  }
  return deps
}

// ---------------------------------------------------------------- 代码生成

function renderBundle(modules, deps) {
  const parts = [banner, '"use strict";', '']
  parts.push('// 由 scripts/build.mjs 生成：模块表')
  parts.push('var __fcModules = {')
  const ids = [...modules.keys()].sort()
  // 入口放最后，便于阅读
  const ordered = [...ids.filter((id) => id !== entryId), ...ids.filter((id) => id === entryId)]
  for (const id of ordered) {
    parts.push(`${JSON.stringify(id)}: function (module, exports, require) {`)
    parts.push(modules.get(id))
    parts.push('},')
  }
  parts.push('};')
  parts.push('')
  parts.push('var __fcDeps = ' + JSON.stringify(deps, null, 0) + ';')
  parts.push('')
  parts.push(`var __fcHostRequire = (function () {
  // Obsidian 以 CommonJS 包装加载 main.js，因此 require 通常存在；
  // 这里同时兼容 module.require，避免宿主包装形态变化时整个插件加载失败。
  if (typeof require === 'function') return require;
  if (typeof module === 'object' && module && typeof module.require === 'function') {
    return module.require.bind(module);
  }
  return function (id) {
    throw new Error('无法加载外部模块：' + id);
  };
})();`)
  parts.push('')
  parts.push(`var __fcCache = Object.create(null);

function __fcLoad(id) {
  if (__fcCache[id] !== undefined) return __fcCache[id].exports;
  var module = { exports: {} };
  __fcCache[id] = module;
  var deps = __fcDeps[id] || {};
  var localRequire = function (spec) {
    var target = Object.prototype.hasOwnProperty.call(deps, spec) ? deps[spec] : null;
    if (target !== null) return __fcLoad(target);
    return __fcHostRequire(spec);
  };
  __fcModules[id].call(module.exports, module, module.exports, localRequire);
  return module.exports;
}`)
  parts.push('')
  parts.push(`// Obsidian 需要模块直接导出插件类；兼容 default 导出与直接导出两种形态
var __fcEntry = __fcLoad(${JSON.stringify(entryId)});
module.exports = (__fcEntry && __fcEntry.default) || __fcEntry;`)
  parts.push('')
  return parts.join('\n')
}

// ---------------------------------------------------------------- 主流程

function buildOnce() {
  compile()
  const modules = collectModules()
  if (!modules.has(entryId)) {
    throw new Error(`编译产物中找不到入口 ${entryId}（检查 tsconfig.build.json 的 rootDir/outDir）`)
  }
  const deps = buildDependencyMap(modules)
  const code = renderBundle(modules, deps)

  const tempFile = `${outFile}.tmp`
  fs.writeFileSync(tempFile, code, 'utf8')
  fs.renameSync(tempFile, outFile)

  const kib = (Buffer.byteLength(code) / 1024).toFixed(1)
  console.log(`✓ 构建完成：main.js（${modules.size} 个模块，${kib} KiB）`)
}

function startWatch() {
  buildOnce()
  let timer = null
  fs.watch(path.join(root, 'src'), { recursive: true }, (_event, filename) => {
    if (filename && !filename.endsWith('.ts')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        buildOnce()
      } catch (error) {
        console.error(error instanceof Error ? error.message : error)
      }
    }, 120)
  })
  console.log('✓ 已进入 watch 模式（Ctrl+C 退出）')
}

try {
  if (watchMode) startWatch()
  else buildOnce()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
