// Codex が許可の候補に入れてくる「規則の追加」（今後も聞かない）を、**覚えられる範囲をそのままボタンに書ける形**にする（#741）。
//
// app-server の `availableDecisions` には、今回だけの許可のほかに、押すと Codex の規則（セッションをまたいで残る許可）が足される候補が来る:
//   { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }      … その語の並びで始まるコマンド
//   { applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } }      … そのホストへの通信（allow / deny）
// 前は「同種のコマンドを許可」とだけ出していて、何が覚えられるかがボタンから読めなかった（実測では提案は「そのコマンドそのもの」だった）。
// **範囲が読めて、ボタンに書き切れるときだけ**文言を返す。読めない・長すぎるものは null（その候補はボタンにしない）。
// 範囲は**候補そのものの中身**から読む（押したときに Codex へ返すのがそれなので、別の欄の `proposedExecpolicyAmendment` は当てにしない）。
// 規則を書くのは Codex 自身で、SAI は `default.rules` を読まないし書かない。

/** ボタンに書く範囲の上限（文字）。超えるものは切らずに出さない（途中までの範囲を見せて押させない） */
export const AMENDMENT_RANGE_MAX = 80
/** 語の数の上限。これより多い並びは、1 行のボタンでは読めない */
export const AMENDMENT_WORDS_MAX = 12

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 制御文字・改行・囲みに使う記号（「」）が入っている語は、ボタンに書いても読めない */
const UNREADABLE = /[\p{Cc}\p{Cf}\u2028\u2029「」]/u

/** 語を見せる形にする。空白や引用符を含む語は "…" で囲む（語の切れ目が分かるように） */
function shown(word: string): string {
  return /[\s"'`\\]/.test(word) ? `"${word.replace(/(["\\])/g, '\\$1')}"` : word
}

/**
 * コマンドの規則の提案（語の並び）を、ボタンに書く範囲にする。書けなければ null:
 * 配列でない・空・語が文字でない・空の語がある・制御文字や改行が入っている・語が多すぎる・長すぎる
 */
export function execAmendmentRange(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AMENDMENT_WORDS_MAX) return null
  const words: string[] = []
  for (const word of raw) {
    if (typeof word !== 'string' || !word || UNREADABLE.test(word)) return null
    words.push(shown(word))
  }
  const range = words.join(' ')
  return [...range].length <= AMENDMENT_RANGE_MAX ? range : null
}

/** ホストの名前として読める形（`example.com`・`*.example.com`・`127.0.0.1:8080`・`[::1]:443`） */
const HOST = /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/

/** ネットワークの規則の提案を読む。ホストが名前として読めない・`action` が allow / deny でない・長すぎるなら null */
export function networkAmendmentRange(raw: unknown): { host: string; action: 'allow' | 'deny' } | null {
  if (!isObject(raw)) return null
  const { host, action } = raw
  if (typeof host !== 'string' || !HOST.test(host) || [...host].length > AMENDMENT_RANGE_MAX) return null
  return action === 'allow' || action === 'deny' ? { host, action } : null
}

export interface AmendmentLabel {
  label: string
  behavior: 'allow' | 'deny'
}

/**
 * 候補 1 つ（`availableDecisions` の要素）が規則の追加なら、ボタンの文言を返す。
 * - 規則の追加でない候補（`accept` など）は `undefined`（呼ぶ側が今までどおり名前で出す）
 * - 規則の追加だが範囲が書けないものは `null`（**ボタンにしない**）
 */
export function amendmentLabel(decision: unknown): AmendmentLabel | null | undefined {
  // 中身の無い名前だけの候補（`"acceptWithExecpolicyAmendment"`）は、何が覚えられるか分からないので出さない
  if (decision === 'acceptWithExecpolicyAmendment' || decision === 'applyNetworkPolicyAmendment') return null
  if (!isObject(decision)) return undefined
  if ('acceptWithExecpolicyAmendment' in decision) {
    const body = decision.acceptWithExecpolicyAmendment
    const range = execAmendmentRange(isObject(body) ? body.execpolicy_amendment : undefined)
    return range === null ? null : { label: `「${range}」で始まるコマンドを今後聞かない`, behavior: 'allow' }
  }
  if ('applyNetworkPolicyAmendment' in decision) {
    const body = decision.applyNetworkPolicyAmendment
    const rule = networkAmendmentRange(isObject(body) ? body.network_policy_amendment : undefined)
    if (!rule) return null
    return rule.action === 'allow' ? { label: `「${rule.host}」への通信を今後聞かない`, behavior: 'allow' } : { label: `「${rule.host}」への通信を今後も断る`, behavior: 'deny' }
  }
  return undefined
}
