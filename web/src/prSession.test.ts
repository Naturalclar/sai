import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newestFirst, prAuthorSession, prCommentKey } from './prSession.ts'

const s = (id: string, project: string, branch: string) => ({ id, project, branch })

test('prAuthorSession: 同じリポジトリで head と同じブランチの、一番新しいセッション', () => {
  // 一覧は新しい順
  const list = [s('new', 'Naturalclar/sai', 'fix-x'), s('old', 'Naturalclar/sai', 'fix-x'), s('other', 'Naturalclar/sai', 'main')]
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'fix-x')?.id, 'new')
  // リポジトリの大文字小文字は見ない（gh と remote で揃っていないことがある）
  assert.equal(prAuthorSession(list, 'naturalclar/SAI', 'fix-x')?.id, 'new')
})

test('prAuthorSession: 別のリポジトリの同じブランチ名・ブランチが違う・材料が無いときは見つからない', () => {
  const list = [s('a', 'Naturalclar/repo-b', 'fix-x'), s('b', 'Naturalclar/sai', 'main')]
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'fix-x'), null)
  assert.equal(prAuthorSession(list, '', 'fix-x'), null)
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', ''), null)
})

test('prCommentKey: PR ごとの鍵で、セッションのエンティティ ID と混ざらない', () => {
  assert.equal(prCommentKey('Naturalclar/sai', 525), 'pr:Naturalclar/sai#525')
  assert.notEqual(prCommentKey('a/b', 1).includes('@'), true)
})

test('prAuthorSession: フォークから出た PR は、同じ名前のブランチがあっても探さない', () => {
  const list = [s('mine', 'Naturalclar/sai', 'main')]
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'main', true), null)
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'main', false)?.id, 'mine')
})

test('newestFirst: アーカイブ済みも混ぜて新しい順に並べる（アーカイブした書き手を飛ばして古いものを選ばない）', () => {
  const live = [{ id: 'old', end: '2026-09-01T00:00:00+09:00' }]
  const archived = [{ id: 'new', end: '2026-09-30T00:00:00+09:00' }]
  assert.deepEqual(newestFirst(live, archived).map((x) => x.id), ['new', 'old'])
  // 同じ id は 1 つ
  assert.deepEqual(newestFirst(live, live).map((x) => x.id), ['old'])
})
