import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKTREE_NAME_MAX, worktreeNameRefusal } from './worktreeName.ts'

test('worktreeNameRefusal: 使える形は英数字と . _ - で、先頭は英数字（#847）', () => {
  for (const ok of ['a', 'dev-worktree-a', 'issue_847', 'v1.2', 'x'.repeat(WORKTREE_NAME_MAX)]) assert.equal(worktreeNameRefusal(ok), '', ok)
})

test('worktreeNameRefusal: 外に出る・フラグに化ける・ブランチ名にならない名前を断る（#847）', () => {
  const bad = ['', '..', '../x', 'a/b', '/tmp/x', 'a\\b', '-b', '--force', '.hidden', 'a..b', 'a.', 'a.lock', 'a b', 'a\nb', ' a', 'ああ', 'a~1', 'a^', 'a:b', 'a@{0}', 'x'.repeat(WORKTREE_NAME_MAX + 1)]
  for (const name of bad) assert.notEqual(worktreeNameRefusal(name), '', JSON.stringify(name))
})

test('worktreeNameRefusal: bare 本体の直下で git が使う名前を、大文字小文字に関わらず断る（#847）', () => {
  for (const name of ['HEAD', 'head', 'refs', 'Objects', 'logs', 'worktrees', 'packed-refs', 'config']) assert.notEqual(worktreeNameRefusal(name), '', name)
})
