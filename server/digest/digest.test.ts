import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { DEFAULT_OPENAI_URL, DigestStore, Digester, OpenAISummarizer, digestKey, digestable, digesterFromEnv, personaResolver, stripThinking, summarizeCommand, summarizeRequest } from './digest.ts'
import type { Summarizer } from './digest.ts'
import { row } from '../rows/aggregate.test.ts'
import type { PersonaId } from '../../shared/types.ts'

/** 呼ばれたプロンプトを覚え、決まった一言を返す。failOn に入れた文を含む行は失敗する */
export class FakeSummarizer implements Summarizer {
  prompts: string[] = []
  failOn = new Set<string>()
  async summarize(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    for (const needle of this.failOn) if (prompt.includes(needle)) throw new Error(`fail: ${needle}`)
    const body = prompt.split('\n---\n')[1] ?? ''
    return `一言: ${body.slice(0, 10)}`
  }
}

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
  const c = summarizeCommand('haiku', {})
  assert.equal(c.bin, 'claude')
  assert.deepEqual(c.args, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'])
  assert.ok(!c.args.includes('--bare'))
  assert.equal(summarizeCommand('haiku', { SAI_CLAUDE_BIN: '/opt/claude' }).bin, '/opt/claude')
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
    assert.deepEqual(fake.prompts.map((p) => p.split('\n---\n')[1]), ['失敗する行', '新しい2', '新しい1'], '新しい順に 1 回ずつ')
    assert.equal(store.get(digestKey(n1))?.summary, '一言: 新しい1')
    assert.equal(store.get(digestKey(n2))?.summary, '一言: 新しい2')
    assert.equal(store.get(digestKey(n1))?.persona, 'ISTJ')
    assert.equal(store.get(digestKey(bad)), undefined, '失敗した行は無いまま')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /失敗する行/)

    const rows = d.attach([old1, n1, bad])
    assert.equal(rows[0], old1, '無い行は同じオブジェクト')
    assert.equal(rows[1]!.summary, '一言: 新しい1')
    assert.equal(rows[2], bad)
    assert.equal(d.summaryFor('S1@r', n1.ts), '一言: 新しい1')
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
    assert.deepEqual(fake.prompts.map((p) => p.split('\n---\n')[1]), ['起動後1'], '1 件目（一番新しい起動後の行）から作る')
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
    assert.deepEqual(fake.prompts.map((p) => p.split('\n---\n')[1]), ['いまの行'])
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
    assert.deepEqual(fake.prompts.map((p) => p.split('\n---\n')[1]), ['本物'])
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

test('summarizeRequest: <base>/chat/completions に user 1 通、stream なし。末尾の / は無視。鍵があれば Bearer', () => {
  const r = summarizeRequest('http://127.0.0.1:11434/v1', 'qwen3:8b', 'プロンプト')
  assert.equal(r.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(r.init.method, 'POST')
  assert.deepEqual(r.init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(String(r.init.body)), { model: 'qwen3:8b', messages: [{ role: 'user', content: 'プロンプト' }], stream: false })
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

test('digesterFromEnv: SAI_DIGEST_PROVIDER で口を選ぶ。openai は SAI_DIGEST_MODEL が無いと無効のまま立つ（落とさない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-env-'))
  const sources = { settings: { get: async () => ({ persona: 'ENFP' as PersonaId }) } }
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    // 既定は claude / haiku、SAI_DIGEST が無ければ無効で何も言わない
    let d = digesterFromEnv(dir, store, sources, {}, log)
    assert.equal(d.enabled, false)
    assert.equal(d.provider, 'claude')
    assert.equal(d.model, 'haiku')
    assert.deepEqual(logs, [])
    // claude を有効に
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST: '1' }, log)
    assert.equal(d.enabled, true)
    assert.equal(d.provider, 'claude')
    assert.deepEqual(logs, ['digest: claude model=haiku'])
    // openai: モデル必須
    logs.length = 0
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST: '1', SAI_DIGEST_PROVIDER: 'openai' }, log)
    assert.equal(d.enabled, false, 'モデルが無ければ summarizer を作らない')
    assert.equal(d.provider, 'openai')
    assert.match(logs[0] ?? '', /SAI_DIGEST_MODEL が要る/)
    // openai: URL は既定 Ollama
    logs.length = 0
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST: '1', SAI_DIGEST_PROVIDER: 'openai', SAI_DIGEST_MODEL: 'qwen3:8b' }, log)
    assert.equal(d.enabled, true)
    assert.equal(d.provider, 'openai')
    assert.equal(d.model, 'qwen3:8b')
    assert.deepEqual(logs, [`digest: openai ${DEFAULT_OPENAI_URL} model=qwen3:8b`])
    // openai: URL を変える
    logs.length = 0
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST: '1', SAI_DIGEST_PROVIDER: 'openai', SAI_DIGEST_MODEL: 'm', SAI_DIGEST_URL: 'http://127.0.0.1:1234/v1' }, log)
    assert.deepEqual(logs, ['digest: openai http://127.0.0.1:1234/v1 model=m'])
    // 知らない口は無効のまま
    logs.length = 0
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST: '1', SAI_DIGEST_PROVIDER: 'gemini' }, log)
    assert.equal(d.enabled, false)
    assert.match(logs[0] ?? '', /知らない口/)
    // SAI_DIGEST が無ければ、口の設定が間違っていても黙っている
    logs.length = 0
    d = digesterFromEnv(dir, store, sources, { SAI_DIGEST_PROVIDER: 'openai' }, log)
    assert.equal(d.enabled, false)
    assert.deepEqual(logs, [])
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
