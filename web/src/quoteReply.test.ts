import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUOTE_MAX_CHARS, quotable, quoteButtonPosition, quoteInsert, quoteText, selectionVisible } from './quoteReply.ts'
import { appendInsert } from './replyRestore.ts'

test('quoteText: 行ごとに > を付ける。複数行・箇条書き・コードの行もそのまま引用にする（#604）', () => {
  assert.equal(quoteText('案 3 を採る'), '> 案 3 を採る')
  assert.equal(quoteText('1 行目\n\n- 項目 A\n- 項目 B'), '> 1 行目\n>\n> - 項目 A\n> - 項目 B')
  assert.equal(quoteText('  const x = 1  \n  return x\n'), '>   const x = 1\n>   return x', '字下げは残し、行末の空白と前後の空行は落とす')
  assert.equal(quoteText('\r\na\r\nb\r\n'), '> a\n> b')
  assert.equal(quoteText('  \n \n'), '', '空白だけなら空')
})

test('quoteText: 長すぎる選択は切って … を付ける', () => {
  const q = quoteText('あ'.repeat(QUOTE_MAX_CHARS + 50))
  assert.equal(q, `> ${'あ'.repeat(QUOTE_MAX_CHARS)}…`)
  assert.equal(quoteText('😀'.repeat(5), 3), '> 😀😀😀…', '絵文字の途中で切らない')
})

test('quoteInsert + appendInsert: 打ちかけは消さずに末尾へ足し、続けて引用すると順に並ぶ', () => {
  const first = appendInsert('', quoteInsert('決めること 1'))
  assert.equal(first, '> 決めること 1\n\n', 'カーソルは引用の下')
  const answered = `${first}A でお願いします`
  const second = appendInsert(answered, quoteInsert('決めること 2'))
  assert.equal(second, '> 決めること 1\n\nA でお願いします\n\n> 決めること 2\n\n')
  assert.equal(appendInsert('打ちかけ', quoteInsert('引用')), '打ちかけ\n\n> 引用\n\n', 'もとの文を消さない')
  assert.equal(quoteInsert('   '), '')
})

test('quotable: 1 つの返答のバブルの中だけ。自分の入力・待ち・バブルをまたいだ選択・空白だけには出さない', () => {
  const ok = { sameBubble: true, side: 'agent', waiting: false, text: '案 3' }
  assert.equal(quotable(ok), true)
  assert.equal(quotable({ ...ok, sameBubble: false }), false)
  assert.equal(quotable({ ...ok, side: 'me' }), false)
  assert.equal(quotable({ ...ok, side: '' }), false)
  assert.equal(quotable({ ...ok, waiting: true }), false)
  assert.equal(quotable({ ...ok, text: ' \n ' }), false)
})

test('quoteButtonPosition: 選択の下の左端に置き、画面からはみ出さない', () => {
  const vp = { width: 390, height: 844 }
  assert.deepEqual(quoteButtonPosition({ left: 40, bottom: 200 }, vp), { left: 40, top: 206 })
  assert.deepEqual(quoteButtonPosition({ left: 380, bottom: 840 }, vp), { left: 390 - 120 - 8, top: 844 - 30 - 8 })
  assert.deepEqual(quoteButtonPosition({ left: -20, bottom: -50 }, vp), { left: 8, top: 8 })
})

test('selectionVisible: 選択がチャットの見えている範囲から流れ出たら出さない', () => {
  const box = { top: 100, bottom: 700 }
  assert.equal(selectionVisible({ top: 300, bottom: 320 }, box), true)
  assert.equal(selectionVisible({ top: 690, bottom: 720 }, box), true, '一部でも見えていれば出す')
  assert.equal(selectionVisible({ top: 20, bottom: 90 }, box), false, '上へ流れた')
  assert.equal(selectionVisible({ top: 710, bottom: 760 }, box), false, '下へ流れた')
})
