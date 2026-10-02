import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from './api'
import { galleryStamps } from './feedGallery.ts'

const SELF = 'mac'

function row(over: Partial<FeedRow>): FeedRow {
  return {
    ts: '2026-09-10T10:00:00+09:00',
    agent: 'claude',
    repo: 'sai',
    branch: 'main',
    session: 's1',
    session_source: 'payload',
    cwd: '/tmp/sai',
    event: 'Stop',
    text: '返答',
    ...over,
  }
}

test('galleryStamps: セッションごとに、発言の出る一番新しい行の ts。新しい順に並ぶ', () => {
  const stamps = galleryStamps([
    row({ session: 's1', ts: '2026-09-10T10:00:00+09:00' }),
    row({ session: 's2', ts: '2026-09-10T10:05:00+09:00' }),
    // 入力の行（端末で貼った画像はここに付く）でも目印が進む
    row({ session: 's1', ts: '2026-09-10T10:30:00+09:00', event: 'UserPromptSubmit', text: '', user_text: 'これを見て [Image #1]' }),
  ], SELF)
  assert.deepEqual([...stamps], [
    ['s1@sai', '2026-09-10T10:30:00+09:00'],
    ['s2@sai', '2026-09-10T10:05:00+09:00'],
  ])
})

test('galleryStamps: 待ちの行では目印を進めない（待ちのバブルには画像を出さない）', () => {
  const stamps = galleryStamps([
    row({ session: 's1', ts: '2026-09-10T10:00:00+09:00' }),
    row({ session: 's1', ts: '2026-09-10T10:10:00+09:00', event: 'PermissionRequest', text: '許可待ち: Bash: ls' }),
  ], SELF)
  assert.deepEqual([...stamps], [['s1@sai', '2026-09-10T10:00:00+09:00']])
})

test('galleryStamps: 別のマシンの行と、セッションの取れない行は見ない', () => {
  const stamps = galleryStamps([
    row({ session: 'far', host: 'other' }),
    row({ session: '' }),
    row({ session: 'here', host: SELF }),
    row({ session: 'nohost', host: '' }),
  ], SELF)
  assert.deepEqual([...stamps.keys()].sort(), ['here@sai', 'nohost@sai'])
})

test('galleryStamps: 上限を超えたら、新しいセッションから残す', () => {
  const stamps = galleryStamps([
    row({ session: 'old', ts: '2026-09-10T09:00:00+09:00' }),
    row({ session: 'mid', ts: '2026-09-10T10:00:00+09:00' }),
    row({ session: 'new', ts: '2026-09-10T11:00:00+09:00' }),
  ], SELF, 2)
  assert.deepEqual([...stamps.keys()], ['new@sai', 'mid@sai'])
})
