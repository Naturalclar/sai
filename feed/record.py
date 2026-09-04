#!/usr/bin/env python3
"""agent-feed: エージェントのターン完了（と、人を待って止まったこと）を JSONL に1行 append する。

Claude Code のフック（Stop / PermissionRequest / PreToolUse / Notification / UserPromptSubmit）と
Codex CLI の notify の両方から呼ばれる。基本は「1行 = 1ターン」で、Claude では加えて
「許可待ち・質問待ちで止まった」ときに待ちの1行、「人が答えて再開した」ときに再開の1行を書く。
集計も表示もここではやらない。

待ちのフック（PermissionRequest / PreToolUse）は stdout に decision を含む JSON を出したときだけ
許可の判断に影響する。このスクリプトは **観測するだけ** で、stdout には何も出さない。

このスクリプトは **絶対に失敗しない**（必ず exit 0）。フックが非0で終わると
エージェント本体を止めてしまうので、記録に失敗したら黙って諦める。
何が起きたか見たいときだけ AGENT_FEED_DEBUG=1 でエラーログが残る。

環境変数:
  AGENT_FEED_DIR    出力先ディレクトリ（既定 ~/.agent-feed）
  AGENT_FEED_DEBUG  1 なら例外を <dir>/record-errors.log に残す
  CODEX_HOME        Codex のホーム（既定 ~/.codex）
"""

from __future__ import annotations

import json
import os
import re
import select
import signal
import subprocess
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------- 設定

MAX_TEXT = 2000
MAX_USER_TEXT = 2000
MAX_THINKING = 4000
MAX_FIRST_USER = 300
SYNTH_GAP_SECONDS = 30 * 60
ROLLOUT_MAX_AGE_SECONDS = 48 * 3600
ROLLOUT_SCAN_LIMIT = 60
HARD_TIMEOUT_SECONDS = 15

_JST = timezone(timedelta(hours=9), "JST")


def tz() -> timezone:
    """日付の切り方は Asia/Tokyo 固定。tzdata が無い環境では +09:00 で代用する。"""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Tokyo")  # type: ignore[return-value]
    except Exception:
        return _JST


def feed_dir() -> Path:
    raw = os.environ.get("AGENT_FEED_DIR")
    return Path(raw).expanduser() if raw else Path.home() / ".agent-feed"


def codex_home() -> Path:
    raw = os.environ.get("CODEX_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".codex"


# ---------------------------------------------------------------- 入力

def _parse_obj(text: str):
    if not text:
        return None
    text = text.strip()
    if not text.startswith("{"):
        return None
    try:
        value = json.loads(text)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def read_payload(argv: list[str]) -> dict | None:
    """notify は「最後の引数」で来ることも stdin で来ることもある。両方受ける。

    先に argv を見るのは意図的で、Codex 経路で stdin を触らずに済ませるため。
    閉じられない stdin を read() するとフックがハングし、エージェント本体を
    止めてしまう。
    """
    for arg in reversed(argv):
        obj = _parse_obj(arg)
        if obj is not None:
            return obj
    return _read_stdin_obj()


def _read_stdin_obj(timeout: float = 5.0) -> dict | None:
    stream = sys.stdin
    if stream is None:
        return None
    try:
        if stream.isatty():
            return None
    except Exception:
        return None
    try:
        ready, _, _ = select.select([stream], [], [], timeout)
        if not ready:
            return None
    except Exception:
        pass  # select が使えない環境ではそのまま read に進む
    try:
        return _parse_obj(stream.read())
    except Exception:
        return None


# ---------------------------------------------------------------- 素性

def detect_agent(payload: dict) -> str:
    if payload.get("hook_event_name") or ("transcript_path" in payload and "session_id" in payload):
        return "claude"
    if payload.get("type") == "agent-turn-complete" or "last-assistant-message" in payload:
        return "codex"
    return "unknown"


def detect_event(payload: dict) -> str:
    for key in ("hook_event_name", "type"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown"


def detect_cwd(payload: dict) -> str:
    for key in ("cwd", "workspace", "working_directory"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return os.path.abspath(value)
    try:
        return os.path.abspath(os.getcwd())
    except Exception:
        return ""


def _git(cwd: str, *args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3
        )
    except Exception:
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def git_facts(cwd: str) -> tuple[str, str]:
    """(repo, branch) を返す。git が無い/リポジトリ外なら cwd の basename にする。"""
    repo = os.path.basename(cwd.rstrip(os.sep)) or "unknown"
    if not cwd or not os.path.isdir(cwd):
        return repo, ""
    toplevel = _git(cwd, "rev-parse", "--show-toplevel")
    if not toplevel:
        return repo, ""
    repo = os.path.basename(toplevel.rstrip("/")) or repo
    # symbolic-ref はコミットが1つも無い直後のブランチでも取れる。detached なら短い SHA
    branch = _git(cwd, "symbolic-ref", "--short", "-q", "HEAD") or _git(cwd, "rev-parse", "--short", "HEAD")
    return repo, branch


# ---------------------------------------------------------------- 本文抽出

def _blocks_to_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            if block.get("type") in ("text", "input_text", "output_text"):
                value = block.get("text")
                if isinstance(value, str):
                    parts.append(value)
    return "\n".join(p for p in parts if p).strip()


_NOISE_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<local-command-caveat>",
    "<user-prompt-submit-hook>",
    "<system-reminder>",
    "Caveat: The messages below",
    "[Request interrupted",
    "<environment_context>",
    "<user_instructions>",
    "<permissions instructions>",
)


def _is_noise(text: str) -> bool:
    stripped = text.strip()
    return not stripped or stripped.startswith(_NOISE_PREFIXES)


# Claude Code が人の代わりに差し込む「入力」。バックグラウンドのタスク（run_in_background の Bash や
# サブエージェント）が終わったときの通知など。新しいターンの起点にはなるが、人が打ったものではない
_SYSTEM_PROMPT_PREFIXES = ("<task-notification>",)


def _is_system_prompt(entry: dict, text: str) -> bool:
    """人ではなく Claude Code が差し込んだ入力の行か。

    新しい版の transcript は `promptSource: "system"`（`origin.kind: task-notification`）が付く。
    古い版には無いので本文の接頭辞でも見る。人の入力に promptSource: system は付かない。
    """
    if entry.get("promptSource") == "system":
        return True
    return text.lstrip().startswith(_SYSTEM_PROMPT_PREFIXES)


def _iter_jsonl(path: Path, limit: int | None = None):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if limit is not None and index >= limit:
                    return
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except Exception:
        return


def _role_and_text(entry: dict) -> tuple[str, str]:
    """Claude の transcript / Codex の rollout どちらの行からも (role, text) を取る。"""
    if entry.get("isMeta") or entry.get("isSidechain"):
        return "", ""
    node = entry
    payload = entry.get("payload")
    if isinstance(payload, dict):
        node = payload
    message = node.get("message")
    if isinstance(message, dict):
        role = message.get("role") or node.get("role") or node.get("type") or ""
        return str(role), _blocks_to_text(message.get("content"))
    if isinstance(message, str):
        # Codex の event_msg 系: {"type": "user_message", "message": "..."}
        return str(node.get("role") or node.get("type") or ""), message
    role = node.get("role") or node.get("type") or entry.get("type") or ""
    return str(role), _blocks_to_text(node.get("content"))


def last_assistant_text(path: Path) -> str:
    entries = list(_iter_jsonl(path))
    for entry in reversed(entries):
        role, text = _role_and_text(entry)
        if role == "assistant" and text.strip():
            return text.strip()
    return ""


_COMMAND_NAME_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
_COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)


def _slash_command(text: str) -> str:
    """スラッシュコマンドで始めたターンの user 行は `<command-name>/foo</command-name>` の形。
    人が打ったのは `/foo 引数` なので、それを復元する。コマンドでなければ空。"""
    match = _COMMAND_NAME_RE.search(text)
    if not match:
        return ""
    name = match.group(1).strip()
    args = _COMMAND_ARGS_RE.search(text)
    tail = args.group(1).strip() if args else ""
    return f"{name} {tail}".strip() if name else ""


def _is_tool_result_only(content) -> bool:
    """ツールの戻りは role=user の行として書かれる。人の入力と区別するため、
    content が tool_result ブロックだけならそれとみなす。"""
    if not isinstance(content, list) or not content:
        return False
    return all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def last_user_text(path: Path) -> str:
    """Claude の transcript から、最後のターンの入力（人が打った文）を取る。

    末尾から遡って最初に見つかる「人の入力」を返す。ツールの戻り（tool_result だけの
    user 行）と isMeta の行は飛ばす。`<system-reminder>` や `[Request interrupted` の
    ような差し込みも飛ばして、その手前の入力を探す。スラッシュコマンドは `/foo 引数`
    の形に戻す。画像だけの入力（text ブロックが無い）は空文字で止まる。

    Claude Code が差し込んだ入力（`<task-notification>`、promptSource: system）に当たったら
    空文字で止まる。それは新しいターンの起点で、そのターンに人の入力は無い。飛ばして手前の
    入力を探すと、前のターンの入力が 2 回目の Stop にも載って画面で二重に出る。
    """
    entries = list(_iter_jsonl(path))
    for entry in reversed(entries):
        if entry.get("isMeta") or entry.get("isSidechain"):
            continue
        message = entry.get("message")
        if entry.get("type") != "user" or not isinstance(message, dict):
            continue
        content = message.get("content")
        if _is_tool_result_only(content):
            continue
        text = _blocks_to_text(content).strip()
        if _is_system_prompt(entry, text):
            return ""
        command = _slash_command(text)
        if command:
            return command
        if text and _is_noise(text):
            continue
        return text
    return ""


def _is_prompt_row(entry: dict) -> bool:
    """人の入力の行か（ツールの戻りや差し込みではない）。ターンの境目を見つけるのに使う。"""
    if entry.get("isMeta") or entry.get("isSidechain"):
        return False
    message = entry.get("message")
    if entry.get("type") != "user" or not isinstance(message, dict):
        return False
    content = message.get("content")
    if _is_tool_result_only(content):
        return False
    text = _blocks_to_text(content).strip()
    if _is_system_prompt(entry, text):
        return True  # 人の入力ではないが、ターンの起点ではある
    if text and _is_noise(text) and not _slash_command(text):
        return False
    return True


def last_turn_thinking(path: Path) -> str:
    """Claude の transcript から、最後のターンの思考（thinking ブロック）を取る。

    末尾から遡って、人の入力の行に当たるまでの assistant 行の thinking ブロックを集め、
    元の順に `\n\n` で繋ぐ。本文が空のブロック（signature だけ）は飛ばす。
    `text`（返答）とは別に拾うので、_blocks_to_text() には混ざらない。
    """
    entries = list(_iter_jsonl(path))
    parts: list[str] = []
    for entry in reversed(entries):
        if _is_prompt_row(entry):
            break
        if entry.get("isMeta") or entry.get("isSidechain") or entry.get("type") != "assistant":
            continue
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if isinstance(block, dict) and block.get("type") == "thinking":
                value = block.get("thinking")
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
    parts.reverse()
    return "\n\n".join(parts)


def rollout_last_turn_reasoning(path: Path) -> str:
    """Codex の rollout から、最後のターンの reasoning の summary を取る。

    末尾から遡って、人の入力（event_msg の user_message か role=user の message）に当たるまでの
    `reasoning` の `summary[].text` を集め、元の順に `\n\n` で繋ぐ。既定の設定では summary は
    空（本文は encrypted_content）なので、たいてい空文字になる。
    """
    entries = list(_iter_jsonl(path))
    parts: list[str] = []
    for entry in reversed(entries):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        kind = payload.get("type")
        if kind == "user_message":
            break
        if kind == "message" and payload.get("role") == "user":
            text = _blocks_to_text(payload.get("content"))
            if not _is_noise(text):
                break
            continue
        if kind == "reasoning":
            summary = payload.get("summary")
            if isinstance(summary, list):
                for item in reversed(summary):
                    value = item.get("text") if isinstance(item, dict) else item
                    if isinstance(value, str) and value.strip():
                        parts.append(value.strip())
    parts.reverse()
    return "\n\n".join(parts)


def first_user_text(path: Path, limit: int = 400) -> str:
    for entry in _iter_jsonl(path, limit=limit):
        role, text = _role_and_text(entry)
        if role in ("user", "user_message") and not _is_noise(text) and not _is_system_prompt(entry, text):
            return text.strip()
    return ""


def clip(text: str, size: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= size else text[:size]


# ---------------------------------------------------------------- 待ち（人を待って止まった）

MAX_WAITING_TEXT = 300

# PreToolUse はツール呼び出しごとに鳴るので、人を待つこの2つだけを待ちとして扱う。
# 他のツールで呼ばれても何も書かない（フック設定の matcher を広く書いても大丈夫なように）
_PRETOOL_WAITING_TOOLS = ("AskUserQuestion", "ExitPlanMode")

# Notification のうち「人を待っている」型だけ。それ以外（auth_success, agent_completed, quota_* など）は書かない。
# permission_prompt は PermissionRequest と同じ場面で6秒後に鳴る補欠なので、直前が許可待ちの行なら重ねない
_WAITING_NOTIFICATIONS = {
    "permission_prompt": "許可待ち",
    "idle_prompt": "入力待ち",
    "agent_needs_input": "入力待ち（バックグラウンドのセッション）",
    "elicitation_dialog": "MCP サーバーの入力待ち",
    "elicitation_url_dialog": "ブラウザで開くのを待っている",
}
# 型だけで分かる待ちは message（英語の定型文）を添えない
_NOTIFICATION_WITHOUT_MESSAGE = ("idle_prompt", "agent_needs_input")


def _first_lines(text: str, n: int) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return "\n".join(lines[:n])


def tool_summary(tool_name: str, tool_input) -> str:
    """許可ダイアログに出るのと同じ「何をしようとしているか」を1つの文字列に。300文字で切る。"""
    if not isinstance(tool_input, dict):
        tool_input = {}
    if tool_name == "AskUserQuestion":
        questions = tool_input.get("questions")
        if isinstance(questions, list):
            texts = [q.get("question") for q in questions if isinstance(q, dict) and isinstance(q.get("question"), str)]
            if texts:
                return clip(" / ".join(t.strip() for t in texts if t.strip()), MAX_WAITING_TEXT)
    elif tool_name == "ExitPlanMode":
        plan = tool_input.get("plan")
        if isinstance(plan, str) and plan.strip():
            return clip(_first_lines(plan, 3), MAX_WAITING_TEXT)
    for key in ("command", "file_path", "notebook_path", "url", "description", "prompt", "pattern", "query"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return clip(value.strip(), MAX_WAITING_TEXT)
    try:
        return clip(json.dumps(tool_input, ensure_ascii=False, sort_keys=True), MAX_WAITING_TEXT)
    except Exception:
        return ""


def waiting_text(payload: dict) -> str | None:
    """待ちの行の text。「何を待っているか」を日本語の接頭辞付きで返す。待ちでなければ None（行を書かない）。"""
    event = detect_event(payload)
    if event in ("PermissionRequest", "PreToolUse"):
        tool_name = payload.get("tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            return None
        if event == "PreToolUse" and tool_name not in _PRETOOL_WAITING_TOOLS:
            return None
        summary = tool_summary(tool_name, payload.get("tool_input"))
        if tool_name == "AskUserQuestion":
            return f"質問: {summary}" if summary else "質問に答えるのを待っている"
        if tool_name == "ExitPlanMode":
            return f"プランの承認待ち: {summary}" if summary else "プランの承認待ち"
        return f"許可待ち: {tool_name}: {summary}" if summary else f"許可待ち: {tool_name}"
    if event == "Notification":
        kind = payload.get("notification_type")
        label = _WAITING_NOTIFICATIONS.get(kind) if isinstance(kind, str) else None
        if not label:
            return None
        message = payload.get("message")
        if kind not in _NOTIFICATION_WITHOUT_MESSAGE and isinstance(message, str) and message.strip():
            return clip(f"{label}: {message.strip()}", MAX_WAITING_TEXT)
        return label
    return None


def is_waiting_event(event: str) -> bool:
    return event in ("PermissionRequest", "PreToolUse", "Notification")


def last_session_row(directory: Path, now: datetime, session: str, repo: str) -> dict | None:
    """同じ (セッション, リポジトリ) の直前の行。待ちの重複と、再開の行を書くかの判断に使う。"""
    previous = None
    for row in _recent_rows(directory, now):
        if row.get("session") == session and row.get("repo") == repo:
            previous = row
    return previous


def skip_waiting(previous: dict | None, event: str, payload: dict, text: str) -> bool:
    """待ちの行を重ねない。
    - 直前が同じ text の待ち → 同じ待ちが二重に鳴った（PermissionRequest と PreToolUse の両方など）
    - 直前が許可待ち（PermissionRequest / PreToolUse）で、今回が Notification の permission_prompt → 6秒後の補欠
    """
    if not previous or not is_waiting_event(str(previous.get("event") or "")):
        return False
    if previous.get("text") == text:
        return True
    if event == "Notification" and payload.get("notification_type") == "permission_prompt":
        return previous.get("event") in ("PermissionRequest", "PreToolUse")
    return False


# ---------------------------------------------------------------- Codex セッションID

_UUID_RE = re.compile(
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)


def _rollout_id(path: Path) -> str:
    match = _UUID_RE.search(path.name)
    if match:
        return match.group(1)
    return path.name[len("rollout-"):-len(".jsonl")] if path.name.startswith("rollout-") else path.stem


def _rollout_cwd(path: Path) -> str:
    for entry in _iter_jsonl(path, limit=8):
        for node in (entry, entry.get("payload") if isinstance(entry.get("payload"), dict) else None):
            if not isinstance(node, dict):
                continue
            value = node.get("cwd")
            if isinstance(value, str) and value:
                return os.path.abspath(value)
            git = node.get("git")
            if isinstance(git, dict):
                value = git.get("repository_path")
                if isinstance(value, str) and value:
                    return os.path.abspath(value)
    return ""


def resolve_codex_session(cwd: str) -> str:
    """cwd が一致する直近の rollout ファイルからセッションIDを引く。

    session_index.jsonl は壊れていることがある（`codex resume --all` が
    「No sessions yet」になる既知の問題）ので、索引ではなくファイル名から取る。
    """
    root = codex_home() / "sessions"
    if not cwd or not root.is_dir():
        return ""
    cutoff = datetime.now().timestamp() - ROLLOUT_MAX_AGE_SECONDS
    candidates: list[tuple[float, Path]] = []
    try:
        for path in root.rglob("rollout-*.jsonl"):
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime >= cutoff:
                candidates.append((mtime, path))
            if len(candidates) > 5000:
                break
    except Exception:
        return ""
    candidates.sort(key=lambda item: item[0], reverse=True)
    # macOS の /var → /private/var のように、片方だけシンボリックリンクを解決した
    # パスになっていることがあるので、比較のときだけ realpath に揃える（記録する cwd は変えない）
    wanted = os.path.realpath(cwd)
    for _, path in candidates[:ROLLOUT_SCAN_LIMIT]:
        found = _rollout_cwd(path)
        if found and os.path.realpath(found) == wanted:
            return _rollout_id(path)
    return ""


def find_codex_rollout(session_id: str) -> Path | None:
    if not session_id:
        return None
    root = codex_home() / "sessions"
    if not root.is_dir():
        return None
    try:
        for path in root.rglob(f"*{session_id}*.jsonl"):
            return path
    except Exception:
        return None
    return None


# ---------------------------------------------------------------- 合成セッション

def _recent_rows(directory: Path, now: datetime, days: int = 2) -> list[dict]:
    rows: list[dict] = []
    for offset in range(days):
        path = directory / f"{(now - timedelta(days=offset)).strftime('%Y-%m-%d')}.jsonl"
        if path.exists():
            rows.extend(_iter_jsonl(path))
    return rows


def synth_session(directory: Path, now: datetime, repo: str, cwd: str, agent: str) -> str:
    """(repo, cwd, agent) が同じで前の行から30分以内なら、同じセッションとみなす。"""
    previous = None
    for row in _recent_rows(directory, now):
        if row.get("repo") == repo and row.get("cwd") == cwd and row.get("agent") == agent:
            previous = row
    if previous:
        try:
            last = datetime.fromisoformat(str(previous.get("ts")))
            if (now - last).total_seconds() <= SYNTH_GAP_SECONDS:
                session = previous.get("session")
                if isinstance(session, str) and session:
                    return session
        except Exception:
            pass
    return f"synth-{repo}-{now.strftime('%Y%m%dT%H%M%S')}"


# ---------------------------------------------------------------- 行の組み立て

def build_row(payload: dict, now: datetime, directory: Path) -> dict | None:
    agent = detect_agent(payload)
    if agent == "unknown" and not payload:
        return None

    cwd = detect_cwd(payload)
    repo, branch = git_facts(cwd)
    text = ""
    user_text = ""
    thinking = ""
    first_user = ""
    session = ""
    source = ""

    event = detect_event(payload)
    waiting = None

    if agent == "claude":
        session_id = payload.get("session_id")
        if isinstance(session_id, str) and session_id:
            session, source = session_id, "payload"
        if is_waiting_event(event):
            # 待ちの行。text は「何を待っているか」で、待ちでない型（auth_success など）なら書かない
            waiting = waiting_text(payload)
            if waiting is None:
                return None
        transcript = payload.get("transcript_path")
        if isinstance(transcript, str) and transcript:
            path = Path(transcript).expanduser()
            # タイトル用の first_user_text はどの行にも載せる。本文と入力はターン完了の行だけ
            first_user = first_user_text(path)
            if event not in ("UserPromptSubmit",) and waiting is None:
                text = last_assistant_text(path)
                user_text = last_user_text(path)
                thinking = last_turn_thinking(path)
        if event == "UserPromptSubmit":
            # 入力した瞬間の行。本文は無く、打った文を user_text にそのまま載せる
            # （画面は Stop を待たずに自分側のバブルを出す）。transcript にはまだ無いので payload から
            # バックグラウンドの通知（<task-notification>）でも鳴るが、それは人の入力ではないので載せない
            # （user_text が空の行の扱いに落ちる: 直前が待ちなら合図としてだけ書く、それ以外は書かない）
            prompt = payload.get("prompt")
            if isinstance(prompt, str) and not _is_system_prompt(payload, prompt):
                user_text = prompt.strip()
            if not first_user:
                first_user = user_text
        if waiting is not None:
            text = waiting

    elif agent == "codex":
        value = payload.get("last-assistant-message") or payload.get("last_assistant_message")
        if isinstance(value, str):
            text = value
        session_id = payload.get("session_id") or payload.get("session-id")
        if isinstance(session_id, str) and session_id:
            session, source = session_id, "payload"
        else:
            resolved = resolve_codex_session(cwd)
            if resolved:
                session, source = resolved, "rollout"
        # input-messages はそのターンの入力そのもの（文字列の配列。念のため文字列も受ける）
        inputs = payload.get("input-messages") or payload.get("input_messages")
        if isinstance(inputs, (list, str)):
            user_text = _blocks_to_text(inputs)
        rollout = find_codex_rollout(session) if source == "rollout" else None
        if rollout is not None:
            first_user = first_user_text(rollout)
            thinking = rollout_last_turn_reasoning(rollout)
        if not first_user:
            first_user = user_text

    if not session:
        session = synth_session(directory, now, repo, cwd, agent)
        source = "synth"

    if agent == "claude" and event == "UserPromptSubmit" and not user_text:
        # 入力が取れなかった行は、直前の待ちを解消する合図としてだけ書く。それ以外は書くものが無い
        previous = last_session_row(directory, now, session, repo)
        if not (previous and is_waiting_event(str(previous.get("event") or ""))):
            return None
    if agent == "claude" and waiting is not None:
        previous = last_session_row(directory, now, session, repo)
        if skip_waiting(previous, event, payload, waiting):
            return None

    return {
        "ts": now.isoformat(timespec="seconds"),
        "agent": agent,
        "repo": repo,
        "branch": branch,
        "session": session,
        "session_source": source,
        "cwd": cwd,
        "event": event,
        "text": clip(text, MAX_TEXT),
        # そのターンの入力（人が打った文）。チャットで自分側のバブルになる
        "user_text": clip(user_text, MAX_USER_TEXT),
        # そのターンの思考（Claude の thinking / Codex の reasoning summary）。無いことが多い。
        # 長ければ先頭側を残す（考え始めが「何をしようとしたか」を表す）。セッション画面だけに出す
        "thinking": clip(thinking, MAX_THINKING),
        # 一覧のタイトル用。集計側は「一番古い行の値」を使うので、1行目だけに
        # 焼くのではなく毎行に載せる。そうしないと days で切った窓の外に
        # セッションの1行目が落ちたときにタイトルが消える。
        "first_user_text": clip(first_user, MAX_FIRST_USER),
    }


def append_row(directory: Path, row: dict, now: datetime) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = directory / f"{now.strftime('%Y-%m-%d')}.jsonl"
    line = json.dumps(row, ensure_ascii=False) + "\n"
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        try:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX)
        except Exception:
            pass
        os.write(handle, line.encode("utf-8"))
    finally:
        os.close(handle)
    return path


# ---------------------------------------------------------------- 入口

def _log_error(directory: Path) -> None:
    if os.environ.get("AGENT_FEED_DEBUG") != "1":
        return
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "record-errors.log").open("a", encoding="utf-8") as handle:
            handle.write(f"--- {datetime.now().isoformat()}\n")
            handle.write(traceback.format_exc())
    except Exception:
        pass


def main(argv: list[str]) -> None:
    payload = read_payload(argv)
    if not payload:
        return
    directory = feed_dir()
    now = datetime.now(tz())
    row = build_row(payload, now, directory)
    if row:
        append_row(directory, row, now)


def _bail(signum, frame):  # pragma: no cover - タイムアウト時の保険
    os._exit(0)


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGALRM, _bail)
        signal.alarm(HARD_TIMEOUT_SECONDS)
    except Exception:
        pass
    try:
        main(sys.argv[1:])
    except BaseException:
        try:
            _log_error(feed_dir())
        except BaseException:
            pass
    sys.exit(0)
