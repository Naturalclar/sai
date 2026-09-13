// 確認（「消して送る」／「端末を使わず送る」）から送り直して受け付けられたら、入力欄を空にする（#338）。
//
// 入力欄を空にするのは `ReplyBox` の `submit()` だけで、確認からの送り直しは `useReply` が直接送るので
// `ReplyBox` を通らない。そのままだと受け付けられても本文が入力欄に残り、打ちかけ（#306）にも保存されて
// 画面を移っても再読み込みしても出てくる（そのまま Enter を押すと二重に送ってしまう）。
// そこで「受け付けた回数」を数えて `ReplyBox` に渡し、増えていたら空にする。
// DOM に依らない判定なので replySent.test.ts で回す。

/** 確認から送り直して受け付けられた回数。`0` はまだ一度も無い */
export type SentCount = number

/**
 * 入力欄を空にするか。**数が増えたときだけ**（同じ数の描画では空にしないので、
 * 送り直しのあとに打ち始めた本文を消さない）
 */
export function clearsOnSent(cleared: SentCount, sent: SentCount): boolean {
  return sent > cleared
}
