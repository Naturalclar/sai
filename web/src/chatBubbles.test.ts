// サーバの `rowMakesBubble()`（#903）が、画面の `toUtterances()` とバブルを立てる行で揃っているか
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowMakesBubble } from '../../shared/chatBubbles.ts'
import { IDLE_PREFIX } from '../../shared/events.ts'
import { toUtterances } from './chatGroups.ts'
import type { FeedRow } from '../../shared/types.ts'

const base: FeedRow = { ts: '2026-11-01T00:00:00+00:00', agent: 'claude', repo: 'repo-a', branch: 'main', session: 's1', session_source: 'payload', cwd: '/w', event: 'Stop', text: '返答', user_text: '' }

test('rowMakesBubble は toUtterances がバブルを立てる行と同じ', () => {
  const cases: Partial<FeedRow>[] = [
    { event: 'Stop' },
    { event: 'Stop', user_text: 'やって' },
    { event: 'agent-turn-complete' },
    { event: 'UserPromptSubmit', text: '', user_text: 'やって' },
    { event: 'UserPromptSubmit', text: '', user_text: '' },
    { event: 'UserPromptSubmit', text: '', user_text: 'This session is being continued from a previous conversation that ran out of context.' },
    { event: 'Notification', text: `${IDLE_PREFIX}: Claude is waiting for your input` },
    { event: 'Notification', text: 'Claude needs your permission' },
    { event: 'PermissionRequest', text: '許可待ち: Bash: ls' },
    { event: 'SessionEnd', text: '' },
    { event: 'なにか知らないもの', text: '' },
  ]
  for (const c of cases) {
    const row = { ...base, ...c }
    assert.equal(rowMakesBubble(row), toUtterances([row]).length > 0, JSON.stringify(c))
  }
  // 立てない側も確かに通っている（作り物の行が全部バブルになっていない）
  assert.ok(cases.filter((c) => !rowMakesBubble({ ...base, ...c })).length >= 4)
})
