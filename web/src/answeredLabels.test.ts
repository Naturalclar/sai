import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answeredLine } from './answeredLabels.ts'

const a = (text: string, behavior: 'allow' | 'deny' = 'allow', label?: string) => ({ approval_id: 'x', text, behavior, at: '2026-10-05T03:00:00Z', ...(label ? { label } : {}) })

test('answeredLine: 待ちの 1 行の頭を外して「許可した / 拒否した / 答えた」にする', () => {
  assert.deepEqual(answeredLine(a('Codex の許可待ち: git add -A', 'allow', 'Yes, proceed')), { verb: '許可した', what: 'git add -A', label: 'Yes, proceed', tone: 'allow' })
  assert.deepEqual(answeredLine(a('許可待ち: Bash: rm -rf node_modules', 'deny')), { verb: '拒否した', what: 'Bash: rm -rf node_modules', label: '', tone: 'deny' })
  assert.equal(answeredLine(a('質問: どのフレームワーク?')).verb, '答えた')
  assert.equal(answeredLine(a('質問: どのフレームワーク?')).what, 'どのフレームワーク?')
  assert.equal(answeredLine(a('質問: やめる?', 'deny')).verb, '拒否した')
  assert.deepEqual(answeredLine(a('Codex の画面で質問または許可への回答を待っている')), { verb: '許可した', what: 'Codex の画面で質問または許可への回答を待っている', label: '', tone: 'allow' }, '頭の無い文はそのまま')
})
