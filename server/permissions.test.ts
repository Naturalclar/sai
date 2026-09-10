import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argsRules, collectPermissions, managedSettingsPath, orderRules, parseSettings, settingsPaths } from './permissions.ts'
import { isReplyPermissionMode, MODE_LABEL, modeSkipsRules, REPLY_MODES } from '../shared/permissions.ts'
import type { PermissionRuleEntry } from '../shared/types.ts'

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
  assert.deepEqual(REPLY_MODES, ['acceptEdits', 'bypassPermissions'])
  assert.equal(isReplyPermissionMode('acceptEdits'), true)
  assert.equal(isReplyPermissionMode('bypassPermissions'), true)
  // REPLY_MODES に無いものは通さない。`auto` は「安全性の確認つき」の中身が CLI 任せで説明できないので入れない
  for (const bad of ['auto', 'plan', 'dontAsk', 'default', '', 'XXX']) {
    assert.equal(isReplyPermissionMode(bad), false, `${bad} は選べない`)
  }
})

test('modeSkipsRules: 素通しだけ true。画面はこれで印を出す', () => {
  assert.equal(modeSkipsRules('bypassPermissions'), true)
  assert.equal(modeSkipsRules('auto'), true)
  assert.equal(modeSkipsRules('acceptEdits'), false, 'ファイル編集だけなら印は出さない')
  assert.equal(modeSkipsRules(''), false)
  // 選べるモードのうち印が要るものは bypassPermissions だけ、が画面の前提
  assert.deepEqual(REPLY_MODES.filter(modeSkipsRules), ['bypassPermissions'])
})

test('MODE_LABEL: 選べるモードには必ず日本語のラベルがある（select が空欄にならない）', () => {
  for (const m of REPLY_MODES) assert.notEqual(MODE_LABEL[m] ?? '', '', m)
})
