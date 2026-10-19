import type { ImageUnavailable } from '../../shared/images.ts'
import { ImageMark } from './ImageMark'
import { imageUnavailableText } from './imageUnavailable'

/**
 * 出せない画像の印と名前（#321）。理由の区分が分かっていれば名前の横に短く出し、どうすれば出るかはマウスを乗せると出る（#820）。
 * 区分が分からない（一言の中・読めなかった理由が来なかった）ときは今までどおり印と名前だけ
 */
export function UnavailableImage({ name, src, why, title }: { name: string; src: string; why: ImageUnavailable | null; title: string }) {
  const text = why ? imageUnavailableText(why, src) : null
  return (
    <span className="md-image" title={text ? `${title}\n${text.hint}` : title}>
      <ImageMark />
      {name}
      {text ? <span className="md-image-why">{text.label}</span> : null}
    </span>
  )
}
