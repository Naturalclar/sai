// #462。`claude --bg` の出力を読むところと、始めたセッションの UUID を `claude agents` から引くところ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundLookupError, ClaudeBackground, parseBackgrounded } from './claudeBackground.ts'

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

test('ClaudeBackground: 始めて、短い ID から UUID を引く。止めるのは短い ID で', async () => {
  const { bin, dir } = await fakeClaude()
  const bg = new ClaudeBackground(bin)
  const got = await bg.start({ bin: 'claude', args: ['--bg', '--', 'やって'], cwd: dir, text: 'やって' })
  assert.deepEqual(got, { short: '5738db0d', sessionId: '5738db0d-b4e1-4396-a5b5-6220d4530861' })
  await bg.stop('5738db0d', dir)
  const calls = (await readFile(join(dir, 'calls'), 'utf-8')).trim().split('\n')
  assert.deepEqual(calls, ['--bg -- やって', `agents --json --all --cwd ${dir}`, 'stop 5738db0d'])
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
