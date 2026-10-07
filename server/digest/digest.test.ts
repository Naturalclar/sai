import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { isTimeout, ClaudeSummarizer, SUMMARIZE_ENV, formFailure, summarizeStats, DEFAULT_OPENAI_URL, DIGEST_ALERT_FAILS, DIGEST_BREAK_MS, DIGEST_MAX_TRIES, DIGEST_RETRY_DELAYS_MS, DigestStore, Digester, OpenAISummarizer, createDigester, digestKey, digestable, partsOf, personaResolver, stripThinking, summarizeCommand, summarizeRequest, summarizerFactory, mayRetryWithoutReasoning } from './digest.ts'
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
  /** 「要約で足りるか」の判定のプロンプト（#639） */
  judges: string[] = []
  /** 判定の答え。本文にこの文があれば FULL、無ければ `judgeAnswer` */
  fullOn = new Set<string>()
  judgeAnswer = 'SUMMARY'
  failOn = new Set<string>()
  async summarize(prompt: string): Promise<string> {
    if (prompt.includes('報告なら SUMMARY')) {
      this.judges.push(prompt)
      for (const needle of this.failOn) if (prompt.includes(needle)) throw new Error(`fail: ${needle}`)
      return [...this.fullOn].some((needle) => prompt.includes(needle)) ? 'FULL' : this.judgeAnswer
    }
    const next = prompt.includes('あなたが次に送る文')
    ;(next ? this.nextAsks : this.prompts).push(prompt)
    for (const needle of this.failOn) if (prompt.includes(needle)) throw new Error(`fail: ${needle}`)
    // 人の返信として読める形（指示）で返す。本文の頭をそのまま返すと、案の確かめ（#729）が「本文の写し」として落とす
    if (next) return `${(prompt.split('エージェントの返答:\n')[1] ?? '').replace(/\s+/g, ' ').slice(0, 10)}（案）を進めて`
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

test('isTimeout: fetch の時間切れと claude -p の時間切れだけ（#639）', () => {
  assert.equal(isTimeout(new DOMException('x', 'TimeoutError')), true)
  assert.equal(isTimeout(new Error('timeout after 90000ms')), true)
  assert.equal(isTimeout(new Error('empty result')), false)
  assert.equal(isTimeout(new Error('HTTP 500: x')), false)
})

test('summarizeCommand: -p / --model / json 出力に、道具・MCP・スキルを外すフラグを足す。--bare と権限のフラグは使わない（#740）', () => {
  const c = summarizeCommand('haiku')
  assert.equal(c.bin, 'claude', 'サーバの PATH の claude（SAI_CLAUDE_BIN は無い。#288）')
  assert.deepEqual(c.args, [
    '-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
  ])
  assert.ok(!c.args.includes('--setting-sources'), '利用者の設定ファイルは読むまま（設定の env の送り先・プロキシを黙って迂回しない）')
  assert.ok(!c.args.includes('--bare'), 'OAuth を読まない')
  for (const flag of c.args) assert.doesNotMatch(flag, /permission|allowedTools|allowed-tools|dangerously/i, '足すのは減らす側だけ')
  // 前の形（軽い形が通らないときの戻り先）
  assert.deepEqual(summarizeCommand('haiku', false).args, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'])
  assert.deepEqual(Object.keys(SUMMARIZE_ENV).sort(), ['CLAUDE_CODE_DISABLE_THINKING', 'MAX_THINKING_TOKENS'], '思考を切る指定だけ')
})

test('summarizeStats: 時間とトークンだけを抜く（本文は持たない）。数字が無ければ undefined', () => {
  const out = { type: 'result', is_error: false, result: '一言の本文', duration_ms: 2258, duration_api_ms: 930, total_cost_usd: 0.0028, usage: { input_tokens: 3, cache_creation_input_tokens: 998, cache_read_input_tokens: 6194, output_tokens: 32 } }
  assert.deepEqual(summarizeStats(out), { duration_ms: 2258, duration_api_ms: 930, input_tokens: 3, cache_write_tokens: 998, cache_read_tokens: 6194, output_tokens: 32, cost_usd: 0.0028 })
  assert.ok(!JSON.stringify(summarizeStats(out)).includes('一言'))
  assert.deepEqual(summarizeStats({ duration_ms: 10 }), { duration_ms: 10, duration_api_ms: 0, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 })
  for (const bad of [null, 'x', {}, { result: 'x' }]) assert.equal(summarizeStats(bad), undefined)
})

/** 偽の `claude`。受けた引数と環境を `calls` に 1 行ずつ残し、`$FAKE_REJECT` に入っているフラグが来たら「知らないフラグ」で落ちる */
const FAKE_CLAUDE = `#!/bin/bash
d="$(dirname "$0")"
echo "$* | think=$MAX_THINKING_TOKENS/$CLAUDE_CODE_DISABLE_THINKING skip=$AGENT_FEED_SKIP" >> "$d/calls"
cat > /dev/null
[ -f "$d/slow" ] && exec sleep 5
[ -n "$FAKE_API_ERROR" ] && { echo '{"type":"result","is_error":true,"result":"API Error: Overloaded"}'; exit 1; }
for a in "$@"; do if [ -n "$FAKE_REJECT" ] && [ "$a" = "$FAKE_REJECT" ]; then echo "error: unknown option '$a'" >&2; exit 1; fi; done
echo '{"type":"result","is_error":false,"result":" できました ","duration_ms":1200,"duration_api_ms":900,"total_cost_usd":0.002,"usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":7000,"output_tokens":40}}'
`

async function withFakeClaude(fn: (bin: string, calls: () => Promise<string[]>, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-claude-'))
  try {
    const bin = join(dir, 'claude')
    await writeFile(bin, FAKE_CLAUDE)
    await chmod(bin, 0o755)
    await fn(bin, async () => (await readFile(join(dir, 'calls'), 'utf-8')).trim().split('\n'), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ClaudeSummarizer: 軽い形で起こし、思考を切る指定と AGENT_FEED_SKIP を渡す。1 回ぶんの数字を持つ（#740）', async () => {
  await withFakeClaude(async (bin, calls, dir) => {
    const s = new ClaudeSummarizer('haiku', dir, {}, { bin })
    assert.equal(await s.summarize('言い換えて'), 'できました')
    assert.deepEqual(s.lastStats, { duration_ms: 1200, duration_api_ms: 900, input_tokens: 3, cache_write_tokens: 0, cache_read_tokens: 7000, output_tokens: 40, cost_usd: 0.002 })
    const [line] = await calls()
    assert.match(line!, /--tools  --strict-mcp-config --mcp-config \{"mcpServers":\{\}\} --disable-slash-commands \| think=0\/1 skip=1$/)
  })
})

test('ClaudeSummarizer: 軽い形が知らないフラグで落ちる版では、前の形で 1 回試し、通ったら以後は前の形で起こす', async () => {
  await withFakeClaude(async (bin, calls, dir) => {
    const reasons: string[] = []
    const s = new ClaudeSummarizer('haiku', dir, { FAKE_REJECT: '--strict-mcp-config' }, { bin, onFallback: (r) => reasons.push(r) })
    assert.equal(await s.summarize('1 回目'), 'できました')
    assert.equal(await s.summarize('2 回目'), 'できました')
    const lines = await calls()
    assert.equal(lines.length, 3, '1 回目は軽い形 → 前の形、2 回目は前の形だけ（毎回 2 本起こさない）')
    assert.match(lines[0]!, /--strict-mcp-config/)
    for (const line of lines.slice(1)) assert.match(line, /^-p --model haiku --output-format json --no-session-persistence \| think=\/ skip=1$/, '前の形には外すフラグも思考の指定も付けない')
    assert.equal(reasons.length, 1)
    assert.match(reasons[0]!, /unknown option/)
  })
})

test('ClaudeSummarizer: API の失敗・空の答えでは前の形を試さない（通ると、以後ずっと遅い前の形に戻ってしまう）。どちらの形でも落ちるなら、しばらく 2 本起こさない', async () => {
  assert.equal(formFailure(new Error("exit 1: error: unknown option '--tools'")), true)
  for (const msg of ['claude: API Error: Overloaded', 'claude: empty result', 'claude: Not logged in · Please run /login', 'timeout after 90000ms']) assert.equal(formFailure(new Error(msg)), false, msg)
  await withFakeClaude(async (bin, calls, dir) => {
    const s = new ClaudeSummarizer('haiku', dir, { FAKE_API_ERROR: '1' }, { bin })
    await assert.rejects(s.summarize('x'), /API Error: Overloaded/)
    assert.equal((await calls()).length, 1, '前の形は起こさない')
    // どちらの形でも落ちる（CLI が壊れている）: 最初の理由を返し、次からは 1 本だけ
    const broken = new ClaudeSummarizer('haiku', dir, { FAKE_REJECT: '-p' }, { bin })
    await assert.rejects(broken.summarize('x'), /unknown option/)
    await assert.rejects(broken.summarize('y'), /unknown option/)
    assert.equal((await calls()).length, 1 + 2 + 1)
  })
})

test('ClaudeSummarizer: 時間切れでは前の形を試さない（前の形はもっと遅い）。legacy は最初から前の形', async () => {
  await withFakeClaude(async (bin, calls, dir) => {
    await writeFile(join(dir, 'slow'), '')
    const s = new ClaudeSummarizer('haiku', dir, {}, { bin, timeoutMs: 1500 })
    await assert.rejects(s.summarize('x'), /timeout after 1500ms/)
    assert.equal((await calls()).length, 1)
    await rm(join(dir, 'slow'))
    const legacy = new ClaudeSummarizer('haiku', dir, {}, { bin, legacy: true })
    await legacy.summarize('x')
    assert.match((await calls()).at(-1)!, /--no-session-persistence \| think=\/ skip=1$/)
  })
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
  for (const status of [401, 403, 404, 413]) assert.equal(mayRetryWithoutReasoning(status), false, `${status}: 鍵・モデル名・大きさの間違いは指定のせいではない（2 回送らない）`)
  for (const status of [408, 409, 425, 429]) assert.equal(mayRetryWithoutReasoning(status), false, `${status}: 一時的。外して通っても覚えてはいけない`)
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

test('OpenAISummarizer: reasoning_effort を 400 / 422 で断る口には、外して送り直し、通ったら以後は付けない（ログに残す）', async () => {
  let status = 400
  const fake = await fakeOpenAI((body) => ('reasoning_effort' in body ? { status, body: 'Extra inputs are not permitted: reasoning_effort' } : completion('外して通った。')))
  try {
    for (status of [400, 422]) {
      fake.seen.length = 0
      const lines: string[] = []
      const s = new OpenAISummarizer(fake.url, 'gpt-4o-mini', { apiKey: 'sk-1', log: (l) => lines.push(l) })
      assert.equal(await s.summarize('P1'), '外して通った。')
      assert.equal(fake.seen.length, 2, `${status}: 1 回目は付けて断られ、2 回目は外して通る`)
      assert.equal(fake.seen[0]!.body.reasoning_effort, 'none')
      assert.equal('reasoning_effort' in fake.seen[1]!.body, false)
      assert.equal(lines.length, 1, '外したことをログに残す（黙って思考が戻らない）')
      assert.match(lines[0]!, new RegExp(`reasoning_effort を受けない（HTTP ${status}: `))
      assert.equal(await s.summarize('P2'), '外して通った。')
      assert.equal(fake.seen.length, 3, '覚えているので次からは 1 往復')
      assert.equal('reasoning_effort' in fake.seen[2]!.body, false)
    }
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: 外しても通らない 400 はそのまま失敗で、指定は外さない。401 / 404 / 408 / 429 は送り直さない（ログも出ない）', async () => {
  let status = 400
  const fake = await fakeOpenAI(() => ({ status, body: JSON.stringify({ error: { message: 'context length exceeded; request: {"reasoning_effort":"none"}' } }) }))
  const lines: string[] = []
  try {
    const s = new OpenAISummarizer(fake.url, 'm', { log: (l) => lines.push(l) })
    await assert.rejects(s.summarize('P1'), /HTTP 400/)
    assert.equal(fake.seen.length, 2, '外して 1 回だけ送り直す')
    await assert.rejects(s.summarize('P2'), /HTTP 400/)
    assert.equal(fake.seen[2]!.body.reasoning_effort, 'none', '通らなかったので覚えず、次も付けて送る')
    for (status of [401, 404, 408, 429]) {
      fake.seen.length = 0
      await assert.rejects(s.summarize('P3'), new RegExp(`HTTP ${status}`))
      assert.equal(fake.seen.length, 1, `${status} は送り直さない（1 往復）`)
      assert.equal(fake.seen[0]!.body.reasoning_effort, 'none', '指定は付けたまま')
    }
    assert.equal(lines.length, 0, '外して通っていないので「受けない」の知らせは出ない')
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: 送り直しが timeout で落ちたら、最初の 4xx の理由を添えて投げる（timeout の文だけで原因を隠さない）', async () => {
  const fake = await fakeOpenAI((body) => ('reasoning_effort' in body ? { status: 422, body: 'Extra inputs are not permitted' } : null))
  try {
    const s = new OpenAISummarizer(fake.url, 'm', { timeoutMs: 150 })
    const t = Date.now()
    await assert.rejects(s.summarize('P'), /HTTP 422: Extra inputs are not permitted; reasoning_effort なしで送り直し: .*(timeout|abort)/i)
    assert.ok(Date.now() - t < 1_000, '1 件の上限は送り直しを含めて timeoutMs（signal は 1 つ）')
    assert.equal(fake.seen.length, 2)
  } finally {
    await fake.close()
  }
})

test('OpenAISummarizer: <think> 付きの返答から思考が落ちる。鍵は Bearer で届く', async () => {
  const fake = await fakeOpenAI(() => completion('<think>\nどう言い換えるか\n</think>\n\nテストも足した。'))
  try {
    const s = new OpenAISummarizer(fake.url, 'qwen3:8b', { apiKey: 'sk-local' })
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
    const s = new OpenAISummarizer(fake.url, 'm', { timeoutMs: 100 })
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

test('Digester: persona が null の行は一言を作らない（セッションで一言を切っている。#263）。次の案は作る（#560）', async () => {
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
    assert.deepEqual(fake.prompts.length, 1, '切っている行の一言は口に渡さない')
    assert.match(fake.prompts[0] ?? '', /作る/)
    // 次に送る文面の案（#371）は一言とは別で、切っているセッションでも作る（#560）
    assert.equal(fake.nextAsks.length, 2)
    const off = store.get(digestKey(row(at(0), 'S1', { repo: 'r' })))
    assert.equal(off?.summary, '', '一言は空（作っていない）')
    assert.equal(off?.next_ask, '切っている（案）を進めて')
    assert.equal(d.summaryFor('S1@r', row(at(0), 'S1', { repo: 'r' }).ts), undefined, '空の一言は「一言なし」')
    assert.equal(store.size, 2)

    // 積み直しても増えず、口も叩き直さない（一言は毎回 null で落ち、案はもうある）
    d.scan([row(at(0), 'S1', { repo: 'r', text: '切っている' })])
    await d.drain()
    assert.equal(store.size, 2)
    assert.equal(fake.prompts.length, 1)
    assert.equal(fake.nextAsks.length, 2)
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
    assert.equal(store.get(digestKey(last))?.next_ask, '新しい返答（案）を進めて', '一言と同じ 1 行に入る')
    assert.equal(d.nextAskFor('S1@r', last.ts), '新しい返答（案）を進めて')
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

test('Digester: 案は一言ではなく要約する前の本文から作る（#560）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-src-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' })
    d.scan([row(at(1), 'S1', { repo: 'r', text: 'どちらにしますか？ A か B', user_text: '進めて' })])
    await d.drain()
    // 一言（偽の口は「（まとめ）」を付けて返す）を材料にすると、要約で落ちた質問・選択肢に答えられない
    assert.match(fake.nextAsks[0]!, /エージェントの返答:\nどちらにしますか？ A か B/)
    assert.doesNotMatch(fake.nextAsks[0]!, /（まとめ）/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 一言を切っていても、次に送る文面の案だけ作る。一番新しい行だけで、1 ターンに 1 回（#560）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-only-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    let now = at(0).getTime()
    const d = new Digester(store, fake, { enabled: false, nextAsk: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log'), now: () => now })
    assert.equal(d.enabled, false, '一言は作っていない')
    assert.equal(d.nextAskEnabled, true)
    assert.equal(d.active, true)
    const older = row(at(1), 'S1', { repo: 'r', text: '古い返答', user_text: '古い入力' })
    const last = row(at(2), 'S1', { repo: 'r', text: '新しい返答', user_text: '新しい入力' })
    d.scan([older, last])
    await d.drain()
    assert.equal(fake.prompts.length, 0, '一言の口は叩かない')
    assert.equal(fake.nextAsks.length, 1, '案は一番新しい行の 1 回だけ')
    assert.equal(store.get(digestKey(older)), undefined, '古い行は何もしない')
    assert.equal(store.get(digestKey(last))?.summary, '', '一言は空')
    assert.equal(d.nextAskFor('S1@r', last.ts), '新しい返答（案）を進めて')
    assert.equal(d.summaryFor('S1@r', last.ts), undefined)
    assert.deepEqual(d.attach([last]), [last], '空の一言は行に載せない')
    // 積み直しても叩き直さない
    d.scan([older, last])
    await d.drain()
    assert.equal(fake.nextAsks.length, 1)

    // 案だけのときの失敗も、一言と同じく数えて間を置く（口が落ちている間に 3 秒ごとに叩き続けない。#443）
    fake.failOn.add('あなたが次に送る文')
    const newest = row(at(3), 'S1', { repo: 'r', text: 'もっと新しい', user_text: 'まだ' })
    d.scan([older, last, newest])
    await d.drain()
    assert.equal(fake.nextAsks.length, 2)
    d.scan([older, last, newest])
    await d.drain()
    assert.equal(fake.nextAsks.length, 2, '間隔が来るまで積み直さない')
    assert.equal(store.get(digestKey(newest)), undefined)
    fake.failOn.clear()

    // 一言を入にしても、案だけ作っていた間の行までさかのぼって一言を作らない（切から入にしたのと同じ）
    now = at(10).getTime()
    d.configure({ digest: true, next_ask: true, digest_provider: 'claude', digest_model: '' })
    d.scan([older, last, newest])
    await d.drain()
    assert.equal(fake.prompts.length, 0)
    const after = row(at(11), 'S1', { repo: 'r', text: '入にしたあと', user_text: 'つづき' })
    d.scan([older, last, newest, after])
    await d.drain()
    assert.equal(store.get(digestKey(after))?.summary, '入にしたあと（まとめ）')
    assert.equal(store.get(digestKey(after))?.next_ask, '入にしたあと（案）を進めて')

    // next_ask を省略した configure は一言に従う（#560 より前の settings.json）
    d.configure({ digest: false, digest_provider: 'claude', digest_model: '' })
    assert.equal(d.nextAskEnabled, false)
    assert.equal(d.active, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: セッションで一言を切っている間に案だけ作った行は、戻すと一言も作る。案は叩き直さない（#560）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-back-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    let off = true
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => (off ? null : 'none') })
    const r = row(at(1), 'S1', { repo: 'r', text: '返答', user_text: '入力' })
    d.scan([r])
    await d.drain()
    assert.equal(store.get(digestKey(r))?.summary, '')
    assert.equal(store.get(digestKey(r))?.next_ask, '返答（案）を進めて')
    off = false
    d.scan([r])
    await d.drain()
    assert.equal(store.get(digestKey(r))?.summary, '返答（まとめ）', '戻せば一言が付く')
    assert.equal(store.get(digestKey(r))?.next_ask, '返答（案）を進めて', '案は残す')
    assert.equal(fake.nextAsks.length, 1, '案の口は 1 回だけ')
    // 読み直しても同じ（あとの行が勝つ）
    const reloaded = new DigestStore(join(dir, 'digest.jsonl'))
    await reloaded.load()
    assert.equal(reloaded.get(digestKey(r))?.summary, '返答（まとめ）')
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

/** SOURCE の中の、人への頼みの文（一言の「人が次にすること」に本文の言葉のまま入る。#713） */
const SOURCE_NEXT_SENTENCE = 'マージはまだしていないので、よければ「マージして」と言ってください。'

test('Digester: 機械の判定に引っかかったら 1 回だけ作り直す。直ったものを残す（#346）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 1 回目は本文に無い番号を書いてしまう。2 回目は本文の番号
    const fake = new RetrySummarizer(['PR #999 出したよ！', 'PR #284 出したよ！'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([r])
    await d.drain()

    assert.equal(fake.prompts.length, 2, '1 回だけ作り直す')
    assert.match(fake.prompts[1]!, /前に作った一言: PR #999 出したよ！/, '作り直しに渡すのは口が書いた部分だけ')
    assert.match(fake.prompts[1]!, /本文に出てこない番号（#999）を書かないでください/, '直してほしい点を伝える')
    const entry = store.get(digestKey(r))
    assert.equal(entry?.summary, `PR #284 出したよ！${SOURCE_NEXT_SENTENCE}`, '直ったものを残す')
    assert.equal(entry?.retried, true)
    assert.equal(entry?.issues, undefined, '残った点が無ければ付けない')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /作り直し invented_number → ok/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 作り直しても直らなければ 1 回目を残し、残った点を書いておく（#346）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 2 回目も本文に無い番号のまま（減っていないので 1 回目を残す）
    const fake = new RetrySummarizer(['PR #999 出したよ！', 'PR #998 出したよ！'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([r])
    await d.drain()

    assert.equal(fake.prompts.length, 2)
    const entry = store.get(digestKey(r))
    assert.equal(entry?.summary, `PR #999 出したよ！${SOURCE_NEXT_SENTENCE}`, '減らなかったので 1 回目のまま')
    assert.deepEqual(entry?.issues, ['invented_number'], '残った点を書いておく（数えられるように）')
    assert.equal(entry?.retried, true)
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /作り直し invented_number → invented_number/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 一言を 2 つで組む。人が次にすることは本文の文そのまま、口には何が起きたかだけを書かせる（#713）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-two-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // 口が頼みを問いかけに言い換えても（前はこれで作り直していた）、その節は落として本文の文を足す
    const fake = new RetrySummarizer(['PR #284 出したよ、マージして？'])
    const d = new Digester(store, fake, { enabled: true, model: 'qwen3:8b', since: at(0).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })
    const two = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    d.scan([two])
    await d.drain()
    assert.equal(fake.prompts.length, 1, '作り直さない')
    assert.match(fake.prompts[0]!, /何が起きたか/)
    assert.match(fake.prompts[0]!, /人への頼み・質問は書かない/)
    assert.doesNotMatch(fake.prompts[0]!, /話の筋を残す/)
    const entry = store.get(digestKey(two))
    assert.equal(entry?.summary, `PR #284 出したよ。${SOURCE_NEXT_SENTENCE}`)
    assert.deepEqual([entry?.what, entry?.next], ['PR #284 出したよ。', SOURCE_NEXT_SENTENCE], '分けたものも残す')
    assert.equal(entry?.retried, undefined)

    // 報告だけの本文: 何が起きたかだけを書かせる。分けた欄は付けない
    const report = row(at(2), 'S2', { repo: 'r', text: '一覧の絞り込みを直しました。テストは通っています。' })
    // 人がすることに触れているが、そのまま抜ける文が無い本文: 今までどおり 1 回で全部を書かせる
    const full = row(at(3), 'S3', { repo: 'r', text: 'CI が落ちています。もう一度回したほうが確実です。' })
    fake.prompts.length = 0
    d.scan([report, full])
    await d.drain()
    const promptFor = (needle: string) => fake.prompts.find((p) => p.includes(needle)) ?? ''
    assert.match(promptFor('一覧の絞り込み'), /人への頼み・質問は書かない/)
    assert.match(promptFor('CI が落ちています'), /話の筋を残す/)
    assert.equal(store.get(digestKey(report))?.next, undefined)
    assert.equal(store.get(digestKey(full))?.next, undefined)
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
    // 本文が「『マージして』と言って」と引用しているので、案はその引用で口を呼ばない（#713）。一言の作り直しもしない
    assert.equal(fake.nextAsks.length, 0)
    assert.equal(store.get(digestKey(r))?.next_ask, 'マージして')
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
  let now = at(10).getTime()
  const fake = new FakeSummarizer() as FakeSummarizer & { where?: string }
  fake.where = 'http://127.0.0.1:11434/v1'
  fake.failOn.add('落ちる')
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
  const rows = Array.from({ length: DIGEST_ALERT_FAILS }, (_, i) => row(at(i + 1), `S${i}`, { repo: 'r', text: `落ちる ${i}` }))
  d.scan(rows.slice(0, DIGEST_ALERT_FAILS - 1))
  await d.drain()
  assert.equal(d.error, '', 'まだ出さない（たまの timeout は実データでもある）')
  d.scan(rows)
  await d.drain()
  assert.match(d.error, new RegExp(`直近 ${DIGEST_ALERT_FAILS} 件続けて失敗`))
  assert.match(d.error, /11434/, 'どこに投げているかを添える')
  assert.match(d.error, /5 分後に再開/, '休んでいることも出す（#497）')
  // 休み明けに 1 件通る
  now += DIGEST_BREAK_MS
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

test('口が続けて DIGEST_ALERT_FAILS 回落ちたら、列を進めずに DIGEST_BREAK_MS 休む。休み明けに通れば平常に戻る（#497。遮断器）', async () => {
  let now = at(10).getTime()
  const fake = new FakeSummarizer()
  fake.failOn.add('timeout')
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log'), now: () => now })
    // 常に timeout する口に 5 本流す
    const rows = Array.from({ length: 5 }, (_, i) => row(at(i + 1), `S${i}`, { repo: 'r', text: `timeout ${i}` }))
    d.scan(rows)
    await d.drain()
    assert.equal(fake.prompts.length, DIGEST_ALERT_FAILS, '3 回目の失敗で止まる')
    assert.equal(d.pending(), 5 - DIGEST_ALERT_FAILS, '残りは列に残る（捨てない）')
    // 休んでいる間は、3 秒ごとの scan() でも、新しい行が来ても口を叩かない
    now += DIGEST_BREAK_MS - 1
    d.scan([...rows, row(at(8), 'S8', { repo: 'r', text: 'timeout 新しい行' })])
    await d.drain()
    assert.equal(fake.prompts.length, DIGEST_ALERT_FAILS, '休みが明けるまで summarize を呼ばない')
    // 列には、残りの 2 本・新しい行・行ごとの作り直しの間隔（1 分）が来た失敗した 3 本が積まれる
    assert.equal(d.pending(), 5 - DIGEST_ALERT_FAILS + 1 + DIGEST_ALERT_FAILS)
    assert.match(d.error, /1 分後に再開/)
    // 休み明けの 1 件も落ちたら、また休む（1 件だけ試す）
    now += 1
    d.scan(rows)
    await d.drain()
    assert.equal(fake.prompts.length, DIGEST_ALERT_FAILS + 1, '休み明けは 1 件だけ試す')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /分休む/)
    // 口が戻ったら、休み明けに通って平常に戻り、残りを続けて作る
    fake.failOn.clear()
    now += DIGEST_BREAK_MS
    d.scan([])
    await d.drain()
    assert.equal(d.pending(), 0, '休んでいる間に積んだ分を回し切る')
    assert.equal(d.error, '')
    assert.equal(fake.prompts.length, DIGEST_ALERT_FAILS + 1 + 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('休んでいる間に口を変えたら、休みを解いてすぐ作る（#497）', async () => {
  const now = at(10).getTime()
  const fake = new FakeSummarizer()
  fake.failOn.add('timeout')
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const d = new Digester(new DigestStore(join(dir, 'digest.jsonl')), fake, { enabled: true, model: 'm', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
    d.scan(Array.from({ length: DIGEST_ALERT_FAILS + 1 }, (_, i) => row(at(i + 1), `S${i}`, { repo: 'r', text: `timeout ${i}` })))
    await d.drain()
    assert.equal(d.pending(), 1)
    fake.failOn.clear()
    d.configure({ digest: true, digest_provider: 'claude', digest_model: 'haiku' })
    d.scan([row(at(9), 'S9', { repo: 'r', text: '通る' })])
    await d.drain()
    assert.equal(d.pending(), 0)
    assert.equal(d.error, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 人に聞いている返答は一言を作らず、作らなかったことを残して、もう一度は判定しない。案は作る（#638）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-asking-'))
  try {
    const path = join(dir, 'digest.jsonl')
    const store = new DigestStore(path)
    await store.load()
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' })
    const old = row(at(1), 'S1', { repo: 'r', text: '甲と乙があります。\n\nどちらにしますか？', user_text: '進めて' })
    const asking = row(at(2), 'S1', { repo: 'r', text: '案を出しました。\n\n## 決めてほしいこと\n\n1. 甲か乙か', user_text: '進めて' })
    const report = row(at(2), 'S2', { repo: 'r', text: '直して push しました。', user_text: '直して' })
    d.scan([old, asking, report])
    await d.drain()
    assert.equal(fake.prompts.length, 1, '一言の口を叩くのは報告の行だけ')
    assert.match(fake.prompts[0]!, /直して push しました/)
    assert.equal(fake.nextAsks.length, 2, '案は今までどおり、各セッションの一番新しい行に作る')
    for (const r of [old, asking]) {
      const e = store.get(digestKey(r))
      assert.equal(e?.summary, '')
      assert.equal(e?.skipped, 'asking')
    }
    assert.equal(store.get(digestKey(old))?.next_ask, undefined, '古い行には案を作らない')
    assert.ok(store.get(digestKey(asking))?.next_ask)
    assert.equal(store.get(digestKey(report))?.skipped, undefined)
    // 行に一言は載らない（画面は本文をそのまま出す）
    assert.equal(d.attach([asking])[0]!.summary, undefined)
    // 3 秒ごとの scan() が積み直さない
    const lines = (await readFile(path, 'utf-8')).trim().split('\n').length
    d.scan([old, asking, report])
    await d.drain()
    assert.equal(d.pending(), 0)
    assert.equal((await readFile(path, 'utf-8')).trim().split('\n').length, lines)
    assert.equal(fake.prompts.length, 1)
    assert.equal(fake.nextAsks.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: セッションで一言を切っているときは、人に聞いている返答かを残さない（戻したときに判定する。#638）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-asking-off-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    let off = true
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => (off ? null : 'none') })
    const asking = row(at(1), 'S1', { repo: 'r', text: '甲と乙があります。\n\nどちらにしますか？', user_text: '進めて' })
    d.scan([asking])
    await d.drain()
    assert.equal(store.get(digestKey(asking))?.skipped, undefined)
    assert.ok(store.get(digestKey(asking))?.next_ask, '案だけ作ってある')
    off = false
    d.scan([asking])
    await d.drain()
    assert.equal(store.get(digestKey(asking))?.skipped, 'asking')
    assert.ok(store.get(digestKey(asking))?.next_ask, '案は持ち越す')
    assert.equal(fake.prompts.length, 0)
    assert.equal(fake.nextAsks.length, 1, '案の口は 1 ターンに 1 回まで')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 人に聞いている返答で案に失敗しても、作らなかった印は残り、口の失敗には数えない（#638）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-asking-fail-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    fake.failOn.add('どちらにしますか')
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const asking = row(at(1), 'S1', { repo: 'r', text: '甲と乙があります。\n\nどちらにしますか？', user_text: '進めて' })
    d.scan([asking])
    await d.drain()
    assert.equal(store.get(digestKey(asking))?.skipped, 'asking')
    assert.equal(store.get(digestKey(asking))?.next_ask, undefined)
    assert.equal(d.error, '', '口の不調にしない')
    d.scan([asking])
    await d.drain()
    assert.equal(fake.nextAsks.length, 1, '積み直さない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 規則が当てなかった返答は手元のモデルに聞き、全文が要ると返ったら一言を作らない。足りると返ったら今までどおり（#639）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-judge-'))
  try {
    const path = join(dir, 'digest.jsonl')
    const store = new DigestStore(path)
    await store.load()
    const fake = new FakeSummarizer()
    fake.fullOn.add('甲と乙を比べ')
    const d = new Digester(store, fake, { enabled: true, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => 'none' })
    const comparing = row(at(1), 'S1', { repo: 'r', text: '甲と乙を比べました。甲は速く、乙は安全です。', user_text: '調べて' })
    const report = row(at(1), 'S2', { repo: 'r', text: '直して push しました。', user_text: '直して' })
    const asking = row(at(1), 'S3', { repo: 'r', text: '甲と乙があります。\n\nどちらにしますか？', user_text: '進めて' })
    d.scan([comparing, report, asking])
    await d.drain()
    assert.equal(fake.judges.length, 2, '規則が当てた行では聞かない')
    assert.ok(!fake.judges.some((p) => p.includes('どちらにしますか')))
    assert.equal(fake.prompts.length, 1, '一言を作るのは、足りると返った行だけ')
    assert.match(fake.prompts[0]!, /直して push しました/)
    assert.equal(fake.nextAsks.length, 3, '案は今までどおり')
    const judged = store.get(digestKey(comparing))
    assert.equal(judged?.summary, '')
    assert.equal(judged?.skipped, 'judged')
    assert.equal(judged?.judge, 'full')
    assert.ok(judged?.next_ask)
    assert.equal(d.attach([comparing])[0]!.summary, undefined, '画面は本文をそのまま出す')
    const kept = store.get(digestKey(report))
    assert.ok(kept?.summary)
    assert.equal(kept?.skipped, undefined)
    assert.equal(kept?.judge, 'summary', '足りると返った行も、あとで合図と突き合わせるために残す')
    assert.equal(store.get(digestKey(asking))?.skipped, 'asking')
    assert.equal(store.get(digestKey(asking))?.judge, undefined)
    // 3 秒ごとの scan() が積み直さない・聞き直さない
    const lines = (await readFile(path, 'utf-8')).trim().split('\n').length
    d.scan([comparing, report, asking])
    await d.drain()
    assert.equal((await readFile(path, 'utf-8')).trim().split('\n').length, lines)
    assert.equal(fake.judges.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 判定の答えが壊れている（1 語でない・口が失敗）ときは、今までどおり一言を作る（#639）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-judge-broken-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    fake.judgeAnswer = 'FULL か SUMMARY のどちらかです'
    const d = new Digester(store, fake, { enabled: true, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const wordy = row(at(1), 'S1', { repo: 'r', text: '直して push しました。', user_text: '直して' })
    d.scan([wordy])
    await d.drain()
    assert.ok(store.get(digestKey(wordy))?.summary)
    assert.equal(store.get(digestKey(wordy))?.judge, undefined, '読めなかった答えは残さない')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /判定が読めない/)
    // 判定の呼び出しだけが落ちる（一言は通る）
    class JudgeDown extends FakeSummarizer {
      override async summarize(prompt: string): Promise<string> {
        if (prompt.includes('報告なら SUMMARY')) {
          this.judges.push(prompt)
          throw new Error('empty result')
        }
        return super.summarize(prompt)
      }
    }
    const down = new JudgeDown()
    const d2 = new Digester(store, down, { enabled: true, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const other = row(at(2), 'S2', { repo: 'r', text: '調べて、原因を書きました。', user_text: '調べて' })
    d2.scan([other])
    await d2.drain()
    assert.equal(down.judges.length, 1)
    assert.ok(store.get(digestKey(other))?.summary, '判定が落ちても一言は作る')
    assert.equal(d2.error, '', '口の不調にしない')
    // 判定が時間切れなら、続けて一言を叩かない（1 行で 2 回待たない）。その行の失敗として数え、作り直しでは聞かない
    class JudgeHangs extends FakeSummarizer {
      override async summarize(prompt: string): Promise<string> {
        if (prompt.includes('報告なら SUMMARY')) {
          this.judges.push(prompt)
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        }
        return super.summarize(prompt)
      }
    }
    let now = at(10).getTime()
    const hangs = new JudgeHangs()
    const d3 = new Digester(store, hangs, { enabled: true, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
    const stuck = row(at(3), 'S3', { repo: 'r', text: '片づけて、結果を書きました。', user_text: '片づけて' })
    d3.scan([stuck])
    await d3.drain()
    assert.equal(hangs.prompts.length, 0, '時間切れのあとに一言を叩かない')
    assert.equal(hangs.nextAsks.length, 0)
    assert.equal(store.get(digestKey(stuck)), undefined)
    now += DIGEST_RETRY_DELAYS_MS[0]! + 1
    d3.scan([stuck])
    await d3.drain()
    assert.equal(hangs.judges.length, 1, '作り直しでは聞かない')
    assert.ok(store.get(digestKey(stuck))?.summary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 口が claude のとき・セッションで一言を切っているとき・失敗して作り直す行では、判定を聞かない（#639）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-judge-skip-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const report = row(at(1), 'S1', { repo: 'r', text: '直して push しました。', user_text: '直して' })
    const claude = new FakeSummarizer()
    const d = new Digester(store, claude, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' })
    d.scan([report])
    await d.drain()
    assert.equal(claude.judges.length, 0, 'claude の口では呼び出しを増やさない')
    assert.equal(claude.prompts.length, 1)

    const off = new FakeSummarizer()
    const d2 = new Digester(store, off, { enabled: true, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => null })
    const muted = row(at(2), 'S2', { repo: 'r', text: '調べて、原因を書きました。', user_text: '調べて' })
    d2.scan([muted])
    await d2.drain()
    assert.equal(off.judges.length, 0, '一言を作らない行では聞かない')
    assert.equal(off.nextAsks.length, 1)

    let now = at(10).getTime()
    const flaky = new FakeSummarizer()
    flaky.failOn.add('片づけて、結果')
    const d3 = new Digester(store, flaky, { enabled: true, nextAsk: false, model: 'local', provider: 'openai', since: at(0).toISOString(), persona: async () => 'none', now: () => now })
    const retried = row(at(3), 'S3', { repo: 'r', text: '片づけて、結果を書きました。', user_text: '片づけて' })
    d3.scan([retried])
    await d3.drain()
    assert.equal(flaky.judges.length, 1)
    assert.equal(store.get(digestKey(retried)), undefined, '一言が失敗した')
    flaky.failOn.clear()
    now += DIGEST_RETRY_DELAYS_MS[0]! + 1
    d3.scan([retried])
    await d3.drain()
    assert.ok(store.get(digestKey(retried))?.summary)
    assert.equal(flaky.judges.length, 1, '作り直しでは聞き直さない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 本文に引用された人の言葉があれば、案はその引用で口を呼ばない。無ければ今までどおり口で作る（#713）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-quote-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const quoted = row(at(1), 'S1', { repo: 'r', text: '直しました。CI は緑です。「マージして」と言ってください。', user_text: '直して' })
    const plain = row(at(1), 'S2', { repo: 'r', text: '直しました。', user_text: '直して' })
    d.scan([quoted, plain])
    await d.drain()
    assert.equal(store.get(digestKey(quoted))?.next_ask, 'マージして')
    assert.equal(store.get(digestKey(quoted))?.next_ask_source, 'quote', '引用から採った印')
    assert.equal(store.get(digestKey(plain))?.next_ask, '直しました。（案）を進めて')
    assert.equal(store.get(digestKey(plain))?.next_ask_source, undefined)
    assert.equal(fake.nextAsks.length, 1, '口を呼ぶのは引用の無い行だけ')
    // 一言を作り直すために同じ行を積み直しても（一言が空の行は積み直す）、持ち越した案の印は落とさない
    const offStore = new DigestStore(join(dir, 'off.jsonl'))
    await offStore.load()
    let off = true
    const d2 = new Digester(offStore, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => (off ? null : 'none'), logPath: join(dir, 'digest.log') })
    d2.scan([quoted])
    await d2.drain()
    assert.deepEqual([offStore.get(digestKey(quoted))?.summary, offStore.get(digestKey(quoted))?.next_ask_source], ['', 'quote'], '一言を切っている間は案だけ')
    off = false
    d2.scan([quoted])
    await d2.drain()
    assert.notEqual(offStore.get(digestKey(quoted))?.summary, '')
    assert.deepEqual([offStore.get(digestKey(quoted))?.next_ask, offStore.get(digestKey(quoted))?.next_ask_source], ['マージして', 'quote'], '持ち越した案の印も残る')
    // 印の無い前の行（この欄が入る前に口が同じ文を作っていた）があっても、新しく引用から採った案には印が付く
    const oldStore = new DigestStore(join(dir, 'old.jsonl'))
    await oldStore.load()
    await oldStore.append({ key: digestKey(quoted), persona: 'none', summary: '', model: 'haiku', ts: at(1).toISOString(), next_ask: 'マージして' })
    const d3 = new Digester(oldStore, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    d3.scan([quoted])
    await d3.drain()
    assert.notEqual(oldStore.get(digestKey(quoted))?.summary, '')
    assert.equal(oldStore.get(digestKey(quoted))?.next_ask_source, undefined, '作り直さず持ち越した案は、前の行の印のまま（無ければ無い）')
    assert.ok(fake.prompts.some((p) => p.includes('「マージして」と言って')), '一言はいつもどおり作る（一言と案は別に数える）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('partsOf / attach / partsFor: 2 つで組んだ一言は分けて渡し、そうでない一言（前の行・報告だけ）は 1 つのまま渡す（#713）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-parts-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const two = row(at(1), 'S1', { repo: 'r', text: SOURCE })
    const old = row(at(2), 'S2', { repo: 'r', text: SOURCE })
    const report = row(at(3), 'S3', { repo: 'r', text: '直しました。' })
    const askOnly = row(at(4), 'S4', { repo: 'r', text: SOURCE })
    const base = { persona: 'ESFP' as const, model: 'qwen3:8b', ts: at(5).toISOString() }
    await store.append({ ...base, key: digestKey(two), summary: `PR 出したよ！${SOURCE_NEXT_SENTENCE}`, what: 'PR 出したよ！', next: SOURCE_NEXT_SENTENCE })
    // #718 より前の一言: 分けたものが無い。繋いだ文のまま 1 つの一言として読む
    await store.append({ ...base, key: digestKey(old), summary: 'PR 出したよ、「マージして」と言ってね！' })
    await store.append({ ...base, key: digestKey(report), summary: '直したよ！' })
    // 案だけ作った行（一言は空。#560）
    await store.append({ ...base, key: digestKey(askOnly), summary: '', next_ask: 'マージして' })
    const d = new Digester(store, new FakeSummarizer(), { enabled: true, model: 'qwen3:8b', since: at(9).toISOString(), persona: async () => 'ESFP', logPath: join(dir, 'digest.log') })

    const [a, b, c, e] = d.attach([two, old, report, askOnly])
    assert.deepEqual([a?.summary, a?.summary_next], ['PR 出したよ！', SOURCE_NEXT_SENTENCE], '2 つに分けて渡す（summary は何が起きたかだけ）')
    assert.deepEqual([b?.summary, b?.summary_next], ['PR 出したよ、「マージして」と言ってね！', undefined], '前の一言はそのまま')
    assert.deepEqual([c?.summary, c?.summary_next], ['直したよ！', undefined])
    assert.equal(e, askOnly, '一言の無い行には何も載せない')
    assert.deepEqual(d.partsFor('S1@r', two.ts), { what: 'PR 出したよ！', next: SOURCE_NEXT_SENTENCE })
    assert.deepEqual(d.partsFor('S2@r', old.ts), { what: 'PR 出したよ、「マージして」と言ってね！' })
    assert.equal(d.partsFor('S4@r', askOnly.ts), undefined)
    assert.equal(d.partsFor('S1@r', ''), undefined)
    assert.equal(d.summaryFor('S1@r', two.ts), `PR 出したよ！${SOURCE_NEXT_SENTENCE}`, '繋いだ文はそのまま引ける（「変？」に残す文）')
    // 片方だけの行（手で書き換えた・壊れた）は、繋いである summary を 1 つの一言として渡す
    assert.deepEqual(partsOf({ summary: '繋いだ文', what: '何か' }), { what: '繋いだ文' })
    assert.deepEqual(partsOf({ summary: '繋いだ文', what: '  ', next: '頼み' }), { what: '繋いだ文' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- #729: 案が人の返信として読めなければ 1 回だけ作り直し、それでも駄目なら出さない
/** 案のプロンプトにだけ、決まった答えを順に返す口（一言は今までどおり）。一言と案は別に数える */
class AskScript extends FakeSummarizer {
  answers: string[]
  constructor(answers: string[]) {
    super()
    this.answers = answers
  }
  override async summarize(prompt: string): Promise<string> {
    if (!prompt.includes('あなたが次に送る文')) return super.summarize(prompt)
    this.nextAsks.push(prompt)
    return this.answers.shift() ?? '次に進めて'
  }
}

test('Digester: 案がエージェントの声なら 1 回だけ作り直す。直れば出し、直らなければ出さずに理由を残す（#729）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-check-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    // S1: 宣言 → 指示に直る。S2: 聞き返し → 作り直しても宣言（出さない）。S3: 最初から読める
    const fake = new AskScript(['集計を直します', '集計を直して', 'この形で出しますか？', '出します', 'それで進めて'])
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const fixed = row(at(1), 'S1', { repo: 'r', text: '原因が分かりました。次は集計を直します。', user_text: '調べて' })
    const dropped = row(at(2), 'S2', { repo: 'r', text: '書き直しました。', user_text: '書き直して' })
    const fine = row(at(3), 'S3', { repo: 'r', text: '足しました。', user_text: '足して' })
    // 列は新しい順に進むので、1 行ずつ積む（答えの順を決める）
    for (const r of [fixed, dropped, fine]) {
      d.scan([r])
      await d.drain()
    }
    const a = store.get(digestKey(fixed))
    assert.equal(a?.next_ask, '集計を直して')
    assert.equal(a?.next_ask_retried, true)
    assert.equal(a?.next_ask_dropped, undefined)
    const b = store.get(digestKey(dropped))
    assert.equal(b?.next_ask, undefined, '読めない案は出さない')
    assert.equal(b?.next_ask_retried, true)
    assert.deepEqual(b?.next_ask_dropped, ['declaration'], '作り直したあとに残った理由')
    assert.ok(b?.summary, '一言は残る')
    assert.equal(d.nextAskFor('S2@r', dropped.ts), undefined)
    const c = store.get(digestKey(fine))
    assert.equal(c?.next_ask, 'それで進めて')
    assert.equal(c?.next_ask_retried, undefined)
    assert.equal(fake.nextAsks.length, 5, '作り直しは 1 回まで（2 + 2 + 1）')
    assert.match(fake.nextAsks[1]!, /前に作った文: 集計を直します/)
    assert.equal(fake.prompts.length, 3, '一言の回数は変わらない（案と別に数える）')
    assert.match(await readFile(join(dir, 'digest.log'), 'utf-8'), /案の作り直し question_back → declaration（出さない）/)
    // 出さなかった行を積み直しても、口は叩き直さない
    d.scan([dropped])
    await d.drain()
    assert.equal(fake.nextAsks.length, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 引用の頼みは今までどおり機械で採り、確かめも作り直しもしない（#718 / #729）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-quote-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new AskScript([])
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none' })
    const quoted = row(at(1), 'S1', { repo: 'r', text: '出しました。よければ「入れて」と言ってください。', user_text: '出して' })
    d.scan([quoted])
    await d.drain()
    const e = store.get(digestKey(quoted))
    assert.equal(e?.next_ask, '入れて')
    assert.equal(e?.next_ask_source, 'quote')
    assert.equal(e?.next_ask_retried, undefined)
    assert.equal(fake.nextAsks.length, 0, '口を呼ばない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 出さなかった案の印は、行を積み直しても持ち越す。作り直しの口が落ちても口の失敗に数えない（#736 のレビュー）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-next-ask-carry-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new AskScript(['書き直します', '書き直しますね'])
    let off = true
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', since: at(0).toISOString(), persona: async () => (off ? null : 'none'), logPath: join(dir, 'digest.log') })
    const r = row(at(1), 'S1', { repo: 'r', text: '見出しを足しました。', user_text: '足して' })
    d.scan([r])
    await d.drain()
    assert.deepEqual(store.get(digestKey(r))?.next_ask_dropped, ['declaration'])
    assert.equal(store.get(digestKey(r))?.summary, '')
    // セッションの一言を戻すと積み直されるが、案は叩き直さず、出さなかった印も残る
    off = false
    d.scan([r])
    await d.drain()
    const e = store.get(digestKey(r))
    assert.ok(e?.summary)
    assert.equal(e?.next_ask, undefined)
    assert.equal(e?.next_ask_retried, true)
    assert.deepEqual(e?.next_ask_dropped, ['declaration'])
    assert.equal(fake.nextAsks.length, 2)

    // 作り直しの呼び出しだけが落ちる口: 出さないで終わり、失敗として積み直さない
    class RetryFails extends FakeSummarizer {
      override async summarize(prompt: string): Promise<string> {
        if (!prompt.includes('あなたが次に送る文')) return super.summarize(prompt)
        this.nextAsks.push(prompt)
        if (prompt.includes('前に作った文')) throw new Error('timeout after 90s')
        return '次も足します'
      }
    }
    const failing = new RetryFails()
    const d2 = new Digester(store, failing, { enabled: false, nextAsk: true, model: 'haiku', since: at(0).toISOString(), persona: async () => 'none', logPath: join(dir, 'digest.log') })
    const r2 = row(at(2), 'S2', { repo: 'r', text: '項目を足しました。', user_text: '足して' })
    d2.scan([r2])
    await d2.drain()
    assert.deepEqual(store.get(digestKey(r2))?.next_ask_dropped, ['declaration'])
    d2.scan([r2])
    await d2.drain()
    assert.equal(failing.nextAsks.length, 2, '同じ行を叩き直さない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
