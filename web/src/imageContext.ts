import { createContext } from 'react'

/**
 * 本文の画像（#321）の URL を作る関数。`Chat` がバブルごとに渡し、`MarkdownImage` が読む（Markdown の木の奥まで props で通さない）。
 * null なら配る口が無い（別のマシンのセッション・一言の中）ので、画像の印と名前だけを出す
 */
export const ImageSourceContext = createContext<((src: string) => string) | null>(null)
