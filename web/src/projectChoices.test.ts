import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectChoices } from './projectChoices.ts'

test('projectChoices は空を落とし、いま選んでいるものが候補に無くても残す', () => {
  assert.deepEqual(projectChoices(['a/x', 'b/y'], ''), ['a/x', 'b/y'])
  assert.deepEqual(projectChoices(['a/x', 'b/y'], 'a/x'), ['a/x', 'b/y'])
  // 絞り込みの結果その窓に行が無くなると facets から落ちる。消すと自分で解除できなくなるので末尾に残す
  assert.deepEqual(projectChoices(['a/x'], 'c/z'), ['a/x', 'c/z'])
  assert.deepEqual(projectChoices([], 'c/z'), ['c/z'])
  assert.deepEqual(projectChoices(['', 'a/x'], ''), ['a/x'])
  // 元の配列は触らない
  const given = ['a/x']
  assert.notEqual(projectChoices(given, 'c/z'), given)
  assert.deepEqual(given, ['a/x'])
})
