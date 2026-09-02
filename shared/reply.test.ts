import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feedReplyTargets, filterReplyTargets, mentionQuery, replyBlockedReason } from './reply.ts'
import type { FeedRow } from './types.ts'

function row(over: Partial<FeedRow>): FeedRow {
  return {
    ts: '2026-09-02T10:00:00+09:00',
    agent: 'claude',
    repo: 'sai',
    branch: 'main',
    session: 's1',
    session_source: 'payload',
    cwd: '/tmp/sai',
    event: 'Stop',
    text: '返答',
    first_user_text: '最初の指示',
    ...over,
  }
}

test('feedReplyTargets: エンティティごとに1件、新しい順、ラベルは一番新しい行のもの', () => {
  const rows = [
    row({ ts: '2026-09-02T10:00:00+09:00', session: 's1', branch: 'main', user_text: '最初の指示' }),
    row({ ts: '2026-09-02T10:05:00+09:00', session: 's2', repo: 'other', first_user_text: 'other の指示' }),
    row({ ts: '2026-09-02T10:10:00+09:00', session: 's1', branch: 'feat/x', user_text: '続きの指示\n2行目' }),
  ]
  const targets = feedReplyTargets(rows)
  assert.deepEqual(
    targets.map((t) => [t.id, t.repo, t.branch, t.title, t.blocked]),
    [
      ['s1@sai', 'sai', 'feat/x', '続きの指示', ''],
      ['s2@other', 'other', 'main', 'other の指示', ''],
    ],
  )
})

test('feedReplyTargets: 再開できないものは blocked に理由が入る。タイトルは text にフォールバックして60文字で切る', () => {
  const long = 'あ'.repeat(70)
  const rows = [
    row({ session: 's-synth', session_source: 'synth' }),
    row({ session: '', ts: '2026-09-02T10:01:00+09:00' }),
    row({ session: 's-unknown', agent: 'unknown', ts: '2026-09-02T10:02:00+09:00' }),
    row({ session: 's-notitle', first_user_text: '', text: `${long}\n2行目`, ts: '2026-09-02T10:03:00+09:00' }),
  ]
  const targets = feedReplyTargets(rows)
  assert.equal(targets.length, 4)
  assert.equal(targets[0]!.title, `${'あ'.repeat(60)}…`)
  assert.equal(targets[0]!.blocked, '')
  assert.equal(targets[1]!.blocked, replyBlockedReason({ id: 's-unknown@sai', agent: 'unknown', session_source: 'payload' }))
  assert.match(targets[2]!.id, /^unknown-2026-09-02@sai$/)
  assert.notEqual(targets[2]!.blocked, '')
  assert.equal(targets[3]!.blocked, replyBlockedReason({ id: 's-synth@sai', agent: 'claude', session_source: 'synth' }))
})

test('filterReplyTargets: リポジトリ / ブランチ / タイトルの部分一致、大文字小文字は無視', () => {
  const targets = feedReplyTargets([
    row({ session: 'a', repo: 'sai', branch: 'feat/Markdown', first_user_text: 'PR を作る' }),
    row({ session: 'b', repo: 'dotfiles', branch: 'main', first_user_text: 'zsh の設定', ts: '2026-09-02T10:01:00+09:00' }),
  ])
  assert.deepEqual(filterReplyTargets(targets, '').map((t) => t.id), ['b@dotfiles', 'a@sai'])
  assert.deepEqual(filterReplyTargets(targets, 'markdown').map((t) => t.id), ['a@sai'])
  assert.deepEqual(filterReplyTargets(targets, 'ZSH').map((t) => t.id), ['b@dotfiles'])
  assert.deepEqual(filterReplyTargets(targets, 'DOT').map((t) => t.id), ['b@dotfiles'])
  assert.deepEqual(filterReplyTargets(targets, 'nothing'), [])
})

test('mentionQuery: 行頭か空白の直後の半角 @ だけ。caret までに空白があれば閉じる', () => {
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(mentionQuery('@sa', 3), { start: 0, query: 'sa' })
  assert.deepEqual(mentionQuery('直して @sai', 8), { start: 4, query: 'sai' })
  assert.deepEqual(mentionQuery('一行目\n@x', 6), { start: 4, query: 'x' })
  // caret が @ より前なら無い
  assert.equal(mentionQuery('@sai', 0), null)
  // 空白で区切られたら確定済みとみなして閉じる
  assert.equal(mentionQuery('@sai を見て', 7), null)
  // メールアドレスの途中
  assert.equal(mentionQuery('mail me@example.com', 10), null)
  // 全角の ＠ は普通の文字
  assert.equal(mentionQuery('＠sai', 4), null)
  // caret の手前だけを見る（後ろに何があっても関係ない）
  assert.deepEqual(mentionQuery('@sa 後ろ', 3), { start: 0, query: 'sa' })
})
