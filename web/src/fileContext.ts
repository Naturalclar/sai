import { createContext } from 'react'
import type { FileRef } from '../../shared/files.ts'

/**
 * 返答の中のファイルのパス（#603）を開ける先のセッション ID。`Chat` がバブルごとに渡し、`CodeSpan` が読む（Markdown の木の奥まで props で通さない）。
 * null なら開く口が無い（自分の入力・別のマシンのセッション・一言・PR の本文・ファイルビューアの中）ので、ただのコードとして出す
 */
export const FileSessionContext = createContext<string | null>(null)

/** ファイルを開く（`FileViewerProvider` が持つ）。null なら開く先が無い */
export const FileOpenContext = createContext<((id: string, ref: FileRef) => void) | null>(null)
