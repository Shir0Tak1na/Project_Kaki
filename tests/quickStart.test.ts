/**
 * 「快速上手」两清单的契约测试。
 *
 * 为什么值得单测：这两份清单是**纯数据**（`quickStart.ts` 不 import obsidian），
 * 而它们最容易出的错不是"渲染不出来"，而是**内容层面的退化**：
 * 某一步的说明忘了写、两份文案被抄成同一份、指路的 `commandId` 拼错成不存在的命令。
 * 前两类在这里就能钉死；第三类需要拿到真实的命令注册表，放在冒烟里断言
 * （单测 import 不了 `main.ts` —— 它 import obsidian，ESM + 类型剥离环境下跑不起来）。
 *
 * 用户的两条明确要求也在这里留痕：
 * 1. **两份文案各自介绍各自的用法**，不是同一份贴两处；
 * 2. 定义管理搬走后，设置页那份里必须仍有一条**指路**（否则用户就找不到新入口了）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { QUICK_START_PANEL, QUICK_START_SETTINGS } from '../src/ui/quickStart.ts'

const BOTH = [
  ['设置页', QUICK_START_SETTINGS],
  ['面板', QUICK_START_PANEL],
] as const

test('两份清单都不为空，且每一条的标题与说明都真的写了字', () => {
  for (const [name, list] of BOTH) {
    assert.ok(list.length > 0, `${name}那份不能是空的`)
    for (const item of list) {
      assert.notEqual(item.title.trim().length, 0, `${name} / 标题不能为空`)
      assert.notEqual(item.hint.trim().length, 0, `${name} / ${item.title} 的说明不能为空`)
      // 说明不能只是把标题抄一遍（那样等于没说"怎么做"）
      assert.notEqual(item.hint.trim(), item.title.trim(), `${name} / ${item.title} 的说明不能等于标题`)
    }
  }
})

test('同一份清单里标题不重复（重复的步骤会让用户以为要照着做两遍）', () => {
  for (const [name, list] of BOTH) {
    const titles = list.map((item) => item.title)
    assert.equal(new Set(titles).size, titles.length, `${name}那份里有重复标题：${titles.join(' / ')}`)
  }
})

test('两份不是同一份文案（各自介绍各自的入口，而不是一份贴两处）', () => {
  const settingsTitles = QUICK_START_SETTINGS.map((item) => item.title)
  const panelTitles = QUICK_START_PANEL.map((item) => item.title)
  assert.notDeepEqual(settingsTitles, panelTitles, '两份清单的标题序列完全相同 = 没有各自讲各自的用法')
})

test('出现 commandId 的条目都必须是合法的命令 id 形状（小写字母开头，可含数字与连字符）', () => {
  for (const [name, list] of BOTH) {
    for (const item of list) {
      if (item.commandId === undefined) continue
      assert.match(item.commandId, /^[a-z][a-z0-9-]*$/, `${name} / ${item.title} 的 commandId 形状不对：${item.commandId}`)
    }
  }
})

test('设置页那份里有一条指向「地图定义」的指路（定义管理搬走后不能只剩一句话都没有）', () => {
  const entry = QUICK_START_SETTINGS.find((item) => item.commandId === 'manage-definitions')
  assert.notEqual(entry, undefined, '设置页那份必须有一条把用户导向「地图定义」的条目')
  assert.ok(
    entry !== undefined && /定义/.test(entry.hint),
    '那一条的说明里要点出它管的是"定义"（否则用户不知道那是新家）',
  )
})

test('两份清单里都至少各有一条"能一键执行"的条目（全是纯文字就等于什么都没给）', () => {
  for (const [name, list] of BOTH) {
    assert.ok(
      list.some((item) => item.commandId !== undefined),
      `${name}那份里没有任何带 commandId 的条目`,
    )
  }
})