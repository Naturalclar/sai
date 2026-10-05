import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexTurnSince, openPromptSince } from './openPrompt.ts'
import type { FeedRow } from './api'

const row = (ts: string, event: string) => ({ ts, event, session: 'S', repo: 'r', text: '' }) as unknown as FeedRow

test('openPromptSince: 一番新しい行が人の入力なら、その時刻。ターン完了・待ちが最後なら空。知らない event は飛ばし、並びに頼らない', () => {
  assert.equal(openPromptSince([]), '')
  assert.equal(openPromptSince([row('2026-09-10T10:00:00+09:00', 'Stop'), row('2026-09-10T10:05:00+09:00', 'UserPromptSubmit')]), '2026-09-10T10:05:00+09:00')
  assert.equal(openPromptSince([row('2026-09-10T10:05:00+09:00', 'UserPromptSubmit'), row('2026-09-10T10:06:00+09:00', 'Stop')]), '', 'ターン完了が来た')
  assert.equal(openPromptSince([row('2026-09-10T10:05:00+09:00', 'UserPromptSubmit'), row('2026-09-10T10:06:00+09:00', 'PermissionRequest')]), '', '待ちのバブルが出ている')
  assert.equal(openPromptSince([row('2026-09-10T10:05:00+09:00', 'UserPromptSubmit'), row('2026-09-10T10:06:00+09:00', 'SubagentStop')]), '2026-09-10T10:05:00+09:00', '知らない event では閉じない')
  assert.equal(openPromptSince([row('2026-09-10T10:06:00+09:00', 'UserPromptSubmit'), row('2026-09-10T10:05:00+09:00', 'Stop')]), '2026-09-10T10:06:00+09:00', '配列の並びではなく ts で見る')
})

test('codexTurnSince: 動いている開いたターンの始まり。最後のターン完了の行より前（同じ秒も）に始まったターンは出さない', () => {
  const stop = row('2026-10-05T12:00:00+09:00', 'agent-turn-complete')
  const open = (turn_since: string, active = true) => ({ active, turn_since })
  assert.equal(codexTurnSince([stop], open('2026-10-05T03:05:00.123Z')), '2026-10-05T03:05:00.123Z', '12:05 JST に始まった')
  assert.equal(codexTurnSince([], open('2026-10-05T03:05:00.123Z')), '2026-10-05T03:05:00.123Z', '行が 1 本も無いセッション（最初のターン）')
  assert.equal(codexTurnSince([stop], open('2026-10-05T02:59:00.000Z')), '', '終わったターン')
  assert.equal(codexTurnSince([stop], open('2026-10-05T03:00:00.900Z')), '', '行は秒までなので、同じ秒は終わったものとして扱う')
  assert.equal(codexTurnSince([stop], open('2026-10-05T03:05:00.123Z', false)), '', '動いていない')
  assert.equal(codexTurnSince([stop], { active: true }), '', '始まりが分からない（Claude・古いサーバ）')
  assert.equal(codexTurnSince([stop], null), '')
  assert.equal(codexTurnSince([stop, row('2026-10-05T12:06:00+09:00', 'PermissionRequest')], open('2026-10-05T03:05:00.123Z')), '2026-10-05T03:05:00.123Z', '待ちの行では閉じない')
})
