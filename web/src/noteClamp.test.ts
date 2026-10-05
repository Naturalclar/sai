import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_CLAMP_CHARS, NOTE_CLAMP_LINES, isLongNote, shownNotes } from './noteClamp.ts'

const n = (i: number) => ({ text: `文 ${i}`, at: new Date(Date.UTC(2026, 9, 5, 0, 0, i)).toISOString() })

test('shownNotes: 末尾の max 件を出し、出していない数を「ほか」に数える', () => {
  const notes = [n(1), n(2), n(3)]
  assert.deepEqual(shownNotes(notes, 3, 3), { shown: notes, earlier: 0 })
  assert.deepEqual(shownNotes(notes, 9, 3), { shown: notes, earlier: 6 }, '応答に載らなかった古い分')
  assert.deepEqual(shownNotes(notes, 9, 3, 1), { shown: [n(3)], earlier: 8 }, 'フィードは最新の 1 つ')
  assert.deepEqual(shownNotes([n(3)], 9, 3), { shown: [n(3)], earlier: 0 }, '前のターンの文を落としたあとは、載らなかった分が同じターンか分からないので数えない')
  assert.deepEqual(shownNotes([], 9, 3), { shown: [], earlier: 0 })
})

test('isLongNote: 字数か行数が多ければ畳む', () => {
  assert.equal(isLongNote('短い文'), false)
  assert.equal(isLongNote('あ'.repeat(NOTE_CLAMP_CHARS + 1)), true)
  assert.equal(isLongNote(Array.from({ length: NOTE_CLAMP_LINES + 1 }, () => 'x').join('\n')), true)
})
