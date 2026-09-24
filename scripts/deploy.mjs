/**
 * 把构建产物部署到一个 Obsidian 库的插件目录。
 *
 * 默认目标是仓库内的隔离测试库（../test-vault），不会碰你的真实库。
 * 要装进真实库时显式指定：
 *   $env:FC_VAULT="D:\你的库"; npm run deploy
 */

import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { assertBundleIsFresh } from './lib/bundleFreshness.mjs'

const PLUGIN_ID = 'project-kaki'
/**
 * 改过名的旧插件目录。部署时会：
 * 1. 把旧目录里的 `data.json`（插件设置）搬到新目录 —— 否则用户的字号/网格设置会白丢；
 * 2. 删掉旧目录 —— 否则 Obsidian 里会同时出现两个插件（正是"两个名字一起用"的来源）。
 */
const LEGACY_PLUGIN_IDS = ['fictional-cartographer']
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css']

const repoRoot = path.resolve(import.meta.dirname, '..')
const vaultPath = path.resolve(process.env.FC_VAULT ?? path.join(repoRoot, '..', 'test-vault'))
const targetDir = path.join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID)

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  // 门禁：产物必须比源码新。部署一份**过期的构建**是最难受的一种情况 ——
  // 用户在真实 Obsidian 里验证的是旧代码，而且他无从知道（详见 lib/bundleFreshness.mjs 的说明）。
  assertBundleIsFresh({ root: repoRoot, action: '部署' })

  if (!(await exists(path.join(repoRoot, 'main.js')))) {
    console.error('✗ 找不到 main.js —— 请先运行 npm run build')
    process.exitCode = 1
    return
  }

  if (!(await exists(vaultPath))) {
    console.error(`✗ 目标库不存在：${vaultPath}\n  用 FC_VAULT 环境变量指定一个已存在的库。`)
    process.exitCode = 1
    return
  }

  await mkdir(targetDir, { recursive: true })
  for (const file of ARTIFACTS) {
    const from = path.join(repoRoot, file)
    if (!(await exists(from))) {
      console.warn(`· 跳过缺失的产物：${file}`)
      continue
    }
    await copyFile(from, path.join(targetDir, file))
  }

  const pluginsDir = path.join(vaultPath, '.obsidian', 'plugins')
  for (const legacyId of LEGACY_PLUGIN_IDS) {
    const legacyDir = path.join(pluginsDir, legacyId)
    if (!(await exists(legacyDir))) continue
    const legacyData = path.join(legacyDir, 'data.json')
    const newData = path.join(targetDir, 'data.json')
    if ((await exists(legacyData)) && !(await exists(newData))) {
      await copyFile(legacyData, newData)
      console.log(`· 已把旧插件目录里的设置搬到新目录（${legacyId} → ${PLUGIN_ID}）`)
    }
    await rm(legacyDir, { recursive: true, force: true })
    console.log(`· 已移除改名前的旧插件目录：${legacyId}`)
  }

  // 确保插件在库的启用列表里（同时清掉改名前的旧 id）
  const communityPath = path.join(vaultPath, '.obsidian', 'community-plugins.json')
  let enabled = []
  if (await exists(communityPath)) {
    try {
      const parsed = JSON.parse(await readFile(communityPath, 'utf8'))
      if (Array.isArray(parsed)) {
        enabled = parsed.filter((id) => typeof id === 'string' && !LEGACY_PLUGIN_IDS.includes(id))
      }
    } catch {
      console.warn('· community-plugins.json 解析失败，将重建')
    }
  }
  if (!enabled.includes(PLUGIN_ID)) enabled.push(PLUGIN_ID)
  await writeFile(communityPath, `${JSON.stringify(enabled, null, 2)}\n`, 'utf8')

  console.log(`✓ 已部署到 ${targetDir}`)
  console.log(`  启用列表：${enabled.join(', ')}`)
  console.log('  若该库从未启用社区插件，请在 Obsidian 里点一次「启用社区插件」。')
}

await main()
