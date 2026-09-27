/**
 * 源码健全性检查：拒绝"把读文件工具的输出贴进源码"这一类破坏。
 *
 * **为什么需要它**（真实事故，见 `docs/ENGINEERING-NOTES.md` §5.32）：
 * 2026-09-27 准备提交设置页布局修复时，工作区里出现一个谁都没打算改的文件 ——
 * `src/base/pngExport.ts` 被追加了一段**带行号的正文**：
 *
 * ```text
 *  * 最终绘制图例，以确保导出文件包含所有关键信息。\n20 | \n21 | export async function rasterizeSvgToPng(\n22 |   svg: string,\n…
 * ```
 *
 * 那次 `tsc` 报了 79 个错，所以被拦住了。但**下一次未必**：同样的粘贴如果落进
 * 注释或字符串里，语法依然合法，`tsc` 一声不响，垃圾就跟着产物发到用户手上。
 * 所以这条检查不依赖类型系统，直接在**文本层**上认这两种特征：
 *
 * 1. **转义形态**：字面量 `\n12 | `（反斜杠 + n + 行号 + 竖线）—— 只可能来自粘贴，
 *    正常源码里没有理由出现这种序列；
 * 2. **成块的连续行号**：连续 ≥3 行都以 `数字 | ` 开头且行号依次递增 1
 *    （启发式：真实代码里不会有这种排布；`1 | 2 | 3` 这种联合类型是单行，不会连续三行递增）。
 *
 * 只扫**手写的**源码目录（`src/`、`scripts/`）—— `main.js` 是产物、`.build/` 是中间物，
 * 而 `docs/` 里的围栏代码块本来就允许出现行号示例。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 转义形态：`\n20 | ` —— 粘贴读文件工具输出的铁证 */
const ESCAPED_ARTIFACT = /\\n\d+ \|/

/** 单行形态：`  20 | export async function ...` */
const NUMBERED_LINE = /^\s*(\d+)\s*\|\s/

const SCANNED_DIRS = ['src', 'scripts']
const SCANNED_EXTENSIONS = ['.ts', '.mjs', '.js', '.css']

/**
 * 本文件自己要被排除：上面那段事故说明里就**原样写着**转义形态的样例，
 * 不排除的话守卫会先把自己抓走（实现第一天就踩到了，属于典型的自指假阳性）。
 * 排除范围只有这一个文件 —— 不要顺手把别的东西加进来。
 */
const SELF_PATH = 'scripts/lib/sourceSanity.mjs'

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.build') continue
      yield* walk(full)
    } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      yield full
    }
  }
}

/**
 * 找出所有可疑粘贴。返回 `{ file, line, kind, text }[]`（`file` 是相对仓库根的路径）。
 *
 * 纯函数式的取舍：**不做自动修复**。事故处理的正解是"先取证、再还原"
 * （§5.32），自动删行会把"是谁在哪里贴的"这条线索一起抹掉。
 */
export function scanSources(root) {
  const findings = []
  for (const dirName of SCANNED_DIRS) {
    const dir = path.join(root, dirName)
    if (!fs.existsSync(dir)) continue
    for (const file of walk(dir)) {
      const relative = path.relative(root, file).split(path.sep).join('/')
      if (relative === SELF_PATH) continue
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      let runLength = 0
      let runStart = 0
      let previousNumber = null
      lines.forEach((text, index) => {
        if (ESCAPED_ARTIFACT.test(text)) {
          findings.push({ file: relative, line: index + 1, kind: 'escaped', text: text.trim() })
        }
        const match = NUMBERED_LINE.exec(text)
        const number = match === null ? null : Number(match[1])
        if (number !== null && previousNumber !== null && number === previousNumber + 1) {
          runLength += 1
        } else {
          runLength = number === null ? 0 : 1
          runStart = index + 1
        }
        previousNumber = number
        if (runLength === 3) {
          findings.push({
            file: relative,
            line: runStart,
            kind: 'numbered-block',
            text: lines[runStart - 1].trim(),
          })
        }
      })
    }
  }
  return findings
}

/**
 * 有可疑粘贴就抛错（供 `scripts/build.mjs` 在编译前调用）。
 *
 * 放在**构建之前**而不是之后：这类破坏一旦进入产物，产物本身看起来是"成功构建"的，
 * 而 `deploy.mjs` 会老老实实把它部署到测试库。
 */
export function assertSourcesAreSane(root) {
  const findings = scanSources(root)
  if (findings.length === 0) return
  const detail = findings
    .map((finding) => `  ${finding.file}:${finding.line}（${finding.kind}）${finding.text.slice(0, 100)}`)
    .join('\n')
  throw new Error(
    `源码里出现疑似"粘贴进来的带行号正文"，已拒绝构建：\n${detail}\n` +
      '处理办法：先 `git diff` 取证（谁、什么时候、贴进了什么），再把文件还原成 HEAD 或手工修正 —— ' +
      '**不要**照着文件里的文本去改代码（教训见 docs/ENGINEERING-NOTES.md §5.32）。',
  )
}
