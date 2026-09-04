import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerAsk, approvalText, askQuestions, toolSummary, alwaysAllowRule, ruleLabel } from './approvals.ts'
import type { Approval } from './types.ts'

test('approvalText は record.py の waiting_text と同じ接頭辞', () => {
  assert.equal(approvalText('Bash', { command: 'rm -rf node_modules', description: '掃除' }), '許可待ち: Bash: rm -rf node_modules')
  assert.equal(approvalText('Edit', { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }), '許可待ち: Edit: /x/a.ts')
  assert.equal(approvalText('AskUserQuestion', { questions: [{ question: 'どれ?', options: [] }, { question: '型は?' }] }), '質問: どれ? / 型は?')
  assert.equal(approvalText('AskUserQuestion', {}), '質問に答えるのを待っている')
  assert.equal(approvalText('ExitPlanMode', { plan: '## 直す\n\n1. a\n2. b\n3. c\n4. d' }), 'プランの承認待ち: ## 直す\n1. a\n2. b')
  assert.equal(approvalText('mcp__x__y', { foo: 1 }), '許可待ち: mcp__x__y: {"foo":1}')
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(1000) }).length, 300)
})

test('askQuestions は壊れた形を落とし、answerAsk は元の入力に answers を足す', () => {
  const input = { questions: [{ question: '赤か青か?', header: '色', options: [{ label: '赤', description: 'red' }, { label: '青' }], multiSelect: false }, { nope: 1 }, 'x'] }
  const qs = askQuestions(input)
  assert.equal(qs.length, 1)
  assert.deepEqual(qs[0], { question: '赤か青か?', header: '色', options: [{ label: '赤', description: 'red' }, { label: '青', description: '' }], multiSelect: false })
  const approval: Approval = { approval_id: 'a', id: 'S@r', since: '', tool_name: 'AskUserQuestion', input, tool_use_id: '', text: '' }
  assert.deepEqual(answerAsk(approval, { '赤か青か?': '青' }), { behavior: 'allow', updatedInput: { questions: input.questions, answers: { '赤か青か?': '青' } } })
})

test('alwaysAllowRule: Bash は先頭 1 語（サブコマンドを持つ CLI は 2 語）の前方一致、MCP はツール名、他は無し', () => {
  const rule = (cmd: string) => alwaysAllowRule('Bash', { command: cmd })
  assert.deepEqual(rule('gh pr create --title x'), { toolName: 'Bash', ruleContent: 'gh pr:*' })
  assert.deepEqual(rule('git push origin main'), { toolName: 'Bash', ruleContent: 'git push:*' })
  assert.deepEqual(rule('pnpm test'), { toolName: 'Bash', ruleContent: 'pnpm test:*' })
  assert.deepEqual(rule('mkdir -p x/y'), { toolName: 'Bash', ruleContent: 'mkdir:*' })
  assert.deepEqual(rule('gh --version'), { toolName: 'Bash', ruleContent: 'gh:*' }, '2 語目がフラグなら 1 語')
  assert.deepEqual(rule('FOO=1 gh pr view'), { toolName: 'Bash', ruleContent: 'gh pr:*' }, '環境変数の代入は飛ばす')
  assert.deepEqual(rule('gh pr list && rm -rf x'), { toolName: 'Bash', ruleContent: 'gh pr:*' }, '&& の手前だけ')
  assert.deepEqual(rule('  ls -la | head'), { toolName: 'Bash', ruleContent: 'ls:*' })
  assert.deepEqual(rule('./scripts/run.sh'), { toolName: 'Bash', ruleContent: './scripts/run.sh:*' })
  assert.equal(rule(''), null)
  assert.equal(rule('$(echo x)'), null, '展開で始まるものは当てにしない')
  assert.equal(rule('"quoted cmd"'), null)
  assert.deepEqual(alwaysAllowRule('mcp__github__create_issue', {}), { toolName: 'mcp__github__create_issue' })
  assert.equal(alwaysAllowRule('Edit', { file_path: '/x' }), null, 'ファイル系には出さない')
  assert.equal(alwaysAllowRule('Write', {}), null)
  assert.equal(alwaysAllowRule('WebFetch', { url: 'https://x' }), null)
  assert.equal(alwaysAllowRule('AskUserQuestion', { questions: [] }), null)
  assert.equal(alwaysAllowRule('ExitPlanMode', { plan: 'x' }), null)
  assert.equal(ruleLabel({ toolName: 'Bash', ruleContent: 'gh pr:*' }), 'Bash(gh pr:*)')
  assert.equal(ruleLabel({ toolName: 'mcp__github__create_issue' }), 'mcp__github__create_issue')
})
