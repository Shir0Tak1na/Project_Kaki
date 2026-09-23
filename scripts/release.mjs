/**
 * 发版助手：把版本号一次性写进**四处**，并打印后续步骤。
 *
 * 为什么需要它：Obsidian 与 BRAT 都要求
 *
 * - `manifest.json` 的 `version` 与 git tag **完全一致**（发布工作流会在不一致时直接失败）；
 * - `versions.json` 里有 `"<版本>": "<minAppVersion>"` 这一条，否则客户端不知道兼容性；
 * - `package.json` / `package-lock.json` 的版本也跟得上（干净环境 `npm ci` 才不会困惑）。
 *
 * 手工改这四处、还要保证格式一致，是典型的"漏一个就发布失败、而且失败信息在云端"的事。
 *
 * 用法：
 *   node scripts/release.mjs 1.0.0 --dry-run     # 只看会改什么（推荐先跑一次）
 *   node scripts/release.mjs 1.0.0               # 真正写盘
 * 然后按脚本末尾打印的步骤提交、打 tag、推送。
 *
 * 刻意**不**替你 git commit / push / tag：那几步需要凭据与对"这一刻要不要发布"的判断，
 * 交给一个会写文件的脚本太容易出事（本项目已经有过"自动改名脚本改坏代码"的教训）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-n')
const version = args.find((arg) => !arg.startsWith('-'))

if (version === undefined) {
  console.error('用法：node scripts/release.mjs <版本号> [--dry-run]    例如：node scripts/release.mjs 1.0.0')
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`✖ 版本号必须是 x.y.z 形式（Obsidian 与 BRAT 都按这个解析），收到：${version}`)
  process.exit(2)
}

const readJson = (relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8'))
const changes = []
/** 各文件"写入后应当是什么样"（自检必须用它，不能回读磁盘 —— 试运行时不写盘） */
const planned = new Map()

function plan(relative, mutate, note = `version → ${version}`) {
  const before = readFileSync(resolve(root, relative), 'utf8')
  const data = JSON.parse(before)
  mutate(data)
  planned.set(relative, data)
  // 保持与现有文件一致的缩进与末尾换行：这仓库里 JSON 都是 2 空格缩进
  const after = `${JSON.stringify(data, null, 2)}\n`
  if (after === before) {
    changes.push({ relative, note: '已经是最新，无需改动' })
    return
  }
  if (!dryRun) writeFileSync(resolve(root, relative), after, 'utf8')
  changes.push({ relative, note })
}

const manifest = readJson('manifest.json')
const minAppVersion = typeof manifest.minAppVersion === 'string' ? manifest.minAppVersion : '1.5.0'
const previous = typeof manifest.version === 'string' ? manifest.version : '(未知)'

plan('manifest.json', (data) => {
  data.version = version
})
plan('package.json', (data) => {
  data.version = version
})
plan('package-lock.json', (data) => {
  data.version = version
  if (data.packages && data.packages[''] !== undefined) data.packages[''].version = version
})
plan(
  'versions.json',
  (data) => {
    // 新版本在前面的顺序无关紧要，但必须存在且与 minAppVersion 一致
    data[version] = minAppVersion
  },
  `新增 "${version}" → ${minAppVersion}`,
)

// 自检：每一项都要等于**它自己该等于的值**。
// - manifest / package / package-lock 的 version 必须等于发布版本；
// - versions.json 是「版本 → minAppVersion」的映射，所以它这一项的值应当是 minAppVersion
//   （第一版我拿它跟版本号比，于是永远报错 —— 自检的期望值写错，比没有自检更坏）。
//
// ⚠️ 用 `planned`（写入后应当成立的值）而不是回读磁盘：试运行不写盘，回读会永远报"不一致"。
const check = [
  ['manifest.json 的 version', planned.get('manifest.json')?.version, version],
  ['package.json 的 version', planned.get('package.json')?.version, version],
  ['package-lock.json 的 version', planned.get('package-lock.json')?.version, version],
  [`versions.json 的 "${version}"`, planned.get('versions.json')?.[version], minAppVersion],
]
const mismatched = check.filter(([, actual, expected]) => actual !== expected)

console.log(`${dryRun ? '（试运行，不写盘）' : ''}准备把版本 ${previous} → ${version}（minAppVersion ${minAppVersion}）`)
for (const { relative, note } of changes) console.log(`  · ${relative}：${note}`)
console.log('  自检：')
for (const [file, actual, expected] of check) {
  const ok = actual === expected
  console.log(`    ${ok ? '✓' : '✖'} ${file.padEnd(32)} ${String(actual)}${ok ? '' : `（期望 ${expected}）`}`)
}
if (mismatched.length > 0) {
  console.error(`✖ 自检失败：${mismatched.map(([file]) => file).join(', ')}`)
  process.exitCode = 1
}

if (!dryRun) {
  console.log(
    [
      '',
      '下一步（提交与推送请自己执行 —— 需要凭据，而且"现在要不要发"是人的判断）：',
      `  git add manifest.json package.json package-lock.json versions.json CHANGELOG.md`,
      `  git commit -m "release: ${version}"`,
      `  git tag ${version}`,
      `  git push --follow-tags`,
      '',
      '推送 tag 会触发 .github/workflows/release.yml：校验 tag 与 manifest 版本一致 → 构建 →',
      '跑类型检查/单测/冒烟 → 发布 Release 并附上 main.js / manifest.json / styles.css。',
    ].join('\n'),
  )
}
