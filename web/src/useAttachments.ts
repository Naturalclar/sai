import { useState } from 'react'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from '../../shared/attachments.ts'
import { sniffImageType } from '../../shared/icon.ts'
import { api } from './api'

/** 入力欄に付けた画像 1 枚 */
export interface Attached {
  /** 返信の attachments に入れる絶対パス */
  path: string
  /** サムネイルの src */
  url: string
}

/**
 * 返信に添える画像。選んだ（貼った・落とした）瞬間にサーバへ置いて、返ってきたパスを持つ。
 * 送信のときに `attachments` として渡し、送れたら clear する。
 * `id` は預け先のエンティティ。無ければ（返信先が決まっていないフィード）何も受け付けない
 */
export function useAttachments(id: string | undefined) {
  const [items, setItems] = useState<Attached[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /** 選ばれたファイルを順に置く。画像でないもの・大きすぎるものはその場で理由を出して飛ばす */
  const add = async (files: readonly File[]) => {
    if (!id || files.length === 0) return
    setError('')
    const room = ATTACHMENT_MAX_COUNT - items.length
    if (room <= 0) return setError(`画像は ${ATTACHMENT_MAX_COUNT} 枚までです`)
    setBusy(true)
    try {
      for (const file of files.slice(0, room)) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          setError(`${file.name || '画像'} は大きすぎます（${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB まで）`)
          continue
        }
        // 中身で見る（拡張子や type は信じない）。iPhone の HEIC はここで弾かれる
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
        if (!sniffImageType(head)) {
          setError(`${file.name || 'そのファイル'} は画像として読めません（PNG / JPEG / GIF / WebP）`)
          continue
        }
        try {
          const saved = await api.addAttachment(id, file)
          // 同じ画像を 2 回選んでも 1 つ（サーバが中身のハッシュで名前を付ける）
          setItems((list) => (list.some((x) => x.path === saved.path) ? list : [...list, { path: saved.path, url: saved.url }]))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = (path: string) => setItems((list) => list.filter((x) => x.path !== path))
  const clear = () => {
    setItems([])
    setError('')
  }

  return { items, busy, error, add, remove, clear, paths: items.map((x) => x.path) }
}
