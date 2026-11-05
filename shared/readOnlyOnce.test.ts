import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardMayMatch, onceBlocked, onceNotReadOnly } from './readOnlyOnce.ts'

test('guardMayMatch: Bash のパターンの最初の語がコマンドに出れば当たりうる。素の Bash・空・ワイルドカードは何にでも当たる。Bash 以外は見ない', () => {
  assert.equal(guardMayMatch(['Bash(git log:*)'], 'git status; git log -3'), true)
  assert.equal(guardMayMatch(['Bash(git log:*)'], 'pwd'), false)
  assert.equal(guardMayMatch(['Bash(GIT push)'], 'echo "$(git status)"'), true, '大文字小文字は見ない')
  assert.equal(guardMayMatch(['Bash(cat *)'], 'pwd | cat'), true)
  assert.equal(guardMayMatch(['Bash("git" log:*)'], 'git log'), true, '引用符は外す')
  assert.equal(guardMayMatch(['Bash(rm:*) Bash(git log:*)'], 'git log -3'), true, '1 つの語に並べたルールも全部見る')
  assert.equal(guardMayMatch(['Bash(rm:*),Bash(git log:*)'], 'git log -3'), true)
  for (const rule of ['Bash', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(* --force)', ' Bash ', 'Read Bash']) assert.equal(guardMayMatch([rule], 'pwd'), true, rule)
  assert.equal(guardMayMatch(['Read(./secret/**)', 'Edit', 'WebFetch', 'BashOutput', 'mcp__x__Bash_like'], 'pwd'), false)
  assert.equal(guardMayMatch([], 'pwd'), false)
  // 語の単位で比べる（語の一部では当たらない）。パスの形は最後の階層でも比べる
  assert.equal(guardMayMatch(['Bash(rm:*)'], 'git log --format=%H | head'), false)
  assert.equal(guardMayMatch(['Bash(git push:*)'], 'echo "digit"'), false)
  assert.equal(guardMayMatch(['Bash(git:*)'], '/usr/bin/git log'), true)
  assert.equal(guardMayMatch(['Bash(/usr/bin/git:*)'], 'git log'), true)
  assert.equal(guardMayMatch(['Bash(git log:*)'], 'echo "$(git log -1)"'), true)
  assert.equal(guardMayMatch(['Bash(cat:*)'], 'ls|cat'), true)
})

test('onceBlocked / onceNotReadOnly: ルールを作れない Claude の Bash だけ。止める側のルールを先に見て、読むだけかは最後', () => {
  const bash = { tool_name: 'Bash', agent: 'claude' as const, answerable: true, input: { command: '(git status; pwd)' } }
  assert.equal(onceBlocked({ ...bash, tool_name: 'Read' }, 'subshell', [])?.quiet, true)
  assert.equal(onceBlocked({ ...bash, agent: 'codex' }, 'subshell', [])?.quiet, true)
  assert.equal(onceBlocked({ ...bash, answerable: false }, 'subshell', [])?.quiet, true)
  assert.equal(onceBlocked(bash, undefined, [])?.quiet, true, 'ルールを作れる形')
  assert.ok(onceBlocked(bash, 'covered', []))
  assert.ok(onceBlocked(bash, 'not_bash', []))
  assert.ok(onceBlocked(bash, 'subshell', null), '止める側を読めない')
  assert.ok(onceBlocked(bash, 'subshell', undefined), '渡していない')
  assert.ok(onceBlocked(bash, 'subshell', ['Bash(pwd)']))
  assert.ok(onceBlocked({ ...bash, input: {} }, 'subshell', []))
  assert.equal(onceBlocked(bash, 'subshell', []), null)
  assert.equal(onceNotReadOnly(bash, { cwd: '/w', roots: ['/w'] }), '')
  assert.notEqual(onceNotReadOnly({ input: { command: '(touch zz; pwd)' } }, { cwd: '/w', roots: ['/w'] }), '')
  assert.notEqual(onceNotReadOnly({ input: {} }, { cwd: '/w' }), '')
})
