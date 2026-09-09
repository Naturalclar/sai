// Python の `json.dumps(obj, ensure_ascii=False, sort_keys=True)` と**同じ文字列**を作る（#147）。
//
// 許可待ちの文言は `feed/record.py` の `waiting_text()` と `shared/approvals.ts` の `approvalText()` の
// 2 か所で作られ、専用の要約が無いツール（MCP のツール、未知のツール）では `tool_input` を
// そのまま JSON にする。そこで `JSON.stringify` を使うと Python と 2 つの点で食い違う:
//
//   record.py     {"body": "本文", "title": "題"}    区切りに空白あり、キーはソート
//   JSON.stringify {"title":"題","body":"本文"}      区切りに空白なし、キーは挿入順
//
// **文字列そのものの書き方（エスケープ）は両者で同じ**なので、値の変換は `JSON.stringify` に任せ、
// 入れ物（オブジェクトと配列）だけを Python の書き方で組み立てる。

/**
 * Python の文字列比較はコードポイント順、JS の `<` は UTF-16 の符号単位順。
 * BMP 外の文字（絵文字など）は符号単位だとサロゲート（U+D800〜U+DFFF）になり、
 * U+E000〜U+FFFF の文字より**前**に来てしまうので、そこだけ揃える
 */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/**
 * `json.dumps(value, ensure_ascii=False, sort_keys=True)` と同じ文字列。
 * オブジェクトのキーは**入れ子の中まで**並べ替える（Python の `sort_keys` がそうする）。
 *
 * 値が `undefined`（JSON には無い）なら `JSON.stringify` と同じく配列の中では `null` にする。
 * Python 側にそもそも `undefined` は無いので、ここは「落ちない」ためだけの扱い
 */
export function dumpsLikePython(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(dumpsLikePython).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => compareCodePoints(a, b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${dumpsLikePython(v)}`).join(', ')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
