import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJevAuto, jevAsks, jevAutoAllows, jevAutoDecision, jevAutoEligible, jevLabel, jevLogged, jevLowestRule, jevLevel, jevPercent, jevRuleState, jevSafeOf, jevState, JEV_AUTO_MIN, JEV_STATE_MAX } from './jev.ts'
import type { Approval } from './types.ts'

const a = (over: Partial<Approval> = {}): Approval => ({
  approval_id: 'ap1',
  id: 'S@sai',
  since: '2026-09-25T10:00:00Z',
  tool_name: 'Bash',
  input: { command: 'git status', description: '状態を見る' },
  tool_use_id: 't1',
  text: '許可待ち: Bash: git status',
  ...over,
})

test('jevAsks: SAI が答えられる許可だけ。検出専用と質問は聞かない', () => {
  assert.equal(jevAsks(a()), true)
  assert.equal(jevAsks(a({ answerable: true, agent: 'codex', tool_name: 'CodexCommand' })), true)
  assert.equal(jevAsks(a({ answerable: false, agent: 'codex', tool_name: 'CodexDialog' })), false, '検出専用（押せない）')
  assert.equal(jevAsks(a({ tool_name: 'AskUserQuestion' })), false, '質問は「問題ないか」の話ではない')
  assert.equal(jevAsks(a({ tool_name: 'ExitPlanMode' })), false)
})

test('jevState: Claude はツール名と名指しした項目（コマンド・説明）を送る。要約（text）は送らない', () => {
  const state = jevState(a())
  assert.match(state, /Tool: Bash/)
  assert.match(state, /Command: git status/)
  assert.match(state, /Description: 状態を見る/)
  assert.doesNotMatch(state, /許可待ち/, '要約は送らない')
  // 長いコマンドも全部（上限まで）
  const long = `echo ${'x'.repeat(300)}`
  assert.match(jevState(a({ input: { command: long }, text: `許可待ち: Bash: ${long.slice(0, 100)}…` })), new RegExp(`Command: ${long}`))
})

test('jevState: MCP のツールは要約が input の JSON なので、要約も input も送らない（ファイル・メッセージの本文が混ざる。#493 のレビュー）', () => {
  const input = { owner: 'me', repo: 'r', path: 'secret.ts', content: 'SECRET_FILE_BODY', message: 'SECRET_MESSAGE' }
  const state = jevState(a({ tool_name: 'mcp__github__create_or_update_file', input, text: `許可待ち: mcp__github__create_or_update_file: ${JSON.stringify(input)}` }))
  assert.match(state, /Tool: mcp__github__create_or_update_file/)
  assert.doesNotMatch(state, /SECRET_FILE_BODY|SECRET_MESSAGE/)
})

test('jevState: ファイルの中身（Write の content / Edit の old_string・new_string）と cwd は送らない', () => {
  const state = jevState(
    a({
      tool_name: 'Edit',
      input: { file_path: 'src/app.ts', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW', cwd: '/Users/me/work' },
      text: '許可待ち: Edit: src/app.ts',
    }),
  )
  assert.match(state, /src\/app\.ts/)
  assert.doesNotMatch(state, /SECRET_OLD|SECRET_NEW|\/Users\/me/)
  const write = jevState(a({ tool_name: 'Write', input: { file_path: 'a.txt', content: 'SECRET_BODY' }, text: '許可待ち: Write: a.txt' }))
  assert.doesNotMatch(write, /SECRET_BODY/)
})

test('jevState: Codex の理由とダイアログの中身を送る。全体は上限で切る', () => {
  const codex = jevState(a({ agent: 'codex', tool_name: 'CodexCommand', input: { command: 'git push', reason: 'PR を出すため' }, text: '許可待ち: コマンド: git push' }))
  assert.match(codex, /\(codex\)/)
  assert.match(codex, /Reason: PR を出すため/)
  const dialog = jevState(
    a({ agent: 'codex', tool_name: 'CodexDialog', input: {}, text: 'Codex の許可待ち: git add -A', dialog: { title: 'Would you like to run the following command?', detail: 'Reason: コミットのため', command: 'git add -A', options: [] } }),
  )
  assert.match(dialog, /Dialog: Would you like/)
  assert.match(dialog, /Command: git add -A/)
  const huge = jevState(a({ input: { command: 'x'.repeat(10_000), description: 'y'.repeat(10_000), reason: 'z'.repeat(10_000) }, text: 'z' }))
  assert.ok(huge.length <= JEV_STATE_MAX + 1, `上限で切る（${huge.length}）`)
})

test('jevLevel / jevLabel: 0.8 以上は問題なさそう、0.3 未満は危なそう、間は割れる', () => {
  assert.equal(jevLevel(0.97), 'safe')
  assert.equal(jevLevel(0.8), 'safe')
  assert.equal(jevLevel(0.79), 'unsure')
  assert.equal(jevLevel(0.3), 'unsure')
  assert.equal(jevLevel(0.29), 'risky')
  assert.equal(jevLabel(0.974), '問題なさそう 97%')
  assert.equal(jevLabel(0.59), '判断が割れる 59%')
  assert.equal(jevLabel(0.01), '危なそう 1%')
})

test('jevSafeOf: noul の数だけ取る。形が違えば null（0 や 1 にしない）', () => {
  assert.equal(jevSafeOf({ answers: { safe: { type: 'noul', noul: 0.97 } } }, 'safe'), 0.97)
  assert.equal(jevSafeOf({ answers: { safe: { type: 'noul', noul: 0 } } }, 'safe'), 0)
  for (const bad of [null, {}, { answers: {} }, { answers: { safe: {} } }, { answers: { safe: { noul: '0.9' } } }, { answers: { safe: { noul: 1.5 } } }, { answers: { safe: { noul: NaN } } }]) {
    assert.equal(jevSafeOf(bad, 'safe'), null, JSON.stringify(bad))
  }
})

test('isJevAuto / jevAutoAllows: 0（しない）か 0.5〜1 だけ受け、閾値以上のときだけ自動で常に許可（#499）', () => {
  for (const ok of [0, JEV_AUTO_MIN, 0.8, 0.9, 1]) assert.equal(isJevAuto(ok), true, String(ok))
  for (const bad of [0.49, -0.1, 1.01, Number.NaN, '0.9', null, undefined, true]) assert.equal(isJevAuto(bad), false, String(bad))
  assert.equal(jevAutoAllows(0.97, 0.9), true)
  assert.equal(jevAutoAllows(0.9, 0.9), true, '閾値ちょうどは許可')
  assert.equal(jevAutoAllows(0.89, 0.9), false)
  assert.equal(jevAutoAllows(undefined, 0.9), false, 'まだ届いていない')
  assert.equal(jevAutoAllows(0.99, 0), false, '0 は「しない」')
})

test('jevAutoEligible / jevRuleState: 自動で常に許可するのは Claude の Bash だけ。ルールの文にはこの回の状態とルールが入る（#499）', () => {
  assert.equal(jevAutoEligible({ tool_name: 'Bash', agent: 'claude' }), true)
  assert.equal(jevAutoEligible({ tool_name: 'Bash' }), true, 'agent 省略は claude')
  assert.equal(jevAutoEligible({ tool_name: 'mcp__github__push_files' }), false, 'MCP ツールは引数を Jev に送らないので対象外')
  assert.equal(jevAutoEligible({ tool_name: 'Write' }), false)
  assert.equal(jevAutoEligible({ tool_name: 'Bash', agent: 'codex' }), false)
  assert.equal(jevAutoEligible({ tool_name: 'Bash', answerable: false }), false)
  assert.equal(jevPercent(0.974), 97)
  const approval: Approval = { approval_id: 'a', id: 'S@r', since: '', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: '', text: '' }
  const state = jevRuleState(approval, 'Bash(rm:*)')
  assert.match(state, /Command: rm -rf build/)
  assert.match(state, /every future command matching the rule: Bash\(rm:\*\)$/)
})

test('jevLowestRule（#705）: 部品ごとのルールのうち一番低いもの。1 つでも届いていなければ待つ', () => {
  assert.deepEqual(jevLowestRule([{ label: 'Bash(git status:*)', safe: 0.96 }, { label: 'Bash(rm:*)', safe: 0.1 }, { label: 'Bash(tee:*)', safe: 0.5 }]), { label: 'Bash(rm:*)', safe: 0.1 })
  assert.deepEqual(jevLowestRule([{ label: 'Bash(git status:*)', safe: 0.96 }]), { label: 'Bash(git status:*)', safe: 0.96 })
  assert.equal(jevLowestRule([{ label: 'Bash(git status:*)', safe: 0.96 }, { label: 'Bash(rm:*)', safe: undefined }]), undefined, '揃うまで待つ（高い方だけで判定しない）')
  assert.equal(jevLowestRule([]), undefined)
})

test('jevAutoDecision（#553）: この回が閾値未満は none、Bash 以外・ルールを作れない・ルールが低いは skip（理由つき）、ルール待ちは wait', () => {
  const bash = { tool_name: 'Bash', jev: 0.97 }
  assert.deepEqual(jevAutoDecision({ ...bash, jev: 0.5 }, 0.8, 'Bash(git status:*)', 0.9), { kind: 'none' }, '自動を期待する回ではない')
  assert.deepEqual(jevAutoDecision({ tool_name: 'Bash' }, 0.8, 'Bash(git status:*)', 0.9), { kind: 'none' }, '確率がまだ無い')
  assert.deepEqual(jevAutoDecision(bash, 0, 'Bash(git status:*)', 0.9), { kind: 'none' }, '自動が切')
  assert.deepEqual(jevAutoDecision({ tool_name: 'Edit', jev: 0.97 }, 0.8, null, undefined), { kind: 'skip', reason: 'Bash 以外（Edit）は自動で答えない' })
  assert.equal(jevAutoDecision({ ...bash, agent: 'codex' as const }, 0.8, null, undefined).kind, 'skip', 'Codex の許可には「常に許可」が無い')
  assert.equal(jevAutoDecision(bash, 0.8, null, undefined).kind, 'skip', 'ルールを作れない')
  assert.deepEqual(jevAutoDecision(bash, 0.8, 'Bash(git status:*)', undefined), { kind: 'wait' })
  assert.deepEqual(jevAutoDecision(bash, 0.8, 'Bash(git status:*)', 'failed'), { kind: 'skip', reason: 'ルール Bash(git status:*) の確率を Jev に聞けなかった' }, '失敗は聞き直さないので待ちのままにしない（#556 のレビュー）')
  assert.deepEqual(jevAutoDecision(bash, 0.8, 'Bash(git status:*)', 0.76), { kind: 'skip', reason: 'ルール Bash(git status:*) が 76%（閾値 80%）' })
  assert.deepEqual(jevAutoDecision(bash, 0.8, 'Bash(git status:*)', 0.8), { kind: 'allow' }, '閾値ちょうどは通す')
})

test('jevLogged（#749）: 記録に残す形。届いた確率は小数 3 桁、届いていなければ理由の種類。分からないものを 0 や 1 にしない', () => {
  assert.deepEqual(jevLogged({ safe: 0.971234 }), { jev: 0.971 })
  // 切り捨てる（丸めると、閾値に届いていなかったものが届いたように読める）
  assert.deepEqual(jevLogged({ safe: 0.8996 }), { jev: 0.899 })
  assert.deepEqual(jevLogged({ safe: 0.9996 }), { jev: 0.999 })
  assert.deepEqual(jevLogged({ safe: 0.9 }), { jev: 0.9 })
  assert.deepEqual(jevLogged({ safe: 0.97 }), { jev: 0.97 })
  assert.deepEqual(jevLogged({ safe: 0 }), { jev: 0 })
  assert.deepEqual(jevLogged({ safe: 1 }), { jev: 1 })
  assert.deepEqual(jevLogged(undefined), { jev_none: 'not_asked' })
  assert.deepEqual(jevLogged({}), { jev_none: 'pending' })
  assert.deepEqual(jevLogged({ failed: true }), { jev_none: 'failed' })
})

test('jevAutoDecision（#749）: ルールを作れない Bash は、この回が閾値以上で、読むだけと分かっているコマンドなら「今回だけ許可」。材料を渡さなければ今までどおり答えない', () => {
  const bash = (command: string, jev: number | undefined): Pick<Approval, 'tool_name' | 'agent' | 'answerable' | 'jev' | 'input'> => ({ tool_name: 'Bash', input: { command }, ...(jev === undefined ? {} : { jev }) })
  const once = { noRule: 'expansion' as const, cwd: '/work/repo' }
  const READ = 'echo "at $(git rev-parse HEAD)"'
  assert.deepEqual(jevAutoDecision(bash(READ, 0.95), 0.9, null, undefined, once), { kind: 'once' })
  assert.deepEqual(jevAutoDecision(bash(READ, 0.9), 0.9, null, undefined, once), { kind: 'once' }, '閾値ちょうどは通す（[常に許可] と同じ）')
  // 閾値未満・確率が無い（聞いていない・聞けなかった）は何もしない（人が見る）
  assert.deepEqual(jevAutoDecision(bash(READ, 0.89), 0.9, null, undefined, once), { kind: 'none' })
  assert.deepEqual(jevAutoDecision(bash(READ, undefined), 0.9, null, undefined, once), { kind: 'none' })
  assert.deepEqual(jevAutoDecision(bash(READ, 0.99), 0, null, undefined, once), { kind: 'none' }, '自動が切')
  // Bash 以外・Claude 以外・答えられない預かりには広げない
  assert.equal(jevAutoDecision({ tool_name: 'Edit', input: { file_path: '/x' }, jev: 0.99 }, 0.9, null, undefined, once).kind, 'skip')
  assert.equal(jevAutoDecision({ ...bash(READ, 0.99), agent: 'codex' }, 0.9, null, undefined, once).kind, 'skip')
  assert.equal(jevAutoDecision({ ...bash(READ, 0.99), answerable: false }, 0.9, null, undefined, once).kind, 'skip')
  // 読むだけと分かっていないものは、確率が高くても人に回す。理由の種類を残す（コマンドの文字は入れない）
  const reasonOf = (command: string, noRule: typeof once.noRule | 'covered' | 'cd_outside' | undefined = 'expansion') =>
    (jevAutoDecision(bash(command, 0.99), 0.9, null, undefined, { cwd: '/work/repo', noRule }) as { kind: string; reason?: string }).reason ?? ''
  assert.match(reasonOf('echo $(rm -rf zzsecret)'), /今回だけの自動の許可も見送り: 読むだけと分かっているコマンドでない/)
  assert.ok(!reasonOf('echo $(rm -rf zzsecret)').includes('zzsecret'))
  assert.match(reasonOf('git commit -m x # $(date)'), /読むだけと分かっているコマンドでない/)
  assert.match(reasonOf('N=$(date) && echo x'), /読める構文だけで書かれていない/)
  assert.match(reasonOf('cat .env | head -1 # $(date)'), /秘密が入っていそう/)
  assert.match(reasonOf('(cat /etc/hosts) # x'), /cwd の外か、読めない形/)
  assert.match(reasonOf('cd /tmp && ls', 'cd_outside'), /読むだけと分かっているコマンドでない/, 'cd は受けない')
  assert.match(reasonOf('git diff $(git merge-base HEAD main)'), /echo 以外に渡している/)
  // ルールがもう設定にあるのに聞かれている形・理由が分からないものは、中身に関係なく人に回す
  assert.match(reasonOf(READ, 'covered'), /ルールを作れない理由が covered/)
  assert.match((jevAutoDecision(bash(READ, 0.99), 0.9, null, undefined, { cwd: '/work/repo', noRule: undefined }) as { reason: string }).reason, /ルールを作れない理由が 分からない/)
  assert.equal(jevAutoDecision({ tool_name: 'Bash', input: {}, jev: 0.99 }, 0.9, null, undefined, once).kind, 'skip', 'コマンドが読めない')
  // ルールを作れなかった理由が何であっても、決めるのはコマンドそのもの
  assert.deepEqual(jevAutoDecision(bash('(git status; git log --oneline -3)', 0.95), 0.9, null, undefined, { cwd: '/work/repo', noRule: 'subshell' }), { kind: 'once' })
  // 材料を渡さなければ今までどおり
  assert.match((jevAutoDecision(bash(READ, 0.99), 0.9, null, undefined) as { reason: string }).reason, /ルールを作れないコマンド/)
  // ルールを作れる形は今までどおり（ルールの確率も見る。今回だけには回さない）
  assert.deepEqual(jevAutoDecision(bash('git status', 0.99), 0.9, 'Bash(git status:*)', 0.95, once), { kind: 'allow' })
  assert.equal(jevAutoDecision(bash('pnpm test', 0.99), 0.9, 'Bash(pnpm test:*)', 0.2, once).kind, 'skip', 'ルールが広いからといって「今回だけ」に落とさない')
  assert.deepEqual(jevAutoDecision(bash('git status', 0.99), 0.9, 'Bash(git status:*)', undefined, once), { kind: 'wait' })
})
