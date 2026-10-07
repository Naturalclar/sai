// SAI から Claude にログインし直す手順（#577）。**本物の `claude` は起こさない**: 偽の `claude`（シェルスクリプト）を渡して、
// URL を取る・コードを stdin に渡す・Mac のブラウザを開かせない・1 本だけ・時間切れで落とす・終わったら聞き直す・
// 切れているときしか起こさない・ログに中身を残さない、を見る。口（/api/claude-auth/login）は偽の手順で、同一オリジンだけを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeLoginResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { ClaudeLogin, LOGIN_CODE_MAX, LOGIN_LOG_FILE, NoClaudeLogin, loginCode, loginUrl } from './local/claudeLogin.ts'
import type { ClaudeLoginRunner } from './local/claudeLogin.ts'
import { FeedStore } from './rows/store.ts'

const SECRET = 'S3CRETSTATE'
const URL_SHOWN = `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=${SECRET}`
const URL_OPENED = `https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&state=${SECRET}`

/**
 * 偽の `claude`。`auth login` で本物と同じ 3 行（URL は端末のリンクの印で包んで 2 回）を出し、`open` を呼び、stdin を 1 行ずつ読む。
 * `good` でログインできたことにして終わり、ほかは `Invalid code` と言って待ち続ける。stdin が閉じても終わらない
 */
const FAKE = `#!/bin/bash
# late / stubborn は SIGTERM を無視する（pid を書く前に仕掛ける。書いた直後に落とされても生き残るように）
case "$FAKE_MODE" in late|stubborn) trap '' TERM ;; esac
echo $$ >> "$FAKE_DIR/pids"
command -v open > "$FAKE_DIR/open-path"
[ "$FAKE_MODE" = nourl ] && exec sleep 30
echo "$PATH" > "$FAKE_DIR/path"
# 本物の open は呼ばない（SAI の置いた open が PATH の先頭に無いと、テストが Mac のブラウザを開いてしまう）
case "$(command -v open)" in "$FAKE_DIR"/shim/p-*/open) open "${URL_OPENED}"; echo $? > "$FAKE_DIR/open-exit" ;; esac
# late: SIGTERM を無視し、少し待ってから自分の pid 入りの URL を出す（落とされたあとに URL を出す子）
if [ "$FAKE_MODE" = late ]; then sleep 0.6; echo "visit: ${URL_SHOWN}&n=$$ "; fi
[ "$FAKE_MODE" = notice ] && echo "A new version is available: https://updates.example/claude/latest "
printf 'Opening browser to sign in…\\nIf the browser did not open, visit: \\033]8;;%s\\007%s\\033]8;;\\007\\nPaste code here if prompted > ' "${URL_SHOWN}" "${URL_SHOWN}"
while IFS= read -r line; do
  echo "$line" >> "$FAKE_DIR/got"
  if [ "$line" = good ]; then
    touch "$FAKE_DIR/loggedin"; echo "Login successful."
    # linger: ログインできても自分では終わらない版
    [ "$FAKE_MODE" = linger ] && exec sleep 30
    exit 0
  fi
  echo "Invalid code. Please make sure the full code was copied."
done
exec sleep 30
`

let dir: string
const servers: Server[] = []
/** 作った手順。テストが途中で落ちても、偽の子を残さない（残ると待ち続ける） */
const logins: ClaudeLogin[] = []
const saved: Record<string, string | undefined> = {}

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  assert.ok(ok(), '時間内に条件を満たさなかった')
}

/** 偽の `claude` と、その置き場ごとの手順を 1 つ作る */
async function fixture(name: string, opts: { mode?: string; timeoutMs?: number; urlWaitMs?: number; killGraceMs?: number; sentRecheckMs?: number[] } = {}) {
  const root = join(dir, name)
  await mkdir(root)
  const bin = join(root, 'claude')
  await writeFile(bin, FAKE)
  await chmod(bin, 0o755)
  process.env.FAKE_DIR = root
  process.env.FAKE_MODE = opts.mode ?? ''
  let asked = 0
  const login = new ClaudeLogin({
    bin,
    shimDir: join(root, 'shim'),
    logDir: root,
    recheck: async () => {
      asked++
      return { loggedIn: existsSync(join(root, 'loggedin')) }
    },
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.urlWaitMs ? { urlWaitMs: opts.urlWaitMs } : {}),
    ...(opts.killGraceMs ? { killGraceMs: opts.killGraceMs } : {}),
    // 既定の聞き直し（5 秒〜）はテストの間に鳴らさない。見るテストだけ短くする
    sentRecheckMs: opts.sentRecheckMs ?? [],
  })
  logins.push(login)
  const read = (file: string) => readFile(join(root, file), 'utf-8').then((s) => s.trim(), () => '')
  const alive = async () => {
    const pids = (await read('pids')).split('\n').filter(Boolean).map(Number)
    return pids.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  }
  return { root, login, read, alive, asked: () => asked }
}

before(async () => {
  for (const key of ['FAKE_DIR', 'FAKE_MODE', 'SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) saved[key] = process.env[key]
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) process.env[key] = '0'
  dir = await mkdtemp(join(tmpdir(), 'sai-claude-login-'))
})

after(async () => {
  for (const login of logins) login.stop()
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('loginUrl: 端末のリンクの印を外して https の URL を取る。戻り先が localhost のもの・http は取らない', () => {
  assert.equal(loginUrl(`visit: \u001b]8;;${URL_SHOWN}\u0007${URL_SHOWN}\u001b]8;;\u0007\nPaste code here > `), URL_SHOWN)
  assert.equal(loginUrl(`open ${URL_OPENED}\nvisit: ${URL_SHOWN}\n`), URL_SHOWN, 'Mac のブラウザ向け（localhost へ戻る）は飛ばす')
  assert.equal(loginUrl(`visit: ${URL_OPENED}\n`), '')
  assert.equal(loginUrl('visit: http://claude.com/authorize?x=1\n'), '')
  assert.equal(loginUrl('Opening browser to sign in…'), '')
  assert.equal(loginUrl('visit: https://user:pw@claude.com/x\n'), '', '資格情報つきの URL は出さない')
  // Anthropic のホストだけ。子が先に出した別の URL（更新の知らせなど）をログインのリンクにしない
  assert.equal(loginUrl(`see https://updates.example/latest \nvisit: ${URL_SHOWN}\n`), URL_SHOWN)
  assert.equal(loginUrl('visit: https://claude.com.evil.example/authorize?x=1\n'), '')
  assert.equal(loginUrl('visit: https://evilclaude.com/authorize?x=1\n'), '')
  const console_ = 'https://console.anthropic.com/oauth/authorize?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback'
  assert.equal(loginUrl(`visit: ${console_}\n`), console_)
  // 認可の URL だけ（戻り先の無い案内のリンクを、ログインのリンクにしない）
  assert.equal(loginUrl(`Docs: https://docs.claude.com/en/setup \nvisit: ${URL_SHOWN}\n`), URL_SHOWN)
  assert.equal(loginUrl('Docs: https://docs.claude.com/en/setup \n'), '')
  // 出力の切れ目で途中までの URL を出さない（後ろに区切りが来てから取る）
  assert.equal(loginUrl(`visit: ${URL_SHOWN.slice(0, 60)}`), '')
})

test('loginCode: 1 行のコードだけ。改行・制御文字・長すぎ・文字列でないものは渡さない', () => {
  assert.equal(loginCode('  abc#def  '), 'abc#def')
  assert.equal(loginCode('abc\ndef'), '')
  assert.equal(loginCode('abc\u001b[2J'), '')
  assert.equal(loginCode('abc\u2028def'), '', '行の区切りになる字（U+2028）も通さない')
  assert.equal(loginCode('abc def'), '', '途中の空白も通さない')
  assert.equal(loginCode('コード'), '')
  assert.equal(loginCode(''), '')
  assert.equal(loginCode('x'.repeat(LOGIN_CODE_MAX + 1)), '')
  assert.equal(loginCode(undefined), '')
  assert.equal(loginCode({ code: 'x' }), '')
})

test('ClaudeLogin: URL を出してコードを待ち、違うコードは待ちに戻し、通れば聞き直して done。ブラウザは開かせず、子は 1 本、ログに中身を残さない', async () => {
  const f = await fixture('flow')
  assert.deepEqual(f.login.state(), { status: 'idle' })
  assert.equal(f.login.code('early'), false, '待っている子が居なければ渡さない')
  assert.equal(f.login.start().status, 'starting')
  assert.equal(f.login.start().status, 'starting', '起こしている途中の 2 回目は起こさない')
  await until(() => f.login.state().status === 'waiting')
  assert.deepEqual(f.login.state(), { status: 'waiting', url: URL_SHOWN })
  f.login.start()
  assert.equal((await f.read('pids')).split('\n').length, 1, '子は 1 本だけ')
  // Mac のブラウザを開かせない: 子から見える open は SAI が置いた何もしないもの
  const shim = (await f.read('path')).split(':')[0]!
  assert.match(shim, new RegExp(`^${join(f.root, 'shim')}/p-[A-Za-z0-9]+$`), '置き場は起こすたびに作る')
  assert.equal(await f.read('open-path'), join(shim, 'open'))
  assert.equal(await f.read('open-exit'), '0')
  assert.equal((await stat(shim)).mode & 0o777, 0o700, 'ほかの人が書けない')

  assert.equal(f.login.code('bad\nline'), false, '形が変なコードは渡さない')
  assert.equal(f.login.code(' bad '), true)
  assert.equal(f.login.state().status, 'sent')
  await until(() => f.login.state().status === 'waiting')
  assert.deepEqual(f.login.state(), { status: 'waiting', note: 'invalid_code', url: URL_SHOWN }, '違うコードは待ちに戻る（子は落ちない）')
  assert.equal(f.asked(), 1, '聞くのは起こす前の 1 回だけ。子が終わるまでは聞き直さない')

  assert.equal(f.login.code('good'), true)
  await until(() => f.login.state().status === 'done')
  assert.deepEqual(f.login.state(), { status: 'done' }, '終わったら URL は捨てる')
  await until(() => !existsSync(shim))
  assert.deepEqual(await readdir(join(f.root, 'shim')), [], '子が終われば置き場を消す')
  assert.equal(f.asked(), 2)
  assert.equal(await f.read('got'), 'bad\ngood', '前後の空白を落として 1 行ずつ渡る')
  assert.deepEqual(await f.alive(), [])

  const log = await f.read(LOGIN_LOG_FILE)
  const line = JSON.parse(log) as Record<string, unknown>
  assert.deepEqual(
    { by: line.ended_by, code: line.exit_code, signal: line.signal, sent: line.codes_sent, invalid: line.invalid_codes, after: line.logged_in_after, stdout: line.stdout_lines },
    { by: 'exit', code: 0, signal: null, sent: 2, invalid: 1, after: true, stdout: 4 },
  )
  assert.ok(!log.includes(SECRET) && !log.includes('claude.com') && !log.includes('good') && !log.includes('Login successful'), 'URL・コード・出力の文言は残さない')

  // ログインできたあとに押しても、子は起こさない（いまのログインを差し替えない）
  assert.equal(f.login.start().status, 'starting')
  await until(() => f.login.state().status === 'failed')
  assert.deepEqual(f.login.state(), { status: 'failed', note: 'logged_in' })
  assert.equal((await f.read('pids')).split('\n').length, 1)
})

test('ClaudeLogin: 切れていると分かっているときだけ起こす。ログインできている・分からないときは子を起こさない', async () => {
  const root = join(dir, 'gate')
  await mkdir(root)
  const bin = join(root, 'claude')
  await writeFile(bin, FAKE)
  await chmod(bin, 0o755)
  process.env.FAKE_DIR = root
  process.env.FAKE_MODE = ''
  let answer: { loggedIn: boolean } | undefined = { loggedIn: true }
  const login = new ClaudeLogin({ bin, shimDir: join(root, 'shim'), recheck: async () => answer })
  logins.push(login)
  login.start()
  await until(() => login.state().status === 'failed')
  assert.deepEqual(login.state(), { status: 'failed', note: 'logged_in' })
  answer = undefined
  login.start()
  await until(() => login.state().note === 'unknown')
  assert.deepEqual(login.state(), { status: 'failed', note: 'unknown' })
  assert.ok(!existsSync(join(root, 'pids')), '子は 1 度も起きていない')
  assert.ok(!existsSync(join(root, 'shim')), 'open の置き場も作っていない')
  answer = { loggedIn: false }
  login.start()
  await until(() => login.state().status === 'waiting')
  login.cancel()
})

test('ClaudeLogin: やめると子を落として最初に戻る（聞き直さない）。サーバが終わるときも子を残さない', async () => {
  const f = await fixture('cancel')
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  assert.equal((await f.alive()).length, 1)
  assert.deepEqual(f.login.cancel(), { status: 'idle' })
  let left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  })
  assert.equal(f.asked(), 1, 'やめた子の結果は聞き直さない（聞いたのは起こす前の 1 回）')
  assert.equal(f.login.code('good'), false, 'やめたあとのコードは渡さない')

  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  f.login.stop()
  left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  })
})

test('ClaudeLogin: 時間切れで子を落とし、聞き直して failed（timeout）。URL が出なければ no_url、起こせなければ spawn_failed', async () => {
  const slow = await fixture('timeout', { timeoutMs: 300 })
  slow.login.start()
  await until(() => slow.login.state().status === 'failed')
  assert.deepEqual(slow.login.state(), { status: 'failed', note: 'timeout' })
  assert.deepEqual(await slow.alive(), [])
  assert.equal((JSON.parse(await slow.read(LOGIN_LOG_FILE)) as { ended_by: string }).ended_by, 'timeout')

  const mute = await fixture('nourl', { mode: 'nourl', urlWaitMs: 200 })
  mute.login.start()
  await until(() => mute.login.state().status === 'failed')
  assert.deepEqual(mute.login.state(), { status: 'failed', note: 'no_url' })
  assert.deepEqual(await mute.alive(), [])

  const none = new ClaudeLogin({ bin: join(dir, 'no-such-claude'), shimDir: join(dir, 'shim-none'), recheck: async () => ({ loggedIn: false }) })
  none.start()
  await until(() => none.state().status === 'failed')
  assert.deepEqual(none.state(), { status: 'failed', note: 'spawn_failed' })
})

test('ClaudeLogin: 前から置いてあるファイルを子の PATH に載せない。仕込まれたリンクを辿って書かない（置き場は毎回新しく作る）', async () => {
  const f = await fixture('planted')
  const target = join(f.root, 'victim')
  await writeFile(target, 'untouched')
  await mkdir(join(f.root, 'shim'))
  // 前の版の置き場に、同じ名前のリンクと別の実行ファイルが仕込まれている
  await symlink(target, join(f.root, 'shim', 'open'))
  await writeFile(join(f.root, 'shim', 'security'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  const first = (await f.read('path')).split(':')[0]!
  assert.notEqual(first, join(f.root, 'shim'), '仕込まれたディレクトリそのものは PATH に載らない')
  assert.deepEqual((await readdir(first)).sort(), ['open', 'xdg-open'], '子から見えるのは SAI が置いた 2 つだけ')
  assert.equal(await readFile(target, 'utf-8'), 'untouched', 'リンクの先は書き換わらない')
  f.login.cancel()
})

test('ClaudeLogin: 子が先に別の URL を出しても、それをログインのリンクにしない', async () => {
  const f = await fixture('notice', { mode: 'notice' })
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  assert.equal(f.login.state().url, URL_SHOWN)
  f.login.cancel()
})

test('ClaudeLogin: 起こしている途中にやめたら子を起こさない。SIGTERM で終わらない子は SIGKILL する', async () => {
  const quick = await fixture('quick')
  quick.login.start()
  assert.deepEqual(quick.login.cancel(), { status: 'idle' })
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(await quick.read('pids'), '', '子は起きていない')
  assert.deepEqual(quick.login.state(), { status: 'idle' })
  assert.deepEqual(await readdir(join(quick.root, 'shim')).catch(() => []), [], '作りかけの置き場も残さない')
  assert.equal(quick.login.start().status, 'starting', 'やめたあとはすぐ始め直せる')
  await until(() => quick.login.state().status === 'waiting')
  quick.login.cancel()

  const stubborn = await fixture('stubborn', { mode: 'stubborn', killGraceMs: 200 })
  stubborn.login.start()
  await until(() => stubborn.login.state().status === 'waiting')
  stubborn.login.cancel()
  let left = await stubborn.alive()
  await until(() => {
    void stubborn.alive().then((a) => (left = a))
    return left.length === 0
  })
  await until(() => existsSync(join(stubborn.root, LOGIN_LOG_FILE)))
  assert.equal((JSON.parse(await stubborn.read(LOGIN_LOG_FILE)) as { signal: string }).signal, 'SIGKILL')
})

test('ClaudeLogin: やめた直後の start は、前の子が片付いてから起こす。前の回の置き場の残りは片付ける', async () => {
  const f = await fixture('again', { mode: 'stubborn', killGraceMs: 300 })
  // 前の回にサーバが落ちて残った置き場（古い）と、同じ置き場を使う別のサーバの、いま走っている回のもの（新しい）
  await mkdir(join(f.root, 'shim', 'p-leftover'), { recursive: true })
  await writeFile(join(f.root, 'shim', 'p-leftover', 'open'), 'old')
  const longAgo = new Date(Date.now() - 2 * 3600_000)
  await utimes(join(f.root, 'shim', 'p-leftover'), longAgo, longAgo)
  await mkdir(join(f.root, 'shim', 'p-other'))
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  assert.ok(!existsSync(join(f.root, 'shim', 'p-leftover')), '古い残りは起こす前に消す')
  assert.ok(existsSync(join(f.root, 'shim', 'p-other')), '新しいもの（別のサーバの回かもしれない）は消さない')
  f.login.cancel()
  // 前の子はまだ生きている（SIGTERM を無視する）。それでも「何も起きない」にしない
  assert.deepEqual(f.login.start(), { status: 'starting' })
  assert.equal((await f.alive()).length, 1)
  assert.deepEqual(f.login.state(), { status: 'starting' }, '落とした子の URL を、次の回のものとして出さない')
  await until(() => f.login.state().status === 'waiting')
  assert.equal((await f.read('pids')).split('\n').length, 2, '前の子が片付いてから 2 本目')
  assert.equal((await f.alive()).length, 1, '同時に生きているのは 1 本')
  // やめれば、待たせていた start も取り消す
  f.login.cancel()
  f.login.start()
  assert.deepEqual(f.login.cancel(), { status: 'idle' })
  let left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal((await f.read('pids')).split('\n').length, 2, '取り消した start は起こさない')
})

test('ClaudeLogin: 落とした子があとから出した URL を、次の回のものとして出さない', async () => {
  const f = await fixture('late', { mode: 'late', killGraceMs: 1500 })
  f.login.start()
  await until(() => existsSync(join(f.root, 'pids')))
  const first = (await f.read('pids')).split('\n')[0]!
  // URL が出る前にやめて、すぐ押し直す。前の子は SIGTERM を無視して 0.6 秒後に URL を出し、1.5 秒後に SIGKILL される
  f.login.cancel()
  f.login.start()
  await new Promise((r) => setTimeout(r, 1000))
  assert.deepEqual(f.login.state(), { status: 'starting' }, '前の子の URL は出さない（前の子が終わるのを待っている）')
  await until(() => f.login.state().status === 'waiting', 6000)
  const pids = (await f.read('pids')).split('\n')
  assert.equal(pids.length, 2)
  assert.equal(f.login.state().url, `${URL_SHOWN}&n=${pids[1]}`, '出すのは新しい子の URL')
  assert.notEqual(pids[1], first)
  f.login.cancel()
})

test('ClaudeLogin: claude が包みのスクリプトでも、やめたら本体（孫）を残さない', async () => {
  const f = await fixture('wrapper')
  // 本体を exec せずに起こす包み。SIGTERM は包みにだけ効いて、本体が残る形
  await writeFile(join(f.root, 'real'), FAKE)
  await chmod(join(f.root, 'real'), 0o755)
  await writeFile(join(f.root, 'claude'), `#!/bin/bash\n"${join(f.root, 'real')}" "$@"\n`)
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  assert.equal((await f.alive()).length, 1, '本体（孫）が動いている')
  f.login.cancel()
  let left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  })
})

test('ClaudeLogin: サーバが終わるときは待たずに SIGKILL し、置き場もその場で消す', async () => {
  const f = await fixture('shutdown', { mode: 'stubborn', killGraceMs: 60_000 })
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  const shim = (await f.read('path')).split(':')[0]!
  f.login.stop()
  assert.ok(!existsSync(shim), '同期で消す（このあとプロセスが終わるので、あとでは消せない）')
  let left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  }, 2000)
  // 止めたあとに届いた start は起こさない（落とす者の居ない子を残さない）
  assert.deepEqual(f.login.start(), { status: 'failed', note: 'unavailable' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await f.read('pids')).split('\n').length, 1)
})

test('ClaudeLogin: コードが通っても子が終わらない版では、聞き直してログインできていたら子を落として done', async () => {
  const f = await fixture('linger', { mode: 'linger', sentRecheckMs: [150, 400] })
  f.login.start()
  await until(() => f.login.state().status === 'waiting')
  f.login.code('bad')
  await until(() => f.login.state().note === 'invalid_code')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(f.login.state().status, 'waiting', 'ログインできていなければ、聞き直しても待ちのまま')
  f.login.code('good')
  await until(() => f.login.state().status === 'done')
  let left = await f.alive()
  await until(() => {
    void f.alive().then((a) => (left = a))
    return left.length === 0
  })
  await until(() => existsSync(join(f.root, LOGIN_LOG_FILE)))
  assert.deepEqual(JSON.parse(await f.read(LOGIN_LOG_FILE)) as Record<string, unknown>, { ...(JSON.parse(await f.read(LOGIN_LOG_FILE)) as Record<string, unknown>), ended_by: 'logged_in', logged_in_after: true })
})

/** 偽の手順。呼ばれたことを覚える */
class FakeLogin implements ClaudeLoginRunner {
  current: ClaudeLoginResponse = { status: 'idle' }
  calls: string[] = []
  state(): ClaudeLoginResponse {
    return this.current
  }
  start(): ClaudeLoginResponse {
    this.calls.push('start')
    this.current = { status: 'waiting', url: URL_SHOWN }
    return this.current
  }
  code(code: string): boolean {
    this.calls.push(`code:${code}`)
    if (this.current.status !== 'waiting') return false
    this.current = { status: 'sent', url: URL_SHOWN }
    return true
  }
  cancel(): ClaudeLoginResponse {
    this.calls.push('cancel')
    this.current = { status: 'idle' }
    return this.current
  }
  stopped = 0
  stop(): void {
    this.stopped++
  }
}

async function serve(_auth: undefined, login: ClaudeLoginRunner | undefined) {
  const feedDir = await mkdtemp(join(dir, 'feed-'))
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, {
    tmux: { run: async () => '' },
    ps: async () => '',
    ...(login ? { claudeLogin: login } : {}),
  })
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const post = (body: unknown, origin = base) => fetch(`${base}/api/claude-auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { base, post, app }
}

test('/api/claude-auth/login: 同一オリジンだけ。始める・コードを渡す・やめるを手順に取り次ぎ、サーバが終わるとき子を残さない', async () => {
  const login = new FakeLogin()
  const { base, post, app } = await serve(undefined, login)

  assert.equal((await post({ action: 'start' }, 'http://evil.example')).status, 403)
  assert.equal((await fetch(`${base}/api/claude-auth/login`, { headers: { Origin: 'http://evil.example' } })).status, 403, '状態（URL が載る）も同一オリジンだけ')
  assert.equal((await fetch(`${base}/api/claude-auth/login`, { method: 'DELETE', headers: { Origin: base } })).status, 405)
  assert.deepEqual(login.calls, [])

  const started = await post({ action: 'start' })
  assert.equal(started.status, 200)
  assert.equal(started.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await started.json(), { status: 'waiting', url: URL_SHOWN })
  assert.deepEqual(await (await fetch(`${base}/api/claude-auth/login`)).json(), { status: 'waiting', url: URL_SHOWN })

  assert.equal((await post({ action: 'code', code: 'a\nb' })).status, 400)
  assert.equal((await post({ action: 'code' })).status, 400)
  assert.equal((await post({ action: 'nope' })).status, 400)
  assert.deepEqual(await (await post({ action: 'code', code: 'abc#def' })).json(), { status: 'sent', url: URL_SHOWN })
  assert.equal((await post({ action: 'code', code: 'again' })).status, 409, 'コードを待っていなければ断る')
  assert.deepEqual(await (await post({ action: 'cancel' })).json(), { status: 'idle' })
  assert.deepEqual(login.calls, ['start', 'code:abc#def', 'code:again', 'cancel'])

  app.dispose()
  assert.equal(login.stopped, 1, 'サーバが終わるとき子を残さない')
})

test('既定（createApp に渡さない）では、ログインの子を起こさない', async () => {
  const { post } = await serve(undefined, undefined)
  assert.deepEqual(await (await post({ action: 'start' })).json(), { status: 'failed', note: 'unavailable' })
  assert.deepEqual(new NoClaudeLogin().state(), { status: 'idle' })
})
