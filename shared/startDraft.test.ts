import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_TEXT_MAX_CHARS } from './agentMessages.ts'
import { liveStartDraft, START_DRAFT_TTL_MS, startDraftOf, startDraftText } from './startDraft.ts'

test('startDraftOf: 名前・エージェント・最初の指示だけを受け、名前は画面の worktree と同じ検査を通す（#892）', () => {
  assert.deepEqual(startDraftOf({ name: ' task-a ', text: ' やって ' }), { draft: { name: 'task-a', agent: 'claude', text: 'やって' } }, 'エージェントの既定は claude')
  assert.deepEqual(startDraftOf({ name: 'task-a', agent: 'opencode', text: 'x' }), { draft: { name: 'task-a', agent: 'opencode', text: 'x' } })
  for (const name of ['', '..', '../repo-b', 'a/b', '-x', '--force', '/tmp/x', 'HEAD', 'x.lock', undefined, 7]) {
    const out = startDraftOf({ name, text: 'x' })
    assert.ok('error' in out && out.error.startsWith('worktree の名前: '), String(name))
  }
  for (const agent of ['grok', 'unknown', 'Claude', 1]) assert.ok('error' in startDraftOf({ name: 'a', agent, text: 'x' }), String(agent))
  assert.ok('error' in startDraftOf({ name: 'a', text: '  ' }))
  assert.ok('error' in startDraftOf({ name: 'a', text: 'x'.repeat(AGENT_TEXT_MAX_CHARS + 1) }))
  assert.ok('draft' in startDraftOf({ name: 'a', text: 'x'.repeat(AGENT_TEXT_MAX_CHARS) }))
})

test('liveStartDraft: 置いてから 24 時間を過ぎたら出さない（#892）', () => {
  const draft = { name: 'a', agent: 'claude' as const, text: 'x', at: 1_000 }
  assert.equal(liveStartDraft(draft, 1_000 + START_DRAFT_TTL_MS - 1), draft)
  assert.equal(liveStartDraft(draft, 1_000 + START_DRAFT_TTL_MS), undefined)
  assert.equal(liveStartDraft(undefined, 0), undefined)
  assert.match(startDraftText(draft), /worktree「a」で Claude Code を始める案/)
})
