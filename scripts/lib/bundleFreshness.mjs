/**
 * 「产物是否新鲜」门禁 —— 冒烟与部署**共用**。
 *
 * 为什么必须有这道门禁，而不是写一句"记得先构建"：
 * 本项目已经被这条陷阱咬过两次，第二次更糟 —— 有人拿旧产物跑出失败，
 * 据此推断出"异常被 `void` 吞掉了"，还照着这个**错误前提**做了一处修复
 * （见 `docs/ENGINEERING-NOTES.md` §5.17）。文档提醒拦不住它，所以改成**拒绝运行**。
 *
 * 两处的后果不同，但都是"人会得出错误结论"：
 * - **冒烟**跑旧产物 → 新写的断言全红，看起来像自己写错了；
 * - **部署**复制旧产物 → 用户在真实 Obsidian 里验证的是**过期的代码**，而且他无从知道
 *   （这是最难受的一种：界面真实、结论错误）。
 *
 * 判据只看 `src/`：产物由它编译而来；`styles.css` 不参与打包（部署时原样复制），
 * 它变新不该拦住任何事情。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 递归找出 `src/` 下最新的那个文件；没有 `src/` 时返回 null */
export function newestSourceFile(root) {
  const sourceRoot = path.join(root, 'src')
  if (!fs.existsSync(sourceRoot)) return null
  let newest = null
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const mtimeMs = fs.statSync(full).mtimeMs
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs }
    }
  }
  walk(sourceRoot)
  return newest
}

/**
 * 时间戳：**手写而不用 `toLocaleString`**。
 *
 * 后者受运行环境的 ICU 版本与区域设置影响（同一时刻在不同机器上打印不同），
 * 而这个字符串是要贴进报告里当证据的 —— 证据必须是确定的。
 * 同样的理由写在 `resourceBundle.ts` 的排序里（那边因此不用 `localeCompare`）。
 */
export function stamp(mtimeMs) {
  const date = new Date(mtimeMs)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 检查产物是否新鲜；不新鲜就打印证据并 `process.exit(1)`。
 *
 * **没有"警告后继续"的开关**：那等于没拦，而这里要防的正是"人看到警告仍然继续"。
 *
 * @param {{ root: string, action: string, bundleName?: string }} options
 *   `root` 仓库根目录；`action` 用来把提示写得具体（例如"冒烟"或"部署"）
 */
export function assertBundleIsFresh({ root, action, bundleName = 'main.js' }) {
  const bundlePath = path.join(root, bundleName)
  if (!fs.existsSync(bundlePath)) {
    console.error(
      `✖ 还没有构建产物：请先跑 \`node scripts/build.mjs\`。\n` +
        `  （${action}要用的是打包产物 ${bundleName}，不是源码 —— 没有它就没有可用的东西。）`,
    )
    process.exit(1)
  }

  const newest = newestSourceFile(root)
  if (newest === null) return

  const bundleTime = fs.statSync(bundlePath).mtimeMs
  if (newest.mtimeMs <= bundleTime) return

  console.error(
    [
      `✖ 拒绝${action}：源码比产物新 —— 请先 \`node scripts/build.mjs\` 再跑。`,
      `    最新源码：${path.relative(root, newest.path)}（${stamp(newest.mtimeMs)}）`,
      `    产物：${bundleName}（${stamp(bundleTime)}）`,
      `  拿旧产物跑出来的结果不是真的结果：${action === '部署' ? '你会在真实界面里验证一份过期的代码。' : '它只会制造错误结论。'}`,
    ].join('\n'),
  )
  process.exit(1)
}
