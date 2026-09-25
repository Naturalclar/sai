import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { ClaudeSummarizer, DEFAULT_OPENAI_URL, DIGEST_ALERT_FAILS, DIGEST_MAX_TRIES, DIGEST_RETRY_DELAYS_MS, DigestStore, Digester, OpenAISummarizer, createDigester, digestKey, digestable, personaResolver, stripThinking, summarizeCommand, summarizeRequest, summarizerFactory, mayRetryWithoutReasoning } from './digest.ts'
import type { Summarizer } from './digest.ts'
import { row } from '../rows/aggregate.test.ts'
import type { PersonaId } from '../../shared/types.ts'

/**
 * 呼ばれたプロンプトを覚え、決まった一言を返す。failOn に入れた文を含む行は失敗する。
 * 一言と「次に送る文面の案」（#371）は同じ口を使うので、**別の入れ物に分けて**覚える（数える側が混ざらないように）
 */
export class FakeSummarizer implements Summarizer {
  /** 一言（digest）のプロンプト */
  prompts: string[] = []
  /** 次に送る文面の案のプロンプト（#371） */
  nextAsks: string[] = []
  failOn = new Set<string>()
  async summarize(prompt: string): Promise<string> {
    const next = prompt.includes('あなたが次に送る文')
    ;(next ? this.nextAsks : this.prompts).push(prompt)
    for (const needle of this.failOn) if (prompt.includes(needle)) throw new Error(`fail: ${needle}`)
    if (next) return `${(prompt.split('エージェントの返答:\n')[1] ?? '').slice(0, 10)}（案）`
    return `${promptBody(prompt).slice(0, 10)}（まとめ）`
  }
}

/**
 * プロンプトの末尾に入る本文。人が頼んだことを渡した回は「エージェントの返答:」の後ろ（#376）、
 * 渡していない回は `---` の後ろがそのまま本文
 */
const promptBody = (prompt: string) => prompt.split('エージェントの返答:\n')[1] ?? prompt.split('\n---\n')[1] ?? ''

const at = (n: number) => new Date(Date.UTC(2026, 8, 4, 0, n))

test('digestKey / digestable: ターン完了で本文がある行だけ', () => {
  const r = row(at(0), 'S1', { repo: 'r' })
  assert.equal(digestKey(r), `S1@r|${r.ts}`)
  assert.equal(digestable(r), true)
  assert.equal(digestable(row(at(0), 'S1', { event: 'UserPromptSubmit', text: '' })), false)
  assert.equal(digestable(row(at(0), 'S1', { event: 'PermissionRequest', text: '許可待ち: Bash' })), false)
  assert.equal(digestable(row(at(0), 'S1', { text: '   ' })), false)
})

test('summarizeCommand: -p / --model / json 出力。--bare は使わない（OAuth を読まない）', () => {
  const c = summarizeCommand('haiku')
  assert.equal(c.bin, 'claude', 'サーバの PATH の claude（SAI_CLAUDE_BIN は無い。#288）')
  assert.deepEqual(c.args, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'])
  assert.ok(!c.args.includes('--bare'))
})

test('DigestStore: 無ければ空、append で残り、読み直せる。壊れた行は落とす', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const path = join(dir, 'sub', 'digest.jsonl')
    const store = new DigestStore(path)
    await store.load()
    assert.equal(store.size, 0)
    assert.equal(store.rev(), '')
    await store.append({ key: 'a|t', persona: 'ENFP', summary: 'やったよ！', model: 'haiku', ts: 'x' })
    assert.equal(store.get('a|t')?.summary, 'やったよ！')
    assert.notEqual(store.rev(), '')
    assert.ok((await readFile(path, 'utf-8')).includes('"summary":"やったよ！"'))
    const again = new DigestStore(path)
    await again.load()
    assert.equal(again.get('a|t')?.summary, 'やったよ！')
    await appendFile(path, '{ not json\n{"key":1}\n')
    const reread = new DigestStore(path)
    await reread.load()
    assert.equal(reread.size, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 起動より前の行は作らず、あとに現れた行だけ新しい順に作る。失敗した行は無いまま。性格は作る直前の値', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    let persona: PersonaId = 'ISTJ'
    // 起動時刻は at(2)。at(0) / at(1) の行は起動より前なので作らない
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(2).toISOString(), persona: async () => persona, logPath: join(dir, 'digest.log') })
    const old1 = row(at(0), 'S1', { repo: 'r', text: '古い1' })
    const old2 = row(at(1), 'S1', { repo: 'r', text: '古い2' })
    d.scan([old1, old2])
    await d.drain()
    assert.equal(fake.prompts.length, 0, '起動より前の行は作らない')

    const n1 = row(at(2), 'S1', { repo: 'r', text: '新しい1' })
    const n2 = row(at(3), 'S2', { repo: 'r', text: '新しい2' })
    const bad = row(at(4), 'S2', { repo: 'r', text: '失敗する行' })
    const skip = row(at(5), 'S2', { repo: 'r', event: 'UserPromptSubmit', text: '', user_text: '入力' })
    fake.failOn.add('失敗する行')
    d.scan([old1, old2, n1, n2, bad, skip])
    d.scan([old1, old2, n1, n2, bad, skip]) // 同じ行を二度積まない
    await d.drain()
    assert.deepEqual(fake.prompts.map(promptBody), ['失敗する行', '新しい2', '新しい1'], '新しい順に 1 回ずつ')
    assert.equal(store.get(digestKey(n1))?.summary, '新しい1（まとめ）')
    assert.equal(store.get(digestKey(n2))?.summary, '新しい2（まとめ）')
    assert.equal(store.get(digestKey(n1))?.persona, 'ISTJ')
    assert.equal(store.get(digestKey(bad)), undefined, '失敗した行は無いまま')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /失敗する行/)

    const rows = d.attach([old1, n1, bad])
    assert.equal(rows[0], old1, '無い行は同じオブジェクト')
    assert.equal(rows[1]!.summary, '新しい1（まとめ）')
    assert.equal(rows[2], bad)
    assert.equal(d.summaryFor('S1@r', n1.ts), '新しい1（まとめ）')
    assert.equal(d.summaryFor('S1@r', ''), undefined)

    persona = 'ENFP'
    const n3 = row(at(6), 'S1', { repo: 'r', text: '新しい3' })
    d.scan([old1, old2, n1, n2, bad, skip, n3])
    await d.drain()
    assert.equal(store.get(digestKey(n3))?.persona, 'ENFP')
    assert.equal(store.get(digestKey(n1))?.persona, 'ISTJ', '過去の一言は変わらない')
    assert.equal(store.get(digestKey(old1)), undefined, '起動より前の行は作らない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 一言を作らせずに列だけ見たいとき用。summarize は返さないので pump が 1 件目で止まる */
class BlockedSummarizer implements Summarizer {
  prompts: string[] = []
  summarize(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return new Promise<string>(() => {}) // 解決しない
  }
}

test('Digester: 基準は起動時刻。あとから days が広がって古い行が見えても積まない（#159）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new BlockedSummarizer()
    // 起動は at(10)。at(0) / at(5) の行は起動より前
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(10).toISOString(), persona: async () => 'none' })
    const old1 = row(at(0), 'S1', { repo: 'r', text: '起動前1' })
    const old2 = row(at(5), 'S1', { repo: 'r', text: '起動前2' })
    const fresh1 = row(at(11), 'S2', { repo: 'r', text: '起動後1' })
    const fresh2 = row(at(12), 'S2', { repo: 'r', text: '起動後2' })

    // 起動直後の 1 回目。まだ対象の行は届いていない
    d.scan([])
    assert.equal(d.pending(), 0)

    // 狭い窓（?days=1）で叩かれ、今日の行だけが見える
    d.scan([fresh1])
    assert.equal(d.pending(), 1)

    // そのあとブラウザが既定の広い窓（?days=7）でポーリングし、過去の行が一気に見える。ここが #159 の再現:
    // 基準が「最初の scan で見えた行の集合」だと、この瞬間に古い行が全部「新しく現れた行」になって積まれる
    d.scan([old1, old2, fresh1, fresh2])
    assert.equal(d.pending(), 2, '窓が広がっても、積まれるのは起動後の 2 件だけ')

    // 同じ行を何度渡しても増えない
    d.scan([old1, old2, fresh1, fresh2])
    assert.equal(d.pending(), 2)

    // pump は性格を引くところで一度 await するので、1 tick 待ってから何を渡したか見る
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(fake.prompts.map(promptBody), ['起動後1'], '1 件目（一番新しい起動後の行）から作る')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: since を渡さなければ「いま」が基準。過去の行は窓に入っていても作らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', persona: async () => 'none' })
    // at(n) は 2026-09-04 で、実行時刻より過去
    d.scan([row(at(0), 'S1', { repo: 'r', text: '過去の行' })])
    // 数秒の緩み（DIGEST_SINCE_SLACK_MS）の内側なので、いま書かれた行は拾う
    d.scan([row(new Date(), 'S2', { repo: 'r', text: 'いまの行' })])
    await d.drain()
    assert.deepEqual(fake.prompts.map(promptBody), ['いまの行'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 自分が回した子（cwd がフィードのディレクトリ）の行は作らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', ownDir: '/home/u/.agent-feed' })
    const own = row(at(0), 'child', { cwd: '/home/u/.agent-feed', text: '一言です' })
    const under = row(at(1), 'child2', { cwd: '/home/u/.agent-feed/sub', text: '一言です' })
    const real = row(at(2), 'S1', { cwd: '/home/u/.agent-feed-other', text: '本物' })
    d.scan([own, under, real])
    await d.drain()
    assert.deepEqual(fake.prompts.map(promptBody), ['本物'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 無効なら何もしない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: false, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' })
    d.scan([row(at(0), 'S1')])
    d.scan([row(at(0), 'S1'), row(at(1), 'S1')])
    await d.drain()
    assert.equal(fake.prompts.length, 0)
    assert.equal(d.enabled, false)
    assert.equal(new Digester(store, null, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' }).enabled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- OpenAI 互換の口（ローカル LLM）

test('summarizeRequest: <base>/chat/completions に user 1 通、stream なし、思考を切る指定つき。末尾の / は無視。鍵があれば Bearer', () => {
  const r = summarizeRequest('http://127.0.0.1:11434/v1', 'qwen3:8b', 'プロンプト')
  assert.equal(r.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(r.init.method, 'POST')
  assert.deepEqual(r.init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(String(r.init.body)), { model: 'qwen3:8b', messages: [{ role: 'user', content: 'プロンプト' }], stream: false, reasoning_effort: 'none' })
  assert.deepEqual(
    JSON.parse(String(summarizeRequest('http://x/v1', 'm', 'p', undefined, { reasoningOff: false }).init.body)),
    { model: 'm', messages: [{ role: 'user', content: 'p' }], stream: false },
    'reasoningOff: false なら付けない',
  )
  assert.equal(mayRetryWithoutReasoning(400), true)
  assert.equal(mayRetryWithoutReasoning(422), true, '知らないキーを 422 で弾く厳格なサーバ')
  assert.equal(mayRetryWithoutReasoning(429), false, '混んでいるだけ。すぐ送り直さない')
  assert.equal(mayRetryWithoutReasoning(500), false)
  assert.equal(summarizeRequest('http://127.0.0.1:1234/v1/', 'm', 'p').url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.deepEqual(summarizeRequest('http://x/v1', 'm', 'p', 'sk-1').init.headers, { 'content-type': 'application/json', authorization: 'Bearer sk-1' })
})

test('stripThinking: <think>…</think> を落とす。閉じていなければそこから後ろを全部落とす', () => {
  assert.equal(stripThinking('<think>\n考え中\n</think>\n\n#35 マージした。'), '#35 マージした。')
  assert.equal(stripThinking('前<think>a</think>中<think>b</think>後'), '前中後')
  assert.equal(stripThinking('本文だけ'), '本文だけ')
  assert.equal(stripThinking('<think>閉じない'), '')
})

/** /v1/chat/completions を偽装する。handler が返した status/body をそのまま返す。null なら応答しない（タイムアウトの確認用） */
async function fakeOpenAI(handler: (body: Record<string, unknown>, headers: Record<string, string | string[] | undefined>) => { status: number; body: string } | null) {
  const seen: { path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
      seen.push({ path: req.url ?? '', body, headers: req.headers })
      const out = handler(body, req.headers)
      if (!out) return // 応答しない
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const completion = (content: string) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }) })

test('OpenAISummarizer: 普通の返答は content をそのまま。model と prompt が body に載る', async () => {
  const fake = await fakeOpenAI(() => completion('  #35 マージしたよ。次は #31？  '))
  try {
    const s = new OpenAISummarizer(fake.url, 'qwen3:8b')
    assert.equal(await s.summarize('P1'), '#35 マージしたよ。次は #31？')
    assert.equal(fake.seen.length, 1)
    assert.equal(fake.seen[0]!.path, '/v1/chat/completions')
    assert.equal(fake.seen[0]!.body.model, 'qwen3:8b')
    assert.deepEqual(fake.seen[0]!.body.messages, [{ role: 'user', content: 'P1' }])
    assert.equal(fake.seen[0]!.headers.authorization, undefined, '鍵が無ければ Authorization を付けない')
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: reasoning_effort を 4xx で断る口には、外して送り直し、通ったら以後は付けない（ログに残す）', async () => {
  for (const status of [400, 422]) {
    const fake = await fakeOpenAI((body) => {
      if ('reasoning_effort' in body) return { status, body: status === 400 ? JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'." } }) : 'Extra inputs are not permitted' }
      return completion('外して通った。')
    })
    const lines: string[] = []
    try {
      const s = new OpenAISummarizer(fake.url, 'gpt-4o-mini', 'sk-1', undefined, undefined, (l) => lines.push(l))
      assert.equal(await s.summarize('P1'), '外して通った。')
      assert.equal(fake.seen.length, 2, `${status}: 1 回目は付けて断られ、2 回目は外して通る`)
      assert.equal(fake.seen[0]!.body.reasoning_effort, 'none')
      assert.equal('reasoning_effort' in fake.seen[1]!.body, false)
      assert.equal(lines.length, 1, '外したことをログに残す（黙って思考が戻らない）')
      assert.match(lines[0]!, /reasoning_effort を受けない/)
      assert.equal(await s.summarize('P2'), '外して通った。')
      assert.equal(fake.seen.length, 3, '覚えているので次からは 1 往復')
      assert.equal('reasoning_effort' in fake.seen[2]!.body, false)
    } finally {
      await fake.close()
    }
  }
})

test('OpenAISummarizer: 外しても通らない 4xx はそのまま失敗で、指定は外さない（別の理由の 4xx で思考が戻らない）。429 は送り直さない', async () => {
  let status = 400
  const fake = await fakeOpenAI(() => ({ status, body: JSON.stringify({ error: { message: 'context length exceeded; request: {"reasoning_effort":"none"}' } }) }))
  try {
    const s = new OpenAISummarizer(fake.url, 'm')
    await assert.rejects(s.summarize('P1'), /HTTP 400/)
    assert.equal(fake.seen.length, 2, '外して 1 回だけ送り直す')
    await assert.rejects(s.summarize('P2'), /HTTP 400/)
    assert.equal(fake.seen[2]!.body.reasoning_effort, 'none', '通らなかったので覚えず、次も付けて送る')
    status = 429
    await assert.rejects(s.summarize('P3'), /HTTP 429/)
    assert.equal(fake.seen.length, 5, '429 は送り直さない（1 往復）')
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: <think> 付きの返答から思考が落ちる。鍵は Bearer で届く', async () => {
  const fake = await fakeOpenAI(() => completion('<think>\nどう言い換えるか\n</think>\n\nテストも足した。'))
  try {
    const s = new OpenAISummarizer(fake.url, 'qwen3:8b', 'sk-local')
    assert.equal(await s.summarize('P'), 'テストも足した。')
    assert.equal(fake.seen[0]!.headers.authorization, 'Bearer sk-local')
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: HTTP エラー、content が空、思考だけ、JSON でない、は throw（Digester 側が「無いまま」にする）', async () => {
  let mode: 'error' | 'empty' | 'think-only' | 'not-json' = 'error'
  const fake = await fakeOpenAI(() => {
    if (mode === 'error') return { status: 500, body: JSON.stringify({ error: { message: 'model not found' } }) }
    if (mode === 'empty') return completion('')
    if (mode === 'think-only') return completion('<think>…</think>')
    return { status: 200, body: 'this is not json' }
  })
  try {
    const s = new OpenAISummarizer(fake.url, 'm')
    await assert.rejects(s.summarize('P'), /HTTP 500: .*model not found/)
    mode = 'empty'
    await assert.rejects(s.summarize('P'), /empty result/)
    mode = 'think-only'
    await assert.rejects(s.summarize('P'), /empty result/)
    mode = 'not-json'
    await assert.rejects(s.summarize('P'), /not JSON/)
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: 応答が無ければ timeoutMs で諦める', async () => {
  const fake = await fakeOpenAI(() => null)
  try {
    const s = new OpenAISummarizer(fake.url, 'm', undefined, 100)
    await assert.rejects(s.summarize('P'), (err: unknown) => err instanceof Error && err.name === 'TimeoutError')
  } finally {
    await fake.close()
  }
})

test('createDigester: 最初は切。configure で口を組み、組んだら口とモデルを log に出す。環境変数の SAI_DIGEST は見ない（#288）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-create-'))
  const sources = { settings: { get: async () => ({ persona: 'ENFP' as PersonaId }) } }
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const d = createDigester(dir, store, sources, { SAI_DIGEST: '1', SAI_DIGEST_PROVIDER: 'openai', SAI_DIGEST_MODEL: 'qwen3:8b' }, log)
    assert.equal(d.enabled, false, '前の環境変数が残っていても入にならない（入切は settings.json だけ）')
    assert.deepEqual(logs, [])
    d.configure({ digest: true, digest_provider: 'claude', digest_model: '' })
    assert.equal(d.enabled, true)
    assert.equal(d.provider, 'claude')
    assert.equal(d.model, 'haiku', 'claude でモデルが空なら haiku')
    assert.deepEqual(logs, ['digest: claude model=haiku'])
    logs.length = 0
    d.configure({ digest: false, digest_provider: 'claude', digest_model: '' })
    assert.equal(d.enabled, false)
    assert.deepEqual(logs, [], '切るときは口を組まない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('summarizerFactory: 口で作り分ける。openai の送り先と鍵は環境変数からで、settings.json からは来ない（#288）', async () => {
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  assert.ok(summarizerFactory('/feed', {}, log)('claude', 'haiku') instanceof ClaudeSummarizer)
  assert.ok(summarizerFactory('/feed', {}, log)('openai', 'qwen3:8b') instanceof OpenAISummarizer)
  assert.deepEqual(logs, ['digest: claude model=haiku', `digest: openai ${DEFAULT_OPENAI_URL} model=qwen3:8b`], 'URL は既定 Ollama')

  const fake = await fakeOpenAI(() => completion('できた。'))
  try {
    logs.length = 0
    const s = summarizerFactory('/feed', { SAI_DIGEST_URL: fake.url, SAI_DIGEST_API_KEY: 'sk-local' }, log)('openai', 'm')
    assert.equal(await s.summarize('P'), 'できた。')
    assert.deepEqual(logs, [`digest: openai ${fake.url} model=m`])
    assert.equal(fake.seen[0]!.body.model, 'm')
    assert.equal(fake.seen[0]!.headers.authorization, 'Bearer sk-local')
  } finally {
    await fake.close()
  }
})

test('Digester.configure: 立て直さずに入切・口・モデルが変わる。入にした時刻より前の行はさかのぼって作らない。openai でモデルが空なら理由を出して作らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-configure-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    const made: string[] = []
    const d = new Digester(
      store,
      (provider, model) => {
        made.push(`${provider}:${model}`)
        return fake
      },
      { enabled: false, model: '', since: at(0).toISOString(), persona: async () => 'none' },
    )
    // 切の間は積まない
    d.scan([row(at(1), 'S1', { repo: 'r', text: '切の間' })])
    assert.equal(d.pending(), 0)
    assert.deepEqual(made, [])

    d.configure({ digest: true, digest_provider: 'claude', digest_model: '' })
    assert.equal(d.enabled, true)
    assert.equal(d.model, 'haiku')
    assert.equal(d.error, '')
    assert.deepEqual(made, ['claude:haiku'])
    // 境目は「入にした時刻」に進む。起動時の since（at(0)）より後でも、切の間に届いた行（at(1)）は作らない
    const later = new Date(Date.now() + 1000)
    d.scan([row(at(1), 'S1', { repo: 'r', text: '切の間' }), row(later, 'S2', { repo: 'r', text: '入にした後' })])
    await d.drain()
    assert.equal(fake.prompts.length, 1)
    assert.match(fake.prompts[0] ?? '', /入にした後/)
    assert.equal(store.get(digestKey(row(later, 'S2', { repo: 'r' })))?.model, 'haiku', '作ったときのモデルが残る')

    // openai でモデルが空: 保存した口は反映するが、作らずに理由を出す
    d.configure({ digest: true, digest_provider: 'openai', digest_model: '' })
    assert.equal(d.enabled, false)
    assert.equal(d.provider, 'openai')
    assert.equal(d.model, '')
    assert.match(d.error, /モデル名が要ります/)
    assert.deepEqual(made, ['claude:haiku'], '組めないときは口を作らない')
    d.configure({ digest: true, digest_provider: 'openai', digest_model: 'qwen3:8b' })
    assert.equal(d.enabled, true)
    assert.equal(d.error, '')
    assert.deepEqual(made, ['claude:haiku', 'openai:qwen3:8b'])
    // 切ったら理由も消える
    d.configure({ digest: false, digest_provider: 'openai', digest_model: '' })
    assert.equal(d.enabled, false)
    assert.equal(d.error, '')

    // 口を作れない Digester（null）は入にしても作らない
    const none = new Digester(store, null, { enabled: false, model: '', persona: async () => 'none' })
    none.configure({ digest: true, digest_provider: 'claude', digest_model: '' })
    assert.equal(none.enabled, false)
    assert.notEqual(none.error, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester.configure: 切ると積んである列を捨てる。作りかけの 1 件だけはその口で終わらせる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-off-queue-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const slow: Summarizer = {
      summarize: async (prompt) => {
        prompts.push(prompt)
        await gate
        return 'できた'
      },
    }
    const d = new Digester(store, slow, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none' })
    d.scan([row(at(1), 'S1', { repo: 'r', text: '一つ目' }), row(at(2), 'S2', { repo: 'r', text: '二つ目' }), row(at(3), 'S3', { repo: 'r', text: '三つ目' })])
    while (prompts.length === 0) await new Promise((r) => setTimeout(r, 5))
    assert.equal(d.pending(), 3, '1 件が作りかけ、2 件が列')

    d.configure({ digest: false, digest_provider: 'claude', digest_model: '' })
    assert.equal(d.pending(), 1, '列は捨て、作りかけだけ残る')
    release()
    await d.drain()
    assert.equal(prompts.length, 1, '捨てた行は口に渡さない')
    assert.equal(store.size, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: persona が null の行は作らない（セッションで一言を切っている。#263）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-off-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    // S1 だけ切っている（行ごとに引くので、同じ回の scan で混ざっていても分かれる）
    const d = new Digester(store, fake, {
      enabled: true,
      model: 'haiku',
      since: at(0).toISOString(),
      persona: async (r) => (r.session === 'S1' ? null : 'none'),
      logPath: join(dir, 'digest.log'),
    })
    d.scan([row(at(0), 'S1', { repo: 'r', text: '切っている' }), row(at(1), 'S2', { repo: 'r', text: '作る' })])
    await d.drain()
    assert.deepEqual(fake.prompts.length, 1, '切っている行は口にも渡さない')
    assert.match(fake.prompts[0] ?? '', /作る/)
    assert.equal(fake.nextAsks.length, 1, '次に送る文面の案（#371）も、切っている行では作らない')
    assert.match(fake.nextAsks[0] ?? '', /作る/)
    assert.equal(store.size, 1)

    // 積み直しても増えない（毎回 null で落ちる）
    d.scan([row(at(0), 'S1', { repo: 'r', text: '切っている' })])
    await d.drain()
    assert.equal(store.size, 1)
    // 失敗ではないのでログにも出さない
    assert.equal(await readFile(join(dir, 'digest.log'), 'utf-8').catch(() => ''), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('personaResolver: digest_off なら null。無ければセッションの persona → 全体の既定（#263）', async () => {
  const meta = new Map<string, { persona?: PersonaId; digest_off?: true }>([
    ['OFF@r', { digest_off: true }],
    ['TONE@r', { persona: 'ISTJ' }],
    // 切ってあれば persona があっても作らない
    ['BOTH@r', { persona: 'ISTJ', digest_off: true }],
  ])
  const resolve = personaResolver({
    settings: { get: async () => ({ persona: 'ENFP' as PersonaId }) },
    meta: { get: async (id) => meta.get(id) },
  })
  assert.equal(await resolve(row(at(0), 'OFF', { repo: 'r' })), null)
  assert.equal(await resolve(row(at(0), 'BOTH', { repo: 'r' })), null)
  assert.equal(await resolve(row(at(0), 'TONE', { repo: 'r' })), 'ISTJ')
  assert.equal(await resolve(row(at(0), 'NONE', { repo: 'r' })), 'ENFP', 'メタが無ければ全体の既定')
})

test('Digester: 一言と同じ行に次に送る文面の案を入れる。一番新しい行だけ。案が失敗しても一言は残る（#371）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const older = row(at(1), 'S1', { repo: 'r', text: '古い返答', user_text: '古い入力' })
    const last = row(at(2), 'S1', { repo: 'r', text: '新しい返答', user_text: '新しい入力' })
    d.scan([older, last])
    await d.drain()

    assert.equal(store.get(digestKey(older))?.summary, '古い返答（まとめ）')
    assert.equal(store.get(digestKey(older))?.next_ask, undefined, '古い行の案は作らない（作っても捨てられる）')
    assert.equal(store.get(digestKey(last))?.summary, '新しい返答（まとめ）')
    assert.equal(store.get(digestKey(last))?.next_ask, '新しい返答（案）', '一言と同じ 1 行に入る')
    assert.equal(d.nextAskFor('S1@r', last.ts), '新しい返答（案）')
    assert.equal(d.nextAskFor('S1@r', older.ts), undefined)
    assert.equal(d.nextAskFor('S1@r', ''), undefined)
    assert.equal(fake.nextAsks.length, 1, '口を叩くのはセッションの一番新しい行のときだけ')
    assert.match(fake.nextAsks[0]!, /直前にあなたが送った文:\n新しい入力/, '人の入力も材料にする')

    // 案だけ失敗しても一言は残る（別の呼び出しにしてあるので道連れにならない）
    fake.failOn.add('あなたが次に送る文')
    const newest = row(at(3), 'S1', { repo: 'r', text: 'もっと新しい', user_text: 'まだある' })
    d.scan([older, last, newest])
    await d.drain()
    assert.equal(store.get(digestKey(newest))?.summary, 'もっと新しい（まとめ）')
    assert.equal(store.get(digestKey(newest))?.next_ask, undefined)
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /次の案に失敗/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 1 回目と 2 回目で違う文を返す口（#346 の作り直しを見るため） */
class RetrySummarizer implements Summarizer {
  prompts: string[] = []
  /** 次に送る文面の案（#371）。作り直しの回数を見るテストなので、一言とは別に数える */
  nextAsks: string[] = []
  private readonly answers: string[]
  constructor(answers: string[]) {
    this.answers = answers
  }
  async summarize(prompt: string): Promise<string> {
    if (prompt.includes('あなたが次に送る文')) {
      this.nextAsks.push(prompt)
      return '次はどうする？'
    }
    this.prompts.push(prompt)
    return this.answers[Math.min(this.prompts.length - 1, this.answers.length - 1)]!
  }
}

const SOURCE = 'PR #284 を出しました。CI は通っています。マージはまだしていないので、よければ「マージして」と言ってください。'

test('Digester: 機械の判定に引っかかったら 1 回だけ作り直す。直ったものを残す（#346）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 1 回目は引用された依頼を問いかけに変えてしまう。2 回目は引用のまま
    const fake = new RetrySummarizer(['PR #284 出したよ、マージして？', 'PR #284 出したよ。よければ「マージして」と言ってね'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([r])
    await d.drain()

    assert.equal(fake.prompts.length, 2, '1 回だけ作り直す')
    assert.match(fake.prompts[1]!, /前に作った一言: PR #284 出したよ、マージして？/)
    assert.match(fake.prompts[1]!, /引用のまま残してください/, '直してほしい点を伝える')
    const entry = store.get(digestKey(r))
    assert.equal(entry?.summary, 'PR #284 出したよ。よければ「マージして」と言ってね', '直ったものを残す')
    assert.equal(entry?.retried, true)
    assert.equal(entry?.issues, undefined, '残った点が無ければ付けない')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /作り直し quoted_request → ok/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 作り直しても直らなければ 1 回目を残し、残った点を書いておく（#346）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 2 回目も問いかけのまま。しかも本文に無い番号が増えている（減っていないので 1 回目を残す）
    const fake = new RetrySummarizer(['PR #284 出したよ、マージして？', 'PR #999 出したよ、マージして？'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([r])
    await d.drain()

    assert.equal(fake.prompts.length, 2)
    const entry = store.get(digestKey(r))
    assert.equal(entry?.summary, 'PR #284 出したよ、マージして？', '減らなかったので 1 回目のまま')
    assert.deepEqual(entry?.issues, ['quoted_request'], '残った点を書いておく（数えられるように）')
    assert.equal(entry?.retried, true)
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /作り直し quoted_request → quoted_request/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 文句の無い一言は作り直さない（一言のために口を 2 回叩かない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new RetrySummarizer(['PR #284 出したよ。よければ「マージして」と言ってね'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([r])
    await d.drain()
    assert.equal(fake.prompts.length, 1)
    assert.equal(fake.nextAsks.length, 1, '案（#371）はそれとは別に 1 回。一言の作り直しではない')
    assert.equal(store.get(digestKey(r))?.retried, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 人が頼んだことも一言の材料に渡す。頼んだことにある番号は作り直さない（#376）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-ask-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 本文に無い番号を書く偽物。頼んだことに同じ番号があれば、作り話ではないので作り直さない
    const fake = new (class extends FakeSummarizer {
      async summarize(prompt: string): Promise<string> {
        await super.summarize(prompt)
        return prompt.includes('あなたが次に送る文') ? '案' : '#371 に着手したよ'
      }
    })()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const asked = row(at(1), 'S1', { repo: 'r', text: '着手しました。', user_text: '#371 に着手して' })
    d.scan([asked])
    await d.drain()
    assert.match(fake.prompts[0]!, /人が頼んだこと:\n#371 に着手して/, '頼んだことを本文と分けて渡す')
    assert.equal(store.get(digestKey(asked))?.retried, undefined, '頼んだことにある番号は作り話と数えない')
    assert.equal(store.get(digestKey(asked))?.issues, undefined)

    // 頼んだことにも無い番号は、今までどおり作り直す
    const other = row(at(2), 'S1', { repo: 'r', text: '直しました。', user_text: '直して' })
    d.scan([asked, other])
    await d.drain()
    assert.equal(store.get(digestKey(other))?.retried, true)
    assert.deepEqual(store.get(digestKey(other))?.issues, ['invented_number'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('失敗した行は間を置いて作り直し、DIGEST_MAX_TRIES 回で諦める（#443。口が落ちている間に同じ行を叩き続けない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    let now = at(10).getTime()
    const fake = new FakeSummarizer()
    fake.failOn.add('落ちる行')
    const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log'), now: () => now })
    const bad = row(at(5), 'S1', { repo: 'r', text: '落ちる行' })
    d.scan([bad])
    await d.drain()
    assert.equal(fake.prompts.length, 1)
    // 3 秒ごとの scan() でも、間隔が来るまでは積まない
    for (let i = 0; i < 5; i++) d.scan([bad])
    assert.equal(d.pending(), 0, '間隔が来るまで積まれない')
    assert.equal(fake.prompts.length, 1)
    // 間隔が来たら 1 回だけ作り直す。回を重ねるごとに間隔は伸びる
    for (const [n, delay] of DIGEST_RETRY_DELAYS_MS.entries()) {
      now += delay - 1
      d.scan([bad])
      assert.equal(d.pending(), 0, `${n + 1} 回目の間隔の手前では積まない`)
      now += 1
      d.scan([bad])
      await d.drain()
      assert.equal(fake.prompts.length, n + 2)
    }
    assert.equal(fake.prompts.length, DIGEST_MAX_TRIES)
    // 諦めたら、どれだけ待っても積まない
    now += 24 * 60 * 60_000
    d.scan([bad])
    assert.equal(d.pending(), 0)
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), new RegExp(`${DIGEST_MAX_TRIES} 回失敗したので諦めた`))
    // 口を変えたら数え直す（新しい口で、もう一度だけ機会をやる）
    d.configure({ digest: true, digest_provider: 'claude', digest_model: 'haiku' })
    d.scan([bad])
    await d.drain()
    assert.equal(fake.prompts.length, DIGEST_MAX_TRIES + 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('口が続けて DIGEST_ALERT_FAILS 回失敗したら error に出し、成功したら消える（#443）', async () => {
  const fake = new FakeSummarizer() as FakeSummarizer & { where?: string }
  fake.where = 'http://127.0.0.1:11434/v1'
  fake.failOn.add('落ちる')
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none' })
  const rows = Array.from({ length: DIGEST_ALERT_FAILS }, (_, i) => row(at(i + 1), `S${i}`, { repo: 'r', text: `落ちる ${i}` }))
  d.scan(rows.slice(0, DIGEST_ALERT_FAILS - 1))
  await d.drain()
  assert.equal(d.error, '', 'まだ出さない（たまの timeout は実データでもある）')
  d.scan(rows)
  await d.drain()
  assert.match(d.error, new RegExp(`直近 ${DIGEST_ALERT_FAILS} 件続けて失敗`))
  assert.match(d.error, /11434/, 'どこに投げているかを添える')
  d.scan([row(at(20), 'S9', { repo: 'r', text: '通る' })])
  await d.drain()
  assert.equal(d.error, '', '1 回でも通ったら消える')
  await rm(dir, { recursive: true, force: true })
})

test('1 行だけ作り直しで何度失敗しても、口の不調は出さない（行で数える。#487 のレビュー）', async () => {
  let now = at(10).getTime()
  const fake = new FakeSummarizer()
  fake.failOn.add('断られる行')
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
    const bad = row(at(5), 'S1', { repo: 'r', text: '断られる行' })
    for (const delay of [0, ...DIGEST_RETRY_DELAYS_MS]) {
      now += delay
      d.scan([bad])
      await d.drain()
    }
    assert.equal(fake.prompts.length, DIGEST_MAX_TRIES)
    assert.equal(d.error, '', '同じ行の作り直しは数えない（口はほかの行では通っている）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('作っている間に口を変えたら、前の口の失敗は数えない（#487 のレビュー）', async () => {
  let release: (err: Error) => void = () => {}
  const slow: Summarizer = { summarize: () => new Promise((_, reject) => (release = reject)) }
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const now = at(10).getTime()
    const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), slow, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
    const r = row(at(5), 'S1', { repo: 'r', text: '口を変える間の行' })
    d.scan([r])
    await new Promise((resolve) => setTimeout(resolve, 10))
    d.configure({ digest: true, digest_provider: 'claude', digest_model: 'haiku' })
    release(new Error('前の口の timeout'))
    await d.drain()
    // 新しい口では、間を置かずにすぐ作る（前の口の失敗が 1 回目として数えられていない）
    d.scan([r])
    assert.equal(d.pending(), 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
