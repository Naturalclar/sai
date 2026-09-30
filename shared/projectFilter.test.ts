import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanProjects, matchesProjects, projectsLabel, storedProjects, toggleProject } from './projectFilter.ts'

test('cleanProjects: 空と重複と文字列でないものを落とす', () => {
  assert.deepEqual(cleanProjects(['a/x', '', ' b/y ', 'a/x', 3, null]), ['a/x', 'b/y'])
})

test('storedProjects: 配列があればそれ、#529 より前の 1 つの文字列も引き継ぐ、壊れていれば空', () => {
  assert.deepEqual(storedProjects({ projects: ['a/x', 'b/y'] }), ['a/x', 'b/y'])
  assert.deepEqual(storedProjects({ project: 'a/x' }), ['a/x'], '古い localStorage の値')
  assert.deepEqual(storedProjects({ project: '' }), [])
  assert.deepEqual(storedProjects({ projects: [], project: 'a/x' }), [], '新しい形が先（すべてに戻したのを古い値で上書きしない）')
  assert.deepEqual(storedProjects({ projects: 'a/x' }), [])
  assert.deepEqual(storedProjects({}), [])
})

test('matchesProjects: 何も選んでいなければ全部、選んでいればどれか 1 つに当たるもの', () => {
  assert.equal(matchesProjects([], ['a/x']), true)
  assert.equal(matchesProjects([], []), true)
  assert.equal(matchesProjects(['a/x', 'b/y'], ['b/y']), true)
  assert.equal(matchesProjects(['a/x', 'b/y'], ['c/z']), false)
  assert.equal(matchesProjects(['a/x'], []), false, 'リポジトリの分からないものは選んだときには出さない')
})

test('toggleProject: 入れ外しする。元の配列は触らない', () => {
  const given = ['a/x']
  assert.deepEqual(toggleProject(given, 'b/y'), ['a/x', 'b/y'])
  assert.deepEqual(toggleProject(given, 'a/x'), [])
  assert.deepEqual(given, ['a/x'])
})

test('projectsLabel: なし・1 つ・複数', () => {
  assert.equal(projectsLabel([]), '全リポジトリ')
  assert.equal(projectsLabel(['Naturalclar/sai']), '#sai')
  assert.equal(projectsLabel(['Naturalclar/sai', 'a/x', 'b/y']), '#sai +2')
})
