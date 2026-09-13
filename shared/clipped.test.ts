import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wasClipped } from './clipped.ts'

test('wasClipped は載っている項目だけ真', () => {
  assert.equal(wasClipped({ clipped: ['text'] }, 'text'), true)
  assert.equal(wasClipped({ clipped: ['text'] }, 'user_text'), false)
  assert.equal(wasClipped({ clipped: ['user_text', 'thinking'] }, 'thinking'), true)
})

test('古い行（clipped が無い）は切れていない扱い', () => {
  assert.equal(wasClipped({}, 'text'), false)
  assert.equal(wasClipped({ clipped: [] }, 'text'), false)
  // 壊れた行（配列でない）でも落ちない
  assert.equal(wasClipped({ clipped: 'text' } as unknown as Pick<import('./types.ts').FeedRow, 'clipped'>, 'text'), false)
})
