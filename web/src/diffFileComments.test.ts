import { test } from 'node:test'
import assert from 'node:assert/strict'
import { perFileComments, sameComments } from './diffFileComments.ts'
import type { DiffComment } from './diffComments.ts'

const c = (id: string, path: string): DiffComment => ({ id, section: 'branch', path, side: 'new', line: 1, kind: 'add', code: 'x', body: 'b' })
const onAdd = () => {}
const onRemove = () => {}

test('perFileComments: ファイルごとに分け、無いファイルには空の口を共用で返す。口が無ければ undefined', () => {
  const a1 = c('1', 'a.ts')
  const a2 = c('2', 'a.ts')
  const b1 = c('3', 'b.ts')
  const of = perFileComments({ section: 'branch', list: [a1, b1, a2], onAdd, onRemove })
  assert.deepEqual(of('a.ts')?.list, [a1, a2], '並びは元のまま')
  assert.deepEqual(of('b.ts')?.list, [b1])
  assert.equal(of('a.ts')?.onAdd, onAdd)
  assert.deepEqual(of('zzz')?.list, [], 'コメントの無いファイルにも口がある')
  assert.equal(of('zzz'), of('yyy'), '空の口は 1 つを共用')
  assert.equal(perFileComments(undefined)('a.ts'), undefined)
})

test('sameComments: 区切り・口・要素の同一性で比べる（1 件足すと、そのファイルだけ違う）', () => {
  const a1 = c('1', 'a.ts')
  const b1 = c('3', 'b.ts')
  const before = perFileComments({ section: 'branch', list: [a1, b1], onAdd, onRemove })
  const after = perFileComments({ section: 'branch', list: [a1, b1, c('4', 'b.ts')], onAdd, onRemove })
  assert.equal(sameComments(before('a.ts'), after('a.ts')), true, 'a.ts は変わっていない')
  assert.equal(sameComments(before('b.ts'), after('b.ts')), false, 'b.ts に 1 件増えた')
  assert.equal(sameComments(before('zzz'), after('zzz')), true, '空は空')
  assert.equal(sameComments(before('a.ts'), { section: 'working', list: [a1], onAdd, onRemove }), false, '区切りが違う')
  assert.equal(sameComments(before('a.ts'), { section: 'branch', list: [a1], onAdd: () => {}, onRemove }), false, '口が違う')
  assert.equal(sameComments(undefined, undefined), true)
  assert.equal(sameComments(before('a.ts'), undefined), false)
})
