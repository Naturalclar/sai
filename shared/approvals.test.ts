import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerAsk, answersReady, approvalText, askQuestions, joinAnswer, toolSummary, alwaysAllowRule, ruleLabel } from './approvals.ts'
import type { Approval } from './types.ts'

test('approvalText は record.py の waiting_text と同じ接頭辞', () => {
  assert.equal(approvalText('Bash', { command: 'rm -rf node_modules', description: '掃除' }), '許可待ち: Bash: rm -rf node_modules')
  assert.equal(approvalText('Edit', { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }), '許可待ち: Edit: /x/a.ts')
  assert.equal(approvalText('AskUserQuestion', { questions: [{ question: 'どれ?', options: [] }, { question: '型は?' }] }), '質問: どれ? / 型は?')
  assert.equal(approvalText('AskUserQuestion', {}), '質問に答えるのを待っている')
  assert.equal(approvalText('ExitPlanMode', { plan: '## 直す\n\n1. a\n2. b\n3. c\n4. d' }), 'プランの承認待ち: ## 直す\n1. a\n2. b')
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(1000) }).length, 300)
})

/**
 * 専用の要約が無いツール（MCP のツール、未知のツール）は `tool_input` をそのまま JSON にする経路（#147）。
 *
 * **`feed/test_record.py` の `test_waiting_text_matches_approval_text_for_json_tools` に同じ入力と
 * 同じ期待文字列がある。**片方だけ変えるともう片方が落ちるので、2 つの実装が離れない
 */
test('approvalText: JSON にフォールバックする経路は record.py と 1 文字も違わない（#147）', () => {
  assert.equal(approvalText('mcp__x__y', { foo: 1 }), '許可待ち: mcp__x__y: {"foo": 1}')
  // キーは挿入順ではなくソート
  assert.equal(approvalText('mcp__github__create_issue', { title: '題', body: '本文' }), '許可待ち: mcp__github__create_issue: {"body": "本文", "title": "題"}')
  // 入れ子の中まで並べ替え、配列の区切りにも空白が入る
  assert.equal(approvalText('SomeUnknownTool', { b: { y: 2, x: 1 }, a: [1, { q: '日本語' }] }), '許可待ち: SomeUnknownTool: {"a": [1, {"q": "日本語"}], "b": {"x": 1, "y": 2}}')
  // 中身が空なら JSON も出す（`{}`）。ツール名だけにはしない
  assert.equal(approvalText('SomeUnknownTool', {}), '許可待ち: SomeUnknownTool: {}')
})

test('askQuestions は壊れた形を落とし、answerAsk は元の入力に answers を足す', () => {
  const input = { questions: [{ question: '赤か青か?', header: '色', options: [{ label: '赤', description: 'red' }, { label: '青' }], multiSelect: false }, { nope: 1 }, 'x'] }
  const qs = askQuestions(input)
  assert.equal(qs.length, 1)
  assert.deepEqual(qs[0], {
    question: '赤か青か?',
    header: '色',
    options: [{ label: '赤', description: 'red', recommended: false }, { label: '青', description: '', recommended: false }],
    multiSelect: false,
    other: true,
    secret: false,
  })
  const approval: Approval = { approval_id: 'a', id: 'S@r', since: '', tool_name: 'AskUserQuestion', input, tool_use_id: '', text: '' }
  assert.deepEqual(answerAsk(approval, { '赤か青か?': '青' }), { behavior: 'allow', updatedInput: { questions: input.questions, answers: { '赤か青か?': '青' } } })
  // 選択肢に無い答え（その他の自由記入）もそのまま渡す。CLI が受け取ることは実測ずみ（#195）
  assert.deepEqual(answerAsk(approval, { '赤か青か?': 'むらさき' }).updatedInput?.answers, { '赤か青か?': 'むらさき' })
})

test('askQuestions は推奨の印を拾って label からは落とす（label 末尾でも description の書き出しでも）', () => {
  const opts = (options: unknown[]) => askQuestions({ questions: [{ question: 'q', options }] })[0]!.options
  // 英語のお約束: label の末尾に (Recommended)
  assert.deepEqual(opts([{ label: 'Vite (Recommended)', description: '速い' }]), [{ label: 'Vite', description: '速い', recommended: true }])
  // 日本語で聞かれたとき: 全角かっこ、あるいは description の書き出しが「推奨」（実測はこちらだった）
  assert.deepEqual(opts([{ label: '青（推奨）' }]), [{ label: '青', description: '', recommended: true }])
  assert.deepEqual(opts([{ label: '青', description: '推奨' }]), [{ label: '青', description: '推奨', recommended: true }])
  assert.deepEqual(opts([{ label: '青', description: '推奨: 一番速い' }]), [{ label: '青', description: '推奨: 一番速い', recommended: true }])
  // 語の途中に混ざっただけのものは印にしない
  assert.deepEqual(opts([{ label: '推奨されない案' }]), [{ label: '推奨されない案', description: '', recommended: false }])
  assert.deepEqual(opts([{ label: 'A', description: 'これは推奨しない' }]), [{ label: 'A', description: 'これは推奨しない', recommended: false }])
  // 印だけの label は空にせず元のまま残す
  assert.deepEqual(opts([{ label: '(Recommended)' }]), [{ label: '(Recommended)', description: '', recommended: true }])
})

test('joinAnswer は選んだ label と自由記入を繋ぎ、answersReady は全問そろって初めて真', () => {
  assert.equal(joinAnswer(['赤'], ''), '赤')
  assert.equal(joinAnswer(['赤', '青'], ''), '赤, 青')
  assert.equal(joinAnswer([], 'むらさき'), 'むらさき')
  assert.equal(joinAnswer(['赤'], ' きん '), '赤, きん')
  assert.equal(joinAnswer([], '   '), '')
  const qs = askQuestions({ questions: [{ question: 'a' }, { question: 'b' }] })
  assert.equal(answersReady(qs, { a: '1' }), false)
  assert.equal(answersReady(qs, { a: '1', b: '  ' }), false)
  assert.equal(answersReady(qs, { a: '1', b: '2' }), true)
  assert.equal(answersReady([], {}), false)
  const codex = askQuestions({ questions: [{ id: 'first', question: '同じ質問' }, { id: 'second', question: '同じ質問' }] })
  assert.equal(answersReady(codex, { first: '1', second: '2' }), true, 'Codexは重複する質問文でもidで区別する')
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
