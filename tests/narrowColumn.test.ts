/**
 * 窄栏（约 300px）不横向溢出的**机器可判**那一半（W7）。
 *
 * 人眼那一半（真实 Obsidian 里的观感）永远要人看 —— 这里只盯最容易回归的两件事：
 * ① 面板类规则里不许出现 ≥300px 的固定宽度（侧栏最窄就约 300px）；
 * ② 轴与图层行必须允许换行 / 收缩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'styles.css'), 'utf8')

test('面板类规则里没有 ≥300px 的固定宽度（否则窄栏会撑出横向滚动条）', () => {
  const offenders: string[] = []
  for (const block of css.split('}')) {
    const parts = block.split('{')
    if (parts.length < 2) continue
    const selector = parts.slice(0, -1).join('{').split('\n').filter((line) => line.includes('.fc-')).join(' ')
    if (selector.trim().length === 0) continue
    const declarations = parts[parts.length - 1]!
    for (const match of declarations.matchAll(/(?:^|;)\s*(min-width|width)\s*:\s*(\d+)px/g)) {
      if (Number(match[2]) >= 300) offenders.push(selector.trim() + ' → ' + match[1] + ': ' + match[2] + 'px')
    }
  }
  assert.deepEqual(offenders, [], '这些规则会把窄栏撑出横向滚动条：\n' + offenders.join('\n'))
})

test('轴与图层行允许换行 / 收缩（窄栏里不硬撑）', () => {
  assert.match(css, /\.fc-ramp-inspector\s*\{[^}]*flex-wrap:\s*wrap/s)
  assert.match(css, /\.fc-layer-row\s*\{[^}]*min-width:\s*0/s)
  assert.match(css, /\.fc-panel\s+\.setting-item-info\s*\{[^}]*min-width:\s*0/s)
})
