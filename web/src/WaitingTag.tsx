/** 人を待って止まっている（許可待ち・質問待ち・入力待ち）。text は「何を待っているか」 */
export function WaitingTag({ text }: { text: string }) {
  return (
    <span className="tag waiting" title={text}>
      待機中
    </span>
  )
}
