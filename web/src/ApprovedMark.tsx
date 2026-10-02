/** PR が承認済み（GitHub の reviewDecision が APPROVED）の印（#636）。Octicons の check-circle。色は currentColor に任せる */
export function ApprovedMark({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="currentColor">
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm3.78 4.72a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L4.22 9.28a.75.75 0 0 1 1.06-1.06L7 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  )
}
