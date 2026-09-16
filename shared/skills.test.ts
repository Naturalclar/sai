import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSkills, opencodeSkills, parseCodexSkills, parseSkill, skillSummary, slashQuery, SKILL_DESC_MAX } from './skills.ts'

const SKILL = `---
name: issue-triage
description: List the open GitHub issues and put them in order. Use when the user says "issueの優先度をつけて".
---

# issue-triage

本文は読まない。
`

test('parseSkill は frontmatter の name / description を取る。無ければ null、name が無ければディレクトリ名', () => {
  assert.deepEqual(parseSkill(SKILL, 'dir-name', 'user'), {
    name: 'issue-triage',
    description: 'List the open GitHub issues and put them in order. Use when the user says "issueの優先度をつけて".',
    source: 'user',
  })
  assert.equal(parseSkill('# 見出しだけ\n本文', 'x', 'user'), null, 'frontmatter が無い')
  assert.equal(parseSkill('---\nname: x\n本文（閉じていない）', 'x', 'user'), null, '閉じの --- が無い')
  assert.deepEqual(parseSkill('---\ndescription: 説明\n---\n', 'sync-main', 'project'), {
    name: 'sync-main',
    description: '説明',
    source: 'project',
  })
  assert.equal(parseSkill('---\nname: "quoted"\ndescription: \'単\'\n---\n', 'x', 'user')?.name, 'quoted', '囲みは外す')
  // 字下げした続きの行は前の値に繋ぐ
  assert.equal(parseSkill('---\nname: x\ndescription: 前半\n  後半\n---\n', 'x', 'user')?.description, '前半 後半')
})

test('slashQuery は入力欄の先頭の `/` だけ。空白が入ったら閉じる', () => {
  assert.deepEqual(slashQuery('/sync', 5), { start: 0, query: 'sync' })
  assert.deepEqual(slashQuery('/', 1), { start: 0, query: '' }, '打った直後は全部の候補')
  assert.deepEqual(slashQuery('/sync', 3), { start: 0, query: 'sy' }, 'カーソルまで')
  assert.equal(slashQuery('/sync-main を実行して', 18), null, '空白より後ろでは開かない')
  assert.equal(slashQuery('あとで /sync', 8), null, '文中の / では開かない')
  // パスを打っている途中は検索語として引く（当たりが無いので画面では開かない。ReplyBox の skillOpen）
  assert.deepEqual(slashQuery('/Users/me/foo を見て', 13), { start: 0, query: 'Users/me/foo' })
  assert.equal(slashQuery('/Users/me/foo を見て', 14), null, '空白が来たら閉じる')
  assert.equal(slashQuery('/x', 0), null, 'カーソルが / の前')
  assert.equal(slashQuery('', 0), null)
})

test('filterSkills は名前でも説明でも当たる', () => {
  const skills = [
    { name: 'issue-triage', description: 'issueの優先度をつけて', source: 'user' as const },
    { name: 'sync-main', description: 'main worktree を最新にする', source: 'project' as const },
  ]
  assert.deepEqual(filterSkills(skills, '').length, 2, '空なら全部')
  assert.deepEqual(filterSkills(skills, 'sync').map((s) => s.name), ['sync-main'])
  assert.deepEqual(filterSkills(skills, 'ISSUE').map((s) => s.name), ['issue-triage'], '大文字小文字は無視')
  assert.deepEqual(filterSkills(skills, '優先度').map((s) => s.name), ['issue-triage'], '説明の中の呼び出し文句で引ける')
  assert.deepEqual(filterSkills(skills, 'zzz'), [])
})

test('skillSummary は1行目を SKILL_DESC_MAX で切る', () => {
  assert.equal(skillSummary('  1行目  \n2行目'), '1行目')
  assert.equal(skillSummary(''), '')
  const long = 'あ'.repeat(SKILL_DESC_MAX + 10)
  assert.equal(skillSummary(long), 'あ'.repeat(SKILL_DESC_MAX) + '…')
})

// Codex の app-server（v0.154.0）の `skills/list` の応答そのままの形
const CODEX_LIST = {
  data: [
    {
      cwd: '/Users/me/work/sai',
      skills: [
        { name: 'probe-codex', description: 'cwd の .codex/skills', path: '/Users/me/work/sai/.codex/skills/probe-codex/SKILL.md', scope: 'repo', enabled: true, pluginId: null },
        { name: 'browser:control-in-app-browser', description: 'Control the in-app Browser', path: '/Users/me/.codex/plugins/cache/openai-bundled/browser/1/skills/control/SKILL.md', scope: 'user', enabled: true, pluginId: 'browser' },
        { name: 'imagegen', description: '画像を作る', path: '/imagegen/SKILL.md', scope: 'system', enabled: true, pluginId: null },
        { name: 'off-one', description: '切ってある', path: '/off/SKILL.md', scope: 'user', enabled: false, pluginId: null },
      ],
    },
  ],
}

test('parseCodexSkills は cwd に依らない分だけを候補にする', () => {
  assert.deepEqual(
    parseCodexSkills(CODEX_LIST).map((s) => [s.name, s.source]),
    [
      ['browser:control-in-app-browser', 'user'],
      ['imagegen', 'user'],
    ],
    'scope が repo のもの（app-server を起こした場所のリポジトリのスキル）と、切ってあるものは出さない',
  )
  assert.equal(parseCodexSkills(CODEX_LIST)[0]?.description, 'Control the in-app Browser')
})

test('parseCodexSkills は知らない形でも落ちない', () => {
  assert.deepEqual(parseCodexSkills(null), [])
  assert.deepEqual(parseCodexSkills({}), [])
  assert.deepEqual(parseCodexSkills({ data: {} }), [])
  assert.deepEqual(parseCodexSkills({ data: [null, 1, { skills: 'x' }] }), [])
  assert.deepEqual(parseCodexSkills({ data: [{ skills: [{ scope: 'user' }] }] }), [], '名前が無ければ出さない')
  assert.deepEqual(
    parseCodexSkills({ data: [{ skills: [{ name: 'a' }, { name: 'a', description: 'あとの方' }] }] }).map((s) => [s.name, s.description]),
    [['a', '']],
    '説明が無ければ空。同じ名前は先に出てきた方',
  )
})

// #393。OpenCode の `/command` は「`/` のあとに打てるもの」を 1 本で返す（スキルもコマンドも入っている）
test('opencodeSkills: スキルとコマンドを `/` の候補にする。コマンドだけ印を付ける', () => {
  const body = {
    data: [
      { name: 'demo-skill', description: 'プロジェクト側のスキル', source: 'skill', template: '本文', hints: [] },
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: ['$ARGUMENTS'] },
    ],
  }
  assert.deepEqual(opencodeSkills(body), [
    { name: 'demo-skill', description: 'プロジェクト側のスキル', source: 'user' },
    { name: 'init', description: 'guided AGENTS.md setup', source: 'command' },
  ])
  // 素の配列でも読む（版で包みが変わっても落ちないように）
  assert.deepEqual(opencodeSkills([{ name: 'x', source: 'skill' }]), [{ name: 'x', description: '', source: 'user' }])
})

test('opencodeSkills: 名前の無いもの・形の違う応答は落とす', () => {
  assert.deepEqual(opencodeSkills({ data: [{ description: '名前が無い' }, { name: '  ' }] }), [])
  assert.deepEqual(opencodeSkills(null), [])
  assert.deepEqual(opencodeSkills({ error: 'unauthorized' }), [])
})
