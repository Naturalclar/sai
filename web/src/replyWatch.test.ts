import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAttachments } from '../../shared/attachments.ts'
import type { Replying, ReplyingMap } from './api'
import { ENDED_WITHOUT_ROW, newReplyWatch, watchReplies } from './replyWatch.ts'

const ID = 'A@r'
const since = '2026-01-01T00:00:00.000Z'
const turn = (text: string, extra: Partial<Replying> = {}): ReplyingMap => ({ [ID]: { since, text, ...extra } })
const failedTurn = (text: string, extra: Partial<Replying> = {}): ReplyingMap => turn(text, { failed: { code: 1, tail: '落ちた' }, ...extra })

/** ポーリングを順に当てて、毎回の結果を返す。行数は `rows`（既定は増えない） */
function polls(steps: ReplyingMap[], rows: (poll: number) => number = () => 5) {
  const watch = newReplyWatch()
  return steps.map((replying, i) => watchReplies(watch, replying, () => rows(i)))
}

test('行が増えないまま処理中から消えたら、打った本文つきで「記録が増えなかった」を出す', () => {
  const [, ended] = polls([turn('本文'), {}])
  assert.deepEqual(ended, [{ id: ID, message: ENDED_WITHOUT_ROW, text: '本文' }])
})

test('行が増えて消えたら、何も出さない', () => {
  assert.deepEqual(polls([turn('本文'), {}], (i) => 5 + i)[1], [])
})

test('失敗はサーバが返し続けても 1 回だけ出し、打った本文を戻せる（画像のパスは外す）', () => {
  const text = withAttachments('本文', ['/作り物/attachments/0123456789abcdef/aaaabbbbccccdddd.png'])
  const [first, second] = polls([failedTurn(text), failedTurn(text)])
  assert.equal(first!.length, 1)
  assert.equal(first![0]!.text, '本文')
  assert.match(first![0]!.message, /落ちた/)
  assert.deepEqual(second, [])
})

test('要約だけのターンは、行が増えずに終わっても「記録が増えなかった」と見ない（#837）', () => {
  assert.deepEqual(polls([turn('/compact 指示', { compact: true }), {}])[1], [])
})

test('失敗のあとに要約のターンが回って終わっても、前の失敗の分から「記録が増えなかった」を出さない（#850）', () => {
  const results = polls([
    turn('前の本文'),
    failedTurn('前の本文'),
    failedTurn('前の本文'),
    turn('/compact 指示', { compact: true }),
    {}, // 要約が終わり、預かりが本文を起こすまでの隙間
    turn('次の本文'),
  ])
  assert.equal(results[1]!.length, 1, '失敗はそのとき 1 回だけ出す')
  assert.deepEqual(results.slice(2), [[], [], [], []])
})

test('失敗がサーバの一覧から消えても、「記録が増えなかった」に化けない（#850）', () => {
  assert.deepEqual(polls([failedTurn('前の本文'), failedTurn('前の本文'), {}])[2], [])
})

test('Claude の要約の失敗には、入力欄に戻す文を付けない（本文は預かりにある。#851）', () => {
  const [failed] = polls([failedTurn('/compact 次の作業に要ることを残す', { compact: true })])
  assert.equal(failed!.length, 1)
  assert.equal(failed![0]!.text, '')
  assert.match(failed![0]!.message, /落ちた/)
})

test('Codex の要約の失敗（`text` が空）も、入力欄に戻す文は空のまま（#837）', () => {
  const [failed] = polls([failedTurn('', { failed: { tail: '要約できませんでした: 作り物' } })])
  assert.equal(failed![0]!.text, '')
})
