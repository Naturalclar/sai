// Codex が許可の候補に入れてくる「規則の追加」（今後も聞かない）を、**覚えられる範囲をそのままボタンに書ける形**にする（#741）。
//
// app-server の `availableDecisions` には、今回だけの許可のほかに、押すと Codex の規則（セッションをまたいで残る許可）が足される候補が来る:
//   { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }      … その語の並びのコマンド
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

/**
 * ボタンに書いても、見た目と中身が食い違う文字: 制御・書式・未割り当て（`\p{C}`）、結合文字（`\p{M}`）、半角空白以外の空白と行の区切り（`\p{Z}`）、
 * 何も描かれない字（ハングルの埋め草・点字の空白）、範囲の囲みに見える括弧（「」『』｢｣）。
 * 囲みが途中で閉じたように見える・1 語が 2 語に見える、を防ぐ（#742 のレビュー）
 */
const UNREADABLE = /[\p{C}\p{M}「」『』｢｣\u3164\u2800\u115F\u1160\uFFA0]|(?! )\p{Z}/u

/** 語を見せる形にする。空白や引用符を含む語は "…" で囲む（語の切れ目が分かるように） */
function shown(word: string): string {
  return /[\s"'`\\]/.test(word) ? `"${word.replace(/(["\\])/g, '\\$1')}"` : word
}

/**
 * コマンドの規則の提案（語の並び）を、ボタンに書く範囲にする。書けなければ null:
 * 配列でない・空・語が文字でない・空の語がある・見た目と中身が食い違う文字（`UNREADABLE`）が入っている・語が多すぎる・長すぎる
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

/**
 * ホストとして書ける字だけ（英数字・`.`・`-`・`_`・`*`・`:`・`[` `]`）で、英数字を 1 つは含む。
 * `my_service.internal`・`example.com.`・`::1`・`[::1]:443`・`*.example.com` を通す。空白・スキーム・パスは通さない
 */
const HOST = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._*:[\]-]+$/

/** ネットワークの規則の提案を読む。ホストが名前として読めない・`action` が allow / deny でない・長すぎるなら null */
export function networkAmendmentRange(raw: unknown): { host: string; action: 'allow' | 'deny' } | null {
  if (!isObject(raw)) return null
  const { host, action } = raw
  // 長さを先に見る（長い文字列に正規表現を当てない）
  if (typeof host !== 'string' || host.length > AMENDMENT_RANGE_MAX || !HOST.test(host)) return null
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
  const exec = 'acceptWithExecpolicyAmendment' in decision
  const network = 'applyNetworkPolicyAmendment' in decision
  if (!exec && !network) return undefined
  // 押すと**候補の中身がまるごと** Codex に返る。ボタンに書いた範囲のほかに何か載っていたら、見せていないものまで通すことになるので出さない
  // （候補の鍵は 1 つ・中身の欄も 1 つ。#742 のレビュー）
  if (Object.keys(decision).length !== 1) return null
  if (exec) {
    const body = decision.acceptWithExecpolicyAmendment
    if (!isObject(body) || Object.keys(body).length !== 1) return null
    const range = execAmendmentRange(body.execpolicy_amendment)
    // 「で始まる」とは書かない: 規則がどう照合されるか（前方一致か）は、押して確かめていない
    return range === null ? null : { label: `「${range}」を今後聞かない`, behavior: 'allow' }
  }
  const body = decision.applyNetworkPolicyAmendment
  if (!isObject(body) || Object.keys(body).length !== 1) return null
  const ruleRaw = body.network_policy_amendment
  if (!isObject(ruleRaw) || Object.keys(ruleRaw).length !== 2) return null
  const rule = networkAmendmentRange(ruleRaw)
  if (!rule) return null
  return rule.action === 'allow' ? { label: `「${rule.host}」への通信を今後聞かない`, behavior: 'allow' } : { label: `「${rule.host}」への通信を今後も断る`, behavior: 'deny' }
}
