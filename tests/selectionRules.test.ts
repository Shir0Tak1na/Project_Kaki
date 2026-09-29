/**
 * 选择系统「筛选器规则」的单测（`src/render/selectionRules.ts`）。
 *
 * 这一组盯五件事：
 * 1. **登记表是从字段表生成的**（加一个数值字段，筛选器自动多一条规则）；
 * 2. **没有值的格不满足任何比较**（"没量过"不等于 0），`exists` 是唯一问"有没有"的运算；
 * 3. **即时校验**：未知键 / 非法运算 / 空值 / `min > max` 都要给出可读原因；
 * 4. **不可用的子句被跳过**（界面刚添一行还没填完时，不该让整张图突然一个都不选）；
 * 5. **人话回显**（`describeGroup`）—— 它是用户唯一能确认"我筛的是什么"的地方。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SELECTION_RULE_SPECS,
  clauseIsUsable,
  describeClause,
  describeGroup,
  emptyRuleGroup,
  groupIsUsable,
  matchesGroup,
  selectionRule,
  validateClause,
  type RuleClause,
  type RuleGroup,
} from '../src/render/selectionRules.ts'
import { OVERLAY_FIELDS } from '../src/render/overlayFields.ts'
import type { TerrainCell } from '../src/data/mapDocument.ts'

const clause = (key: string, op: RuleClause['op'], value: RuleClause['value']): RuleClause => ({ key, op, value })
const group = (clauses: RuleClause[], join: RuleGroup['join'] = 'and', negate = false): RuleGroup => ({
  join,
  negate,
  clauses,
})

test('规则登记表：地形一条 + **每个数值字段各一条**（自动生成，不是手写清单）', () => {
  const keys = SELECTION_RULE_SPECS.map((spec) => spec.key)
  assert.equal(keys[0], 'terrain')
  for (const spec of OVERLAY_FIELDS) {
    if (spec.numeric) assert.ok(keys.includes(spec.cellKey), `${spec.label} 应当有一条规则`)
  }
  // 每条规则都得把界面要用的四件事说全
  for (const spec of SELECTION_RULE_SPECS) {
    assert.ok(spec.label.length > 0, `${spec.key} 要有显示名`)
    assert.ok(spec.ops.length > 0, `${spec.key} 要有允许的运算`)
    assert.ok(['enum', 'number', 'range', 'boolean'].includes(spec.valueKind))
    assert.equal(typeof spec.match, 'function')
    assert.equal(typeof spec.describe, 'function')
  }
  // 数值字段的规则覆盖全部数值运算，枚举的只覆盖枚举那几种
  const temp = selectionRule('temp')!
  assert.deepEqual(temp.ops, ['=', '≠', '>', '≥', '<', '≤', 'between', 'exists'])
  assert.deepEqual(selectionRule('terrain')!.ops, ['=', '≠', 'in', 'exists'])
  assert.equal(selectionRule('nope'), null, '不认识的键返回 null（界面不该炸）')
})

test('数值规则：比较、范围、有没有值；**没有值的格不满足任何比较**', () => {
  const temp = selectionRule('temp')!
  const cold: TerrainCell = { temp: -20 }
  const none: TerrainCell = { t: 'plains' }
  assert.equal(temp.match(cold, '=', -20), true)
  assert.equal(temp.match(cold, '≠', -20), false)
  assert.equal(temp.match(cold, '>', -20), false, '严格大于')
  assert.equal(temp.match(cold, '≥', -20), true)
  assert.equal(temp.match(cold, '<', 0), true)
  assert.equal(temp.match(cold, '≤', -20), true)
  assert.equal(temp.match(cold, 'between', [-30, -10]), true)
  assert.equal(temp.match(cold, 'between', [-10, 10]), false)
  assert.equal(temp.match(cold, 'exists', true), true)
  assert.equal(temp.match(cold, 'exists', false), false)
  // 没值的格：所有比较都是 false，只有 exists=false 成立 —— 0 是合法值，绝不当成"没有"
  for (const op of ['=', '≠', '>', '≥', '<', '≤'] as const) {
    assert.equal(temp.match(none, op, 0), false, `没值的格不该满足 ${op}`)
  }
  assert.equal(temp.match(none, 'between', [-30, 10]), false)
  assert.equal(temp.match(none, 'exists', false), true)
  assert.equal(temp.match(undefined, 'exists', true), false, '连格都没有 → 也没有值')
  // 0 是有值
  assert.equal(temp.match({ temp: 0 }, 'exists', true), true)
  assert.equal(temp.match({ temp: 0 }, '=', 0), true)
})

test('地形规则：= / ≠ / in / exists（未知地形也照比 —— 筛选器不假装它不存在）', () => {
  const terrain = selectionRule('terrain')!
  const forest: TerrainCell = { t: 'forest' }
  assert.equal(terrain.match(forest, '=', 'forest'), true)
  assert.equal(terrain.match(forest, '≠', 'forest'), false)
  assert.equal(terrain.match(forest, 'in', ['forest', 'water']), true)
  assert.equal(terrain.match(forest, 'in', ['water']), false)
  assert.equal(terrain.match(forest, 'exists', true), true)
  assert.equal(terrain.match({ temp: 1 }, 'exists', true), false, '只有温度、没有地形的格')
  assert.equal(terrain.match({ t: 'custom:沙漠' }, '=', 'custom:沙漠'), true, '自定义地形照样能筛')
  assert.equal(terrain.match({ t: 'custom:沙漠' }, 'in', ['forest']), false)
})

test('即时校验：非法子句给出可读原因，且**不算数**', () => {
  assert.equal(validateClause(clause('temp', '≥', 10)), null)
  assert.equal(validateClause(clause('temp', 'between', [10, 30])), null)
  assert.equal(clauseIsUsable(clause('temp', 'between', [10, 30])), true)
  assert.match(validateClause(clause('nope', '=', 1)) ?? '', /不认识的筛选键/)
  assert.match(validateClause(clause('temp', 'in', ['a'])) ?? '', /不支持这个运算/)
  assert.match(validateClause(clause('temp', '≥', Number.NaN)) ?? '', /要填一个数/)
  assert.match(validateClause(clause('temp', 'between', [10])) ?? '', /需要填两个数/)
  assert.match(validateClause(clause('temp', 'between', [30, 10])) ?? '', /下限不能大于上限/)
  assert.match(validateClause(clause('terrain', '=', '')) ?? '', /还没选/)
  assert.match(validateClause(clause('terrain', 'in', [])) ?? '', /还没选/)
  assert.match(validateClause(clause('temp', 'exists', 'yes')) ?? '', /有 \/ 没有/)
  assert.equal(clauseIsUsable(clause('temp', 'between', [30, 10])), false)
  // 不可用 ⇒ 人话直接给出原因（界面把这一行标红显示的就是它）
  assert.match(describeClause(clause('temp', 'between', [30, 10])), /下限不能大于上限/)
})

test('matchesGroup：and / or / 取反；不可用的子句被**跳过**（不是当成 false）', () => {
  const forest: TerrainCell = { t: 'forest', temp: 20 }
  const and = group([clause('terrain', '=', 'forest'), clause('temp', '≥', 10)])
  assert.equal(matchesGroup(forest, and), true)
  assert.equal(matchesGroup({ t: 'forest', temp: 5 }, and), false)
  assert.equal(matchesGroup(forest, group(and.clauses, 'or')), true)
  assert.equal(matchesGroup({ t: 'water', temp: 5 }, group(and.clauses, 'or')), false)
  assert.equal(matchesGroup(forest, group(and.clauses, 'and', true)), false, '取反：不满足整组')

  // 刚添了一行还没填完：那一行被跳过，剩下的照常生效
  const halfFilled = group([clause('terrain', '=', 'forest'), clause('temp', 'between', [30, 10])])
  assert.equal(matchesGroup(forest, halfFilled), true, '非法子句不该让整张图一个都不选')
  assert.equal(groupIsUsable(halfFilled), true)

  // 一个可用子句都没有 ⇒ 不匹配任何格（"什么都不填就全选"是另一个动作，不是这里）
  assert.equal(matchesGroup(forest, emptyRuleGroup()), false)
  assert.equal(matchesGroup(forest, group([clause('temp', '≥', Number.NaN)])), false)
  assert.equal(groupIsUsable(emptyRuleGroup()), false)
})

test('describeGroup：人话回显（含 and / or / 取反），并跳过不可用子句', () => {
  assert.equal(describeGroup(emptyRuleGroup()), '还没有可用的条件')
  assert.equal(
    describeGroup(group([clause('temp', 'between', [10, 30]), clause('terrain', '=', 'forest')])),
    '温度 10–30℃ 且 地形 = forest',
  )
  assert.equal(
    describeGroup(group([clause('terrain', 'in', ['forest', 'water'])], 'or')),
    '地形是 forest / water 之一',
  )
  assert.equal(describeGroup(group([clause('terrain', '=', 'forest')], 'and', true)), '不满足（地形 = forest）')
  assert.equal(
    describeGroup(group([clause('temp', 'exists', true), clause('temp', '≥', 10)])),
    '有温度值 且 温度 ≥ 10℃',
  )
})