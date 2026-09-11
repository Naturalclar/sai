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

test('AgentMessages: メッセージで回っているターンからは送れない（連鎖は 1 段）。人の返信で起動したら解ける', () => {
  const agents = new AgentMessages()
  agents.launched('B1@r', 'm1')
  assert.equal(agents.origin('B1@r'), 'm1')
  assert.match(agents.refusal('B1@r', 't1'), /連鎖は 1 段まで/)
  agents.launched('B1@r', undefined)
  assert.equal(agents.origin('B1@r'), undefined)
  assert.equal(agents.refusal('B1@r', 't1'), '')
})
