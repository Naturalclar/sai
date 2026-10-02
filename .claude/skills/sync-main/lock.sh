#!/usr/bin/env bash
# /sync-main を 1 本ずつにする lock（#580）。同時に走ると、サーバの立て直しが重なって起動コマンドが飲まれる（#296 の形）。
# 後から来た方は先の方が終わるのを待ち、取れたら普段の手順をそのまま回す（最新なら手順の側が何もしない）。
#
#   lock.sh acquire <lock のディレクトリ> <名乗り> [待つ秒数=480] [古いとみなす秒数=900]
#   lock.sh release <lock のディレクトリ> <名乗り>
#   lock.sh status  <lock のディレクトリ>
#
# 終了コード: 0 = 取れた / 外した、3 = 待つ上限を超えた（回さずに報告する）、4 = 自分の lock ではない、2 = 使い方
# lock は mkdir（原子的）。落ちたまま残った lock は、取った時刻（since）から <古いとみなす秒数> を過ぎたら引き取る。
set -u

cmd=${1:-}
dir=${2:-}
[ -n "$cmd" ] && [ -n "$dir" ] || { echo 'usage: lock.sh acquire|release|status <dir> [who] [wait] [stale]' >&2; exit 2; }

# 取った時刻。since がまだ書かれていない一瞬はディレクトリの更新時刻（macOS / Linux の両方の stat）
since_of() {
  local s
  s=$(cat "$1/since" 2>/dev/null)
  [ -n "$s" ] || s=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)
  echo "${s:-}"
}

case "$cmd" in
  acquire)
    who=${3:-}
    wait=${4:-480}
    stale=${5:-900}
    [ -n "$who" ] || { echo 'acquire: 名乗りが要る' >&2; exit 2; }
    start=$(date +%s)
    while :; do
      if mkdir "$dir" 2>/dev/null; then
        date +%s > "$dir/since"
        printf '%s\n' "$who" > "$dir/owner"
        echo "acquired waited=$(( $(date +%s) - start ))s"
        exit 0
      fi
      now=$(date +%s)
      since=$(since_of "$dir")
      if [ -n "$since" ] && [ $(( now - since )) -ge "$stale" ]; then
        # 落ちたまま残った lock。動かしてから「見たものと同じか」を確かめる（その間に誰かが引き取って取り直していたら戻す）
        old="$dir.stale.$$"
        if mv "$dir" "$old" 2>/dev/null; then
          if [ "$(since_of "$old")" = "$since" ]; then
            echo "stale: $(cat "$old/owner" 2>/dev/null) の lock（$(( now - since )) 秒前）を引き取った" >&2
            rm -rf "$old"
          else
            mv "$old" "$dir" 2>/dev/null || rm -rf "$old"
          fi
        fi
        continue
      fi
      if [ $(( now - start )) -ge "$wait" ]; then
        echo "timeout: $(cat "$dir/owner" 2>/dev/null) が $(( now - ${since:-now} )) 秒前から持っている"
        exit 3
      fi
      sleep 2
    done
    ;;
  release)
    who=${3:-}
    [ -d "$dir" ] || { echo 'released (もう無い)'; exit 0; }
    if [ "$(cat "$dir/owner" 2>/dev/null)" != "$who" ]; then
      echo "not mine: $(cat "$dir/owner" 2>/dev/null) の lock" >&2
      exit 4
    fi
    rm -rf "$dir"
    echo released
    ;;
  status)
    if [ -d "$dir" ]; then
      echo "held: $(cat "$dir/owner" 2>/dev/null) $(( $(date +%s) - $(since_of "$dir") ))s"
    else
      echo free
    fi
    ;;
  *)
    echo "unknown: $cmd" >&2
    exit 2
    ;;
esac
