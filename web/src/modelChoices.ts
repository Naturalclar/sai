// 返信で使うモデルの候補と、入力欄に出すときの短い名前。
// 画面（ReplyModelPicker / ModelTag）から使う判定だけをここに置いて node:test で回す（sessionNav.ts と同じ形）。
import type { Agent } from '../../shared/types.ts'

/** Claude の `--model` が受ける別名。Codex には別名が無い */
export const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']

/** 入力欄に出す名前の長さ。これを超えたら切る（送信ボタンの左に置くので長いと折り返す） */
export const MODEL_LABEL_MAX = 14

/**
 * メニューの選択肢の名前（#282）。**名前は英語**で、隣の許可モード（`shared/permissions.ts` の `MODE_LABEL`。#271）と
 * 揃える。言い回しは Claude Code 自身のモデル選択（`Default (recommended)` / `Custom model`。2.1.266 で確認）。
 * 例外は名前だけで、何が起きるか（`CLI に任せる`）やモーダルの説明は日本語のまま。
 * 未設定のボタンが許可モードと同じ `Default` になるのは意図的（どちらも「CLI に任せる」で同じ意味）
 */
export const MODEL_DEFAULT_LABEL = 'Default'
export const MODEL_CUSTOM_LABEL = 'Custom model…'

/** `claude-opus-5` のような正式名から一族の名前を取る。別名（`opus`）はそのまま通る */
const CLAUDE_FAMILY = new RegExp(`^claude-(${CLAUDE_ALIASES.join('|')})(?:[-.].*)?$`)

/**
 * 候補の一覧。そのセッションで出てきたモデル → Claude の別名 → いまの値、の順で重複を除く。
 * Codex には別名を足さない（`-m` に渡すのは正式名だけ）
 */
export function modelChoices(agent: Agent, models: readonly string[], current: string): string[] {
  const aliases = agent === 'claude' ? CLAUDE_ALIASES : []
  return [...new Set([...models, ...aliases, ...(current ? [current] : [])])].filter(Boolean)
}

/**
 * 入力欄に出す短い名前。`claude-opus-5` → `opus`。
 * 一族が分からないものは MODEL_LABEL_MAX で切る（`qwen3:8b` のような短い名前はそのまま）。
 * **省略するのは見た目だけ**で、保存する値も候補の一覧も正式名のまま（`claude-opus-5` と別名の `opus` が
 * どちらも `opus` に見えてしまうため、メニューには正式名を出す）
 */
export function shortModel(model: string): string {
  const name = model.trim()
  const m = CLAUDE_FAMILY.exec(name)
  if (m) return m[1]!
  return name.length <= MODEL_LABEL_MAX ? name : `${name.slice(0, MODEL_LABEL_MAX - 1)}…`
}

/** 入力欄のボタン（閉じているとき）に出す名前。未設定（CLI の既定）なら `Default` */
export function modelButtonLabel(model: string): string {
  return shortModel(model) || MODEL_DEFAULT_LABEL
}
