// #418。`claude agents --json` を読むところと、聞けなかったときに黙る形
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgents, NoAgents, agentListFromEnv, backgroundIn, backgroundLive, busyIn, parseAgents } from './claudeAgents.ts'

/** `claude agents --json` の代わりに、決まった中身を吐く実行ファイルを置く */
async function fakeClaude(stdout: string, code = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const bin = join(dir, 'claude')
  // 引数が `agents --json --all` のときだけ返す（他の形で呼んでいたら空になり、テストが落ちる）
  await writeFile(bin, `#!/bin/sh\n[ "$1" = agents ] && [ "$2" = --json ] && [ "$3" = --all ] || exit 9\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`)
  await chmod(bin, 0o755)
  return bin
}

const one = (over: Record<string, unknown> = {}) =>
  JSON.stringify([{ pid: 1, cwd: '/w', kind: 'interactive', status: 'idle', sessionId: 'S1', name: 'かなで', ...over }])

test('parseAgents: 読めた分だけ返す。読めなければ null（空の配列とは別）', () => {
  const got = parseAgents(one({ status: 'busy' }))
  assert.equal(got?.length, 1)
  assert.deepEqual(got?.[0], { sessionId: 'S1', id: '', kind: 'interactive', status: 'busy', state: '', cwd: '/w', pid: 1, name: 'かなで' })
  assert.deepEqual(parseAgents('[]'), [], '生きているセッションが 0 件（聞けている）')
  assert.equal(parseAgents(''), null, '空は「聞けなかった」')
  assert.equal(parseAgents('not json'), null)
  assert.equal(parseAgents('{"error":"x"}'), null, '配列でも sessions でもない')
  // 形が変わって `{ sessions: [...] }` になっても読める
  assert.equal(parseAgents('{"sessions":[{"sessionId":"S2"}]}')?.[0]?.sessionId, 'S2')
  assert.deepEqual(parseAgents('[{"pid":1},"x",null]'), [], 'sessionId の無い要素は捨てる')
})

test('busyIn: 同じ sessionId が複数あるので、1 つでも busy なら回っている', () => {
  // 実測の形: 端末の TUI が idle、SAI が -p --resume で起こした子が同じ ID で busy
  const agents = parseAgents(JSON.stringify([
    { sessionId: 'S1', status: 'idle', kind: 'interactive', pid: 1, cwd: '/w', name: 'かなで' },
    { sessionId: 'S1', status: 'busy', kind: 'interactive', pid: 2, cwd: '/w', name: 'dev-kanade-34' },
  ]))!
  assert.equal(busyIn(agents, 'S1'), true)
  assert.equal(busyIn(agents, 'S2'), false, '一覧に無いセッションは回っていない')
  assert.equal(busyIn([], 'S1'), false)
})

test('ClaudeAgents: busy を引く。同じ答えは少しのあいだ覚える', async () => {
  const bin = await fakeClaude(one({ status: 'busy' }))
  const agents = new ClaudeAgents(bin)
  assert.equal(await agents.busy('S1'), true)
  assert.equal(await agents.busy('S9'), false, '一覧に無ければ false（「聞けたが回っていない」）')
  assert.equal(await agents.busy(''), undefined, 'セッション ID が無ければ聞きに行かない')
})

test('ClaudeAgents: 1 本目が返る前の呼び出しは、同じ 1 本を待つ（#433）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const bin = join(dir, 'claude')
  const count = join(dir, 'count')
  // 呼ばれるたびに 1 行足し、すぐには返らない（`claude agents --json` は即答ではない）
  await writeFile(bin, `#!/bin/sh\necho x >> '${count}'\nsleep 0.3\necho '${one({ status: 'busy' })}'\n`)
  await chmod(bin, 0o755)
  const agents = new ClaudeAgents(bin)
  const got = await Promise.all(['S1', 'S1', 'S9', 'S1', 'S9'].map((id) => agents.busy(id)))
  assert.deepEqual(got, [true, true, false, true, false])
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 1, '5 本同時でも claude は 1 回')
})

test('ClaudeAgents: 聞けなかった 1 本は覚えず、次の呼び出しでまた試す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const bin = join(dir, 'claude')
  const count = join(dir, 'count')
  await writeFile(bin, `#!/bin/sh\necho x >> '${count}'\nexit 1\n`)
  await chmod(bin, 0o755)
  const agents = new ClaudeAgents(bin)
  assert.equal(await agents.busy('S1'), undefined)
  assert.equal(await agents.busy('S1'), undefined)
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2, '失敗は TTL で覚えない')
})

test('ClaudeAgents: 聞けなければ undefined（false にしない）', async () => {
  assert.equal(await new ClaudeAgents('/nonexistent/claude').busy('S1'), undefined, 'claude が無い')
  assert.equal(await new ClaudeAgents(await fakeClaude('', 1)).busy('S1'), undefined, '非 0 で終わった（古い CLI）')
  assert.equal(await new ClaudeAgents(await fakeClaude('not json')).busy('S1'), undefined, '壊れた出力')
  // 時間切れ（1ms で諦める）
  const slow = await fakeClaude('sleep 5; echo "[]"')
  assert.equal(await new ClaudeAgents(slow, 3000, 1).busy('S1'), undefined)
})

test('agentListFromEnv: SAI_CLAUDE_AGENTS=0 なら聞きに行かない', async () => {
  assert.equal(agentListFromEnv({ SAI_CLAUDE_AGENTS: '0' }) instanceof NoAgents, true)
  assert.equal(agentListFromEnv({}) instanceof ClaudeAgents, true)
  assert.equal(await new NoAgents().busy('S1'), undefined)
})

// #462。`claude --bg` の行。実測の形（2.1.278）: 生きているものは status が idle / busy / waiting、止めたものは status が無い
const bgRows = JSON.stringify([
  { pid: 1, cwd: '/w', kind: 'interactive', status: 'idle', sessionId: 'S1', id: 'aaaaaaaa' },
  { pid: 2, cwd: '/w', kind: 'background', status: 'waiting', state: 'blocked', sessionId: 'S1', id: '5738db0d' },
  { pid: 0, cwd: '/w', kind: 'background', state: 'done', sessionId: 'S2', id: '4a4a3485' },
])

test('backgroundIn: 同じ ID の端末の TUI とは分けて、--bg の行だけ返す', () => {
  const agents = parseAgents(bgRows)!
  assert.equal(backgroundIn(agents, 'S1')?.id, '5738db0d')
  assert.equal(backgroundIn(agents, 'S1')?.status, 'waiting')
  assert.equal(backgroundIn(agents, 'S9'), null)
  assert.equal(backgroundLive(backgroundIn(agents, 'S1')!), true)
  assert.equal(backgroundLive(backgroundIn(agents, 'S2')!), false, '止めたものは status が空')
  assert.equal(busyIn(agents, 'S2'), false, '止めたものは回っていない')
})

test('ClaudeAgents.background: 引ける・無い・分からない', async () => {
  const agents = new ClaudeAgents(await fakeClaude(bgRows))
  assert.equal((await agents.background('S2'))?.id, '4a4a3485')
  assert.equal(await agents.background('S9'), null)
  assert.equal(await agents.background(''), undefined)
  assert.equal(await new ClaudeAgents('/nonexistent/claude').background('S1', true), undefined)
})

test('ClaudeAgents: --all を知らない版では付けずに引き直し、以後は付けない（#462）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const bin = join(dir, 'claude')
  const calls = join(dir, 'calls')
  // 古い CLI の断り方（commander の文言。本物は `error: unknown option '<flag>'` と言う）
  await writeFile(bin, `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$3" = --all ] && { echo "error: unknown option '--all'" >&2; exit 1; }\n[ "$1" = agents ] && [ "$2" = --json ] || exit 9\necho '${one({ status: 'busy' })}'\n`)
  await chmod(bin, 0o755)
  const agents = new ClaudeAgents(bin, 0)
  assert.equal(await agents.busy('S1'), true)
  assert.equal(await agents.busy('S1'), true)
  // 1 回目は `--all` で断られて引き直し（2 本）、2 回目からは最初から付けない（1 本）
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['agents --json --all', 'agents --json', 'agents --json'])
})

test('ClaudeAgents: --all と関係ない失敗では引き直さない（壊れた CLI で毎回 2 本起こさない。#433 / #462）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-agents-'))
  const bin = join(dir, 'claude')
  const calls = join(dir, 'calls')
  await writeFile(bin, `#!/bin/sh\necho "$*" >> '${calls}'\necho "error: not logged in" >&2\nexit 1\n`)
  await chmod(bin, 0o755)
  assert.equal(await new ClaudeAgents(bin, 0).busy('S1'), undefined)
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['agents --json --all'])
})

test('backgroundLive: 版で持つキーが違うので両方見る（#462。2.1.278 は state、2.1.276 は status）', () => {
  const bg = (o: Record<string, unknown>) => parseAgents(JSON.stringify([{ sessionId: 'S1', kind: 'background', id: '5738db0d', ...o }]))![0]!
  // 2.1.278（実測）: バックグラウンドの行は state だけを持ち、status も pid も無い
  assert.equal(backgroundLive(bg({ state: 'working' })), true)
  assert.equal(backgroundLive(bg({ state: 'stopped' })), false, '止めたばかり')
  assert.equal(backgroundLive(bg({ state: 'done' })), false, '終わっている')
  // 2.1.276: status（busy / idle / waiting）で、止めたものは空
  assert.equal(backgroundLive(bg({ status: 'idle' })), true)
  assert.equal(backgroundLive(bg({ status: 'waiting' })), true)
  assert.equal(backgroundLive(bg({ status: '' })), false)
})
