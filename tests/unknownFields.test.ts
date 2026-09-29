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

import { createEmptyMapDocument, canonicalCellJson, cellsEqual, parseMapDocument, serializeMapDocument } from '../src/data/mapDocument.ts'

function parseWithCells(cells: Record<string, unknown>) {
  const input = { ...createEmptyMapDocument({}), terrain: cells }
  return parseMapDocument(JSON.parse(JSON.stringify(input)))
}

test('每格默认值（dataDefaults）：解析进正式字段、写回仍在、且**不会被当成未知顶层段**', () => {
  // 施工文件 §B.5 点名的第一处：漏了 `KNOWN_TOP_LEVEL_KEYS` 就会被塞进 `extra` ——
  // 那样它会被当成"本插件不认识的段落"原样写回，而插件自己读不到它（表现是"设了默认值没效果"）。
  const base = createEmptyMapDocument({})
  const result = parseMapDocument({ ...base, dataDefaults: { temp: 15, depth: 0 } })
  assert.equal(result.ok, true)
  const document_ = result.document!
  assert.deepEqual(document_.dataDefaults, { temp: 15, depth: 0 })
  assert.equal(document_.extra, undefined, '不能进 extra')
  assert.deepEqual(result.issues, [], '正常的默认值不该告警')
  // 写回：值还在，且键按字典序（Git diff 稳定）
  const text = serializeMapDocument(document_)
  assert.match(text, /"dataDefaults": \{"depth":0,"temp":15\}/)
})

test('每格默认值：空表 = 没有这一段（清空后文件里不留 `{}`），老地图逐字节不变', () => {
  const base = createEmptyMapDocument({})
  // ① 文件里写着 `{}` → 解析成"没有这一段"
  const emptyInput = parseMapDocument({ ...base, dataDefaults: {} })
  assert.equal(emptyInput.document!.dataDefaults, undefined)
  assert.equal(serializeMapDocument(emptyInput.document!).includes('dataDefaults'), false)
  // ② 内存里是 `{}`（例如清空后忘了删字段）→ 序列化也**不写**这个键
  const withEmptyObject = { ...createEmptyMapDocument({}), dataDefaults: {} }
  assert.equal(serializeMapDocument(withEmptyObject).includes('dataDefaults'), false)
  // ③ 压根没有这一段的老地图：前后都不出现这个词
  const legacy = createEmptyMapDocument({})
  const text = serializeMapDocument(legacy)
  assert.equal(text.includes('dataDefaults'), false)
  assert.equal(parseMapDocument(JSON.parse(text)).issues.length, 0)
})

test('每格默认值：坏值丢掉、不认识的键保留并告警（未知值属于用户的数据）', () => {
  const base = createEmptyMapDocument({})
  const result = parseMapDocument({
    ...base,
    dataDefaults: { temp: 15, depth: 'not a number', humdity: 3 },
  })
  const document_ = result.document!
  assert.deepEqual(document_.dataDefaults, { temp: 15, humdity: 3 }, '坏值丢掉、拼错的键原样保留')
  const warning = result.issues.find((issue) => issue.path === 'dataDefaults')
  assert.equal(warning?.level, 'warning')
  assert.match(warning?.message ?? '', /humdity/, '告警要点出是哪个键')
  assert.equal(serializeMapDocument(document_).includes('humdity'), true, '写回时它还在')
})

test('格上的未知字段被原样保留（值、嵌套对象、数组都一样）', () => {
  // 注意：`temp` / `depth` 从这一版起是**正式字段**（见文件末尾那几节），
  // 所以"未知字段"这条测试改用真正没被认识的名字（湿度 / 气候）
  const result = parseWithCells({
    '0_0': { t: 'forest', humidity: 12, climate: { level: 3, tags: ['a', 'b'] } },
  })
  assert.equal(result.ok, true)
  const cell = result.document?.terrain['0_0']
  assert.equal(cell?.t, 'forest')
  assert.deepEqual(cell?.extra, { humidity: 12, climate: { level: 3, tags: ['a', 'b'] } })
})

test('写回时是摊平的：文件里没有 "extra" 这个键，未知字段直接挂在格上', () => {
  const parsed = parseWithCells({ '0_0': { t: 'forest', humidity: 12 } })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"extra"'), false, '不允许把未知字段塞进 extra 嵌套层')
  assert.equal(text.includes('"humidity":12'), true, text)
  // 再解析一次：形状与第一次完全一致（往返稳定）
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.terrain['0_0'], parsed.document?.terrain['0_0'])
})

test('未知字段不会污染已知键：t/f/c 的收敛规则照旧', () => {
  const result = parseWithCells({
    '1_1': { t: 'river', f: 3.7, c: '#123456', humidity: 8 },
    // f = 0 是"缺省"（与既有规则一致：不写回 0），未知字段不受影响
    '2_2': { t: 'road', f: 0, extraUnknown: 'kept' },
  })
  const withFlags = result.document?.terrain['1_1']
  assert.equal(withFlags?.f, 3)
  assert.equal(withFlags?.c, '#123456')
  assert.deepEqual(withFlags?.extra, { humidity: 8 })
  const zeroFlag = result.document?.terrain['2_2']
  assert.equal(zeroFlag?.f, undefined)
  assert.deepEqual(zeroFlag?.extra, { extraUnknown: 'kept' })
  const text = serializeMapDocument(result.document!)
  assert.equal(/"t":"road"/.test(text), true)
  assert.equal(text.includes('"f":0'), false, 'f=0 依旧不写回')
})

test('未知格字段只告警一次，并列出字段名（不按格刷屏）', () => {
  const cells = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`${index}_0`, { t: 'forest', humidity: 1, rainfall: 2 }]),
  )
  const result = parseWithCells(cells)
  const warnings = result.issues.filter((issue) => issue.message.includes('不认识的字段'))
  assert.equal(warnings.length, 1, JSON.stringify(result.issues.map((issue) => issue.message)))
  assert.match(warnings[0]!.message, /"rainfall"/)
  assert.match(warnings[0]!.message, /"humidity"/)
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

// ------------------------------------------------- F2：格可以没有地形

test('只有值没有地形的格：保留、往返稳定，且不许补一个假地形', () => {
  const parsed = parseWithCells({ '0_0': { temp: 20, depth: 300 } })
  const cell = parsed.document?.terrain['0_0']
  assert.equal(cell?.t, undefined, '没有 t 就是没有地形')
  assert.equal(cell?.temp, 20, '温度进正式字段')
  assert.equal(cell?.depth, 300, '深度进正式字段')
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"0_0": {"temp":20,"depth":300}'), true, text)
  assert.equal(text.includes('"t"'), false, '不许写一个空的 t 出来')
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.terrain['0_0'], cell, '往返稳定')
})

test('坏掉的 t 不再丢整格：原值原样写回同一个键名', () => {
  // 以前这一格会被**整格跳过** —— 连同格的其它字段一起永久删掉，没有任何补救入口
  const parsed = parseWithCells({ '0_0': { t: 42, temp: 20 } })
  const cell = parsed.document?.terrain['0_0']
  assert.equal(cell?.t, undefined, '坏值不进已知槽位（这一格按无地形处理）')
  assert.equal(cell?.temp, 20, '同格的温度照旧进正式字段')
  assert.deepEqual(cell?.extra, { t: 42 })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"0_0": {"t":42,"temp":20}'), true, text)
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.terrain['0_0'], cell, '往返稳定（坏值也得能原样往返）')
  assert.ok(
    parsed.issues.some((issue) => issue.message.includes('42')),
    `告警里要带上原值，用户才知道是哪个值坏了：${JSON.stringify(parsed.issues.map((i) => i.message))}`,
  )
})

// ------------------------------------------------- 温度 / 深度：正式的格字段

test('温度 / 深度进正式字段，且 0 是合法值（不许像 `f` 那样把 0 当缺省）', () => {
  const parsed = parseWithCells({
    '0_0': { t: 'forest', temp: 0, depth: 0 },
    '1_0': { t: 'water', temp: -12.5, depth: 3400 },
  })
  const zero = parsed.document?.terrain['0_0']
  assert.equal(zero?.temp, 0, '0 ℃ 必须留下')
  assert.equal(zero?.depth, 0, '0 = 海平面，也是合法值')
  assert.equal(zero?.extra, undefined, '它们不该再落到 extra 里')
  const deep = parsed.document?.terrain['1_0']
  assert.equal(deep?.temp, -12.5)
  assert.equal(deep?.depth, 3400)
})

test('写盘顺序固定：t → f → c → temp → depth → 未知键（Git diff 才稳定）', () => {
  const parsed = parseWithCells({ '0_0': { t: 'forest', depth: 5, temp: 3, humidity: 9, c: '#fff' } })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(
    text.includes('"0_0": {"t":"forest","c":"#fff","temp":3,"depth":5,"humidity":9}'),
    true,
    text,
  )
})

test('温度 / 深度给了非数字：值原样保留、键名不变，只按"没有数据"处理', () => {
  const parsed = parseWithCells({ '0_0': { t: 'forest', temp: '20', depth: null } })
  const cell = parsed.document?.terrain['0_0']
  assert.equal(cell?.temp, undefined, '字符串不是数字，不进正式字段')
  assert.deepEqual(cell?.extra, { temp: '20', depth: null })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"temp":"20"'), true, text)
  assert.equal(text.includes('"depth":null'), true, text)
  // 只告警一次（每格一条会刷屏）：文案里同时点出坏掉的键名与"为什么不可用"
  const warnings = parsed.issues.filter((issue) => issue.message.includes('不是可用的值'))
  assert.equal(warnings.length, 1, JSON.stringify(parsed.issues.map((issue) => issue.message)))
  assert.match(warnings[0]!.message, /"temp"/)
  assert.match(warnings[0]!.message, /"depth"/)
  const again = parseMapDocument(JSON.parse(text))
  assert.deepEqual(again.document?.terrain['0_0'], cell, '往返稳定')
})

// ------------------------------------------------- F1：编辑器"有没有变化"的判断

test('「有没有变化」把未知字段算作内容（F1）', () => {
  // 以前编辑器手写比较 `t` / `f` / `c` 三个字段，于是"格上多/少了一个未知字段"被当成没变化。
  // 后果不是"少一次撤销"这么轻：**用同一种地形重刷一遍就把那个字段抹掉**，而且连 op 都不产生。
  assert.equal(cellsEqual({ t: 'forest', extra: { temp: 20 } }, { t: 'forest', extra: { temp: 20 } }), true)
  assert.equal(cellsEqual({ t: 'forest', extra: { temp: 20 } }, { t: 'forest' }), false, '少一个未知字段也是变化')
  assert.equal(cellsEqual({ t: 'forest' }, { t: 'forest', extra: { temp: 20 } }), false, '多一个未知字段也是变化')
  assert.equal(cellsEqual(null, { t: 'forest' }), false)
  assert.equal(cellsEqual(null, null), true)
  // 已知键的既有口径不变
  assert.equal(cellsEqual({ t: 'forest' }, { t: 'forest', c: '#fff' }), false)
  // 未知字段的**键序**不影响判断（写盘时会排序，判断必须与之一致）
  assert.equal(cellsEqual({ t: 'forest', extra: { a: 1, b: 2 } }, { t: 'forest', extra: { b: 2, a: 1 } }), true)
})

test('规范形式就是文件里写出来的那一格（判断依据与写盘形状同一个函数）', () => {
  // 这条断言锁的是"唯一真相"：谁把序列化改成另一套写法都会红。
  const parsed = parseWithCells({ '0_0': { t: 'forest', f: 1, temp: 12 } })
  const text = serializeMapDocument(parsed.document!)
  assert.equal(
    text.includes(`"0_0": ${canonicalCellJson(parsed.document!.terrain['0_0']!)}`),
    true,
    text,
  )
})
