import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openPromptSince } from './openPrompt.ts'
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
