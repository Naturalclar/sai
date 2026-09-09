import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalState } from './hooks'
import { appeared, notifyKey, notifyPlan } from './notify.ts'
import type { TodoItem } from './todoItems.ts'

/** 通知を出せるか。`Notification` が無い（古い環境、保護されていない文脈）なら unsupported */
export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied'

function currentState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotifyState
}

/**
 * 「あなたを待っています」をタブの外へ出す（#231）。
 *
 * - **入にした時だけ**許可を求める（勝手にダイアログを出さない）。localStorage に残る
 * - 鳴らすのは**タブが隠れている間だけ**。見ているなら要対応のバッジがそこにあるので邪魔なだけ
 * - 鳴らすのは**新しく待ちに入ったものだけ**（`notifyKey` に待ち始めた時刻が入っている）。
 *   最初の 1 回は覚えるだけで鳴らさない（開いた瞬間に溜まっていた分が一斉に鳴るのを防ぐ）
 * - 押したらそのタブへ来て要対応を開く
 */
export function useNotify(items: readonly TodoItem[] | null) {
  const [pref, setPref] = useLocalState<{ on: boolean }>('sai.notify', { on: false })
  const [state, setState] = useState<NotifyState>(currentState)
  // すでに知らせた（あるいは開いた時点で待っていた）待ちの鍵
  const seen = useRef<Set<string> | null>(null)

  const enabled = pref.on && state === 'granted'

  useEffect(() => {
    if (!items) return
    const keys = new Set(items.map(notifyKey))

    // 最初の 1 回は覚えるだけ。開いた時点で待っていたものは「今きた」ではない
    if (seen.current === null) {
      seen.current = keys
      return
    }

    const fresh = appeared(seen.current, items)
    seen.current = keys
    // 見ているときは鳴らさない。切っているとき・許可が無いときも同じ（覚えるのは続ける）
    if (!enabled || !document.hidden) return

    const plan = notifyPlan(fresh)
    if (!plan) return
    try {
      const n = new Notification(plan.title, { body: plan.body, tag: plan.tag })
      n.onclick = () => {
        window.focus()
        location.hash = plan.hash
        n.close()
      }
    } catch {
      // 通知が作れなくても画面は動く（題名の件数は出たまま）
    }
  }, [items, enabled])

  /** 入切。入にするときだけ許可を求める */
  const toggle = useCallback(async () => {
    if (pref.on) {
      setPref({ on: false })
      return
    }
    if (typeof Notification === 'undefined') {
      setState('unsupported')
      return
    }
    const answer = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    setState(answer as NotifyState)
    setPref({ on: answer === 'granted' })
  }, [pref.on, setPref])

  return { on: pref.on, state, enabled, toggle }
}
