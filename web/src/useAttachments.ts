import { useState } from 'react'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, hasBinaryBytes, sniffPdf } from '../../shared/attachments.ts'
import { sniffImageType } from '../../shared/icon.ts'
import { api } from './api'
import { restoresImages } from './replyRestore.ts'

/** 入力欄に付けた添付 1 つ（画像か、文字のファイル・PDF。#608） */
export interface Attached {
  /** 返信の attachments に入れる絶対パス */
  path: string
  /** サムネイルの src。画像以外は空（配る口が無い） */
  url: string
  /** 画像以外のときだけ: 種類・元の名前・大きさ（並びに印と名前で出す） */
  kind?: 'text' | 'pdf'
  name?: string
  size?: number
}

/** 画面で先に見る頭の長さ。文字のファイルかどうかは、ここに制御文字（NUL など）が無いかで見る（全部を見るのはサーバ） */
const HEAD_BYTES = 4096

/**
 * 返信に添える画像。選んだ（貼った・落とした）瞬間にサーバへ置いて、返ってきたパスを持つ。
 * 送信のときに `attachments` として渡し、送れたら clear する。
 * `id` は預け先のエンティティ。無ければ（返信先が決まっていないフィード）何も受け付けない。
 * `initial` は打ちかけの下書きから戻す画像（#306。作ったときに 1 回だけ読む）
 */
export function useAttachments(id: string | undefined, initial: readonly Attached[] = []) {
  const [items, setItems] = useState<Attached[]>(() => [...initial])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /** 選ばれたファイルを順に置く。画像でないもの・大きすぎるものはその場で理由を出して飛ばす */
  const add = async (files: readonly File[]) => {
    if (!id || files.length === 0) return
    setError('')
    const room = ATTACHMENT_MAX_COUNT - items.length
    if (room <= 0) return setError(`添付は ${ATTACHMENT_MAX_COUNT} 個までです`)
    setBusy(true)
    try {
      for (const file of files.slice(0, room)) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          setError(`${file.name || 'そのファイル'} は大きすぎます（${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB まで）`)
          continue
        }
        // 中身で見る（拡張子や type は信じない）。画像・PDF でなく、頭に制御文字があるもの（バイナリ。iPhone の HEIC・
        // zip・Office の文書など）はここで弾く。文字のファイルかどうかの最終の判定はサーバ（全部を UTF-8 として読む）
        const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
        if (head.length === 0 || (!sniffImageType(head) && !sniffPdf(head) && hasBinaryBytes(head))) {
          setError(`${file.name || 'そのファイル'} は添えられません（画像・文字のファイル・PDF だけ）`)
          continue
        }
        try {
          const saved = await api.addAttachment(id, file, file.name)
          const item: Attached = saved.kind === 'image' ? { path: saved.path, url: saved.url } : { path: saved.path, url: '', kind: saved.kind, name: saved.name, size: saved.size }
          // 同じものを 2 回選んでも 1 つ（サーバが中身のハッシュで名前を付ける）
          setItems((list) => (list.some((x) => x.path === saved.path) ? list : [...list, item]))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = (path: string) => setItems((list) => list.filter((x) => x.path !== path))
  /**
   * 送れなかったぶんを戻す（#350）。サーバには置いたままなので預け直さない（パスはそのまま使える）。
   * 失敗のあとに別の画像を足していれば触らない
   */
  const restore = (kept: readonly Attached[]) => {
    if (kept.length === 0) return
    setItems((list) => (restoresImages(list.length) ? [...kept] : list))
  }
  const clear = () => {
    setItems([])
    setError('')
  }

  return { items, busy, error, add, remove, restore, clear, paths: items.map((x) => x.path) }
}
