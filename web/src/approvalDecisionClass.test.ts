import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionClass } from './approvalDecisionClass.ts'

test('残る候補のボタンは、今回だけのボタンと別の見た目にする（#741）', () => {
  assert.equal(decisionClass({ behavior: 'allow' }), 'allow')
  assert.equal(decisionClass({ behavior: 'deny' }), 'deny')
  // 「今後聞かない」は「許可」と同じ塗りにしない。「今後も断る」も今回だけの拒否と見分けられる
  assert.equal(decisionClass({ behavior: 'allow', persists: true }), 'persist allow')
  assert.equal(decisionClass({ behavior: 'deny', persists: true }), 'persist deny')
  // SAI 自身の「常に許可」のクラスは使わない
  assert.ok(!decisionClass({ behavior: 'allow', persists: true }).split(' ').includes('always'))
})
