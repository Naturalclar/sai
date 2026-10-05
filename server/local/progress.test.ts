import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectName, PROGRESS_IDLE_MS, PROGRESS_NOTES } from '../../shared/progress.ts'
import { OPENCODE_CONTEXT_TTL_MS, PROGRESS_TAIL_START, ProgressReader, sessionOf } from './progress.ts'

const SID = '11111111-2222-3333-4444-555555555555'
const j = (o: unknown) => JSON.stringify(o)
/** いまから少し前（書き込みが古くなって「止まっている」にならない時刻）。基準は 1 回だけ取る（呼ぶたびに Date.now() がずれる） */
const BASE = Date.now() - 60_000
const at = (s: number) => new Date(BASE + s * 1000).toISOString()
const prompt = (ts: string, text: string) => j({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const assistant = (ts: string, blocks: unknown[], stop: string) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks, stop_reason: stop } })
const result = (ts: string, id: string, content = 'ok') => j({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult: {} })
const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })

async function withDirs(fn: (dirs: { projects: string; sessions: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sai-progress-'))
  try {
    await fn({ projects: join(root, 'projects'), sessions: join(root, 'sessions') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('sessionOf: エンティティ ID からセッション ID。パスに混ぜられない形と unknown- は空', () => {
  assert.equal(sessionOf({ id: `${SID}@sai`, repo: 'sai' }), SID)
  assert.equal(sessionOf({ id: SID, repo: '' }), SID)
  assert.equal(sessionOf({ id: 'unknown-2026-09-10@sai', repo: 'sai' }), '')
  assert.equal(sessionOf({ id: '../../etc@sai', repo: 'sai' }), '')
  assert.equal(sessionOf({ id: 'a/b@sai', repo: 'sai' }), '')
  assert.equal(sessionOf({ id: 'a.jsonl@sai', repo: 'sai' }), '')
})

test('ProgressReader(Claude): cwd から transcript を引き、走っているツールを返す。結果とターン完了が書かれたら閉じる', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const cwd = '/Users/me/work/sai.git/dev-a'
    const dir = join(projects, claudeProjectName(cwd))
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${SID}.jsonl`)
    await writeFile(path, [prompt(at(0), 'テストを回して'), assistant(at(1), [bash('t1', 'pnpm test')], 'tool_use')].join('\n') + '\n')
    const reader = new ProgressReader(projects, sessions)
    const s = { id: `${SID}@sai`, repo: 'sai', agent: 'claude' as const, cwd }

    let p = await reader.read(s)
    assert.equal(p.active, true)
    assert.equal(p.total, 1)
    assert.deepEqual(
      p.steps.map((x) => [x.tool, x.summary, x.ended]),
      [['Bash', 'pnpm test', undefined]],
    )
    assert.notEqual(p.rev, '')
    assert.notEqual(p.updated_at, '')
    const rev = p.rev

    await appendFile(path, [result(at(30), 't1'), assistant(at(31), [{ type: 'text', text: '通りました' }], 'end_turn')].join('\n') + '\n')
    p = await reader.read(s)
    assert.equal(p.active, false, 'ターンが閉じた')
    assert.equal(p.total, 2)
    assert.equal(p.steps[0]?.ended, at(30))
    assert.notEqual(p.rev, rev, 'ファイルが変われば rev も変わる')
  })
})

test('ProgressReader: 最後にモデルを呼んだときに読んだ量を context_tokens に載せる。読めなければ 0（#311）', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const cwd = '/Users/me/work/sai.git/dev-a'
    const dir = join(projects, claudeProjectName(cwd))
    await mkdir(dir, { recursive: true })
    const usage = { input_tokens: 12, cache_read_input_tokens: 880_000, cache_creation_input_tokens: 4_000, output_tokens: 300 }
    await writeFile(
      join(dir, `${SID}.jsonl`),
      [prompt(at(0), 'やって'), j({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: '見ました' }], stop_reason: 'end_turn', usage } })].join('\n') + '\n',
    )
    const reader = new ProgressReader(projects, sessions)
    assert.equal((await reader.read({ id: `${SID}@sai`, repo: 'sai', agent: 'claude', cwd })).context_tokens, 884_012)
    assert.equal((await reader.read({ id: 'nope@sai', repo: 'sai', agent: 'claude', cwd })).context_tokens, 0)
  })
})

test('ProgressReader(Claude): 組み立てた名前に無ければ projects の中から探す。無いセッション・OpenCode・読めない ID は空', async () => {
  await withDirs(async ({ projects, sessions }) => {
    await mkdir(join(projects, 'renamed'), { recursive: true })
    await writeFile(join(projects, 'renamed', `${SID}.jsonl`), [prompt(at(0), 'やって'), assistant(at(1), [bash('a', 'ls')], 'tool_use')].join('\n') + '\n')
    const reader = new ProgressReader(projects, sessions)
    const found = await reader.read({ id: `${SID}@r`, repo: 'r', agent: 'claude', cwd: '/somewhere/else' })
    assert.equal(found.steps[0]?.summary, 'ls')

    const none = { rev: '', active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 }
    assert.deepEqual(await reader.read({ id: '99999999-0000-0000-0000-000000000000@r', repo: 'r', agent: 'claude', cwd: '/x' }), { ...none, id: '99999999-0000-0000-0000-000000000000@r' })
    assert.deepEqual(await reader.read({ id: `${SID}@r`, repo: 'r', agent: 'opencode', cwd: '/x' }), { ...none, id: `${SID}@r` })
    assert.deepEqual(await reader.read({ id: 'unknown-2026-09-10@r', repo: 'r', agent: 'claude', cwd: '/x' }), { ...none, id: 'unknown-2026-09-10@r' })
  })
})

test('ProgressReader: ターンの始まりが末尾の 64KB より前にあっても読み足して、前のターンの手順を混ぜない', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const cwd = '/w'
    const dir = join(projects, claudeProjectName(cwd))
    await mkdir(dir, { recursive: true })
    const big = 'x'.repeat(PROGRESS_TAIL_START)
    await writeFile(
      join(dir, `${SID}.jsonl`),
      [
        prompt(at(0), '前のターン'),
        assistant(at(1), [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: '/old' } }], 'tool_use'),
        result(at(2), 'old'),
        assistant(at(3), [{ type: 'text', text: '前の返答' }], 'end_turn'),
        prompt(at(10), 'いまのターン'),
        assistant(at(11), [bash('a', 'cat big.log')], 'tool_use'),
        // 1 行で最初に読む量を超える tool_result（画像や長い出力）
        result(at(12), 'a', big),
        assistant(at(13), [bash('b', 'pnpm build')], 'tool_use'),
      ].join('\n') + '\n',
    )
    const p = await new ProgressReader(projects, sessions).read({ id: `${SID}@r`, repo: 'r', agent: 'claude', cwd })
    assert.deepEqual(
      p.steps.map((s) => s.summary),
      ['cat big.log', 'pnpm build'],
      '前のターンの Read は入らない',
    )
    assert.equal(p.total, 2)
    assert.equal(p.active, true)
  })
})

test('ProgressReader: 閉じていないターンでも、書き込みが止まって古くなれば動いていない（Esc で止めた）', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const cwd = '/w'
    const dir = join(projects, claudeProjectName(cwd))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${SID}.jsonl`), prompt(at(0), 'やって') + '\n')
    const s = { id: `${SID}@r`, repo: 'r', agent: 'claude' as const, cwd }
    assert.equal((await new ProgressReader(projects, sessions).read(s)).active, true, '入力のすぐあと')
    const later = new ProgressReader(projects, sessions, () => Date.now() + PROGRESS_IDLE_MS + 60_000)
    assert.equal((await later.read(s)).active, false)
  })
})

test('ProgressReader(Codex): sessions/YYYY/MM/DD の rollout をセッション ID で引く', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const d = new Date()
    const dir = join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `rollout-2026-09-10T12-00-00-${SID}.jsonl`),
      [
        j({ timestamp: at(0), type: 'session_meta', payload: { id: SID, cwd: '/w' } }),
        j({ timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }),
        j({ timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'await tools.exec_command({"cmd":"cargo build"})' } }),
      ].join('\n') + '\n',
    )
    const p = await new ProgressReader(projects, sessions).read({ id: `${SID}@r`, repo: 'r', agent: 'codex', cwd: '/w' })
    assert.equal(p.active, true)
    assert.deepEqual(
      p.steps.map((s) => [s.tool, s.summary]),
      [['exec', 'cargo build']],
    )
    // 開いているターンの始まり（#693。端末で打った Codex のターンの「処理中」の起点）
    assert.equal(p.turn_since, at(1))
    // ターンが閉じたら載せない
    await writeFile(
      join(dir, `rollout-2026-09-10T12-00-00-${SID}.jsonl`),
      [j({ timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }), j({ timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } })].join('\n') + '\n\n',
    )
    const closed = await new ProgressReader(projects, sessions).read({ id: `${SID}@r`, repo: 'r', agent: 'codex', cwd: '/w' })
    assert.equal(closed.active, false)
    assert.equal(closed.turn_since, undefined)
  })
})

test('ProgressReader: OpenCode は読んだ量だけ本体に聞いて埋め、しばらく覚える（#396）', async () => {
  let now = 1_000_000
  const reader = new ProgressReader('/nonexistent', '/nonexistent', () => now)
  const target = { id: 'ses_abc@r', repo: 'r', agent: 'opencode' as const, cwd: '/w' }
  const none = { rev: '', id: 'ses_abc@r', active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 }
  assert.deepEqual(await reader.read(target), none, '聞き先を渡していなければ今までどおり空')

  const asked: string[] = []
  let size = 42_000
  reader.useOpencode(async (session) => {
    asked.push(session)
    return size
  })
  const got = await reader.read(target)
  assert.equal(got.context_tokens, 42_000)
  assert.deepEqual(got.steps, [], '手順は空のまま（transcript は無い）')
  assert.deepEqual(asked, ['ses_abc'], 'エンティティ ID ではなくセッション ID で聞く')
  size = 90_000
  assert.equal((await reader.read(target)).context_tokens, 42_000, '覚えている間は聞き直さない')
  assert.equal(asked.length, 1)
  now += OPENCODE_CONTEXT_TTL_MS
  const later = await reader.read(target)
  assert.equal(later.context_tokens, 90_000, '時間が経てば聞き直す')
  assert.notEqual(later.rev, got.rev, '大きさが変われば rev も変わる')

  reader.useOpencode(async () => {
    throw new Error('opencode serve が落ちた')
  })
  now += OPENCODE_CONTEXT_TTL_MS
  assert.deepEqual(await reader.read(target), none, '聞けなければ空（予算の判定は「分からない相手は足さない」のまま）')
})

test('ProgressReader: 途中で書いた文（#680）は手順とは別に末尾だけ返す。無ければ載せない', async () => {
  await withDirs(async ({ projects, sessions }) => {
    const cwd = '/Users/me/work/sai.git/dev-n'
    const dir = join(projects, claudeProjectName(cwd))
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${SID}.jsonl`)
    const reader = new ProgressReader(projects, sessions)
    const s = { id: `${SID}@sai`, repo: 'sai', agent: 'claude' as const, cwd }
    await writeFile(path, [prompt(at(0), '直して'), assistant(at(1), [bash('t0', 'ls')], 'tool_use')].join('\n') + '\n')
    let p = await reader.read(s)
    assert.equal('notes' in p, false, '途中の文が無ければ載せない')
    const lines: string[] = []
    for (let i = 0; i < PROGRESS_NOTES + 2; i++) lines.push(assistant(at(10 + i * 2), [{ type: 'text', text: `途中の文 ${i}` }], 'tool_use'), assistant(at(11 + i * 2), [bash(`t${i + 1}`, 'ls')], 'tool_use'))
    await appendFile(path, lines.join('\n') + '\n')
    p = await reader.read(s)
    assert.equal(p.notes_total, PROGRESS_NOTES + 2)
    assert.deepEqual(p.notes?.map((n) => n.text), Array.from({ length: PROGRESS_NOTES }, (_, i) => `途中の文 ${i + 2}`), 'ツールの呼び出しに押し出されず、末尾の分だけ')
  })
})
