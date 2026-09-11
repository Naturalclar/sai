import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SEND_MAX } from '../../shared/agentMessages.ts'
import { AgentMessages, ensureAgentToken, tokenMatches } from './agentMessages.ts'

test('ensureAgentToken: 無ければ作って 0600 で書き、あれば同じものを読む。形が違えば作り直す（#310）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agent-'))
  try {
    const path = join(dir, 'sub', 'agent-token')
    const first = ensureAgentToken(path)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal((await readFile(path, 'utf-8')).trim(), first)
    assert.equal((await stat(path)).mode & 0o777, 0o600, '同じマシンの別のユーザーには読ませない')
    assert.equal(ensureAgentToken(path), first, 'サーバを立て直しても同じ（MCP サーバが読み直さなくてよい）')

    await writeFile(path, 'short\n')
    const next = ensureAgentToken(path)
    assert.match(next, /^[0-9a-f]{64}$/)
    assert.notEqual(next, first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tokenMatches: 同じ文字列だけ。長さ違い・文字列でない・空のトークンは通さない', () => {
  const token = 'a'.repeat(64)
  assert.equal(tokenMatches(token, token), true)
  assert.equal(tokenMatches(token, 'a'.repeat(63)), false)
  assert.equal(tokenMatches(token, 'b'.repeat(64)), false)
  assert.equal(tokenMatches(token, undefined), false)
  assert.equal(tokenMatches(token, ['x']), false)
  assert.equal(tokenMatches('', ''), false, 'トークンが無ければ誰も通さない')
})

test('AgentMessages: 1 ターンに AGENT_SEND_MAX 回まで。ターンが変われば数え直す（#311）', () => {
  const agents = new AgentMessages()
  const send = (turn: string) => {
    const message_id = agents.newId()
    agents.record({ message_id, from: 'A1@r', to: 'B1@r', text: 'x', since: '2026-09-11T01:00:00Z' }, turn)
    return message_id
  }
  for (let i = 0; i < AGENT_SEND_MAX; i++) {
    assert.equal(agents.refusal('A1@r', 't1'), '', `${i + 1} 回目は送れる`)
    send('t1')
  }
  assert.match(agents.refusal('A1@r', 't1'), new RegExp(`${AGENT_SEND_MAX} 回まで`))
  assert.equal(agents.refusal('A1@r', 't2'), '', '次のターン（人が次の指示を打った）では数え直す')
  assert.equal(agents.refusal('B1@r', 't1'), '', '回数は送り元ごと')
  const id = send('t2')
  assert.equal(agents.get(id)?.to, 'B1@r')
  assert.equal(agents.sentInTurn('A1@r', 't2'), 1)
  assert.match(agents.newId(), /^[0-9a-f]{16}$/)
})

test('AgentMessages: 1 ターンで相手に読み直させた量を足していき、ターンが変われば 0 から（#311）', () => {
  const agents = new AgentMessages()
  const message = (from: string) => ({ message_id: agents.newId(), from, to: 'B1@r', text: 'x', since: '' })
  agents.record(message('A1@r'), 't1', 900_000)
  agents.record(message('A1@r'), 't1', 0)
  agents.record(message('A1@r'), 't1', 1_100_000)
  assert.equal(agents.readInTurn('A1@r', 't1'), 2_000_000, '分からない相手（0）は足さない')
  assert.equal(agents.sentInTurn('A1@r', 't1'), 3)
  assert.equal(agents.readInTurn('A1@r', 't2'), 0)
  agents.record(message('A1@r'), 't2', 50_000)
  assert.equal(agents.readInTurn('A1@r', 't2'), 50_000)
  assert.equal(agents.readInTurn('C1@r', 't1'), 0, '送り元ごと')
})

test('AgentMessages: 人が止めたら送らせず、再開したら送れる。送った記録は新しい順に出す（#311）', () => {
  const agents = new AgentMessages()
  const k0 = agents.key()
  assert.equal(agents.hasActivity('A1@r'), false)
  assert.equal(agents.stop('A1@r'), true)
  assert.equal(agents.stop('A1@r'), false, '止まっていれば何もしない')
  assert.notEqual(agents.key(), k0, '止めたら rev が変わる（画面が拾う）')
  assert.match(agents.refusal('A1@r', 't1'), /止めています/)
  assert.equal(agents.hasActivity('A1@r'), true, '止めているだけでも画面に出す（再開を押せるように）')
  assert.equal(agents.resume('A1@r'), true)
  assert.equal(agents.resume('A1@r'), false)
  assert.equal(agents.refusal('A1@r', 't1'), '')

  for (const to of ['B1@r', 'C1@r', 'D1@r']) agents.record({ message_id: agents.newId(), from: 'A1@r', to, text: 'x', since: '2026-09-11T05:00:00.000Z' }, 't1')
  agents.record({ message_id: agents.newId(), from: 'Z1@r', to: 'B1@r', text: 'x', since: '2026-09-11T05:00:00.000Z' }, 't9')
  assert.deepEqual(agents.sentBy('A1@r').map((m) => m.to), ['D1@r', 'C1@r', 'B1@r'], '同じ時刻でも送った順の逆')
  assert.deepEqual(agents.sentBy('A1@r', 2).map((m) => m.to), ['D1@r', 'C1@r'])
  assert.equal(agents.hasActivity('Z1@r'), true)
})

test('AgentMessages: メッセージで回っているターンからは送れない（連鎖は 1 段）。人の返信で起動したら解ける', () => {
  const agents = new AgentMessages()
  agents.launched('B1@r', 'm1')
  assert.equal(agents.origin('B1@r'), 'm1')
  assert.match(agents.refusal('B1@r', 't1'), /連鎖は 1 段まで/)
  agents.launched('B1@r', undefined)
  assert.equal(agents.origin('B1@r'), undefined)
  assert.equal(agents.refusal('B1@r', 't1'), '')
})
