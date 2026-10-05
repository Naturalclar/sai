#!/usr/bin/env bash
# main worktree の更新・ビルド・必要なサーバ再起動を 1 回で行う（#687）。
# 人やエージェントが途中のコマンドを組み立てなくてよいように、判断結果だけを短い行で返す。
set -u

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
start=${1:-$(pwd)}
wait_seconds=${SYNC_MAIN_LOCK_WAIT:-480}
stale_seconds=${SYNC_MAIN_LOCK_STALE:-900}
port=${SAI_PORT:-8787}
pnpm_bin=${SYNC_MAIN_PNPM:-pnpm}
skip_server=${SYNC_MAIN_SKIP_SERVER:-0}
lock_held=0
lockdir=''
locksh=''
who=''
tmp=''

one_line() {
  tr '\n' ' ' | tr -s ' ' | cut -c1-1200
}

finish() {
  code=$?
  if [ "$lock_held" = 1 ]; then
    release=$(bash "$locksh" release "$lockdir" "$who" 2>&1)
    echo "lock=$(printf '%s' "$release" | one_line)"
  fi
  [ -z "$tmp" ] || rm -rf "$tmp"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

fail() {
  code=$1
  stage=$2
  shift 2
  echo "status=blocked stage=$stage detail=$(printf '%s' "$*" | one_line)"
  exit "$code"
}

run_quiet() {
  stage=$1
  shift
  log="$tmp/$stage.log"
  if "$@" >"$log" 2>&1; then return 0; fi
  detail=$(tail -8 "$log" | one_line)
  fail 5 "$stage" "$detail"
}

worktrees=$(git -C "$start" worktree list --porcelain 2>/dev/null) || fail 2 locate 'git worktree list を読めない'
main=$(printf '%s\n' "$worktrees" | awk '/^worktree /{w=substr($0,10)} /^branch refs\/heads\/main$/{print w; exit}')
[ -n "$main" ] || fail 4 locate 'main ブランチの worktree が無い'
top=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || fail 2 locate '作業ツリーの外'
common=$(git -C "$main" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || fail 2 locate 'git common dir を読めない'
lockdir="$common/sai-sync-main.lock"
locksh="$main/.claude/skills/sync-main/lock.sh"
[ -f "$locksh" ] || locksh="$script_dir/lock.sh"
[ -f "$locksh" ] || fail 2 locate 'lock.sh が無い'
who="$(basename "$top") $$ $(date +%H:%M:%S)"

lock_output=$(bash "$locksh" acquire "$lockdir" "$who" "$wait_seconds" "$stale_seconds" 2>&1)
lock_code=$?
echo "main=$main"
echo "lock=$(printf '%s' "$lock_output" | one_line)"
[ "$lock_code" -eq 0 ] || exit "$lock_code"
lock_held=1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sai-sync-main.XXXXXX") || fail 2 prepare '一時ディレクトリを作れない'

status=$(git -C "$main" status --short 2>&1) || fail 4 status "$status"
[ -z "$status" ] || fail 4 status "dirty: $status"
branch=$(git -C "$main" branch --show-current 2>&1) || fail 4 branch "$branch"
[ "$branch" = main ] || fail 4 branch "main ではない: ${branch:-detached}"

run_quiet fetch git -C "$main" fetch origin main
commits=$(git -C "$main" log --format='%h %s' HEAD..FETCH_HEAD 2>&1) || fail 4 log "$commits"
if [ -n "$commits" ]; then
  run_quiet merge git -C "$main" merge --ff-only FETCH_HEAD
  echo "sync=updated commits=$(printf '%s' "$commits" | one_line)"
else
  echo 'sync=latest commits=none'
fi

node_version=$(node -p "process.versions.node" 2>/dev/null) || fail 5 node 'node を起動できない'
node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=18) ? 0 : 1)' >/dev/null 2>&1; echo $?)
[ "$node_ok" -eq 0 ] || fail 5 node "Node 22.18+ が要る: $node_version"
run_quiet install "$pnpm_bin" -C "$main" install --frozen-lockfile
run_quiet build "$pnpm_bin" -C "$main" build
echo "build=ok node=$node_version"

if [ "$skip_server" = 1 ]; then
  echo 'server=skipped reason=test'
  echo 'status=ok'
  exit 0
fi

command -v lsof >/dev/null 2>&1 || { echo 'server=blocked reason=lsof-not-found'; echo 'status=ok'; exit 0; }
pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -z "$pid" ]; then
  echo "server=stopped port=$port action=none"
  echo 'status=ok'
  exit 0
fi
for bin in ps tmux curl; do command -v "$bin" >/dev/null 2>&1 || { echo "server=blocked reason=$bin-not-found"; echo 'status=ok'; exit 0; }; done

report_runtime() {
  settings="$tmp/settings.json"
  if curl -sS -m 10 -o "$settings" "http://127.0.0.1:$port/api/settings"; then
    digest_on=$(node -e 'const fs=require("node:fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(d.digest_on?"true":"false") } catch { process.exit(2) }' "$settings" 2>/dev/null)
    if [ "$digest_on" = false ]; then
      models="$tmp/models.json"
      provider=claude
      if curl -sS -m 5 -o "$models" http://127.0.0.1:11434/v1/models && node -e 'const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit((d.data||[]).some(x=>x.id==="qwen3:8b")?0:1)' "$models" 2>/dev/null; then
        provider=openai
      fi
      if [ "$provider" = openai ]; then payload='{"digest":true,"digest_provider":"openai","digest_model":"qwen3:8b"}'; else payload='{"digest":true,"digest_provider":"claude","digest_model":""}'; fi
      curl -sS -m 10 -X PUT -H 'Content-Type: application/json' -d "$payload" -o "$settings" "http://127.0.0.1:$port/api/settings" || true
    fi
    digest=$(node -e '
const fs=require("node:fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write("on="+(!!d.digest_on)+" provider="+(d.provider||"-")+" model="+(d.digest_model||d.model||"-")+" error="+(d.digest_error||"-")) } catch { process.exit(2) }
' "$settings" 2>/dev/null)
    echo "digest=${digest:-unreadable}"
  else
    echo 'digest=unavailable'
  fi

  headers="$tmp/headers"
  : >"$headers"
  curl -sS -m 10 -D "$headers" -o /dev/null "http://127.0.0.1:$port/api/sessions?days=1" || true
  header=$(awk 'tolower($1)=="x-sai-build:"{gsub("\r", "", $2); print $2; exit}' "$headers")
  dist=$(node -e 'const fs=require("node:fs"); try { process.stdout.write(String(fs.statSync(process.argv[1]).mtimeMs)) } catch { process.exit(1) }' "$main/web/dist/index.html" 2>/dev/null)
  match=$(node -e 'const a=Number(process.argv[1]), b=Number(process.argv[2]); process.stdout.write(Number.isFinite(a)&&Number.isFinite(b)&&Math.floor(a)===Math.floor(b)?"yes":"no")' "$header" "$dist")
  echo "verify=build-$match header=${header:--} dist=${dist:--}"
}

# node --watch は自分で再起動するので C-c を送らない。
up=$pid
watch=0
while [ -n "$up" ] && [ "$up" != 1 ]; do
  command=$(ps -o command= -p "$up" 2>/dev/null)
  case "$command" in *'node --watch'*) watch=1; break ;; esac
  up=$(ps -o ppid= -p "$up" 2>/dev/null | tr -d ' ')
done

lstart=$(ps -o lstart= -p "$pid" 2>/dev/null)
started_ms=$(node -e 'const n=Date.parse(process.argv[1]); if (!Number.isFinite(n)) process.exit(1); process.stdout.write(String(n))' "$lstart" 2>/dev/null) || { echo "server=blocked pid=$pid reason=start-time"; echo 'status=ok'; exit 0; }
ref="$tmp/server-start"
node -e 'const fs=require("node:fs"); const d=new Date(Number(process.argv[2])); fs.writeFileSync(process.argv[1], ""); fs.utimesSync(process.argv[1], d, d)' "$ref" "$started_ms"
newer=$(find "$main/server" "$main/shared" -name '*.ts' -newer "$ref" -print -quit 2>/dev/null)
if [ -z "$newer" ]; then
  echo "server=latest pid=$pid action=none"
  report_runtime
  echo 'status=ok'
  exit 0
fi
if [ "$watch" = 1 ]; then
  echo "server=watch pid=$pid action=self-restart"
  report_runtime
  echo 'status=ok'
  exit 0
fi

sessions="$tmp/sessions.json"
if ! curl -sS -m 10 -o "$sessions" "http://127.0.0.1:$port/api/sessions?days=7"; then
  echo "server=blocked pid=$pid reason=sessions-unavailable"
  echo 'status=ok'
  exit 0
fi
busy=$(node -e '
const fs=require("node:fs");
try {
  const d=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const agents=new Map((d.sessions||[]).map(s=>[s.id,s.agent]));
  const ids=[];
  for (const [id,r] of Object.entries(d.replying||{})) {
    if (r.via==="terminal" || r.failed) continue;
    const a=agents.get(id);
    if (a==="codex" || a===undefined) ids.push(id);
  }
  process.stdout.write(ids.slice(0,3).join(","));
} catch { process.exit(2); }
' "$sessions" 2>/dev/null)
busy_code=$?
if [ "$busy_code" -ne 0 ]; then
  echo "server=blocked pid=$pid reason=sessions-unreadable"
  echo 'status=ok'
  exit 0
fi
if [ -n "$busy" ]; then
  echo "server=deferred pid=$pid reason=codex-busy ids=$busy"
  echo 'status=ok'
  exit 0
fi

tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
pane=$(tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null | awk -v t="/dev/$tty" '$2==t{print $1; exit}')
if [ -z "$pane" ]; then
  echo "server=blocked pid=$pid reason=tmux-pane-not-found"
  echo 'status=ok'
  exit 0
fi
shell=$(tmux display -p -t "$pane" '#{pane_pid}' 2>/dev/null)
case "$shell" in ''|*[!0-9]*) echo "server=blocked pid=$pid reason=tmux-shell-not-found"; echo 'status=ok'; exit 0 ;; esac

tmux send-keys -t "$pane" C-c || { echo "server=blocked pid=$pid reason=ctrl-c-failed"; echo 'status=ok'; exit 0; }
i=0
kids=''
while [ "$i" -lt 200 ]; do
  kids=$(ps -A -o pid=,ppid=,command= 2>/dev/null | awk -v p="$shell" '$2==p{print}')
  [ -n "$kids" ] || break
  sleep 0.05
  i=$((i + 1))
done
if [ -n "$kids" ]; then
  echo "server=blocked pid=$pid reason=children-remain detail=$(printf '%s' "$kids" | one_line)"
  echo 'status=ok'
  exit 0
fi

tmux send-keys -t "$pane" C-u || { echo "server=blocked reason=clear-input-failed"; echo 'status=ok'; exit 0; }
tmux send-keys -t "$pane" 'pnpm start' Enter || { echo "server=blocked reason=start-input-failed"; echo 'status=ok'; exit 0; }
new=''
i=0
while [ "$i" -lt 200 ]; do
  new=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ -z "$new" ] || break
  sleep 0.05
  i=$((i + 1))
done
if [ -z "$new" ]; then
  echo "server=blocked pane=$pane reason=restart-timeout"
  echo 'status=ok'
  exit 0
fi

up=$new
while [ -n "$up" ] && [ "$up" != 1 ] && [ "$up" != "$shell" ]; do up=$(ps -o ppid= -p "$up" 2>/dev/null | tr -d ' '); done
if [ "$up" != "$shell" ]; then
  echo "server=blocked pid=$new pane=$pane reason=wrong-parent"
  echo 'status=ok'
  exit 0
fi
echo "server=restarted old=$pid new=$new pane=$pane"
report_runtime
echo 'status=ok'
