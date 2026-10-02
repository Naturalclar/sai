/** 左右に分けた枠（横に並べて開く）。色は currentColor に任せる */
export function SplitMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M8 2.75v10.5" />
    </svg>
  )
}
