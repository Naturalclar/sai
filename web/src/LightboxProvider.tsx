import { useCallback, useState, type ReactNode } from 'react'
import { LightboxContext, type LightboxImage } from './lightbox'
import { ImageLightbox } from './ImageLightbox'

/** チャットの中の画像を、ページの中のライトボックスで開けるようにする（#507）。開いている画像はここが 1 つだけ持つ */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ images: LightboxImage[]; index: number } | null>(null)
  const open = useCallback((images: LightboxImage[], index: number) => setShown({ images, index }), [])
  const close = useCallback(() => setShown(null), [])
  const move = useCallback((index: number) => setShown((s) => (s ? { ...s, index } : s)), [])
  return (
    <LightboxContext value={open}>
      {children}
      {shown && <ImageLightbox images={shown.images} index={shown.index} onIndex={move} onClose={close} />}
    </LightboxContext>
  )
}
