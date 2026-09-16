// 返信の入力欄で `/` を打った時に出すスキルの候補。
// Claude の置き場は `~/.claude/skills/<name>/SKILL.md`（ユーザー）と `<セッションの cwd>/.claude/skills/`（プロジェクト）、
// Codex は `<cwd>/.codex/skills/` と `<cwd>/.agents/skills/`（リポジトリ）＋ app-server の `skills/list`（ユーザー・プラグイン・組み込み）。
// 読み取りは `server/local/skills.ts` と `server/reply/codexAppServer.ts`。
// ここは SKILL.md の頭の読み方と、app-server の応答の読み方、`/` の検出・絞り込みだけ（fs も DOM も触らない）。
// 候補を選んでも SAI は本文を `/<name> ` にするだけで、展開は CLI に任せる（端末でも `-p` でも同じ。Codex の app-server でも
// `input: [{ type: 'text', text: '/<name>' }]` で実際にスキルが動くことを v0.154.0 で確かめた）。

/** SKILL.md 1つ分。中身は読まない（一覧に出すのは名前と説明だけ） */
export interface Skill {
  name: string
  description: string
  /**
   * project: セッションの cwd の置き場（Claude は `.claude/skills/`、Codex は `.codex/skills/` と `.agents/skills/`）。
   * user: cwd に依らないもの（Claude は `~/.claude/skills/`、Codex は app-server の `scope` が `user` / `system` のもの、OpenCode は本体が返すスキル）。
   * command: OpenCode のスラッシュコマンド（#393。スキルと同じ `/` のメニューに並ぶので印で見分ける）
   */
  source: 'user' | 'project' | 'command'
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
 * Codex の app-server の `skills/list` の応答（`{ data: [{ cwd, skills: [...] }] }`）を候補にする。
 *
 * **`scope` が `repo` のものは落とす**。SAI の app-server は**サーバの cwd**で長く生きている 1 本なので、
 * そこから返るリポジトリのスキルは「そのセッションの cwd」のものではない（セッション側の分は
 * `server/local/skills.ts` が cwd から直接読む）。`user`（`$CODEX_HOME/skills/` とプラグイン）と
 * `system`（組み込み）は cwd に依らないので、どのセッションにもそのまま出してよい。
 * 切ってあるもの（`enabled: false`）も出さない。名前が重なったら先に出てきた方を採る。
 */
export function parseCodexSkills(result: unknown): Skill[] {
  const data = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: Skill[] = []
  const seen = new Set<string>()
  for (const group of data) {
    const skills = (group as { skills?: unknown } | null)?.skills
    if (!Array.isArray(skills)) continue
    for (const raw of skills) {
      const skill = raw as { name?: unknown; description?: unknown; scope?: unknown; enabled?: unknown } | null
      const name = typeof skill?.name === 'string' ? skill.name : ''
      if (!name || seen.has(name)) continue
      if (skill?.scope === 'repo') continue
      if (skill?.enabled === false) continue
      seen.add(name)
      out.push({ name, description: typeof skill?.description === 'string' ? skill.description : '', source: 'user' })
    }
  }
  return out
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
/**
 * OpenCode の `GET /command?directory=<cwd>` の応答を `/` の候補にする（#393）。
 *
 * **この 1 本だけで足りる**（1.18.30 で確認）: 返ってくるのは「`/` のあとに打てるもの」全部で、
 * スキル（`source: "skill"`）とスラッシュコマンド（`source: "command"`）が同じ一覧に入っている。
 * `/skill` と混ぜると同じものが 2 回出る（手元では 15 件 = スキル 13 + コマンド 2 で、13 は `/skill` と同じ顔ぶれ）。
 *
 * **プロジェクト側かどうかは応答から分からない**ので、スキルは `user` に寄せて印を付けない
 * （Claude 側の `project` の印は「このリポジトリのもの」という意味なので、嘘をつくより出さない）
 */
export function opencodeSkills(data: unknown): Skill[] {
  const items = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown })?.data) ? (data as { data: unknown[] }).data : []
  const out: Skill[] = []
  for (const raw of items) {
    const item = raw as { name?: unknown; description?: unknown; source?: unknown }
    if (typeof item.name !== 'string' || !item.name.trim()) continue
    out.push({
      name: item.name.trim(),
      description: typeof item.description === 'string' ? item.description : '',
      source: item.source === 'command' ? 'command' : 'user',
    })
  }
  return out
}

export function skillSummary(description: string): string {
  const line = description.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length <= SKILL_DESC_MAX ? line : `${line.slice(0, SKILL_DESC_MAX)}…`
}
