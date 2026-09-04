import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerAsk, approvalText, askQuestions, toolSummary } from './approvals.ts'
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
