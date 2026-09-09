// どのマシンのセッションか（#114）。行の `host`（#112）とサーバ自身のホスト名を突き合わせて、
// 「別のマシンで動いているセッション」を見分ける。印を出すのも、返信を止めるのもこの判定を通す。
// DOM にもファイルにも触らない純粋関数なので shared/host.test.ts で回す。

/** ホスト名の長さの上限。feed/record.py の MAX_HOST と揃える */
const MAX_HOST = 64

/**
 * ホスト名を短い形にする。`feed/record.py` の `host_name()` と同じ規則（前後の空白を落とし、
 * 最初の `.` から先（`.local` などのドメイン部分）を捨て、64 文字で切る）。
 *
 * サーバ側（`SAI_HOST` / `os.hostname()`）と記録側で規則が違うと、同じマシンが `mbp` と `mbp.local` の
 * 2 台に見えて、自分のセッションが全部リモート扱いになる
 */
export function shortHost(raw: string): string {
  const first = (raw ?? '').trim().split('.')[0] ?? ''
  return first.slice(0, MAX_HOST)
}

/**
 * そのセッション（か行）が**別のマシン**のものか。
 *
 * - `host` が空 … `host` を載せない古い record.py が書いた行。**自分のマシン扱い**（今までどおり返信できる）
 * - `self` が空 … サーバが自分のホスト名を決められなかった。**何もリモートにしない**
 *   （判定の材料が無いのに返信を止めると、1 台で使っている人が返信できなくなる）
 */
export function isRemoteHost(host: string | undefined, self: string): boolean {
  // 大文字小文字は無視する。ホスト名はもともと区別しないうえ、記録側（AGENT_FEED_HOST / gethostname）と
  // サーバ側（SAI_HOST / os.hostname）で違う綴りが入りうる。**表示は元のまま**なので shortHost では畳まない
  const h = shortHost(host ?? '').toLowerCase()
  const s = shortHost(self).toLowerCase()
  return h !== '' && s !== '' && h !== s
}
