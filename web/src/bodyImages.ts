import { createContext } from 'react'
import { imageName } from '../../shared/markdown.ts'
import { imageRefs } from '../../shared/images.ts'
import type { LightboxImage } from './lightbox'

/**
 * その発言の本文（#702）。`Message` が `BodyImagesProvider` で渡し、`MarkdownImage` が押されたときに
 * 同じ本文の画像の並びを作る（描くたびに本文を解釈しない）。`broken` は読めなかった画像の URL
 */
export interface BodyImages {
  text: string
  broken: ReadonlySet<string>
  markBroken: (url: string) => void
}

export const BodyImagesContext = createContext<BodyImages | null>(null)

/**
 * 本文の画像を、出てきた順にライトボックスの並びにする（#702）。出どころは `imageRefs()`＝`imagesByBubble()` が
 * 「本文にもう出ているもの」として除くのと同じ一覧。同じ URL は 1 つ、読めなかったものは入れない
 */
export function bodyImages(text: string, urlOf: (src: string) => string, broken: ReadonlySet<string> = new Set()): LightboxImage[] {
  const out: LightboxImage[] = []
  for (const ref of imageRefs(text)) {
    const url = urlOf(ref.src)
    if (broken.has(url) || out.some((i) => i.url === url)) continue
    out.push({ url, name: ref.alt || imageName(ref.src) })
  }
  return out
}

/** 押した 1 枚 → ライトボックスに渡す並びと位置。並びに自分が居なければ（本文が渡っていないなど）自分 1 枚だけ */
export function lightboxFrom(images: readonly LightboxImage[], self: LightboxImage): { images: LightboxImage[]; index: number } {
  const index = images.findIndex((i) => i.url === self.url)
  return index < 0 ? { images: [self], index: 0 } : { images: [...images], index }
}
