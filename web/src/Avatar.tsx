interface Props {
  /** 色を決める側（`me` か、エージェントの種類 `claude` / `codex` / …）。CSS の `.avatar.<kind>` */
  kind: string
  /** アイコンの画像の URL。あれば頭文字の代わりに出す */
  icon?: string | undefined
  /** 画像が無いときの頭文字（`私` / `C` / `X` …） */
  mark: string
}

/**
 * バブルの左のアバター（#666）。**アイコンがあれば画像、無ければ頭文字**、をここ 1 つで決める。
 * 前は `Chat` と許可のバブルが別々に書いていて、許可のバブルと送ったメッセージへの返答は頭文字だけだった。
 * 新しいバブルを足すときもこれを使う（アイコンを渡し忘れなければ出る）
 */
export function Avatar({ kind, icon, mark }: Props) {
  return <div className={`avatar ${kind}`}>{icon ? <img src={icon} alt="" /> : mark}</div>
}
