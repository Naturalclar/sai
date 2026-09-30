// 差分ビューアの仮想化（#287）。見えている行 ± 余白だけを DOM に置く。DOM に依存しないので diffVirtual.test.ts で回す。
//
// 決めた形（#287 の「決めたこと」）:
// - 単位は**ファイルごと**。見えていないファイルは高さだけの空箱。開いているファイルの中で行を間引く
// - 行コメント（#511）が付いている行と編集中の行は、見えていなくても常に DOM に置く（`pinned`）。高さは置いたあとに測って下の行に足す
// - 横幅は DOM からではなく、ファイルの中で一番長い行の文字数から先に計算して固定する（`fileWidthCh()`。全角は 2）
// - ページ内検索（⌘F）が DOM に無い行に当たらなくなるのは、いったん諦める
//
// 行の高さは固定（等幅 12px × 1.5 = 18px、`white-space: pre` で折り返さない）。ハンク見出し `.hh` と注記も固定。
// 高さの値は styles.css と揃える（変えたら両方）

/** 1 行の高さ（`.ln`。12px × line-height 1.5） */
export const LINE_H = 18
/** ハンク見出しの高さ（`.hh`。11px × 1.5 + padding 2px × 2） */
export const HUNK_HEADER_H = 20.5
/** ハンクの間の罫線（`.hunk + .hunk` の border-top） */
export const HUNK_GAP = 1
/** 見えている範囲の上下に余分に描く高さ（px）。指で送ったときに白い帯が見えにくい程度 */
export const OVERSCAN_PX = 400

/** 1 ファイルの中の描く単位の並び。ハンク見出しと行を上から順に平らに並べたもの */
export interface FileRow {
  kind: 'header' | 'line'
  /** ハンクの番号 */
  hunk: number
  /** 行の番号（ハンクの中）。見出しは -1 */
  line: number
  /** ファイルの先頭からの位置（px）。固定の高さだけで組む。ピン留めした行の余分な高さは別に足す（`rowTop()`） */
  top: number
  height: number
}

/** ファイルの行を平らにする。位置は固定の高さだけで組む */
export function layoutFile(hunks: readonly { lines: readonly unknown[] }[]): { rows: FileRow[]; height: number } {
  const rows: FileRow[] = []
  let top = 0
  hunks.forEach((h, hunk) => {
    if (hunk > 0) top += HUNK_GAP
    rows.push({ kind: 'header', hunk, line: -1, top, height: HUNK_HEADER_H })
    top += HUNK_HEADER_H
    for (let line = 0; line < h.lines.length; line++) {
      rows.push({ kind: 'line', hunk, line, top, height: LINE_H })
      top += LINE_H
    }
  })
  return { rows, height: top }
}

/**
 * ピン留めした行（コメント・編集中）の下に付く余分な高さ。鍵は `rows` の添字。
 * 置いたあとに測るので、最初の描画では 0（次の描画で位置が直る）
 */
export type ExtraHeights = ReadonlyMap<number, number>

/** 添字 i の行の実際の位置。それより上のピン留めの余分な高さを足す */
export function rowTop(rows: readonly FileRow[], i: number, extra: ExtraHeights): number {
  let add = 0
  for (const [k, h] of extra) if (k < i) add += h
  return rows[i]!.top + add
}

/** ファイル全体の実際の高さ（余分な高さを含む） */
export function fileHeight(base: number, extra: ExtraHeights): number {
  let add = 0
  for (const h of extra.values()) add += h
  return base + add
}

/**
 * スクロール位置から、描く行の添字の範囲 `[from, to)` を出す。
 * `viewTop` / `viewBottom` は**ファイルの先頭を 0 とした**見えている範囲（呼び出し側がスクロール容器の中でのファイルの位置を引く）。
 * 上下に `OVERSCAN_PX` を足す。ピン留めの余分な高さは `extra` で見る（下の行ほどずれる）。
 * 見えていなければ `[0, 0)`。2 分探索ではなく線形（1 ファイル数千行で十分速く、余分な高さがあると単調でも一様でない）
 */
export function visibleRange(rows: readonly FileRow[], viewTop: number, viewBottom: number, extra: ExtraHeights = new Map(), overscan = OVERSCAN_PX): [number, number] {
  if (rows.length === 0 || viewBottom <= viewTop) return [0, 0]
  const lo = viewTop - overscan
  const hi = viewBottom + overscan
  let from = -1
  let to = 0
  let add = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const top = r.top + add
    const bottom = top + r.height + (extra.get(i) ?? 0)
    if (bottom > lo && from < 0) from = i
    if (top < hi) to = i + 1
    else break
    add += extra.get(i) ?? 0
  }
  return from < 0 ? [0, 0] : [from, to]
}

/**
 * 描く行の添字の集まり: 見えている範囲に、ピン留め（コメント付き・編集中）を足したもの。昇順。
 * 見えていないピン留めも DOM に置くのは、高さを測るためと、そこへスクロールしても抜けないため
 */
export function rowsToRender(range: readonly [number, number], pinned: Iterable<number>, count: number): number[] {
  const set = new Set<number>()
  for (let i = range[0]; i < range[1]; i++) set.add(i)
  for (const p of pinned) if (p >= 0 && p < count) set.add(p)
  return [...set].sort((a, b) => a - b)
}

/**
 * 文字の幅（等幅のセル数）。全角（East Asian Wide / Fullwidth）と絵文字は 2、それ以外は 1。
 * 制御文字は 0。結合文字（濁点など）も 0。CJK の記号・かな・漢字・全角英数・ハングルを 2 と数える範囲を並べる
 */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0 // 結合記号
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0 // 異体字セレクタ
  if (cp === 0x200d) return 0 // ZWJ
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** 文字列の幅（等幅のセル数）。タブは 8 桁 */
export function textWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x09) {
      w += 8 - (w % 8)
      continue
    }
    w += charWidth(cp)
  }
  return w
}

/** 番号 2 つ（3.5em × 2）＋記号（1.2em）＋本文の右の余白（10px ≒ 1.4ch）を、本文の文字幅に足すぶん（ch）。styles.css と揃える */
export const LINE_CHROME_CH = 3.5 * 2 * (12 / 7.2) + 1.2 * (12 / 7.2) + 1.4
/**
 * ファイルの本文の箱の幅（ch）。一番長い行（見出しも含む）の文字幅から先に決める（#287。#514 の「一番長い行の幅まで伸ばす」を
 * 見えている行だけでやると、その行が画面外に出た瞬間に幅が縮んで横スクロールが跳ねる）。
 * `.ln` は 12px の等幅で、1ch ≒ 7.2px。`.hh` は 11px なのでこちらは 11/12 に縮めて数える。見えている幅（min-width: 100%）より狭ければ CSS が伸ばす
 */
export function fileWidthCh(hunks: readonly { header: string; lines: readonly { text: string }[] }[]): number {
  let widest = 0
  for (const h of hunks) {
    widest = Math.max(widest, (textWidth(h.header) + 2.8) * (11 / 12))
    for (const l of h.lines) widest = Math.max(widest, textWidth(l.text) + LINE_CHROME_CH)
  }
  return Math.ceil(widest)
}
