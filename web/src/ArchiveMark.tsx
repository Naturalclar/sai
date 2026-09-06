/**
 * 「アーカイブ」の箱（蓋と取っ手）。restore なら取っ手の代わりに上向きの矢印で「戻す」。
 * 色は currentColor に任せる
 */
export function ArchiveMark({ restore = false }: { restore?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5c0 .698-.409 1.301-1 1.582V13.25A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V5.832A1.75 1.75 0 0 1 0 4.25v-1.5C0 1.784.784 1 1.75 1ZM1.5 2.75v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25ZM2.5 6v7.25c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V6Z" />
      {restore ? (
        <path fill="var(--panel, #fff)" d="M8 6.75 5.25 9.5h1.9v3.25h1.7V9.5h1.9Z" />
      ) : (
        <path fill="var(--panel, #fff)" d="M6.25 8.25h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z" />
      )}
    </svg>
  )
}
