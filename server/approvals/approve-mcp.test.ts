import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.ts'
import { Approvals } from './approvals.ts'
import { FeedStore } from '../rows/store.ts'
import { APPROVE_MCP_PATH } from '../reply/runner.ts'
import type { ReplyCommand, Runner } from '../reply/runner.ts'

let dir: string
let server: Server
let base: string
const approvals = new Approvals()
const runner: Runner = {
  running: () => true,
  snapshot: () => ({}),
  async start(_id: string, _cmd: ReplyCommand) {},
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-mcp-'))
  await writeFile(join(dir, 'x.jsonl'), '')
  server = createServer((req, res) => void createApp(new FeedStore(dir), join(dir, 'dist'), runner, approvals)(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

/** 子に JSON-RPC を 1 行送って、id が一致する応答を待つ */
function rpc(child: ChildProcess, lines: string[], msg: object): Promise<Record<string, unknown>> {
  const id = (msg as { id?: number }).id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('応答が無い')), 10_000)
    const onLine = () => {
      for (const line of lines.splice(0)) {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.id === id) {
          clearTimeout(timer)
          child.stdout!.off('data', onData)
          resolve(obj)
          return
        }
      }
    }
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (l) lines.push(l)
      }
      onLine()
    }
    child.stdout!.on('data', onData)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

test('approve-mcp.ts: tools/call が SAI に預けられ、画面の答えがそのまま CLI への決定になる', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', APPROVE_MCP_PATH], {
    env: { ...process.env, SAI_URL: base, SAI_ENTITY: 'S@r' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  try {
    const init = await rpc(child, lines, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'sai')
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const list = await rpc(child, lines, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal((list.result as { tools: { name: string }[] }).tools[0]!.name, 'approve')

    // tools/call は答えが付くまで返らない。その間、サーバの approvals に載る
    const call = rpc(child, lines, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'gh pr create' }, tool_use_id: 'toolu_1' } },
    })
    let pending = approvals.snapshot()['S@r']
    for (let i = 0; i < 100 && !pending; i++) {
      await new Promise((r) => setTimeout(r, 50))
      pending = approvals.snapshot()['S@r']
    }
    assert.equal(pending?.[0]?.text, '許可待ち: Bash: gh pr create')
    assert.equal(pending?.[0]?.tool_use_id, 'toolu_1')

    const res = await fetch(`${base}/api/approvals/${pending![0]!.approval_id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ behavior: 'deny', message: '今はだめ' }),
    })
    assert.equal(res.status, 200)
    const result = (await call).result as { content: { type: string; text: string }[] }
    assert.deepEqual(JSON.parse(result.content[0]!.text), { behavior: 'deny', message: '今はだめ' })
    assert.deepEqual(approvals.snapshot(), {}, '渡したら消える')
  } finally {
    child.kill()
  }
})

test('approve-mcp.ts: SAI に届かなければ deny（勝手に許可しない）', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', APPROVE_MCP_PATH], {
    // 届かなければ繋ぎ直すが（#440）、いつまでも届かなければ拒否に落ちる。待つ長さはテスト用に短くする
    env: { ...process.env, SAI_URL: 'http://127.0.0.1:9', SAI_ENTITY: 'S@r', SAI_APPROVE_RECONNECT_MS: '1500' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  try {
    const call = await rpc(child, lines, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } } })
    const decision = JSON.parse((call.result as { content: { text: string }[] }).content[0]!.text) as { behavior: string; message: string }
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.message, /SAI に届かない/)
  } finally {
    child.kill()
  }
})

test('approve-mcp.ts: 答えを待っている間に SAI を立て直しても、繋ぎ直して同じ許可の答えを受け取る（#440）', async () => {
  // 1 台目の SAI（預かりを approvals.json に書く）。返信の子は生きている扱い（replying.json から引き取った形）
  const stateDir = await mkdtemp(join(tmpdir(), 'sai-mcp-restart-'))
  await writeFile(join(stateDir, 'x.jsonl'), '')
  const first = new Approvals()
  // createApp は 1 回だけ作る（作るときに approvals.json を読むので、立て直しと同じ形になる）
  const app1 = createApp(new FeedStore(stateDir), join(stateDir, 'dist'), runner, first)
  let one: Server = createServer((req, res) => void app1(req, res))
  await new Promise<void>((resolve) => one.listen(0, '127.0.0.1', resolve))
  const addr = one.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', APPROVE_MCP_PATH], {
    env: { ...process.env, SAI_URL: `http://127.0.0.1:${port}`, SAI_ENTITY: 'R@r', SAI_APPROVE_RECONNECT_MS: '20000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let two: Server | null = null
  try {
    const pending = rpc(child, lines, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'git status' } } } })
    // 預けられるまで待つ
    for (let i = 0; i < 100 && (first.snapshot()['R@r'] ?? []).length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    const asked = first.snapshot()['R@r']?.[0]
    assert.ok(asked, '1 台目に預けられた')
    // 立て直す: 1 台目を落とし（待っている GET も切れる）、同じ港で 2 台目を立てる（別の Approvals。ファイルから引き取る）
    one.closeAllConnections()
    await new Promise<void>((resolve) => one.close(() => resolve()))
    await new Promise((r) => setTimeout(r, 1_500)) // 落ちている間に MCP が 1 回は届かない
    const second = new Approvals()
    const app2 = createApp(new FeedStore(stateDir), join(stateDir, 'dist'), runner, second)
    two = createServer((req, res) => void app2(req, res))
    await new Promise<void>((resolve) => two!.listen(port, '127.0.0.1', resolve))
    assert.equal(second.snapshot()['R@r']?.[0]?.approval_id, asked.approval_id, '2 台目が同じ預かりを引き取った')
    assert.equal(second.answer(asked.approval_id, { behavior: 'allow', updatedInput: { command: 'git status' } }), true)
    const call = await pending
    const decision = JSON.parse((call.result as { content: { text: string }[] }).content[0]!.text) as { behavior: string }
    assert.equal(decision.behavior, 'allow', '拒否に落ちず、2 台目で押した答えが CLI に届く')
  } finally {
    child.kill()
    if (two) {
      two.closeAllConnections()
      await new Promise<void>((resolve) => two!.close(() => resolve()))
    }
    one = null as unknown as Server
    await rm(stateDir, { recursive: true, force: true })
  }
})
