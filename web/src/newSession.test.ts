import { test } from 'node:test'
import assert from 'node:assert/strict'
import { START_SILENT_MS, startStatus, workspaceChoices, workspaceLabel } from './newSession.ts'
import type { SessionSummary } from '../../shared/types.ts'

const s = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 'S@sai', cwd: '/w/sai', host: '', project: 'Naturalclar/sai', repo: 'sai', branch: 'main', end: '2026-09-11T10:00:00+09:00', ...over }) as SessionSummary

test('workspaceChoices: cwd ごとに 1 つ、その cwd の一番新しいセッションを from にして、新しい順（#314）', () => {
  const choices = workspaceChoices(
    [
      s({ id: 'old@dev-a', cwd: '/w/dev-a', repo: 'dev-a', branch: 'x', end: '2026-09-10T09:00:00+09:00' }),
      s({ id: 'new@dev-a', cwd: '/w/dev-a', repo: 'dev-a', branch: 'y', end: '2026-09-11T09:00:00+09:00' }),
      s({ id: 'main@sai', cwd: '/w/sai', end: '2026-09-11T11:00:00+09:00' }),
    ],
    'mac',
  )
  assert.deepEqual(choices.map((w) => w.from), ['main@sai', 'new@dev-a'])
  assert.equal(choices[1]?.branch, 'y', 'ブランチも一番新しいセッションのもの')
})

test('workspaceChoices: 別のマシンのものと cwd の分からないものは出さない。エージェントは問わない', () => {
  const choices = workspaceChoices(
    [
      s({ id: 'remote@r', cwd: '/w/remote', host: 'mini' }),
      s({ id: 'nocwd@r', cwd: '' }),
      s({ id: 'codex@r', cwd: '/w/codex', agent: 'codex' }),
      s({ id: 'mine@r', cwd: '/w/mine', host: 'MAC' }),
    ],
    'mac',
  )
  assert.deepEqual(choices.map((w) => w.from).sort(), ['codex@r', 'mine@r'], 'host の大文字小文字は問わない（isRemoteHost）')
})

test('workspaceLabel: リポジトリ · worktree（ブランチ）。分からないところは省く', () => {
  const w = workspaceChoices([s({})], '')[0]!
  assert.equal(workspaceLabel(w), 'Naturalclar/sai · sai（main）')
  assert.equal(workspaceLabel({ ...w, project: '', branch: '' }), 'sai')
})

test('startStatus: 最初の行が届いたら移る。届く前に落ちたら理由、CLI が終わっても届かなければ記録の問題（#314）', () => {
  const since = Date.parse('2026-09-11T12:00:00+09:00')
  const running = { since: '2026-09-11T12:00:00+09:00', text: 'x' }
  assert.deepEqual(startStatus(false, running, since, since + 2000), { kind: 'running' })
  assert.deepEqual(startStatus(true, running, since, since + 2000), { kind: 'arrived' }, '届いたらプロセスがまだ動いていても移る')
  assert.deepEqual(startStatus(false, { ...running, failed: { code: 1, tail: 'Invalid API key' } }, since, since + 5000), { kind: 'failed', message: 'Invalid API key' })
  assert.deepEqual(startStatus(false, { ...running, failed: { code: 2, tail: '' } }, since, since + 5000), { kind: 'failed', message: '終了コード 2' })
  // 送った直後はまだ一覧に replying が載っていない（ポーリング待ち）ので、落ちたとは決めない
  assert.deepEqual(startStatus(false, undefined, since, since + 3000), { kind: 'running' })
  assert.deepEqual(startStatus(false, undefined, since, since + START_SILENT_MS + 1), { kind: 'silent' })
  assert.deepEqual(startStatus(false, running, since, since + START_SILENT_MS + 1), { kind: 'running' }, '動いている間は待つ（長いターン）')
})
