// #421。保留をどこに聞きに行くか・出したものだけ答えられるか（`createApp` を通さない分はここで見る）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpencodePermissions } from './opencodePermissions.ts'
import type { OpencodeApp } from './opencodeServer.ts'
import type { OpencodePermission } from '../../shared/opencodePermissions.ts'
import { REAL_PERMISSION } from '../../shared/opencodePermissions.test.ts'
import type { SessionSummary } from '../../shared/types.ts'

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'ses_1@r', start: '', end: '2026-09-16T14:44:53+09:00', date: '2026-09-16', dates: ['2026-09-16'],
    agent: 'opencode', agents: ['opencode'], repo: 'r', repos: ['r'], project: 'p', projects: ['p'],
    branch: '', branches: [], session_source: 'payload', sources: ['payload'], cwd: '/w', turns: 1,
    waiting: '', title: '', first_user_text: '', last_text: '', last_turn_ts: '', host: 'mac', hosts: ['mac'],
    ...over,
  }) as SessionSummary

/** 聞かれた directory を覚え、渡された保留を返すだけの偽物 */
function fake(pending: OpencodePermission[], running = false) {
  const dirs: string[][] = []
  const answered: string[] = []
  const app: OpencodeApp = {
    running: () => running,
    replying: () => ({}),
    start: async () => {},
    skills: async () => [],
    models: async () => [],
    settle: () => [],
    stop: () => {},
    async permissions(d: readonly string[]) {
      dirs.push([...d])
      return pending
    },
    async answerPermission(sessionId: string, permissionId: string, response: string) {
      answered.push(`${sessionId}/${permissionId}/${response}`)
      return true
    },
  }
  return { app, dirs, answered }
}

const pending: OpencodePermission[] = [{ id: REAL_PERMISSION.id, sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'], metadata: { filepath: '/etc/hosts' } }]

test('聞きに行くのは、待っているか回しているセッションの cwd だけ', async () => {
  const idle = fake(pending)
  assert.deepEqual(await new OpencodePermissions(idle.app).scan([session({})]), {}, '待ってもいない・回してもいなければ')
  assert.deepEqual(idle.dirs, [], 'サーバに 1 本も投げない')

  const waiting = fake(pending)
  const map = await new OpencodePermissions(waiting.app).scan([session({ waiting: '許可待ち: external_directory' })])
  assert.deepEqual(waiting.dirs, [['/w']], '待っている行があれば、その cwd を渡す')
  assert.equal(map['ses_1@r']?.length, 1)

  const busy = fake(pending, true)
  await new OpencodePermissions(busy.app).scan([session({})])
  assert.deepEqual(busy.dirs, [['/w']], '回している間も聞く（行が届く前に許可で止まる）')
})

test('同じ cwd は 1 回だけ、Claude / Codex のセッションは数えない', async () => {
  const f = fake(pending, true)
  await new OpencodePermissions(f.app).scan([
    session({ id: 'ses_1@r' }),
    session({ id: 'ses_2@r', waiting: '許可待ち' }),
    session({ id: 'c1@r', agent: 'claude', agents: ['claude'], waiting: '許可待ち: Bash: ls', cwd: '/other' }),
  ])
  assert.deepEqual(f.dirs, [['/w']])
})

test('答えられるのは出したバブルだけ。押したら消える', async () => {
  const f = fake(pending)
  const perms = new OpencodePermissions(f.app)
  const id = `opencode-${REAL_PERMISSION.id}`
  assert.equal(perms.has(id), false, 'まだ出していない')
  assert.deepEqual(await perms.answer(id, { behavior: 'allow', decision: 'once' }), { ok: false, status: 404, error: 'approval not found' })
  await perms.scan([session({ waiting: '許可待ち: external_directory' })])
  assert.equal(perms.has(id), true)
  assert.deepEqual(await perms.answer(id, { behavior: 'allow', decision: 'once' }), { ok: true })
  assert.deepEqual(f.answered, [`ses_1/${REAL_PERMISSION.id}/once`])
  assert.equal(perms.has(id), false, '押したぶんは消える（二度は押せない）')
})

test('同じ保留の since は動かない（並べ替えが毎回変わらない）', async () => {
  const f = fake(pending)
  let now = 1_000_000
  const perms = new OpencodePermissions(f.app, () => now)
  const first = await perms.scan([session({ waiting: 'w' })])
  now += 60_000
  const second = await perms.scan([session({ waiting: 'w' })])
  assert.equal(second['ses_1@r']![0]!.since, first['ses_1@r']![0]!.since)
})
