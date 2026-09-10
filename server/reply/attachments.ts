// 返信に添える画像の置き場。~/.agent-feed/attachments/<sha1(ID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext>。
// エンティティ ID には `@` や `/` が入るのでファイル名には使わず、ID からパスを組み立てない（icons.ts と同じ流儀）。
//
// **返信の attachments は CLI に渡って読まれる**ので、画面から来た絶対パスをそのまま信じない。
// resolvePath() が「このセッションの置き場の、この形の名前」だけを通す（他のファイルを読ませない）。
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTACHMENT_NAME_RE, ATTACHMENT_DIR_RE, attachmentUrl } from '../../shared/attachments.ts'
import { ICON_MIME, sniffImageType } from '../../shared/icon.ts'

export interface Attachment {
  /** ファイルの絶対パス。返信の本文（と Codex の -i）に載る */
  path: string
  /** <img src>。/api/attachments/<dir>/<name> */
  url: string
  dir: string
  name: string
  mime: string
  size: number
}

/** ID → ディレクトリ名。逆引きはしない */
export function attachmentDir(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16)
}

export class AttachmentStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** 画像を置く。中身で種類を見て、画像でなければ理由を返す。同じ中身なら同じ名前になる（重複を作らない） */
  async put(id: string, bytes: Buffer): Promise<{ attachment?: Attachment; error: string }> {
    const type = sniffImageType(bytes)
    if (!type) return { error: '画像として読めません（PNG / JPEG / GIF / WebP）' }
    const dir = attachmentDir(id)
    const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${type}`
    const dirPath = join(this.dir, dir)
    try {
      await mkdir(dirPath, { recursive: true })
      await writeFile(join(dirPath, name), bytes)
    } catch (err) {
      return { error: err instanceof Error ? err.message : '保存できませんでした' }
    }
    return {
      attachment: { path: join(dirPath, name), url: attachmentUrl(dir, name), dir, name, mime: ICON_MIME[type], size: bytes.length },
      error: '',
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
    if (!ATTACHMENT_NAME_RE.test(name)) return null
    if (parts.join('/') !== want) return null
    return join(want, name)
  }

  /** 配るとき。dir と name の形を見てから開く（パスは組み立てるだけで、リクエストの文字列は入れない） */
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
