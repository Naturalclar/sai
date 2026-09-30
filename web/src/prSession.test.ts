import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prAuthorSession, prCommentKey } from './prSession.ts'

const s = (id: string, project: string, branch: string) => ({ id, project, branch })

test('prAuthorSession: 同じリポジトリで head と同じブランチの、一番新しいセッション', () => {
  // 一覧は新しい順
  const list = [s('new', 'Naturalclar/sai', 'fix-x'), s('old', 'Naturalclar/sai', 'fix-x'), s('other', 'Naturalclar/sai', 'main')]
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'fix-x')?.id, 'new')
  // リポジトリの大文字小文字は見ない（gh と remote で揃っていないことがある）
  assert.equal(prAuthorSession(list, 'naturalclar/SAI', 'fix-x')?.id, 'new')
})

test('prAuthorSession: 別のリポジトリの同じブランチ名・ブランチが違う・材料が無いときは見つからない', () => {
  const list = [s('a', 'Naturalclar/dotfiles', 'fix-x'), s('b', 'Naturalclar/sai', 'main')]
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', 'fix-x'), null)
  assert.equal(prAuthorSession(list, '', 'fix-x'), null)
  assert.equal(prAuthorSession(list, 'Naturalclar/sai', ''), null)
})

test('prCommentKey: PR ごとの鍵で、セッションのエンティティ ID と混ざらない', () => {
  assert.equal(prCommentKey('Naturalclar/sai', 525), 'pr:Naturalclar/sai#525')
  assert.notEqual(prCommentKey('a/b', 1).includes('@'), true)
})
