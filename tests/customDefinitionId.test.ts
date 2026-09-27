/**
 * 自定义定义 ID 自动生成的单元测试。
 *
 * 这一层的重点：**生成的 ID 必须可预测、且绝不撞车**。
 * 撞车的后果不是"报错"，而是用户拿到两条同 ID 定义后，"画上去是哪一个"变成说不清的问题
 * （解析层按先出现的胜出，但用户看不出顺序）——所以这里把冲突分支逐条钉住。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { isBlankCustomId, slugFromLabel, suggestCustomId } from '../src/render/customDefinitionId.ts'

test('ASCII 显示名压成 slug（小写、非法字符压成一个连字符）', () => {
  assert.equal(slugFromLabel('My Forest'), 'my-forest')
  assert.equal(slugFromLabel('  My   Forest!  '), 'my-forest')
  assert.equal(slugFromLabel('A_B-C'), 'a-b-c')
  assert.equal(slugFromLabel('!!!'), '')
})

test('slug 过长要截断，且不留尾巴连字符', () => {
  const slug = slugFromLabel('a'.repeat(40))
  assert.equal(slug.length, 24)
  assert.equal(slug.endsWith('-'), false)
})

test('ASCII 显示名给出可读 ID', () => {
  assert.equal(suggestCustomId('My Forest', []), 'custom:my-forest')
  assert.equal(suggestCustomId('My Forest', [], 'x:'), 'x:my-forest')
})

test('纯中文显示名退到短序号（本地没有可靠的拼音库，硬造映射会让 ID 不可预测）', () => {
  assert.equal(suggestCustomId('沼泽地', [], 'custom:', 'region'), 'custom:region1')
})

test('撞车时依次找下一个空位：绝不返回已被占用的 ID', () => {
  assert.equal(suggestCustomId('My Forest', ['custom:my-forest']), 'custom:my-forest1')
  assert.equal(suggestCustomId('My Forest', ['custom:my-forest', 'custom:my-forest1']), 'custom:my-forest2')
  assert.equal(suggestCustomId('沼泽地', ['custom:region1', 'custom:region2'], 'custom:', 'region'), 'custom:region3')
  assert.equal(suggestCustomId('沼泽地', ['custom:region2'], 'custom:', 'region'), 'custom:region1')
})

test('空显示名也给得出 ID（用户什么都没填也能建）', () => {
  assert.equal(suggestCustomId('', [], 'custom:', 'terrain'), 'custom:terrain1')
  assert.equal(suggestCustomId('', ['custom:terrain1'], 'custom:', 'terrain'), 'custom:terrain2')
})

test('只看同一类定义之间是否撞车（前缀不同 = 不同命名空间）', () => {
  assert.equal(suggestCustomId('My Forest', ['custom:my-forest', 'realm', 'river']), 'custom:my-forest1')
  assert.equal(suggestCustomId('My Forest', ['realm', 'river']), 'custom:my-forest')
})

test('重复调用是稳定的（同一个显示名 + 同一份现有列表 → 同一个结果）', () => {
  const existing = ['custom:my-forest']
  assert.equal(suggestCustomId('My Forest', existing), suggestCustomId('My Forest', existing))
})

test('空白字符串算"没填"（空格不该变成一个叫空格的 ID）', () => {
  assert.equal(isBlankCustomId(''), true)
  assert.equal(isBlankCustomId('   '), true)
  assert.equal(isBlankCustomId(undefined), true)
  assert.equal(isBlankCustomId(123), true)
  assert.equal(isBlankCustomId('marsh'), false)
})
