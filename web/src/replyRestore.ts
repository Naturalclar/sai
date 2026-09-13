// 送信に失敗したら、打った本文と画像を入力欄に戻す（#350）。
//
// `ReplyBox` の `submit()` は送る前に入力欄を空にして（送った直後から次を打てるように）、
// 送れなかったときだけ戻す。戻す条件と、非同期の失敗（`202` のあとにプロセスが落ちた）で
// 親から頼まれた戻しを当てるかの判定を、DOM に依らない形でここに置く（`replyRestore.test.ts`）。

/** 非同期の失敗から入力欄に戻す頼み（#350）。`seq` は押すたびに増える */
export interface RestoreRequest {
  text: string
  seq: number
}

/**
 * 送れなかった本文を入力欄に戻すか。**人がもう次を打ち始めていたら上書きしない**
 * （空白だけなら打ちかけとは見ない）
 */
export function restoresText(current: string): boolean {
  return current.trim() === ''
}

/** 添えた画像を戻すか。失敗のあとに別の画像を足していれば触らない */
export function restoresImages(current: number): boolean {
  return current === 0
}

/**
 * 親から頼まれた戻し（失敗の理由に添えた「入力欄に戻す」）を当てるか。**`seq` が増えたときだけ**。
 * 同じ本文をもう一度戻せるように、本文ではなく数で見る（#338 の `clearsOnSent` と同じ形）
 */
export function restoresOnRequest(applied: number, seq: number): boolean {
  return seq > applied
}
