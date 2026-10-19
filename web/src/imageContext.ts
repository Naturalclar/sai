import { createContext } from 'react'
import type { ImageUnavailable } from '../../shared/images.ts'

/**
 * 本文の画像（#321）の URL を作る関数。`Chat` がバブルごとに渡し、`MarkdownImage` が読む（Markdown の木の奥まで props で通さない）。
 * null なら配る口が無い（別のマシンのセッション・一言の中）ので、画像の印と名前だけを出す
 */
export const ImageSourceContext = createContext<((src: string) => string) | null>(null)

/**
 * 配る口が無い（`ImageSourceContext` が null）理由（#820）。別のマシンのセッションのバブルでだけ `remote` にして、名前の横に理由を出す。
 * 一言の中・ファイルの表示は null のまま（理由を出さない。画像は別の場所に出る）
 */
export const ImageNoSourceContext = createContext<ImageUnavailable | null>(null)
