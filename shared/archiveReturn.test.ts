import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newerSibling, returnedFromArchive } from './archiveReturn.ts'

const AT = '2026-09-04T03:00:00.000Z'

test('returnedFromArchive: archived_at があるのにアーカイブ済みでないときだけ、その時刻を返す（#583）', () => {
  assert.equal(returnedFromArchive({ meta: { archived_at: AT } }), AT, 'アーカイブのあとに行が増えて戻ってきた')
  assert.equal(returnedFromArchive({ meta: { archived_at: AT }, archived: true }), '', 'アーカイブ済みのまま')
  assert.equal(returnedFromArchive({ meta: { name: 'sai_main' } }), '', 'archived_at が無い')
  assert.equal(returnedFromArchive({}), '')
  assert.equal(returnedFromArchive({ meta: { archived_at: 'こわれた' } }), '')
})

test('newerSibling: 同じ worktree でアーカイブのあとに始まった一番新しいセッション。アーカイブ済み・自分・別の worktree は外す（#583）', () => {
  const self = { id: 'a@main', project: 'o/r', repo: 'main', host: '', start: '2026-09-01T00:00:00Z', meta: { archived_at: AT } }
  const peer = (id: string, start: string, over = {}) => ({ id, project: 'o/r', repo: 'main', host: '', start, ...over })
  const peers = [
    self,
    peer('old@main', '2026-09-02T00:00:00Z'),
    peer('b@main', '2026-09-25T00:00:00Z'),
    peer('c@main', '2026-09-20T00:00:00Z'),
    peer('gone@main', '2026-09-28T00:00:00Z', { archived: true }),
    peer('d@dev', '2026-09-29T00:00:00Z', { repo: 'dev' }),
    peer('e@main', '2026-09-29T00:00:00Z', { project: 'o/other' }),
    peer('f@main', '2026-09-29T00:00:00Z', { host: 'mini' }),
  ]
  assert.equal(newerSibling(self, peers)?.id, 'b@main')
  assert.equal(newerSibling(self, [self, peer('old@main', '2026-09-02T00:00:00Z')]), undefined, 'アーカイブより前に始まったものは出さない')
  assert.equal(newerSibling({ ...self, meta: {} }, peers), undefined, '戻ってきたセッションでなければ探さない')
})

test('returnedFromArchive: アーカイブのあと端末を閉じただけ（SessionEnd の行だけ増えた）なら印を出さない（#610 のレビュー）', () => {
  const before = '2026-01-01T00:00:00+09:00'
  assert.equal(returnedFromArchive({ meta: { archived_at: AT }, last_kind: 'end', last_turn_ts: before }), '', 'アーカイブより後に終わったターンが無い')
  assert.equal(returnedFromArchive({ meta: { archived_at: AT }, last_kind: 'end' }), '', 'ターン完了が 1 つも無い')
  assert.equal(returnedFromArchive({ meta: { archived_at: AT }, last_kind: 'end', last_turn_ts: '2099-01-01T00:00:00+09:00' }), AT, 'ターンが回ってから閉じた')
  assert.equal(returnedFromArchive({ meta: { archived_at: AT }, last_kind: 'turn', last_turn_ts: before }), AT, '終わりの行でなければ今までどおり')
})
