// 返信に添える画像の置き場。~/.agent-feed/attachments/<sha1(ID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext>。
// エンティティ ID には `@` や `/` が入るのでファイル名には使わず、ID からパスを組み立てない（icons.ts と同じ流儀）。
//
// **返信の attachments は CLI に渡って読まれる**ので、画面から来た絶対パスをそのまま信じない。
// resolvePath() が「このセッションの置き場の、この形の名前」だけを通す（他のファイルを読ませない）。
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STRIPPED_MARK, stripImageMetadata, UNREADABLE_IMAGE_REASON } from '../local/imageMetadata.ts'
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
/**
 * 原本の隣に置く、**捨てない軽い版**の置き場（`attachments/<dir>/thumb/<名前の幹>.jpg|png`。#792）。
 * `thumbs/` は LRU で古いものから捨てる派生の置き場なので相乗りしない（原本を消したあとは軽い版が記録そのものになる）
 */
export const KEPT_THUMB_SUBDIR = 'thumb'
/**
 * 捨てない軽い版の版（名前 `<幹>.<版>.jpg|png` に入る）。縮め方・メタデータの落とし方を変えて `THUMB_VERSION` を上げるときは、これも上げる
 * （原本があるうちは古い版を配らず作り直し、原本が消えたあとは古い版でも配る＝記録そのものなので捨てない）
 */
export const KEPT_THUMB_VERSION = 1
const KEPT_THUMB_RE = /^[0-9a-f]{16}\.(\d+)\.(jpg|png)$/
/** `keepThumb()` の tmp（`<幹>.<版>.jpg.<pid>.<連番>.tmp`）。起動時に古いものを消す */
const KEPT_THUMB_WORK_RE = /^[0-9a-f]{16}\.\d+\.(jpg|png)\.\d+\.\d+\.tmp$/

/** ID → ディレクトリ名。逆引きはしない */
export function attachmentDir(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16)
}

/** 前からある添付の画像からメタデータを落とし終えた印（#791）。名前は `METADATA_STRIP_VERSION` から（落とし方を変えたら上がる） */
export const ATTACHMENTS_STRIPPED_MARK = STRIPPED_MARK
/** `put()` と一括処理が書く tmp の形（`<名前>.<pid>.<連番>[.strip].tmp`）。起動時に古いものを消す */
export const ATTACHMENT_WORK_RE = /^[0-9a-f]{16}\.(png|jpeg|gif|webp|pdf|txt)\.\d+\.\d+(\.strip)?\.tmp$/
/** これより古い tmp は残骸として消す（別の SAI が書いている最中のものは、これより新しい） */
export const ATTACHMENT_WORK_STALE_MS = 10 * 60_000

export interface CleanResult {
  /** 読んだ画像の数（印があれば 0） */
  checked: number
  /** 落として置き直した数 */
  changed: number
  /** 消した残骸の tmp の数 */
  removed: number
  marked: boolean
}

/** 捨てない軽い版（`attachments/<dir>/thumb/`）の 1 枚 */
export interface KeptThumb {
  path: string
  type: 'jpeg' | 'png'
  mime: string
  /** 今の `KEPT_THUMB_VERSION` で作ったもの。古い版は原本が消えたあとの代わりにだけ使う */
  current: boolean
}

export class AttachmentStore {
  readonly dir: string
  /** 起動時の一括処理（作られたときに始める）。置くときと配るときはこれを待たない（原本の名前は変わらない） */
  private readonly cleaned: Promise<CleanResult>
  /** tmp の連番（同じ中身を同時に置いても、同じ置き場を使う別の SAI と重なっても、tmp の名前が被らない） */
  private seq = 0
  private readonly now: () => number

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir
    this.now = now
    this.cleaned = this.cleanStored().catch(() => ({ checked: 0, changed: 0, removed: 0, marked: false }))
  }

  /** 起動時の一括処理の結果（テスト用） */
  ready(): Promise<CleanResult> {
    return this.cleaned
  }

  /**
   * 起動時の一括処理（#791）。
   * - 残骸の tmp（`ATTACHMENT_WORK_RE`。書けずに落ちた・途中で止められた）は、古ければ消す。印があっても毎回
   * - 前からある添付の画像（この版より前に置いたもの。EXIF がそのまま）から一度だけメタデータを落とす。印があれば読まない。
   *   1 枚ずつ読んで、落ちたものだけ tmp に書いて rename（名前は変えない。本文の行が指している）。読む前と置く直前の stat が
   *   違えば置かない（古い SAI が同じ置き場に書いている最中の原本を、途中のまま置き直さない）。
   *   読めない・書けないものが残っても印は置く（配る口は読めないものを配らないので配るものは清い。置かないと、1 枚のせいで起動のたびに全部を読み直す）
   */
  private async cleanStored(): Promise<CleanResult> {
    const out: CleanResult = { checked: 0, changed: 0, removed: 0, marked: false }
    const mark = join(this.dir, ATTACHMENTS_STRIPPED_MARK)
    let marked = false
    try {
      await stat(mark)
      marked = true
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
        names = await readdir(join(this.dir, d))
      } catch {
        continue
      }
      for (const n of names) {
        const path = join(this.dir, d, n)
        if (ATTACHMENT_WORK_RE.test(n)) {
          out.removed += await this.rmStale(path)
          continue
        }
        if (n === KEPT_THUMB_SUBDIR) {
          // 捨てない軽い版の置き場の tmp も同じ扱い（#792）
          let inner: string[] = []
          try {
            inner = (await readdir(path)).filter((t) => KEPT_THUMB_WORK_RE.test(t))
          } catch {
            // 読めない
          }
          for (const t of inner) out.removed += await this.rmStale(join(path, t))
          continue
        }
        if (marked || !ATTACHMENT_NAME_RE.test(n)) continue
        const tmp = `${path}.${process.pid}.${++this.seq}.strip.tmp`
        try {
          const before = await stat(path)
          const bytes = await readFile(path)
          const type = sniffImageType(bytes)
          if (!type) continue
          out.checked++
          const r = stripImageMetadata(bytes, type)
          if (!r.changed) continue
          await writeFile(tmp, r.bytes)
          const after = await stat(path)
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('書かれている最中')
          await rename(tmp, path)
          out.changed++
        } catch {
          await rm(tmp, { force: true }) // 読めない・書けない・書かれている最中のものは残す（配る口は読めないものを配らない）
        }
      }
    }
    if (!marked) {
      await writeFile(mark, '')
      marked = true
    }
    out.marked = marked
    return out
  }

  /** 古い tmp なら消す。消したら 1 */
  private async rmStale(path: string): Promise<number> {
    try {
      if (this.now() - (await stat(path)).mtimeMs >= ATTACHMENT_WORK_STALE_MS) {
        await rm(path, { force: true })
        return 1
      }
    } catch {
      // 消えていた・消せない
    }
    return 0
  }

  /**
   * 添付を置く。**中身で種類を見る**（拡張子も Content-Type も信じない）: 画像（PNG / JPEG / GIF / WebP）・PDF・文字のファイル（UTF-8）。
   * どれでもなければ理由を返す。同じ中身なら同じ名前になる（重複を作らない）。
   * 文字のファイルは元の拡張子に関わらず `.txt` で置く（HTML / SVG も。配る口は画像の名前しか通さない）。
   * 元の名前は隣の `<名前>.name` に置く（#608。画面に出す・本文の行に添えるだけ）
   */
  async put(id: string, input: Buffer, originalName = ''): Promise<{ attachment?: Attachment; error: string }> {
    const image = sniffImageType(input)
    // 写真の EXIF（GPS など）は置く前に落とす（#791。ICC と向きは残る）。名前のハッシュも落とした後の中身から。
    // 形が読めず落とせたか分からないものは置かない（置いて配ると、落としたものとして扱われる）
    const stripped = image ? stripImageMetadata(input, image) : null
    if (stripped?.unreadable) return { error: UNREADABLE_IMAGE_REASON }
    const bytes = stripped ? stripped.bytes : input
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
      try {
        await writeFile(tmp, bytes)
        await rename(tmp, target)
      } catch (err) {
        await rm(tmp, { force: true }) // 書けなかった（ENOSPC など）・rename できなかった tmp を残さない
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

  /** 捨てない軽い版の置き場のパス（`find()` と同じく形を見てから組む。リクエストの文字列は入れない） */
  private keptThumbPath(dir: string, name: string, type: 'jpeg' | 'png', version = KEPT_THUMB_VERSION): string | null {
    if (!ATTACHMENT_DIR_RE.test(dir) || !ATTACHMENT_NAME_RE.test(name)) return null
    return join(this.dir, dir, KEPT_THUMB_SUBDIR, `${name.slice(0, 16)}.${version}.${type === 'jpeg' ? 'jpg' : 'png'}`)
  }

  /**
   * `resolvePath()` を通ったパスが、いま CLI に渡せるか（無いパスを読ませない）。無ければ理由（#792。画像の原本が寿命で消えた＝軽い版が
   * 残っている、か、ただ無い）。軽い版のパスに差し替えはしない（本文の行・画像を受ける口が原本の形の名前しか知らない）
   */
  async missingReason(resolved: string): Promise<string | null> {
    try {
      if ((await stat(resolved)).isFile()) return null
    } catch {
      // 無い
    }
    const parts = resolved.split('/')
    const name = parts.pop() ?? ''
    const dir = parts.pop() ?? ''
    if (ATTACHMENT_NAME_RE.test(name) && (await this.keptThumb(dir, name))) return 'その画像の原本は寿命で消えています（軽い版はチャットに残ります）。送るには添え直してください'
    return 'その添付が見つかりません。添え直してください'
  }

  /** 原本の隣に置いてある捨てない軽い版。今の版を先に、無ければ古い版（`current: false`）。どれも無ければ null（#792） */
  async keptThumb(dir: string, name: string): Promise<KeptThumb | null> {
    if (!ATTACHMENT_DIR_RE.test(dir) || !ATTACHMENT_NAME_RE.test(name)) return null
    const stem = name.slice(0, 16)
    let names: string[]
    try {
      names = (await readdir(join(this.dir, dir, KEPT_THUMB_SUBDIR))).filter((t) => t.startsWith(`${stem}.`) && KEPT_THUMB_RE.test(t))
    } catch {
      return null
    }
    const current = names.find((n) => n.split('.')[1] === String(KEPT_THUMB_VERSION))
    const pick = current ?? names.sort().at(-1)
    if (!pick) return null
    const type = pick.endsWith('.png') ? 'png' : 'jpeg'
    return { path: join(this.dir, dir, KEPT_THUMB_SUBDIR, pick), type, mime: ICON_MIME[type], current: pick === current }
  }

  /** 捨てない軽い版を置く（tmp + rename。古い版・別の形式の同じ幹は消す）。置けなければ、置いてあるものか null（#792） */
  async keepThumb(dir: string, name: string, bytes: Buffer, type: 'jpeg' | 'png'): Promise<KeptThumb | null> {
    const path = this.keptThumbPath(dir, name, type)
    if (!path) return null
    const sub = join(this.dir, dir, KEPT_THUMB_SUBDIR)
    const tmp = `${path}.${process.pid}.${++this.seq}.tmp`
    try {
      await mkdir(sub, { recursive: true })
      await writeFile(tmp, bytes)
      await rename(tmp, path)
    } catch {
      await rm(tmp, { force: true })
      return this.keptThumb(dir, name)
    }
    try {
      for (const t of await readdir(sub)) if (t.startsWith(`${name.slice(0, 16)}.`) && KEPT_THUMB_RE.test(t) && join(sub, t) !== path) await rm(join(sub, t), { force: true })
    } catch {
      // 読めなければそのまま
    }
    return { path, type, mime: ICON_MIME[type], current: true }
  }

  /**
   * 置き場の中身を歩く（掃除と大きさの計測に。#792）。返すのは **SAI が作った形の名前だけ**（原本・軽い版・元の名前・印・tmp）。
   * 知らない名前は数えない・触らない
   */
  async walk(): Promise<{ dir: string; name: string; path: string; kind: 'original' | 'thumb' | 'other'; size: number; mtimeMs: number }[]> {
    const out: { dir: string; name: string; path: string; kind: 'original' | 'thumb' | 'other'; size: number; mtimeMs: number }[] = []
    let dirs: string[]
    try {
      dirs = (await readdir(this.dir)).filter((d) => ATTACHMENT_DIR_RE.test(d))
    } catch {
      return out
    }
    const push = async (dir: string, name: string, path: string, kind: 'original' | 'thumb' | 'other') => {
      try {
        const st = await stat(path)
        if (st.isFile()) out.push({ dir, name, path, kind, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // 一覧を取った直後に消えた
      }
    }
    for (const dir of dirs) {
      let names: string[]
      try {
        names = await readdir(join(this.dir, dir))
      } catch {
        continue
      }
      for (const n of names) {
        if (n === KEPT_THUMB_SUBDIR) {
          let thumbs: string[] = []
          try {
            thumbs = (await readdir(join(this.dir, dir, n))).filter((t) => KEPT_THUMB_RE.test(t))
          } catch {
            // 無い・読めない
          }
          for (const t of thumbs) await push(dir, t, join(this.dir, dir, n, t), 'thumb')
          continue
        }
        const kind = ATTACHMENT_NAME_RE.test(n) ? 'original' : ATTACHMENT_FILE_NAME_RE.test(n) || n.endsWith(LABEL_SUFFIX) || ATTACHMENT_WORK_RE.test(n) ? 'other' : null
        if (kind) await push(dir, n, join(this.dir, dir, n), kind)
      }
    }
    return out
  }

  /** 原本を消す（掃除から。`walk()` が返したパスだけを渡す。#792）。消せなければ false */
  async removeOriginal(dir: string, name: string): Promise<boolean> {
    if (!ATTACHMENT_DIR_RE.test(dir) || !ATTACHMENT_NAME_RE.test(name)) return false
    try {
      await rm(join(this.dir, dir, name))
      return true
    } catch {
      return false
    }
  }
}
