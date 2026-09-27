/**
 * 格上"不认识的字段"必须原样保留 —— 这是给未来"一格多值"（温度带、深度分层…）留的接缝。
 *
 * 赌注很直接：以后新版本往格上写了 `temp`，用户用老版本打开一次再保存，
 * 如果那些值被丢掉，就是**永久数据丢失**。所以这里盯三件事：
 * 1. 保留（值、嵌套结构都要原样）；
 * 2. **写回时是摊平的**（`"temp": 12` 而不是 `"extra": {"temp": 12}`）—— 嵌套等于换了位置，别的版本认不出来；
 * 3. 已知键（`t`/`f`/`c`）行为一字不变，且未知字段不会污染它们。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createEmptyMapDocument, parseMapDocument, serializeMapDocument } from '../src/data/mapDocument.ts'

function parseWithCells(cells: Record<string, unknown>) {
  const input = { ...createEmptyMapDocument({}), terrain: cells }
  return parseMapDocument(JSON.parse(JSON.stringify(input)))
}

test('格上的未知字段被原样保留（值、嵌套对象、数组都一样）', () => {
  const result = parseWithCells({
    '0_0': { t: 'forest', temp: 12, depth: { level: 3, tags: ['a', 'b'] } },
  })
  assert.equal(result.ok, true)
  const cell = result.document?.terrain['0_0']
  assert.equal(cell?.t, 'forest')
  assert.deepEqual(cell?.extra, { temp: 12, depth: { level: 3, tags: ['a', 'b'] } })
})

test('写回时是摊平的：文件里没有 "extra" 这个键，未知字段直接挂在格上', () => {
  const parsed = parseWithCells({ '0_0': { t: 'forest', temp: 12 } })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"extra"'), false, '不允许把未知字段塞进 extra 嵌套层')
  assert.equal(text.includes('"temp":12'), true, text)
  // 再解析一次：形状与第一次完全一致（往返稳定）
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.terrain['0_0'], parsed.document?.terrain['0_0'])
})

test('未知字段不会污染已知键：t/f/c 的收敛规则照旧', () => {
  const result = parseWithCells({
    '1_1': { t: 'river', f: 3.7, c: '#123456', temp: 8 },
    // f = 0 是"缺省"（与既有规则一致：不写回 0），未知字段不受影响
    '2_2': { t: 'road', f: 0, extraUnknown: 'kept' },
  })
  const withFlags = result.document?.terrain['1_1']
  assert.equal(withFlags?.f, 3)
  assert.equal(withFlags?.c, '#123456')
  assert.deepEqual(withFlags?.extra, { temp: 8 })
  const zeroFlag = result.document?.terrain['2_2']
  assert.equal(zeroFlag?.f, undefined)
  assert.deepEqual(zeroFlag?.extra, { extraUnknown: 'kept' })
  const text = serializeMapDocument(result.document!)
  assert.equal(/"t":"road"/.test(text), true)
  assert.equal(text.includes('"f":0'), false, 'f=0 依旧不写回')
})

test('未知格字段只告警一次，并列出字段名（不按格刷屏）', () => {
  const cells = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`${index}_0`, { t: 'forest', temp: 1, depth: 2 }]),
  )
  const result = parseWithCells(cells)
  const warnings = result.issues.filter((issue) => issue.message.includes('不认识的字段'))
  assert.equal(warnings.length, 1, JSON.stringify(result.issues.map((issue) => issue.message)))
  assert.match(warnings[0]!.message, /"depth"/)
  assert.match(warnings[0]!.message, /"temp"/)
  assert.match(warnings[0]!.message, /已原样保留/)
})

test('没有未知字段时一条告警都不发（别把正常地图也刷上警告）', () => {
  const result = parseWithCells({ '0_0': { t: 'forest', f: 1, c: '#fff' } })
  assert.equal(result.issues.filter((issue) => issue.message.includes('不认识的字段')).length, 0)
})

test('顶层未知段落的保留是既有能力（回归：别在改格的时候把它弄坏）', () => {
  const input = { ...createEmptyMapDocument({}), temperature: { bands: [1, 2] } }
  const parsed = parseMapDocument(JSON.parse(JSON.stringify(input)))
  assert.deepEqual(parsed.document?.extra, { temperature: { bands: [1, 2] } })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"temperature"'), true)
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.extra, { temperature: { bands: [1, 2] } })
})
