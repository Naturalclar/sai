/** 「履歴から選ぶ」の時計と戻る矢印。ImageMark と同じく 16px の viewBox、色は currentColor に任せる */
export function HistoryMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8.5 1a6.5 6.5 0 1 1-6.33 8h1.03A5.5 5.5 0 1 0 3.6 4.5H5.5v1h-3.5V2h1v1.66A6.49 6.49 0 0 1 8.5 1z" />
      <path d="M8 4h1v3.8l2.6 1.5-.5.87L8 8.4V4z" />
    </svg>
  )
}
