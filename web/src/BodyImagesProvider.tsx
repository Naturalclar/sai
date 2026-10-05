import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { BodyImagesContext } from './bodyImages'

/** 発言の本文を、その中の画像（`MarkdownImage`）に渡す（#702。同じ発言の本文の画像を ← → で送るため） */
export function BodyImagesProvider({ text, children }: { text: string; children: ReactNode }) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set())
  const markBroken = useCallback((url: string) => setBroken((s) => (s.has(url) ? s : new Set(s).add(url))), [])
  const value = useMemo(() => ({ text, broken, markBroken }), [text, broken, markBroken])
  return <BodyImagesContext value={value}>{children}</BodyImagesContext>
}
