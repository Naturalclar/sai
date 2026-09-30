// 長い本文を折りたたむか（Message の「もっと見る」と、要対応の「元の文」#537 で同じ 1 つを使う）。
// 描画前の生の長さで見る（コードブロック 1 つで 8 行を超えても折りたたむ。今まで通り）
export const isLong = (text: string): boolean => text.length > 600 || text.split('\n').length > 8
