import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardMayMatch, readOnlyOnce } from './readOnlyOnce.ts'

test('guardMayMatch: Bash のパターンの最初の語がコマンドに出れば当たりうる。素の Bash・空・ワイルドカードは何にでも当たる。Bash 以外は見ない', () => {
  assert.equal(guardMayMatch(['Bash(git log:*)'], 'git status; git log -3'), true)
  assert.equal(guardMayMatch(['Bash(git log:*)'], 'pwd'), false)
  assert.equal(guardMayMatch(['Bash(GIT push)'], 'echo "$(git status)"'), true, '大文字小文字は見ない')
  assert.equal(guardMayMatch(['Bash(cat *)'], 'pwd | cat'), true)
  for (const rule of ['Bash', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(* --force)', ' Bash ']) assert.equal(guardMayMatch([rule], 'pwd'), true, rule)
  assert.equal(guardMayMatch(['Read(./secret/**)', 'Edit', 'WebFetch'], 'pwd'), false)
  assert.equal(guardMayMatch([], 'pwd'), false)
})

test('readOnlyOnce: ルールを作れない Claude の Bash だけ。止める側のルールを先に見て、置き場を引くのは最後', () => {
  const bash = { tool_name: 'Bash', agent: 'claude' as const, answerable: true, input: { command: '(git status; pwd)' } }
  const place = { cwd: '/w', roots: ['/w'], repo: '' }
  assert.equal(readOnlyOnce({ ...bash, tool_name: 'Read' }, 'subshell', []).kind, 'skip')
  assert.equal(readOnlyOnce({ ...bash, agent: 'codex' }, 'subshell', []).kind, 'skip')
  assert.equal(readOnlyOnce({ ...bash, answerable: false }, 'subshell', []).kind, 'skip')
  assert.equal(readOnlyOnce(bash, undefined, []).kind, 'skip', 'ルールを作れる形')
  assert.equal(readOnlyOnce(bash, 'covered', []).kind, 'skip')
  assert.equal(readOnlyOnce(bash, 'subshell', null).kind, 'skip', '止める側を読めない')
  assert.equal(readOnlyOnce(bash, 'subshell', ['Bash(pwd)']).kind, 'skip')
  assert.equal(readOnlyOnce({ ...bash, input: {} }, 'subshell', []).kind, 'skip')
  assert.equal(readOnlyOnce(bash, 'subshell', []).kind, 'place')
  assert.equal(readOnlyOnce(bash, 'subshell', [], place).kind, 'once')
  assert.equal(readOnlyOnce({ ...bash, input: { command: '(touch zz; pwd)' } }, 'subshell', [], place).kind, 'skip')
})
