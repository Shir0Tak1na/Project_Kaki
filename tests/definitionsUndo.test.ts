/**
 * 「改地图定义」能不能真的撤销（`SetDefinitionsOp`）。
 *
 * 补的是 `FEATURE-AUDIT.md` §1.3 B 的缺口「**定义修改可撤销 —— 只有结构断言**」。
 * 这条比一般的撤销更微妙，原因写在 `history.ts` 的注释里：**它会顺带改文档版本号** ——
 * 老图（v1）第一次改定义要升到 v2，撤销必须把这个数字也还原；否则「改一次再撤销」会留下一张
 * 版本号变了、内容却没变的文件，直接破掉「老图一个字节都不动」的承诺。
 *
 * 所以这里钉的不是「有没有这个 op」，而是**往返之后文档是不是逐字段回到原样**。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOp, invertOp, type MapOp, type SetDefinitionsOp } from '../src/editor/history.ts'
import { createEmptyMapDocument, type MapDocument, type MapDefinitions } from '../src/data/mapDocument.ts'

function definitions(over: MapDefinitions = {}): MapDefinitions {
  return { terrains: [{ id: 'custom:red', name: '红土' }], biomes: [{ id: 'custom:void' }], ...over }
}

/** 一份「v1 老图」：没有 definitions 段，版本 1 */
function legacyDocument(): MapDocument {
  const document = createEmptyMapDocument({})
  document.version = 1
  delete document.definitions
  return document
}

function snapshot(document: MapDocument): string {
  return JSON.stringify(document)
}

test('v1 老图改定义：写入 definitions 并升到 v2', () => {
  const document = legacyDocument()
  const op: SetDefinitionsOp = {
    kind: 'setDefinitions',
    from: null,
    fromVersion: 1,
    to: definitions(),
    toVersion: 2,
  }
  applyOp(document, op)
  assert.equal(document.version, 2, '改定义会把老图升到 v2')
  assert.deepEqual(document.definitions, definitions())
})

test('撤销之后**版本号也回来**（这是这条 op 最容易漏的一半）', () => {
  const document = legacyDocument()
  const before = snapshot(document)
  const op: SetDefinitionsOp = { kind: 'setDefinitions', from: null, fromVersion: 1, to: definitions(), toVersion: 2 }
  applyOp(document, op)
  applyOp(document, invertOp(op) as MapOp)
  assert.equal(document.version, 1, '撤销必须把版本号也落回 1，否则老图无缘无故被「升级」了')
  assert.equal('definitions' in document, false, '撤销要把整段**删掉**，不是留一个空对象')
  assert.equal(snapshot(document), before, '往返之后整份文档应与初始逐字段一致')
})

test('v2 改定义：撤销回到原来那一份，版本仍是 2', () => {
  const document = createEmptyMapDocument({ definitions: definitions() })
  document.version = 2
  const original = snapshot(document)
  const next: MapDefinitions = { ...definitions(), pathTypes: [{ id: 'custom:rail' }] }
  const op: SetDefinitionsOp = { kind: 'setDefinitions', from: definitions(), fromVersion: 2, to: next, toVersion: 2 }
  applyOp(document, op)
  assert.deepEqual(document.definitions, next)
  applyOp(document, invertOp(op) as MapOp)
  assert.deepEqual(document.definitions, definitions())
  assert.equal(document.version, 2)
  assert.equal(snapshot(document), original)
})

test('删掉整段定义之后撤销：整段装回来（不是空壳）', () => {
  const document = createEmptyMapDocument({ definitions: definitions() })
  document.version = 2
  const original = snapshot(document)
  const op: SetDefinitionsOp = { kind: 'setDefinitions', from: definitions(), fromVersion: 2, to: null, toVersion: 2 }
  applyOp(document, op)
  assert.equal(document.definitions, undefined, '整段删除')
  applyOp(document, invertOp(op) as MapOp)
  assert.deepEqual(document.definitions, definitions(), '撤销要把整段原样装回')
  assert.equal(snapshot(document), original)
})

test('改两次再倒序撤销两次：逐字段回到初始（老图依然是 v1、依然没有 definitions 段）', () => {
  const document = legacyDocument()
  const before = snapshot(document)
  const op1: SetDefinitionsOp = { kind: 'setDefinitions', from: null, fromVersion: 1, to: definitions(), toVersion: 2 }
  const op2: SetDefinitionsOp = {
    kind: 'setDefinitions',
    from: definitions(),
    fromVersion: 2,
    to: { terrains: [{ id: 'custom:blue' }] },
    toVersion: 2,
  }
  applyOp(document, op1)
  applyOp(document, op2)
  applyOp(document, invertOp(op2) as MapOp)
  applyOp(document, invertOp(op1) as MapOp)
  assert.equal(document.version, 1)
  assert.equal('definitions' in document, false)
  assert.equal(snapshot(document), before)
})

test('invertOp 自反：连着倒两次就是原 op', () => {
  const op: SetDefinitionsOp = { kind: 'setDefinitions', from: null, fromVersion: 1, to: definitions(), toVersion: 2 }
  const twice = invertOp(invertOp(op)) as SetDefinitionsOp
  assert.deepEqual(twice, op)
})
