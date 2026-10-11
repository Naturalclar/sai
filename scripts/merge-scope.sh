#!/usr/bin/env bash
# PR が触ったファイルのパスから、「依頼に『マージまで』と書かれていても、人の『マージして』を待つ PR」（#581）かを出す。
#   bash scripts/merge-scope.sh <PR 番号>     gh でファイルの一覧を引く（改名は前の名前も見る）
#   bash scripts/merge-scope.sh -             パスを stdin から読む（1 行に 1 つ）
# 当たれば `scope=hold hits=<数>` と当たったパス・理由を出して exit 1。当たらなければ `scope=none files=<数>` で exit 0。
# **止まる側に倒す**: 一覧が引けない・1 つも無い・使い方が違うときも hold にする。
# `scope=none` は「パスでは当たらなかった」だけで、対象に入るとは限らない（中身で決めるのは /merge の一覧。迷ったら外す）
set -u

# 左が理由、右がパスの正規表現。足すのは自由、外すのは人が決める（決めた範囲は #581 のコメント）
rules=(
  '許可の判定とルール|^server/approvals/|^shared/(approvals|approvalCounts|bashRules|permissions|jev|opencodePermissions|codexDialog|pyjson|reply)\.|^feed/(record\.py|opencode/)'
  'セッション同士のメッセージ・/mcp・預かり・待ち・ループ|^server/mcp/|^feed/mcp/|^\.mcp\.json$|^shared/(agentMessages|sendAcross|loops|waits|waitingSaid|holding|handoff|managerDraft|codexQueue)\.'
  '認証・同一オリジン・tailnet|^server/[^/]+$|^shared/host\.|^server/meta/settings\.'
  '外に問い合わせる・書く口|^server/git/|^server/digest/|^shared/(digestSettings|prs|prReview|prComments|prLineComments)\.'
  'SAI が起こすコマンドの組み方|^server/reply/|^server/local/(claude(Login|Auth|Agents)|thumbnails)\.'
  'マージの決まりそのもの|^\.claude/|^\.github/|^(CLAUDE|AGENTS)\.md$|^scripts/|^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$'
)

hold() { echo "scope=hold $1"; exit 1; }

[ $# -eq 1 ] || hold 'reason=usage'
if [ "$1" = - ]; then
  files=$(cat)
else
  case "$1" in *[!0-9]*|'') hold 'reason=usage' ;; esac
  repo=$(git remote get-url origin 2>/dev/null | sed -E 's#^[^@]*@[^:/]+[:/]##; s#^[a-z]+://[^/]+/##; s#\.git$##')
  [ -n "$repo" ] || hold 'reason=unreadable'
  # --name-only は改名の後ろの名前しか出さないので、API から前の名前も引く（守っているファイルを外へ移す PR を落とさない）
  files=$(gh api "repos/$repo/pulls/$1/files" --paginate -q '.[] | .filename, (.previous_filename // empty)' 2>/dev/null) || hold 'reason=unreadable'
fi
# 行末の CR・前後の空白・先頭の ./ は落としてから比べる
files=$(printf '%s\n' "$files" | sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's#^\./##' -e '/^$/d')
[ -n "$files" ] || hold 'reason=unreadable'

hits=
while IFS= read -r f; do
  for rule in "${rules[@]}"; do
    if printf '%s\n' "$f" | grep -Eiq -- "${rule#*|}"; then
      hits+="$f — ${rule%%|*}"$'\n'
      break
    fi
  done
done <<EOF
$files
EOF

if [ -n "$hits" ]; then
  echo "scope=hold hits=$(printf '%s' "$hits" | wc -l | tr -d ' ')"
  printf '%s' "$hits" | head -n 20
  exit 1
fi
echo "scope=none files=$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
