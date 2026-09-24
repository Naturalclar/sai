// #462。`claude --bg` の出力を読むところと、始めたセッションの UUID を `claude agents` から引くところ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundLookupError, ClaudeBackground, parseBackgrounded, attachedIn } from './claudeBackground.ts'

test('parseBackgrounded: 実測の出力から短い ID を取る。読めなければ空', () => {
  const out = 'backgrounded · 5738db0d\n  claude agents             list sessions\n  claude attach 5738db0d    open in this terminal\n'
  assert.equal(parseBackgrounded(out), '5738db0d')
  assert.equal(parseBackgrounded('Error: something'), '')
  assert.equal(parseBackgrounded(''), '')
})

/** `claude` の代わり。`--bg` なら短い ID を出し、`agents` なら一覧を出し、`stop` は引数を書き残す */
async function fakeClaude(): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-bg-'))
  const bin = join(dir, 'claude')
  const agents = JSON.stringify([{ id: '5738db0d', sessionId: '5738db0d-b4e1-4396-a5b5-6220d4530861', kind: 'background', status: 'busy' }])
  await writeFile(bin, [
    '#!/bin/sh',
    `echo "$@" >> '${dir}/calls'`,
    'case "$1" in',
    `  agents) [ "$2" = --json ] && [ "$3" = --all ] && [ "$4" = --cwd ] || exit 9; echo '${agents}' ;;`,
    '  stop) echo "stopped $2" ;;',
    '  *) echo "backgrounded · 5738db0d"; echo "  claude attach 5738db0d    open in this terminal" ;;',
    'esac',
  ].join('\n'))
  await chmod(bin, 0o755)
  return { bin, dir }
}

test('ClaudeBackground: 始めて、短い ID から UUID を引く（止める口は持たない。#462）', async () => {
  const { bin, dir } = await fakeClaude()
  const bg = new ClaudeBackground(bin)
  const got = await bg.start({ bin: 'claude', args: ['--bg', '--', 'やって'], cwd: dir, text: 'やって' })
  assert.deepEqual(got, { short: '5738db0d', sessionId: '5738db0d-b4e1-4396-a5b5-6220d4530861' })
  const calls = (await readFile(join(dir, 'calls'), 'utf-8')).trim().split('\n')
  // **`stop` は呼べない**（attach している端末をその場で閉じるので、SAI からは撃たない）
  assert.deepEqual(calls, ['--bg -- やって', `agents --json --all --cwd ${dir}`])
})

test('ClaudeBackground: claude が無い・出力が読めなければ投げる', async () => {
  await assert.rejects(new ClaudeBackground('/nonexistent/claude').start({ bin: 'claude', args: ['--bg'], cwd: tmpdir(), text: '' }))
  const dir = await mkdtemp(join(tmpdir(), 'sai-bg-'))
  const bin = join(dir, 'claude')
  await writeFile(bin, '#!/bin/sh\necho "Error: unknown option"\n')
  await chmod(bin, 0o755)
  await assert.rejects(new ClaudeBackground(bin).start({ bin: 'claude', args: ['--bg'], cwd: dir, text: '' }), /ID を読めませんでした/)
})

test('ClaudeBackground: 始まったが claude agents に出てこなければ、短い ID を添えて投げる（二重に始めさせない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-bg-'))
  const bin = join(dir, 'claude')
  await writeFile(bin, '#!/bin/sh\ncase "$1" in agents) echo "[]" ;; *) echo "backgrounded · 5738db0d" ;; esac\n')
  await chmod(bin, 0o755)
  await assert.rejects(new ClaudeBackground(bin).start({ bin: 'claude', args: ['--bg'], cwd: dir, text: '' }), (err: Error) => err instanceof BackgroundLookupError && /claude attach 5738db0d/.test(err.message))
})

test('attachedIn: argv の並びで attach している端末を探す（#462）', () => {
  const uuid = '5738db0d-b4e1-4396-a5b5-6220d4530861'
  // 実測（2.1.278）: attach の端末は argv がそのまま `claude attach <短い ID>`
  assert.equal(attachedIn('claude attach 5738db0d\n', '5738db0d', uuid), true)
  // UUID 全体や、その頭（6 文字以上）でも attach できる
  assert.equal(attachedIn(`/opt/bin/claude attach ${uuid}`, '5738db0d', uuid), true)
  assert.equal(attachedIn('claude attach 5738db', '5738db0d', uuid), true)
  // 別のセッション・別のサブコマンドは数えない
  assert.equal(attachedIn('claude attach 11111111', '5738db0d', uuid), false)
  assert.equal(attachedIn('claude logs 5738db0d', '5738db0d', uuid), false)
  // **`attach` を含むだけの行は数えない**（SAI 自身の `claude -p` は `--mcp-config` の中に `attachments` がある。実測）
  assert.equal(attachedIn('claude --mcp-config {"attachments":"5738db0d"} -p --resume 5738db0d', '5738db0d', uuid), false)
  // 短すぎる頭は数えない（別のセッションと取り違える）
  assert.equal(attachedIn('claude attach 57', '5738db0d', uuid), false)
})

test('ClaudeBackground.attached: ps が読めなければ「居る」扱い（止めない側に倒す。#462）', async () => {
  const bg = new ClaudeBackground('claude', async () => { throw new Error('ps: not found') })
  assert.equal(await bg.attached('5738db0d', '5738db0d-b4e1-4396-a5b5-6220d4530861'), true)
  const none = new ClaudeBackground('claude', async () => 'zsh\nnode server/main.ts\n')
  assert.equal(await none.attached('5738db0d', '5738db0d-b4e1-4396-a5b5-6220d4530861'), false)
})
