import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FULL_TEXT_JUDGE_HEAD, FULL_TEXT_JUDGE_TAIL, fullTextJudgePrompt, judgeBody, parseFullTextJudge } from './fullTextJudge.ts'

test('parseFullTextJudge: 1 語のときだけ読む。飾り・大文字小文字・句点は許す（#639）', () => {
  for (const a of ['FULL', 'full', ' Full\n', '**FULL**', '「FULL」', 'FULL。', 'FULL.']) assert.equal(parseFullTextJudge(a), true, a)
  for (const a of ['SUMMARY', 'summary', '`SUMMARY`']) assert.equal(parseFullTextJudge(a), false, a)
})

test('parseFullTextJudge: 1 語でない・空・両方書いてある答えは読めない（呼び出し側は今までどおり一言を作る。#639）', () => {
  for (const a of ['', '  ', 'FULL か SUMMARY', 'FULL です。理由は…', 'SUMMARY\nFULL', '判断待ち', 'FULLY']) assert.equal(parseFullTextJudge(a), null, a)
})

test('judgeBody: 長い本文は頭と末尾だけを渡す。短ければそのまま（#639）', () => {
  assert.equal(judgeBody('短い'), '短い')
  const long = `${'あ'.repeat(FULL_TEXT_JUDGE_HEAD)}${'中'.repeat(500)}${'末'.repeat(FULL_TEXT_JUDGE_TAIL)}`
  const body = judgeBody(long)
  assert.ok(body.startsWith('あ'.repeat(FULL_TEXT_JUDGE_HEAD)))
  assert.ok(body.endsWith('末'.repeat(FULL_TEXT_JUDGE_TAIL)))
  assert.ok(!body.includes('中'.repeat(2)), '真ん中は落とす')
})

test('fullTextJudgePrompt: 本文が先で問いが後。指示の部分に書き写せる番号・作例を置かない（#639）', () => {
  const p = fullTextJudgePrompt('本文です')
  assert.ok(p.indexOf('本文です') < p.indexOf('1 語だけで答えてください'))
  const instructions = p.split('</返答>')[1] ?? ''
  assert.doesNotMatch(instructions, /#\d/)
  assert.doesNotMatch(instructions, /例[:：]/)
  assert.match(instructions, /迷ったら SUMMARY/)
})
