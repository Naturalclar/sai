import type { ImageUnavailable } from '../../shared/images.ts'
import { ImageMark } from './ImageMark'
import { imageUnavailableText } from './imageUnavailable'

/**
 * 出せない画像の印と名前（#321）。理由の区分が分かっていれば名前の横に短く出し、どうすれば出るかはマウスを乗せると出る（#820）。
 * 区分が分からない（一言の中・読めなかった理由が来なかった）ときは印と名前だけ。`broken`（読みに行って失敗した）なら title に「表示できません」を添える
 */
export function UnavailableImage({ name, src, why, broken = false }: { name: string; src: string; why: ImageUnavailable | null; broken?: boolean }) {
  const text = why ? imageUnavailableText(why, src) : null
  const title = text ? `${src}\n${text.hint}` : broken ? `${src}\n表示できません（ファイルが無い・作業ディレクトリの外・画像でない）` : src
  return (
    <span className="md-image" title={title}>
      <ImageMark />
      {name}
      {text ? <span className="md-image-why">{text.label}</span> : null}
    </span>
  )
}
