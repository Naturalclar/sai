// 本文の画像を配れなかったときに、名前の横に出す短い理由と、どうすれば出るかの 1 行（#820）。
// 区分はサーバが `X-SAI-Image-Unavailable` で渡す（パスは渡さない）。`/tmp` かどうかは画面が本文に書かれたパスから見る
import { IMAGE_MAX_BYTES, type ImageUnavailable } from '../../shared/images.ts'

/** macOS の `/tmp` は `/private/tmp` へのリンク */
const IN_TMP = /^\/(?:private\/)?tmp\//

export function imageUnavailableText(why: ImageUnavailable, src: string): { label: string; hint: string } {
  switch (why) {
    case 'outside':
      return {
        label: IN_TMP.test(src) ? '作業ディレクトリの外（/tmp）' : '作業ディレクトリの外',
        hint: 'SAI が出すのは作業ディレクトリの中の画像だけです。エージェントに作業ディレクトリの中（.screenshots/ など）へ置かせ、本文に ![名前](パス) と書かせると出ます',
      }
    case 'missing':
      return { label: 'ファイルが無い', hint: 'このパスにファイルがありません（消えた・動いた）。同じパスに置き直すと出ます' }
    case 'not-image':
      return { label: '画像でない', hint: '出せるのは中身が PNG / JPEG / GIF / WebP のファイルだけです（SVG は出しません）' }
    case 'too-big':
      return { label: '大きすぎる', hint: `出せるのは ${IMAGE_MAX_BYTES / 1024 / 1024}MB 以下の画像だけです` }
    case 'remote':
      return { label: '別のマシン', hint: '別のマシンのセッションの画像は、そのマシンの SAI で見られます' }
  }
}
