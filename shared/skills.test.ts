import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSkills, parseSkill, skillSummary, slashQuery, SKILL_DESC_MAX } from './skills.ts'

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
