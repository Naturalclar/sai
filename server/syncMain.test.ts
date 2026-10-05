// /sync-main の更新・ビルドを 1 回にまとめるスクリプト（#687）。本物の main worktree と 8787 は触らない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../.claude/skills/sync-main/sync.sh', import.meta.url))

type Result = { code: number; out: string; err: string }

function command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: { ...process.env, ...env } }, (error, out, err) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, out: out.trim(), err: err.trim() })
    })
  })
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const got = await command('git', args, cwd, { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' })
  assert.equal(got.code, 0, `git ${args.join(' ')}\n${got.err}`)
  return got.out
}

type Fixture = { root: string; upstream: string; seed: string; repo: string; main: string; dev: string; bin: string; pnpm: string; calls: string; before: string; target: string; lock: string }

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'sai-sync-main-'))
  const upstream = join(root, 'upstream.git')
  const seed = join(root, 'seed')
  const repo = join(root, 'sai.git')
  const main = join(root, 'main')
  const dev = join(root, 'dev')
  const bin = join(root, 'bin')
  const calls = join(root, 'pnpm-calls')
  await mkdir(seed)
  await mkdir(bin)
  await git(root, 'init', '--bare', upstream)
  await git(seed, 'init', '-b', 'main')
  await mkdir(join(seed, 'web', 'dist'), { recursive: true })
  await mkdir(join(seed, 'server'), { recursive: true })
  await writeFile(join(seed, 'app.txt'), 'one\n')
  await writeFile(join(seed, 'web', 'dist', 'index.html'), '<html></html>')
  await writeFile(join(seed, 'server', 'main.ts'), 'console.log("sai")\n')
  await git(seed, 'add', 'app.txt', 'web/dist/index.html', 'server/main.ts')
  await git(seed, 'commit', '-m', 'one')
  await git(seed, 'remote', 'add', 'origin', upstream)
  await git(seed, 'push', '-u', 'origin', 'main')
  await git(root, 'clone', '--bare', upstream, repo)
  await git(repo, 'worktree', 'add', main, 'main')
  await git(repo, 'worktree', 'add', '-b', 'dev', dev, 'main')
  const before = await git(main, 'rev-parse', 'HEAD')

  await writeFile(join(seed, 'app.txt'), 'two\n')
  await git(seed, 'add', 'app.txt')
  await git(seed, 'commit', '-m', 'two')
  await git(seed, 'push', 'origin', 'main')
  const target = await git(seed, 'rev-parse', 'HEAD')

  const pnpm = join(bin, 'pnpm')
  await writeFile(
    pnpm,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_PNPM_CALLS"\ncase "$*" in *' build') [ "${'$'}{FAKE_PNPM_FAIL:-}" = build ] && { echo 'fake build failed' >&2; exit 9; };; esac\nexit 0\n`,
  )
  await chmod(pnpm, 0o755)
  return { root, upstream, seed, repo, main, dev, bin, pnpm, calls, before, target, lock: join(repo, 'sai-sync-main.lock') }
}

async function run(f: Fixture, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return command('bash', [SCRIPT, f.dev], f.dev, {
    SYNC_MAIN_SKIP_SERVER: '1',
    SYNC_MAIN_LOCK_WAIT: '0',
    SYNC_MAIN_PNPM: f.pnpm,
    FAKE_PNPM_CALLS: f.calls,
    ...env,
  })
}

async function clean(f: Fixture) {
  await rm(f.root, { recursive: true, force: true })
}

test('sync-main: bare repo の main worktree を ff-only で進め、install・build を 1 回で行う', async () => {
  const f = await fixture()
  try {
    const got = await run(f)
    assert.equal(got.code, 0, got.out + got.err)
    assert.equal(await git(f.main, 'rev-parse', 'HEAD'), f.target)
    assert.match(got.out, /^main=.*\nlock=acquired/m)
    assert.match(got.out, /sync=updated commits=.*two/)
    assert.match(got.out, /build=ok/)
    assert.match(got.out, /server=skipped reason=test/)
    assert.match(got.out, /status=ok/)
    assert.match(got.out, /lock=released$/)
    assert.ok(got.out.split('\n').length <= 8, '成功時の出力を短く保つ')
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n')
    assert.equal(calls.length, 2)
    assert.match(calls[0]!, /^-C \/.+\/main install --frozen-lockfile$/)
    assert.match(calls[1]!, /^-C \/.+\/main build$/)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: main worktree が汚れていれば fetch も build もせず、lock を放す', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.main, 'dirty.txt'), 'mine\n')
    const got = await run(f)
    assert.equal(got.code, 4)
    assert.match(got.out, /status=blocked stage=status detail=dirty:/)
    assert.equal(await git(f.main, 'rev-parse', 'HEAD'), f.before)
    assert.equal(existsSync(f.calls), false)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: サーバが止まっていれば起動せず、短い状態だけを返す', async () => {
  const f = await fixture()
  try {
    const lsof = join(f.bin, 'lsof')
    await writeFile(lsof, '#!/bin/sh\nexit 1\n')
    await chmod(lsof, 0o755)
    const got = await run(f, { SYNC_MAIN_SKIP_SERVER: '0', PATH: `${f.bin}:${process.env.PATH ?? ''}` })
    assert.equal(got.code, 0, got.out + got.err)
    assert.match(got.out, /server=stopped port=8787 action=none/)
    assert.doesNotMatch(got.out, /sessions|replying/, 'API の本文を出さない')
    assert.ok(got.out.split('\n').length <= 8, '状態を決まった行数に収める')
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: 動いている最新サーバは再起動せず、API本文を出さずにdigestとbuildだけ要約する', async () => {
  const f = await fixture()
  try {
    const lsof = join(f.bin, 'lsof')
    const ps = join(f.bin, 'ps')
    const tmux = join(f.bin, 'tmux')
    const curl = join(f.bin, 'curl')
    await writeFile(lsof, '#!/bin/sh\necho 4242\n')
    await writeFile(ps, `#!/bin/sh\ncase "$*" in *'command='*) echo 'node server/main.ts';; *'ppid='*) echo 1;; *'lstart='*) echo 'Sat Oct  5 23:59:59 2030';; *) exit 1;; esac\n`)
    await writeFile(tmux, '#!/bin/sh\nexit 0\n')
    await writeFile(
      curl,
      `#!/bin/sh\nout=''\nheaders=''\nurl=''\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out=$2; shift 2;;\n    -D) headers=$2; shift 2;;\n    http://*) url=$1; shift;;\n    *) shift;;\n  esac\ndone\ncase "$url" in\n  */api/settings) printf '%s' '{"digest_on":true,"provider":"openai","digest_model":"qwen3:8b","digest_error":"","secret_body":"DO_NOT_PRINT"}' > "$out";;\n  */api/sessions*) [ -z "$headers" ] || printf '%s\\r\\n' 'X-SAI-Build: 1' > "$headers"; [ "$out" = /dev/null ] || printf '%s' '{"secret_body":"DO_NOT_PRINT"}' > "$out";;\nesac\n`,
    )
    await Promise.all([lsof, ps, tmux, curl].map((path) => chmod(path, 0o755)))
    const got = await run(f, { SYNC_MAIN_SKIP_SERVER: '0', PATH: `${f.bin}:${process.env.PATH ?? ''}` })
    assert.equal(got.code, 0, got.out + got.err)
    assert.match(got.out, /server=latest pid=4242 action=none/)
    assert.match(got.out, /digest=on=true provider=openai model=qwen3:8b error=-/)
    assert.match(got.out, /verify=build-no header=1 dist=/)
    assert.doesNotMatch(got.out, /DO_NOT_PRINT|secret_body/)
    assert.ok(got.out.split('\n').length <= 10)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: Codex のターン中は古いサーバを再起動せず、API本文を出さない', async () => {
  const f = await fixture()
  try {
    const tmuxCalls = join(f.root, 'tmux-calls')
    const lsof = join(f.bin, 'lsof')
    const ps = join(f.bin, 'ps')
    const tmux = join(f.bin, 'tmux')
    const curl = join(f.bin, 'curl')
    await writeFile(lsof, '#!/bin/sh\necho 4242\n')
    await writeFile(
      ps,
      `#!/bin/sh\ncase "$*" in *'command='*) echo 'node server/main.ts';; *'ppid='*) echo 1;; *'lstart='*) echo 'Sat Oct  5 01:00:00 2020';; *) exit 1;; esac\n`,
    )
    await writeFile(tmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_TMUX_CALLS"\n`)
    await writeFile(
      curl,
      `#!/bin/sh\nout=''\nurl=''\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out=$2; shift 2;;\n    http://*) url=$1; shift;;\n    *) shift;;\n  esac\ndone\ncase "$url" in\n  */api/sessions?days=7) printf '%s' '{"sessions":[{"id":"busy","agent":"codex"}],"replying":{"busy":{"since":"now","secret_body":"DO_NOT_PRINT"}}}' > "$out";;\nesac\n`,
    )
    await Promise.all([lsof, ps, tmux, curl].map((path) => chmod(path, 0o755)))
    const got = await run(f, {
      SYNC_MAIN_SKIP_SERVER: '0',
      PATH: `${f.bin}:${process.env.PATH ?? ''}`,
      FAKE_TMUX_CALLS: tmuxCalls,
    })
    assert.equal(got.code, 0, got.out + got.err)
    assert.match(got.out, /server=deferred pid=4242 reason=codex-busy ids=busy/)
    assert.doesNotMatch(got.out, /DO_NOT_PRINT|secret_body/)
    assert.equal(existsSync(tmuxCalls), false, 'Codex 処理中は tmux に C-c を送らない')
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: 古いサーバはCodexが動いていなければ同じtmuxペインで立て直し、親とbuildを検証する', async () => {
  const f = await fixture()
  try {
    const state = join(f.root, 'server-started')
    const tmuxCalls = join(f.root, 'tmux-calls')
    const lsof = join(f.bin, 'lsof')
    const ps = join(f.bin, 'ps')
    const tmux = join(f.bin, 'tmux')
    const curl = join(f.bin, 'curl')
    await writeFile(lsof, `#!/bin/sh\nif [ -f "$FAKE_SERVER_STATE" ]; then echo 5252; else echo 4242; fi\n`)
    await writeFile(
      ps,
      `#!/bin/sh\ncase "$*" in\n  *'command='*'-p 4242') echo 'node server/main.ts';;\n  *'command='*'-p 100') echo zsh;;\n  *'ppid='*'-p 4242') echo 100;;\n  *'ppid='*'-p 5252') echo 100;;\n  *'ppid='*'-p 100') echo 1;;\n  *'lstart='*) echo 'Sat Oct  5 01:00:00 2020';;\n  *'tty='*) echo ttys001;;\n  *'-A -o pid=,ppid=,command=') exit 0;;\n  *) exit 1;;\nesac\n`,
    )
    await writeFile(
      tmux,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_TMUX_CALLS"\ncase "$1" in\n  list-panes) echo '%1 /dev/ttys001';;\n  display) echo 100;;\n  send-keys) case "$*" in *'pnpm start'*) touch "$FAKE_SERVER_STATE";; esac;;\nesac\n`,
    )
    await writeFile(
      curl,
      `#!/bin/sh\nout=''\nheaders=''\nurl=''\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out=$2; shift 2;;\n    -D) headers=$2; shift 2;;\n    http://*) url=$1; shift;;\n    *) shift;;\n  esac\ndone\ncase "$url" in\n  */api/sessions?days=7) printf '%s' '{"sessions":[],"replying":{}}' > "$out";;\n  */api/settings) printf '%s' '{"digest_on":true,"provider":"openai","digest_model":"qwen3:8b","digest_error":""}' > "$out";;\n  */api/sessions?days=1) [ -z "$headers" ] || printf '%s\\r\\n' 'X-SAI-Build: 1' > "$headers";;\nesac\n`,
    )
    await Promise.all([lsof, ps, tmux, curl].map((path) => chmod(path, 0o755)))
    const got = await run(f, {
      SYNC_MAIN_SKIP_SERVER: '0',
      PATH: `${f.bin}:${process.env.PATH ?? ''}`,
      FAKE_SERVER_STATE: state,
      FAKE_TMUX_CALLS: tmuxCalls,
    })
    assert.equal(got.code, 0, got.out + got.err)
    assert.match(got.out, /server=restarted old=4242 new=5252 pane=%1/)
    assert.match(got.out, /digest=on=true provider=openai model=qwen3:8b error=-/)
    assert.match(got.out, /verify=build-no header=1 dist=/)
    const calls = await readFile(tmuxCalls, 'utf8')
    assert.match(calls, /send-keys -t %1 C-c/)
    assert.match(calls, /send-keys -t %1 C-u/)
    assert.match(calls, /send-keys -t %1 pnpm start Enter/)
    assert.ok(got.out.split('\n').length <= 10)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: main ブランチの worktree が無ければ何も触らず止まる', async () => {
  const f = await fixture()
  try {
    await git(f.main, 'switch', '-c', 'other')
    const got = await run(f)
    assert.equal(got.code, 4)
    assert.match(got.out, /stage=locate.*main ブランチの worktree が無い/)
    assert.equal(await git(f.main, 'rev-parse', 'HEAD'), f.before)
    assert.equal(existsSync(f.calls), false)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: main と origin/main が分岐して ff できなければ build せず、lock を放す', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.main, 'local.txt'), 'local\n')
    await git(f.main, 'add', 'local.txt')
    await git(f.main, 'commit', '-m', 'local')
    const local = await git(f.main, 'rev-parse', 'HEAD')
    const got = await run(f)
    assert.equal(got.code, 5)
    assert.match(got.out, /status=blocked stage=merge/)
    assert.equal(await git(f.main, 'rev-parse', 'HEAD'), local)
    assert.equal(existsSync(f.calls), false)
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})

test('sync-main: build が失敗しても lock を放し、失敗段と短いログを返す', async () => {
  const f = await fixture()
  try {
    const got = await run(f, { FAKE_PNPM_FAIL: 'build' })
    assert.equal(got.code, 5)
    assert.match(got.out, /status=blocked stage=build detail=fake build failed/)
    assert.equal(await git(f.main, 'rev-parse', 'HEAD'), f.target, 'merge 済みの main は戻さない')
    assert.equal(existsSync(f.lock), false)
  } finally {
    await clean(f)
  }
})
