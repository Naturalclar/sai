import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DigestStore, Digester, digestKey, digestable, summarizeCommand } from './digest.ts'
import type { Summarizer } from './digest.ts'
import { row } from './aggregate.test.ts'
import type { PersonaId } from '../shared/types.ts'

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

test('Digester: 起動時にあった行は作らず、新しく現れた行だけ新しい順に作る。失敗した行は無いまま。性格は作る直前の値', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    await store.load()
    const fake = new FakeSummarizer()
    let persona: PersonaId = 'ISTJ'
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', persona: async () => persona, logPath: join(dir, 'digest.log') })
    const old1 = row(at(0), 'S1', { repo: 'r', text: '古い1' })
    const old2 = row(at(1), 'S1', { repo: 'r', text: '古い2' })
    d.scan([old1, old2]) // baseline
    await d.drain()
    assert.equal(fake.prompts.length, 0, '起動時にあった行は作らない')

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

    assert.equal(d.backfill([old1, old2, n1, n2, bad, skip, n3], 2), 2)
    await d.drain()
    assert.equal(store.get(digestKey(old2))?.summary, '一言: 古い2')
    assert.equal(store.get(digestKey(old1)), undefined, '2 件目までなので old1 はまだ')
    assert.equal(store.get(digestKey(bad)), undefined, 'bad はまた失敗')
    assert.equal(d.backfill([old1, old2], 10), 1)
    await d.drain()
    assert.equal(store.get(digestKey(old1))?.summary, '一言: 古い1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 自分が回した子（cwd がフィードのディレクトリ）の行は作らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: true, model: 'haiku', persona: async () => 'none', ownDir: '/home/u/.agent-feed' })
    d.scan([])
    const own = row(at(0), 'child', { cwd: '/home/u/.agent-feed', text: '一言です' })
    const under = row(at(1), 'child2', { cwd: '/home/u/.agent-feed/sub', text: '一言です' })
    const real = row(at(2), 'S1', { cwd: '/home/u/.agent-feed-other', text: '本物' })
    d.scan([own, under, real])
    await d.drain()
    assert.deepEqual(fake.prompts.map((p) => p.split('\n---\n')[1]), ['本物'])
    assert.equal(d.backfill([own, under], 5), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Digester: 無効なら何もしない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-digest-'))
  try {
    const store = new DigestStore(join(dir, 'digest.jsonl'))
    const fake = new FakeSummarizer()
    const d = new Digester(store, fake, { enabled: false, model: 'haiku', persona: async () => 'none' })
    d.scan([row(at(0), 'S1')])
    d.scan([row(at(0), 'S1'), row(at(1), 'S1')])
    assert.equal(d.backfill([row(at(0), 'S1')], 5), 0)
    await d.drain()
    assert.equal(fake.prompts.length, 0)
    assert.equal(d.enabled, false)
    assert.equal(new Digester(store, null, { enabled: true, model: 'haiku', persona: async () => 'none' }).enabled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
