// 返信に添える画像の置き場。~/.agent-feed/attachments/<sha1(ID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext>。
// エンティティ ID には `@` や `/` が入るのでファイル名には使わず、ID からパスを組み立てない（icons.ts と同じ流儀）。
//
// **返信の attachments は CLI に渡って読まれる**ので、画面から来た絶対パスをそのまま信じない。
// resolvePath() が「このセッションの置き場の、この形の名前」だけを通す（他のファイルを読ませない）。
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STRIPPED_MARK, stripImageMetadata } from '../local/imageMetadata.ts'
import { ATTACHMENT_FILE_NAME_RE, ATTACHMENT_NAME_RE, ATTACHMENT_DIR_RE, attachmentLabel, attachmentUrl, isUtf8Text, sniffPdf } from '../../shared/attachments.ts'
import type { AttachmentKind } from '../../shared/attachments.ts'
import { ICON_MIME, sniffImageType } from '../../shared/icon.ts'

export interface Attachment {
  /** ファイルの絶対パス。返信の本文（と Codex の -i）に載る */
  path: string
  /** <img src>。/api/attachments/<dir>/<name>。**画像だけ**（ほかのファイルは配らないので空） */
  url: string
  /** 中身から決めた種類（#608） */
  kind: AttachmentKind
  /** 元のファイル名（画面に出す・本文の行に添えるだけ。パスには使わない）。画像と、名前の無いものは空 */
  label: string
  dir: string
  name: string
  mime: string
  size: number
}

/** 元の名前を置く隣のファイルの接尾辞（`<ハッシュ>.txt.name`） */
const LABEL_SUFFIX = '.name'

/** ID → ディレクトリ名。逆引きはしない */
export function attachmentDir(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16)
}

/** 前からある添付の画像からメタデータを落とし終えた印（#791）。名前は `METADATA_STRIP_VERSION` から（落とし方を変えたら上がる） */
export const ATTACHMENTS_STRIPPED_MARK = STRIPPED_MARK

export class AttachmentStore {
  readonly dir: string
  /** 起動時の一括処理（作られたときに始める）。置くときと配るときはこれを待たない（原本の名前は変わらない） */
  private readonly cleaned: Promise<{ checked: number; changed: number; marked: boolean }>
  /** tmp の連番（同じ中身を同時に置いても、同じ置き場を使う別の SAI と重なっても、tmp の名前が被らない） */
  private seq = 0

  constructor(dir: string) {
    this.dir = dir
    this.cleaned = this.stripStored().catch(() => ({ checked: 0, changed: 0, marked: false }))
  }

  /** 起動時の一括処理の結果（テスト用） */
  ready(): Promise<{ checked: number; changed: number; marked: boolean }> {
    return this.cleaned
  }

  /**
   * 前からある添付の画像（この版より前に置いたもの。EXIF がそのまま）から一度だけメタデータを落とす（#791）。
   * 印があれば何もしない。1 枚ずつ読んで、落ちたものだけ tmp に書いて rename（名前は変えない。本文の行が指している）。
   * 読めない・書けないものが残っても印は置く（配る口でも落とすので配るものは清い。置かないと、1 枚のせいで起動のたびに全部を読み直す）
   */
  private async stripStored(): Promise<{ checked: number; changed: number; marked: boolean }> {
    const out = { checked: 0, changed: 0, marked: false }
    const mark = join(this.dir, ATTACHMENTS_STRIPPED_MARK)
    try {
      await stat(mark)
      return { ...out, marked: true }
    } catch {
      // まだ
    }
    let dirs: string[]
    try {
      dirs = (await readdir(this.dir)).filter((d) => ATTACHMENT_DIR_RE.test(d))
    } catch {
      return out // 置き場がまだ無い（最初の put が作る。そのときの中身は落とした後のもの）
    }
    for (const d of dirs) {
      let names: string[]
      try {
        names = (await readdir(join(this.dir, d))).filter((n) => ATTACHMENT_NAME_RE.test(n))
      } catch {
        continue
      }
      for (const n of names) {
        const path = join(this.dir, d, n)
        const tmp = `${path}.${process.pid}.${++this.seq}.strip.tmp`
        try {
          const bytes = await readFile(path)
          const type = sniffImageType(bytes)
          if (!type) continue
          out.checked++
          const r = stripImageMetadata(bytes, type)
          if (!r.changed) continue
          await writeFile(tmp, r.bytes)
          await rename(tmp, path)
          out.changed++
        } catch {
          await rm(tmp, { force: true }) // 読めない・書けないものは残す（配る口で落とす）
        }
      }
    }
    await writeFile(mark, '')
    out.marked = true
    return out
  }

  /**
   * 添付を置く。**中身で種類を見る**（拡張子も Content-Type も信じない）: 画像（PNG / JPEG / GIF / WebP）・PDF・文字のファイル（UTF-8）。
   * どれでもなければ理由を返す。同じ中身なら同じ名前になる（重複を作らない）。
   * 文字のファイルは元の拡張子に関わらず `.txt` で置く（HTML / SVG も。配る口は画像の名前しか通さない）。
   * 元の名前は隣の `<名前>.name` に置く（#608。画面に出す・本文の行に添えるだけ）
   */
  async put(id: string, input: Buffer, originalName = ''): Promise<{ attachment?: Attachment; error: string }> {
    const image = sniffImageType(input)
    // 写真の EXIF（GPS など）は置く前に落とす（#791。ICC と向きは残る）。名前のハッシュも落とした後の中身から
    const bytes = image ? stripImageMetadata(input, image).bytes : input
    const kind: AttachmentKind | null = image ? 'image' : sniffPdf(bytes) ? 'pdf' : isUtf8Text(bytes) ? 'text' : null
    if (!kind) return { error: '添えられるのは画像（PNG / JPEG / GIF / WebP）・文字のファイル（UTF-8）・PDF だけです' }
    const ext = image ?? (kind === 'pdf' ? 'pdf' : 'txt')
    const dir = attachmentDir(id)
    const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`
    const dirPath = join(this.dir, dir)
    const label = kind === 'image' ? '' : attachmentLabel(originalName)
    try {
      await mkdir(dirPath, { recursive: true })
      // tmp に書いて rename（起動時の一括処理が、書きかけの原本を読んで途中のまま置き直さないように）。
      // 同じ中身を同時に 2 回置くと後の rename が ENOENT になりうるが、名前が中身のハッシュなので「もう置いてある」なら成功
      const target = join(dirPath, name)
      const tmp = join(dirPath, `${name}.${process.pid}.${++this.seq}.tmp`)
      await writeFile(tmp, bytes)
      try {
        await rename(tmp, target)
      } catch (err) {
        await rm(tmp, { force: true })
        if (!(await stat(target).catch(() => null))) throw err
      }
      // 名前なしで同じ中身を置き直したら、前の名前は消す（#667 のレビュー。残すと、画面は名前なしなのに本文には前の名前が載る）
      if (label) await writeFile(join(dirPath, `${name}${LABEL_SUFFIX}`), label, 'utf-8')
      else if (kind !== 'image') await rm(join(dirPath, `${name}${LABEL_SUFFIX}`), { force: true })
    } catch (err) {
      return { error: err instanceof Error ? err.message : '保存できませんでした' }
    }
    return {
      attachment: { path: join(dirPath, name), url: image ? attachmentUrl(dir, name) : '', dir, name, mime: image ? ICON_MIME[image] : kind === 'pdf' ? 'application/pdf' : 'text/plain', size: bytes.length, kind, label },
      error: '',
    }
  }

  /** `resolvePath()` を通ったパスの、元の名前。無ければ空（読むのは隣の `.name` だけ。リクエストの文字列は入れない） */
  async labelOf(resolved: string): Promise<string> {
    try {
      return attachmentLabel(await readFile(`${resolved}${LABEL_SUFFIX}`, 'utf-8'))
    } catch {
      return ''
    }
  }

  /**
   * 画面から来た絶対パスを、そのセッションの置き場のものとして解決する。違えば null。
   * これを通ったパスだけを CLI に渡す（任意のファイルを読ませない）
   */
  resolvePath(id: string, path: string): string | null {
    const want = join(this.dir, attachmentDir(id))
    const parts = path.split('/')
    const name = parts.pop() ?? ''
    if (!ATTACHMENT_NAME_RE.test(name) && !ATTACHMENT_FILE_NAME_RE.test(name)) return null
    if (parts.join('/') !== want) return null
    return join(want, name)
  }

  /**
   * 配るとき。dir と name の形を見てから開く（パスは組み立てるだけで、リクエストの文字列は入れない）。
   * **画像の名前だけ**を通す（#608。文字のファイル・PDF・`.name` は配らない。HTML / SVG を同じオリジンで描かせない）
   */
  async find(dir: string, name: string): Promise<{ path: string; mime: string } | null> {
    if (!ATTACHMENT_DIR_RE.test(dir) || !ATTACHMENT_NAME_RE.test(name)) return null
    const path = join(this.dir, dir, name)
    try {
      if (!(await stat(path)).isFile()) return null
    } catch {
      return null
    }
    const ext = name.slice(name.lastIndexOf('.') + 1) as keyof typeof ICON_MIME
    return { path, mime: ICON_MIME[ext] }
  }
}
