/**
 * 打包脚本。
 *
 * 正常情况下使用原生 esbuild（快）。但在只允许写工作区的受限沙箱里，
 * 原生 esbuild 需要 spawn 一个子进程并通过命名管道通信，会被直接拒绝（spawn EPERM）。
 * 因此这里做一次回退：改用 esbuild-wasm —— 同一个 esbuild，编译成 WASM 后在
 * **当前 Node 进程内**运行，不需要任何子进程或额外权限。
 *
 * 两条路径产出完全相同的 main.js；使用哪条会打印出来。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const production = process.argv[2] === 'production'

const banner = `/*
Fictional Cartographer — 生成文件，请勿手工编辑。
源码在 src/，由 esbuild.config.mjs 打包。
*/`

/** @type {import('esbuild').BuildOptions} */
const options = {
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  // 'obsidian' 与 Electron/CodeMirror 由宿主提供，必须保持 external
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
}

function isSpawnDenied(error) {
  const code = error?.code
  return code === 'EPERM' || error?.errno === -4048
}

/** 原生 esbuild：生产模式单次构建，开发模式进入 watch */
async function buildWithNative() {
  const esbuild = await import('esbuild')

  if (production) {
    await esbuild.build(options)
    return
  }

  const context = await esbuild.context(options)
  await context.watch()
  console.log('✓ 原生 esbuild 已进入 watch 模式（Ctrl+C 退出）')
}

/** WASM 回退：进程内编译；watch 用 fs.watch 自己实现 */
async function buildWithWasm() {
  const esbuild = await import('esbuild-wasm')
  await esbuild.initialize({ worker: false })

  if (production) {
    await esbuild.build(options)
    return
  }

  await esbuild.build(options)

  let timer = null
  const rebuild = (file) => {
    if (file && !file.endsWith('.ts')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await esbuild.build(options)
        console.log('✓ 已重新构建')
      } catch (error) {
        console.error('✗ 构建失败：', error instanceof Error ? error.message : error)
      }
    }, 120)
  }

  fs.watch('src', { recursive: true }, (_event, filename) => rebuild(filename))
  console.log('✓ esbuild-wasm 已进入 watch 模式（Ctrl+C 退出）')
}

async function main() {
  try {
    await buildWithNative()
    if (production) console.log('✓ 使用原生 esbuild 打包完成')
    return
  } catch (error) {
    if (!isSpawnDenied(error)) throw error
    console.warn('· 原生 esbuild 无法启动（spawn EPERM，受限沙箱的正常现象），改用 esbuild-wasm 进程内编译')
  }

  await buildWithWasm()
  if (production) console.log('✓ 使用 esbuild-wasm 打包完成')
}

await main()
