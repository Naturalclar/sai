#!/usr/bin/env python3
"""agent-feed: エージェントのターン完了を JSONL に1行 append する。

Claude Code の Stop フックと Codex CLI の notify の両方から呼ばれる。
どちらの経路でも「1行 = 1ターン」で、集計も表示もここではやらない。

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


def first_user_text(path: Path, limit: int = 400) -> str:
    for entry in _iter_jsonl(path, limit=limit):
        role, text = _role_and_text(entry)
        if role in ("user", "user_message") and not _is_noise(text):
            return text.strip()
    return ""


def clip(text: str, size: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= size else text[:size]


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
    for _, path in candidates[:ROLLOUT_SCAN_LIMIT]:
        if _rollout_cwd(path) == cwd:
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
    first_user = ""
    session = ""
    source = ""

    if agent == "claude":
        session_id = payload.get("session_id")
        if isinstance(session_id, str) and session_id:
            session, source = session_id, "payload"
        transcript = payload.get("transcript_path")
        if isinstance(transcript, str) and transcript:
            path = Path(transcript).expanduser()
            text = last_assistant_text(path)
            first_user = first_user_text(path)

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
        rollout = find_codex_rollout(session) if source == "rollout" else None
        if rollout is not None:
            first_user = first_user_text(rollout)
        if not first_user:
            inputs = payload.get("input-messages") or payload.get("input_messages")
            if isinstance(inputs, list):
                first_user = _blocks_to_text(inputs)
            elif isinstance(inputs, str):
                first_user = inputs

    if not session:
        session = synth_session(directory, now, repo, cwd, agent)
        source = "synth"

    return {
        "ts": now.isoformat(timespec="seconds"),
        "agent": agent,
        "repo": repo,
        "branch": branch,
        "session": session,
        "session_source": source,
        "cwd": cwd,
        "event": detect_event(payload),
        "text": clip(text, MAX_TEXT),
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
