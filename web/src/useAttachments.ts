import { useState } from 'react'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, hasBinaryBytes, sniffPdf } from '../../shared/attachments.ts'
import { PASTE_FILE_NAME, pasteChars } from '../../shared/pasteFile.ts'
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
  /**
   * 長い貼り付けをファイルにしたもの（#609）。字数と、貼った文そのもの（「本文に戻す」と中身の確かめに使う。
   * 置き場のファイルは画面から読めないので、こちらで持つ）
   */
  pasted?: { chars: number; text: string }
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

  /** 貼り付けをファイルにできるか（預け先がある・数に空きがある・大きさが上限以内）。貼った瞬間に同期で決める */
  const canPaste = (text: string): boolean => Boolean(id) && !busy && items.length < ATTACHMENT_MAX_COUNT && new Blob([text]).size <= ATTACHMENT_MAX_BYTES

  /**
   * 長い貼り付けをテキストファイルにして預ける（#609）。預けられたらその項目、失敗したら null（呼ぶ側が本文に入れる。貼った文を失わない）。
   * 項目を返すのは、預けている間に入力欄が作り直されたとき（別のセッションへ移った）に、呼ぶ側が下書きへ足せるように
   */
  const addPasted = async (text: string): Promise<Attached | null> => {
    if (!id) return null
    setError('')
    setBusy(true)
    try {
      const saved = await api.addAttachment(id, new Blob([text], { type: 'text/plain' }), PASTE_FILE_NAME)
      if (saved.kind !== 'text') return null
      const item: Attached = { path: saved.path, url: '', kind: 'text', name: saved.name, size: saved.size, pasted: { chars: pasteChars(text), text } }
      setItems((list) => (list.some((x) => x.path === saved.path) ? list : [...list, item]))
      return item
    } catch (err) {
      setError(`貼り付けをファイルにできなかったので、本文に入れました（${err instanceof Error ? err.message : String(err)}）`)
      return null
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

  return { items, busy, error, add, addPasted, canPaste, remove, restore, clear, paths: items.map((x) => x.path) }
}
