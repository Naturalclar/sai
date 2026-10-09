import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SEND_MAX } from '../../shared/agentMessages.ts'
import { HALTED_ON_RESTART } from './agentMessages.ts'
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

test('AgentMessages: エージェントに見せない量（別のリポジトリの相手の分）は、合計に数えたうえで別にも覚える。立て直しても残る（#747）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const path = join(dir, 'agent-messages.json')
  try {
    const agents = new AgentMessages(path)
    const message = () => ({ message_id: agents.newId(), from: 'A1@r', to: 'B1@r', text: 'x', since: '' })
    agents.record(message(), 't1', 900_000)
    assert.equal(agents.hiddenInTurn('A1@r', 't1'), 0)
    agents.record(message(), 't1', 200_000, true)
    agents.record(message(), 't1', 100_000)
    assert.deepEqual([agents.readInTurn('A1@r', 't1'), agents.hiddenInTurn('A1@r', 't1')], [1_200_000, 200_000])
    assert.equal(agents.hiddenInTurn('A1@r', 't2'), 0, 'ターンが変われば 0 から')
    const after = new AgentMessages(path)
    assert.equal(after.hiddenInTurn('A1@r', 't1'), 200_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('AgentMessages: サーバを立て直しても、送った記録・止めたこと・1 ターンの回数と量・連鎖の印が残る（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const path = join(dir, 'agent-messages.json')
  try {
    const before = new AgentMessages(path)
    before.record({ message_id: 'm1', from: 'A@r', to: 'B@r', text: 'よろしく', since: '2026-09-30T10:00:00Z' }, 'turn-1', 1200)
    before.record({ message_id: 'm2', from: 'A@r', to: 'C@r', text: 'こちらも', since: '2026-09-30T10:01:00Z' }, 'turn-1', 300)
    before.stop('X@r')
    before.launched('B@r', 'm1')

    const after = new AgentMessages(path)
    assert.deepEqual(after.sentBy('A@r').map((m) => m.message_id), ['m2', 'm1'], '送った記録（新しい順）')
    assert.equal(after.get('m1')?.to, 'B@r', 'sai_wait が探せる')
    assert.equal(after.isStopped('X@r'), true, '「送信を止める」が立て直しで外れない')
    assert.match(after.refusal('X@r', 'turn-9'), /止めています/)
    assert.equal(after.sentInTurn('A@r', 'turn-1'), 2, '1 ターンの回数を数え直さない')
    assert.equal(after.readInTurn('A@r', 'turn-1'), 1500, '読み直させた量も')
    assert.equal(after.origin('B@r'), 'm1', 'メッセージで回っているターンの印（連鎖は 1 段まで）も残る')
    // 再開も書く
    after.resume('X@r')
    assert.equal(new AgentMessages(path).isStopped('X@r'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AgentMessages: 残すファイルが壊れていても起きる（無かったことにする）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const path = join(dir, 'agent-messages.json')
  try {
    await writeFile(path, '{壊れている')
    const a = new AgentMessages(path)
    assert.deepEqual(a.sentBy('A@r'), [])
    a.stop('A@r')
    assert.equal(new AgentMessages(path).isStopped('A@r'), true, '書き直して以後は残る')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AgentMessages.follow: メッセージを送ったことのある相手への返信だけ覚え、立て直しても残る（#700）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const path = join(dir, 'agent-messages.json')
  try {
    const before = new AgentMessages(path)
    before.record({ message_id: 'm1', from: 'A@r', to: 'B@r', text: 'よろしく', since: '2026-10-05T03:00:00Z' }, 'turn-1')
    const key = before.key()
    assert.equal(before.follow('A@r', 'C@r', 'マージして', 'ts'), false, '送ったことのない相手')
    assert.equal(before.follow('B@r', 'A@r', 'マージして', 'ts'), false, '逆向き')
    assert.equal(before.follow('A@r', 'A@r', 'マージして', 'ts'), false)
    assert.equal(before.key(), key, '覚えなければ rev を進めない')
    assert.equal(before.follow('A@r', 'B@r', 'あ'.repeat(600), '2026-10-05T03:05:00Z', '2026-10-05T03:10:00Z'), true)
    assert.notEqual(before.key(), key)
    const after = new AgentMessages(path)
    const [f] = after.followupsBy('A@r')
    assert.deepEqual([f?.to, f?.text.length, f?.anchor, f?.at], ['B@r', 500, '2026-10-05T03:05:00Z', '2026-10-05T03:10:00Z'])
    assert.deepEqual(after.followupsBy('B@r'), [])
    assert.deepEqual(after.sentBy('A@r').map((m) => m.message_id), ['m1'], '送った記録はそのまま')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AgentMessages の預かり: 送る前に印を書き、印が付いたまま立て直されたら送り直さない。順番待ちは残る（#727）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const path = join(dir, 'agent-messages.json')
  const held = (id: string, over: Record<string, unknown> = {}) => ({ message_id: id, from: 'A@r', to: 'B@r', text: `本文 ${id}`, turn: 'turn-1', at: '2026-10-07T03:00:00Z', context: 100, url: 'http://127.0.0.1:1', ...over })
  try {
    const before = new AgentMessages(path)
    const key = before.key()
    before.hold(held('h1'))
    before.hold(held('h2', { wake: true }))
    before.hold(held('h3', { turn: 'turn-2', context: 50 }))
    before.hold(held('x1', { from: 'C@r' }))
    assert.notEqual(before.key(), key, '預かったら画面が描き直す')
    assert.equal(before.hasActivity('A@r'), true, '送ったことが無くても、預かりがあれば枠を出す')
    assert.deepEqual(before.heldInTurn('A@r', 'turn-1'), { count: 2, read: 200 })
    assert.deepEqual(before.heldFroms(), ['A@r', 'C@r'])
    // 人が止めている・連鎖のターンは、回数を見なくても断る
    before.launched('Z@r', 'm0')
    assert.match(before.refusal('Z@r', 't', Infinity), /連鎖は 1 段まで/)
    assert.equal(before.refusal('A@r', 'turn-1', Infinity), '', '回数は見ない（超えた分は預かる）')

    // h1 は送って記録した。h2 は送りかけの印を付けたところで落ちた。h3 は順番待ち
    assert.equal(before.beginHeld('h1'), true)
    before.record({ message_id: 'h1', from: 'A@r', to: 'B@r', text: '本文 h1', since: '2026-10-07T03:01:00Z' }, 'backlog:1')
    assert.equal(before.beginHeld('h2'), true)
    assert.equal(before.beginHeld('h2'), false, '送りかけのものをもう一度は始めない')

    const after = new AgentMessages(path)
    assert.deepEqual(after.heldBy('A@r').map((h) => [h.message_id, h.halted]), [['h2', HALTED_ON_RESTART], ['h3', undefined]], '記録の済んだ預かりは捨て、送りかけは止めて残す')
    assert.equal(after.beginHeld('h2'), false, '届いたか分からないものは送り直さない')
    assert.equal(after.beginHeld('h3'), true, '順番待ちはそのまま送れる')
    assert.equal(after.heldBy('A@r')[0]?.wake, true)
    // 送らないと決めた 1 件は、捨てずに理由を付けて止める（画面に出る。自動では送らない）
    assert.equal(after.haltHeld('h3', '相手がもう送れるセッションではありません'), true)
    assert.equal(after.haltHeld('nope', 'x'), false)
    assert.deepEqual(new AgentMessages(path).heldBy('A@r').map((h) => h.halted), [HALTED_ON_RESTART, '相手がもう送れるセッションではありません'])
    // 預かっていた分を送れたときの記録は、1 ターンの回数・量を上書きしない（送り元がいま回している別のターンの数を潰さない）
    after.record({ message_id: 'n1', from: 'A@r', to: 'B@r', text: '新しいターン', since: '2026-10-07T03:05:00Z' }, 'turn-3', 700)
    after.recordHeld({ message_id: 'h9', from: 'A@r', to: 'B@r', text: '預かっていた分', since: '2026-10-07T03:06:00Z', turn: 'turn-1' })
    assert.deepEqual([after.sentInTurn('A@r', 'turn-3'), after.readInTurn('A@r', 'turn-3')], [1, 700])
    assert.equal(after.get('h9')?.turn, 'turn-1', '記録には載る（返答はいつもどおり引ける）')
    // 人が止めたら、その送り元の預かりだけ全部捨てる
    assert.equal(after.dropHeldBy('A@r'), 2)
    assert.equal(after.dropHeldBy('A@r'), 0)
    assert.deepEqual(new AgentMessages(path).heldFroms(), ['C@r'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
