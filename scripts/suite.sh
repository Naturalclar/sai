#!/usr/bin/env bash
# コミット前の一式（test / test:feed / lint / typecheck、--build で build も）を回し、結果を短い key=value の行だけで返す（#688）。
# エージェントが素の `pnpm test` を回すと 1 万字を超える出力が文脈に入り、以降の呼び出し全部で送り直される。
# 通ったら 1 行、落ちたら落ちたものだけ（上限 SUITE_MAX_LINES 行）を出し、全文は log= の下に残す。
# どれかが落ちても残りは回す（1 回で全部の落ち方が分かる）。落ちたら exit 1
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 2
max=${SUITE_MAX_LINES:-40}
log=$(mktemp -d "${TMPDIR:-/tmp}/sai-suite.XXXXXX")
failed=0
steps=(test feed lint typecheck)
[ "${1:-}" = "--build" ] && steps+=(build)

script_of() { [ "$1" = feed ] && echo test:feed || echo "$1"; }
# 落ちたときに見せる行。全文は出さない
excerpt() {
  case "$1" in
    test) grep -E '^not ok' "$2" ;;
    feed) grep -E '^(FAIL|ERROR): ' "$2" ;;
    lint) grep -E ': error ' "$2" || tail -n "$max" "$2" ;;
    typecheck) grep -E 'error TS' "$2" ;;
    *) tail -n "$max" "$2" ;;
  esac | head -n "$max"
}
num() { grep -E "^# $1 " "$2" | tail -n 1 | awk '{print $3}'; }

for step in "${steps[@]}"; do
  name=$(script_of "$step")
  out="$log/$step.log"
  if pnpm -s "$name" >"$out" 2>&1; then state=ok; else state=fail; failed=1; fi
  case "$step" in
    test) note="tests=$(num tests "$out") pass=$(num pass "$out") fail=$(num fail "$out")" ;;
    feed) note=$(grep -E '^Ran [0-9]+ tests?' "$out" | tail -n 1 | awk '{print "tests=" $2}') ;;
    lint) note="warnings=$(grep -c ': warning ' "$out") errors=$(grep -c ': error ' "$out")" ;;
    *) note= ;;
  esac
  echo "$name=$state${note:+ $note}"
  if [ "$state" = fail ]; then
    excerpt "$step" "$out" | sed 's/^/  /'
    echo "  （全文: ${out}）"
  fi
done

if [ "$failed" = 0 ]; then
  rm -rf "$log"
  echo "status=ok"
else
  echo "status=fail log=$log"
  exit 1
fi
