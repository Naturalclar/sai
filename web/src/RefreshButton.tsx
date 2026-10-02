import { RefreshMark } from './RefreshMark'

/**
 * GitHub 関連の画面の「更新」（#601。PR の一覧・PR 1 本・レビューの確認）。アイコン＋「更新」で、取っている間は「更新中…」にして
 * アイコンを回す。**狭い画面では文字を隠してアイコンだけ**にする（PR の見出しは「Open in GitHub」と並び、携帯では幅が足りない）ので、
 * 読み上げと title は常に付ける。取る時機は変えていない（開いたときと押したときだけ）
 */
export function RefreshButton({ busy, onClick, linkish = false }: { busy: boolean; onClick: () => void; linkish?: boolean }) {
  const label = busy ? '更新中…' : '更新'
  return (
    <button type="button" className={`refresh${busy ? ' busy' : ''}${linkish ? ' linkish' : ''}`} onClick={onClick} disabled={busy} aria-label={label} title={busy ? 'GitHub から取っています' : 'GitHub から取り直す'}>
      <RefreshMark />
      <span className="label">{label}</span>
    </button>
  )
}
