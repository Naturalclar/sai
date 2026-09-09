// 返信の入力欄で `/` を打った時に出すスキルの候補。
// 置き場は `~/.claude/skills/<name>/SKILL.md`（ユーザー）と `<セッションの cwd>/.claude/skills/`（プロジェクト）で、
// 読み取りは `server/skills.ts`。ここは SKILL.md の頭の読み方と、`/` の検出・絞り込みだけ（fs も DOM も触らない）。
// 候補を選んでも SAI は本文を `/<name> ` にするだけで、展開は CLI に任せる（端末でも `-p` でも同じ）。

/** SKILL.md 1つ分。中身は読まない（一覧に出すのは名前と説明だけ） */
export interface Skill {
  name: string
  description: string
  /** project: セッションの cwd の `.claude/skills/`。user: `~/.claude/skills/` */
  source: 'user' | 'project'
}

/** 候補に出す説明の長さ。これを超えたら切る */
export const SKILL_DESC_MAX = 120

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  return v
}

/**
 * SKILL.md の頭の `---` で挟まれた部分を `キー: 値` として読む。YAML のごく一部だけ:
 * 1行の値、`"` / `'` の囲み、字下げした続きの行（前の値に空白で繋ぐ）。無ければ null
 */
function frontmatter(text: string): Record<string, string> | null {
  const body = text.replace(/^﻿/, '')
  if (!body.startsWith('---')) return null
  const head = body.indexOf('\n')
  if (head < 0) return null
  const end = body.indexOf('\n---', head)
  if (end < 0) return null
  const out: Record<string, string> = {}
  let key = ''
  for (const line of body.slice(head + 1, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/)
    if (m) {
      key = m[1] ?? ''
      out[key] = unquote(m[2] ?? '')
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key] ?? ''} ${line.trim()}`.trim()
    }
  }
  return out
}

/** SKILL.md 1つ分を読む。frontmatter が無ければ null。`name` が無ければディレクトリ名で代える */
export function parseSkill(text: string, fallbackName: string, source: Skill['source']): Skill | null {
  const fm = frontmatter(text)
  if (!fm) return null
  const name = fm.name || fallbackName
  if (!name) return null
  return { name, description: fm.description ?? '', source }
}

/**
 * 入力欄の `/`。**先頭にあるときだけ**（文中の `/` は開かない。パスを打つ場面があるので）。
 * `mentionQuery()` と同じ形で、開始位置と検索語を返す。空白が入ったらもう候補ではない
 */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  if (!text.startsWith('/') || caret < 1) return null
  const query = text.slice(1, caret)
  if (/\s/.test(query)) return null
  return { start: 0, query }
}

/** 名前と説明のどちらでも絞れる（説明には「issueの優先度をつけて」のような呼び出し文句が入っている） */
export function filterSkills(skills: Skill[], query: string): Skill[] {
  const q = query.toLowerCase()
  if (!q) return skills
  return skills.filter((s) => `${s.name}\n${s.description}`.toLowerCase().includes(q))
}

/** 候補に出す1行。説明の1行目を SKILL_DESC_MAX で切る */
export function skillSummary(description: string): string {
  const line = description.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length <= SKILL_DESC_MAX ? line : `${line.slice(0, SKILL_DESC_MAX)}…`
}
