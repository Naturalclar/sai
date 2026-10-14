/** バイト数を MB で（10MB 未満は小数 1 桁。#792 のバナー） */
export function mbLabel(bytes: number): string {
  const mb = bytes / 1048576
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
}
