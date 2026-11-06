import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argsRules, collectPermissions, guardRules, otherManagedSettings, MAX_SETTINGS_BYTES, readSettingsStrict, managedSettingsPath, orderRules, parseSettings, settingsPaths } from './permissions.ts'
import { defaultModeHint, isReplyPermissionMode, launchedModeNote, MODE_HINT, MODE_LABEL, modeEmphasis, modeLabel, modeName, modeSkipsRules, REPLY_MODES, replyModeOf, shortReplyMode, skipModeInArgs } from '../../shared/permissions.ts'

test('MODE_HINT / modeLabel: 何が起きるかは日本語で添え、タグ・モーダル用は「名前 — 説明」（#271）', () => {
  // 名前を英語にしても、説明が消えてはいけない（メニューの補足と見出しのタグが空になる）
  for (const m of Object.keys(MODE_LABEL) as (keyof typeof MODE_LABEL)[]) assert.notEqual(MODE_HINT[m] ?? '', '', m)
  assert.equal(modeLabel('acceptEdits'), 'Accept edits — ファイル編集は聞かない')
  assert.equal(modeLabel('bypassPermissions'), 'Bypass permissions — 許可の確認をしない')
  assert.equal(modeLabel('しらない値'), 'しらない値', '知らない値はそのまま出す（説明を付けない）')
})
import type { PermissionRuleEntry } from '../../shared/types.ts'

test('settingsPaths: cwd と home から固定で組み立てる（強い順）', () => {
  const paths = settingsPaths('/w/repo', '/home/me', 'darwin')
  assert.deepEqual(paths, [
    { kind: 'managed', path: '/Library/Application Support/ClaudeCode/managed-settings.json' },
    { kind: 'local', path: '/w/repo/.claude/settings.local.json' },
    { kind: 'project', path: '/w/repo/.claude/settings.json' },
    { kind: 'user', path: '/home/me/.claude/settings.json' },
  ])
  assert.equal(managedSettingsPath('linux'), '/etc/claude-code/managed-settings.json')
  assert.match(managedSettingsPath('win32'), /^C:\\Program Files\\ClaudeCode\\/)
})

test('parseSettings: allow / deny / ask と defaultMode を取る。無い・壊れている・permissions が無いは空', () => {
  const ok = parseSettings(
    'local',
    '/w/.claude/settings.local.json',
    JSON.stringify({ permissions: { allow: ['Bash(gh api:*)', ''], deny: ['Read(./.env)'], ask: ['Bash(rm:*)'], defaultMode: 'plan' }, model: 'opus' }),
  )
  assert.deepEqual(ok.source, { kind: 'local', path: '/w/.claude/settings.local.json', default_mode: 'plan' })
  assert.deepEqual(
    ok.rules.map((r) => `${r.kind}:${r.rule}`),
    ['deny:Read(./.env)', 'ask:Bash(rm:*)', 'allow:Bash(gh api:*)'],
    '空文字は落とす。並びは deny → ask → allow',
  )
  assert.ok(ok.rules.every((r) => r.source === 'local'))

  assert.deepEqual(parseSettings('user', '/p', null).source, { kind: 'user', path: '/p', missing: true })
  assert.deepEqual(parseSettings('user', '/p', '{ broken').source, { kind: 'user', path: '/p', broken: true })
  assert.deepEqual(parseSettings('project', '/p', '{"hooks":{}}'), { source: { kind: 'project', path: '/p' }, rules: [] })
  // 配列でない・文字列でない値が混ざっていても落ちない
  const junk = parseSettings('project', '/p', JSON.stringify({ permissions: { allow: 'Bash(ls)', deny: [1, 'Read(x)', null] } }))
  assert.deepEqual(junk.rules.map((r) => r.rule), ['Read(x)'])
})

test('argsRules: SAI_CLAUDE_ARGS の --allowedTools / --disallowedTools を可変長で拾う', () => {
  assert.deepEqual(argsRules(undefined).source, { kind: 'sai_args', path: 'SAI_CLAUDE_ARGS', missing: true })
  assert.deepEqual(argsRules('   ').source.missing, true)
  const r = argsRules('--allowedTools "Bash(gh *)" "Read(**)" --disallowedTools "Bash(rm *)" --model opus')
  assert.deepEqual(
    r.rules.map((x) => `${x.kind}:${x.rule}`),
    ['allow:Bash(gh *)', 'allow:Read(**)', 'deny:Bash(rm *)'],
    '次のフラグ（- 始まり）で止まるので --model の値は拾わない',
  )
  assert.ok(r.rules.every((x) => x.source === 'sai_args'))
  assert.deepEqual(argsRules('--verbose').rules, [], '許可に関係ない引数だけなら空')
})

test('orderRules: deny → ask → allow、同じ種類なら強い出どころから、同じなら名前順', () => {
  const rules: PermissionRuleEntry[] = [
    { kind: 'allow', rule: 'Bash(b)', source: 'user' },
    { kind: 'allow', rule: 'Bash(a)', source: 'user' },
    { kind: 'allow', rule: 'Bash(z)', source: 'local' },
    { kind: 'deny', rule: 'Read(x)', source: 'user' },
    { kind: 'ask', rule: 'Bash(rm)', source: 'project' },
    { kind: 'deny', rule: 'Read(a)', source: 'managed' },
  ]
  assert.deepEqual(
    orderRules(rules).map((r) => `${r.kind}/${r.source}/${r.rule}`),
    ['deny/managed/Read(a)', 'deny/user/Read(x)', 'ask/project/Bash(rm)', 'allow/local/Bash(z)', 'allow/user/Bash(a)', 'allow/user/Bash(b)'],
  )
})

test('collectPermissions: 4 か所 + SAI_CLAUDE_ARGS を読み、読んだ先は無かったものも返す', async () => {
  const files: Record<string, string> = {
    '/w/repo/.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(gh api:*)'] } }),
    '/home/me/.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }),
  }
  const { sources, rules } = await collectPermissions('/w/repo', {
    home: '/home/me',
    platform: 'linux',
    env: { SAI_CLAUDE_ARGS: '--allowedTools "Bash(pnpm *)"' },
    read: async (path) => files[path] ?? null,
  })
  assert.deepEqual(sources.map((s) => s.kind), ['managed', 'local', 'project', 'user', 'sai_args'], '無かった先も出す（どこを直すか分かるように）')
  assert.deepEqual(sources.filter((s) => s.missing).map((s) => s.kind), ['managed', 'project'])
  assert.deepEqual(
    rules.map((r) => `${r.kind}/${r.source}/${r.rule}`),
    ['deny/user/Read(./.env)', 'allow/local/Bash(gh api:*)', 'allow/sai_args/Bash(pnpm *)'],
    'deny はユーザー設定のものでも allow より先',
  )
})

test('collectPermissions: 設定が 1 つも無い cwd でも空で返る（落ちない）', async () => {
  const { sources, rules } = await collectPermissions('/nowhere', { home: '/home/me', platform: 'linux', env: {}, read: async () => null })
  assert.deepEqual(rules, [])
  assert.ok(sources.every((s) => s.missing))
})

// ---- #253: 素通し（bypassPermissions）を画面から選べるようにした

test('REPLY_MODES: 画面の select とサーバの検査が同じ一覧を見る', () => {
  // 並ぶ順がそのまま select の順。素通しは「聞かない方が強い」ので後ろ
  assert.deepEqual(REPLY_MODES, ['acceptEdits', 'auto', 'bypassPermissions'])
  for (const ok of REPLY_MODES) assert.equal(isReplyPermissionMode(ok), true)
  // REPLY_MODES に無いものは通さない
  for (const bad of ['plan', 'dontAsk', 'manual', 'default', '', 'XXX']) {
    assert.equal(isReplyPermissionMode(bad), false, `${bad} は選べない`)
  }
})

test('modeSkipsRules: 素通しだけ true。画面はこれで印を出す', () => {
  assert.equal(modeSkipsRules('bypassPermissions'), true)
  assert.equal(modeSkipsRules('auto'), true)
  assert.equal(modeSkipsRules('acceptEdits'), false, 'ファイル編集だけなら印は出さない')
  assert.equal(modeSkipsRules(''), false)
  assert.deepEqual(REPLY_MODES.filter(modeSkipsRules), ['auto', 'bypassPermissions'])
})

test('modeEmphasis: 素通しは赤（loud）、Auto mode は 1 段弱い色（caution）。目立たせるかは modeSkipsRules と揃う（#691）', () => {
  assert.equal(modeEmphasis('bypassPermissions'), 'loud')
  assert.equal(modeEmphasis('auto'), 'caution')
  for (const mode of ['', 'default', 'acceptEdits', 'plan', 'dontAsk', 'XXX']) assert.equal(modeEmphasis(mode), '', mode)
  for (const mode of ['', 'default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']) assert.equal(modeEmphasis(mode) !== '', modeSkipsRules(mode), mode)
})

test('skipModeInArgs: 運用者の引数の中の、ルールに関係なく通るモード（2 語・1 語・--dangerously-skip-permissions）', () => {
  assert.equal(skipModeInArgs(['--permission-mode', 'bypassPermissions']), 'bypassPermissions')
  assert.equal(skipModeInArgs(['--permission-mode=auto']), 'auto')
  assert.equal(skipModeInArgs(['--model', 'x', '--permission-mode', 'auto']), 'auto')
  assert.equal(skipModeInArgs(['--dangerously-skip-permissions']), 'bypassPermissions')
  assert.equal(skipModeInArgs(['--permission-mode', 'acceptEdits']), '')
  assert.equal(skipModeInArgs(['--allowedTools', 'Bash(auto *)']), '', '値に auto を含むだけの別の引数では当てない')
  assert.equal(skipModeInArgs(['--permission-mode']), '')
  // --settings に JSON で渡した既定のモードも見る（#697 のレビュー。前は引数のどこかに名前があれば当てていた）
  assert.equal(skipModeInArgs(['--settings', '{"permissions":{"defaultMode":"bypassPermissions"}}']), 'bypassPermissions')
  assert.equal(skipModeInArgs(['--settings={"permissions": {"defaultMode" : "auto"}}']), 'auto')
  assert.equal(skipModeInArgs(['--settings', '{"permissions":{"defaultMode":"acceptEdits"}}']), '')
  assert.equal(modeName('auto'), 'Auto mode')
  assert.equal(modeName('bypassPermissions'), 'Bypass permissions')
})

test('MODE_LABEL: 選べるモードには必ずラベルがある（メニューが空欄にならない）', () => {
  for (const m of REPLY_MODES) assert.notEqual(MODE_LABEL[m] ?? '', '', m)
})

test('MODE_LABEL: 名前は Claude Code の端末表示（Shift+Tab）と同じ言い回しの英語（#271）', () => {
  assert.equal(MODE_LABEL.acceptEdits, 'Accept edits')
  assert.equal(MODE_LABEL.bypassPermissions, 'Bypass permissions')
  assert.equal(MODE_LABEL.plan, 'Plan mode')
  assert.equal(MODE_LABEL.auto, 'Auto mode')
  // 名前に日本語を混ぜない（何が起きるかの説明は MODE_HINT に分けてある）
  for (const [m, name] of Object.entries(MODE_LABEL)) assert.doesNotMatch(name, /[぀-ヿ一-龯]/, m)
})

test('shortReplyMode: 入力欄のボタンに出す短い名前。空は「既定」と同じ扱い（#265 / #271）', () => {
  assert.equal(shortReplyMode(''), 'Default', '設定していない = CLI の既定')
  assert.equal(shortReplyMode('default'), 'Default')
  assert.equal(shortReplyMode('acceptEdits'), 'Accept edits')
  assert.equal(shortReplyMode('bypassPermissions'), 'Bypass')
  // 返信で選べる値には全部短い名前がある（増やしたらここで止まる）
  for (const m of REPLY_MODES) assert.notEqual(shortReplyMode(m), m, m)
  assert.equal(shortReplyMode('しらない値'), 'しらない値', '知らない値はそのまま出す')
})

test('replyModeOf / defaultModeHint（#582）: セッションで選んだものが勝ち、無いときだけ設定の既定。どちらも無ければ空', () => {
  assert.equal(replyModeOf('bypassPermissions', 'acceptEdits'), 'bypassPermissions')
  assert.equal(replyModeOf('acceptEdits', 'bypassPermissions'), 'acceptEdits', '既定のほうが強くても、選んだものが勝つ')
  assert.equal(replyModeOf(undefined, 'acceptEdits'), 'acceptEdits')
  assert.equal(replyModeOf('', 'auto'), 'auto')
  assert.equal(replyModeOf(undefined, ''), '')
  assert.equal(replyModeOf(undefined, undefined), '')
  // 既定が素通しなら、何も選んでいないセッションも「ルールに関係なく通る」として扱われる（ループ・tailnet の断り）
  assert.equal(modeSkipsRules(replyModeOf(undefined, 'bypassPermissions')), true)
  assert.equal(modeSkipsRules(replyModeOf('acceptEdits', 'bypassPermissions')), false)
  // 既定で動いたターンは、いまの設定と同じなので「次の返信から」を出さない
  assert.equal(launchedModeNote({ since: '', text: '', permission_mode: 'acceptEdits' }, replyModeOf(undefined, 'acceptEdits')), '')
  assert.equal(defaultModeHint('acceptEdits'), '設定の既定に従う（Accept edits）')
  assert.equal(defaultModeHint(''), `CLI に任せる（${MODE_HINT.default}）`)
  assert.equal(defaultModeHint(undefined), `CLI に任せる（${MODE_HINT.default}）`)
})

test('launchedModeNote: 処理中のターンが今の設定と違うモードで動いているときだけ出す（#272）', () => {
  const running = { since: '2026-09-10T06:11:35.000Z', text: 'x' }
  // Auto mode（#691）でも同じに出る
  assert.equal(launchedModeNote({ ...running, permission_mode: 'acceptEdits' }, 'auto'), 'このターンは「Accept edits」で動いています。「Auto mode」は次の返信から効きます')
  assert.equal(launchedModeNote({ ...running, permission_mode: 'auto' }, 'auto'), '')
  // 実際に起きた形: acceptEdits で起動したターンの途中で素通しに変えた。
  // モードの名前は MODE_LABEL の英語（#271。端末の Shift+Tab と同じ言い回し。ボタンと違って幅の制約が無いので短くしない）
  assert.equal(
    launchedModeNote({ ...running, permission_mode: 'acceptEdits' }, 'bypassPermissions'),
    'このターンは「Accept edits」で動いています。「Bypass permissions」は次の返信から効きます',
  )
  assert.equal(
    launchedModeNote({ ...running, permission_mode: '' }, 'bypassPermissions'),
    'このターンは「Default」で動いています。「Bypass permissions」は次の返信から効きます',
    'フラグ無しで起動した = 既定',
  )
  assert.equal(
    launchedModeNote({ ...running, permission_mode: 'bypassPermissions' }, undefined),
    'このターンは「Bypass permissions」で動いています。「Default」は次の返信から効きます',
    '素通しから戻したときも、戻ったのは次の返信から',
  )

  // 同じなら出さない。空と default は同じ扱い
  assert.equal(launchedModeNote({ ...running, permission_mode: 'bypassPermissions' }, 'bypassPermissions'), '')
  assert.equal(launchedModeNote({ ...running, permission_mode: '' }, undefined), '')
  assert.equal(launchedModeNote({ ...running, permission_mode: 'default' }, ''), '')

  // 材料が無い・もう動いていないときは出さない
  assert.equal(launchedModeNote(undefined, 'bypassPermissions'), '', '処理中でない')
  assert.equal(launchedModeNote(running, 'bypassPermissions'), '', '起動したときのモードが分からない（Codex・古い replying.json）')
  assert.equal(launchedModeNote({ ...running, via: 'terminal', permission_mode: '' }, 'bypassPermissions'), '', '端末に打ち込んだ返信にはそもそもフラグが効かない')
  assert.equal(
    launchedModeNote({ ...running, permission_mode: 'acceptEdits', failed: { code: 1, tail: '' } }, 'bypassPermissions'),
    '',
    '失敗して残っているだけ（もう動いていない）',
  )
})

test('guardRules（#863）: ask / deny だけを返す。CLAUDE_CONFIG_DIR の下も読む。壊れた設定・別の設定を足す引数は null', async () => {
  const files: Record<string, string> = {
    '/w/repo/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], ask: ['Bash(git log:*)'] } }),
    '/home/me/.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }),
    '/cfg/settings.json': JSON.stringify({ permissions: { ask: ['Bash(gh:*)'] } }),
  }
  const read = async (path: string) => files[path] ?? null
  const base = { home: '/home/me', platform: 'linux' as const, read, otherManaged: async () => false }
  assert.deepEqual((await guardRules('/w/repo', { ...base, env: {} }))?.sort(), ['Bash(git log:*)', 'Bash(rm:*)'])
  assert.deepEqual((await guardRules('/w/repo', { ...base, env: { CLAUDE_CONFIG_DIR: '/cfg' } }))?.sort(), ['Bash(gh:*)', 'Bash(git log:*)', 'Bash(rm:*)'])
  assert.deepEqual((await guardRules('/w/repo', { ...base, env: { SAI_CLAUDE_ARGS: '--disallowedTools Bash(curl:*)' } }))?.sort(), ['Bash(curl:*)', 'Bash(git log:*)', 'Bash(rm:*)'], '運用者の引数の deny も')
  for (const args of ['--settings x.json', '--settings=x.json', '--setting-sources user', '--disallowedTools=Bash(git:*)', '--disallowed-tools Bash(git:*)', '--allowed-tools Bash(ls)']) assert.equal(await guardRules('/w/repo', { ...base, env: { SAI_CLAUDE_ARGS: args } }), null, args)
  assert.equal(await guardRules('/w/repo', { ...base, env: {}, read: async (path) => (path === '/w/repo/.claude/settings.local.json' ? '{' : read(path)) }), null, '壊れた設定')
  assert.equal(await guardRules('/w/repo', { ...base, env: { CLAUDE_CONFIG_DIR: '/cfg' }, read: async (path) => (path === '/cfg/settings.json' ? '{' : read(path)) }), null)
  // トップの .claude の止める側も足す（cwd がトップより下のとき）。managed のほかの配り方があれば分からない
  files['/w/.claude/settings.json'] = JSON.stringify({ permissions: { allow: ['Bash(cat:*)'], deny: ['Bash(curl:*)'] } })
  assert.deepEqual((await guardRules('/w/repo', { ...base, env: {}, top: '/w' }))?.sort(), ['Bash(curl:*)', 'Bash(git log:*)', 'Bash(rm:*)'])
  assert.deepEqual((await guardRules('/w/repo', { ...base, env: {}, top: '/w/repo' }))?.sort(), ['Bash(git log:*)', 'Bash(rm:*)'])
  files['/w/.claude/settings.local.json'] = '{'
  assert.equal(await guardRules('/w/repo', { ...base, env: {}, top: '/w' }), null, 'トップの壊れた設定')
  assert.equal(await guardRules('/w/repo', { ...base, env: {}, otherManaged: async () => true }), null)
  assert.equal(await guardRules('/w/repo', { ...base, env: {}, read: async (path) => { if (path === '/home/me/.claude/settings.json') throw new Error('EACCES'); return read(path) } }), null, '読めない')
})

test('readSettingsStrict（#863）: 無いときだけ null。大きすぎる・ディレクトリは投げる', async () => {
  const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'sai-strict-'))
  try {
    assert.equal(await readSettingsStrict(join(dir, 'none.json')), null)
    assert.equal(await readSettingsStrict(join(dir, 'none', 'deeper.json')), null)
    await writeFile(join(dir, 'ok.json'), '{}')
    assert.equal(await readSettingsStrict(join(dir, 'ok.json')), '{}')
    await writeFile(join(dir, 'big.json'), ' '.repeat(MAX_SETTINGS_BYTES + 1))
    await assert.rejects(readSettingsStrict(join(dir, 'big.json')))
    await mkdir(join(dir, 'adir.json'))
    await assert.rejects(readSettingsStrict(join(dir, 'adir.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('otherManagedSettings（#863）: managed の置き場に 1 つのファイルのほかがある・MDM の plist に claude の名前があれば true', async () => {
  const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'sai-managed-'))
  try {
    const managed = join(dir, 'ClaudeCode')
    const mdm = join(dir, 'Managed Preferences')
    const at = { file: join(managed, 'managed-settings.json'), mdm }
    assert.equal(await otherManagedSettings('darwin', at), false, 'どちらも無い')
    await mkdir(managed)
    await writeFile(at.file, '{}')
    await mkdir(mdm)
    await writeFile(join(mdm, 'com.example.other.plist'), '')
    assert.equal(await otherManagedSettings('darwin', at), false, 'ファイル 1 つだけ・ほかの plist')
    await mkdir(join(mdm, 'someone'))
    await writeFile(join(mdm, 'someone', 'com.anthropic.claudecode.plist'), '')
    assert.equal(await otherManagedSettings('darwin', at), true, '利用者ごとの plist')
    assert.equal(await otherManagedSettings('linux', at), false, 'macOS 以外は plist を見ない')
    await mkdir(join(managed, 'managed-settings.d'))
    assert.equal(await otherManagedSettings('linux', at), true, 'drop-in の置き場')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
