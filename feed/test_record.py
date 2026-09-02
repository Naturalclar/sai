#!/usr/bin/env python3
"""record.py のテスト。`python3 -m unittest feed.test_record` か直接実行。

押さえること:
- 壊れた入力を食わせても exit 0 で、行が増えない
- Claude の Stop で session_source が payload になる
- Codex で rollout からセッションIDが引ける（session_source=rollout）
- 引けなければ30分ギャップで合成し、続けて呼ぶと同じIDになる
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = HERE / "record.py"
JST = timezone(timedelta(hours=9))


def run(stdin: str | None = None, argv: list[str] | None = None, env: dict | None = None):
    merged = dict(os.environ)
    merged.update(env or {})
    return subprocess.run(
        [sys.executable, str(RECORD)] + (argv or []),
        input=stdin,
        capture_output=True,
        text=True,
        env=merged,
        timeout=30,
    )


def read_rows(feed_dir: Path) -> list[dict]:
    rows = []
    for path in sorted(feed_dir.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.feed_dir = root / "feed"
        self.codex_home = root / "codex"
        self.cwd = root / "work" / "myrepo"
        self.cwd.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "-b", "feature/x", str(self.cwd)], check=True)
        self.env = {
            "AGENT_FEED_DIR": str(self.feed_dir),
            "CODEX_HOME": str(self.codex_home),
            "AGENT_FEED_DEBUG": "1",
        }

    def tearDown(self):
        self.tmp.cleanup()

    # -- 絶対に失敗しない

    def test_garbage_stdin_exits_zero_and_records_nothing(self):
        result = run(stdin="not json at all", env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(read_rows(self.feed_dir) if self.feed_dir.exists() else [], [])

    def test_garbage_argv_exits_zero(self):
        result = run(argv=["{{{{ broken"], env=self.env)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.feed_dir.exists())

    def test_empty_input_exits_zero(self):
        result = run(stdin="", env=self.env)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.feed_dir.exists())

    def test_json_array_is_ignored(self):
        result = run(stdin="[1,2,3]", env=self.env)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.feed_dir.exists())

    def test_unwritable_feed_dir_exits_zero(self):
        blocker = Path(self.tmp.name) / "blocker"
        blocker.write_text("i am a file, not a directory")
        env = dict(self.env, AGENT_FEED_DIR=str(blocker))
        result = run(stdin=json.dumps({"hook_event_name": "Stop", "session_id": "s", "cwd": str(self.cwd)}), env=env)
        self.assertEqual(result.returncode, 0)

    def test_missing_transcript_still_records(self):
        payload = {
            "hook_event_name": "Stop",
            "session_id": "sess-1",
            "cwd": str(self.cwd),
            "transcript_path": str(Path(self.tmp.name) / "does-not-exist.jsonl"),
        }
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0)
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["text"], "")

    # -- Claude

    def test_claude_stop_records_payload_session(self):
        transcript = Path(self.tmp.name) / "transcript.jsonl"
        write_jsonl(transcript, [
            {"type": "user", "isMeta": True, "message": {"role": "user", "content": "<command-name>/clear</command-name>"}},
            {"type": "user", "message": {"role": "user", "content": "背中のメニューを出して"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "..."}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "途中の発話"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "背中のメニューを出した。\nワンハンドロウ 10kg×10×3。"}]}},
        ])
        payload = {
            "session_id": "sess-abc",
            "transcript_path": str(transcript),
            "cwd": str(self.cwd),
            "hook_event_name": "Stop",
            "stop_hook_active": False,
        }
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["agent"], "claude")
        self.assertEqual(row["event"], "Stop")
        self.assertEqual(row["session"], "sess-abc")
        self.assertEqual(row["session_source"], "payload")
        self.assertEqual(row["repo"], "myrepo")
        self.assertEqual(row["branch"], "feature/x")
        self.assertEqual(row["cwd"], str(self.cwd))
        self.assertEqual(row["text"], "背中のメニューを出した。\nワンハンドロウ 10kg×10×3。")
        self.assertEqual(row["first_user_text"], "背中のメニューを出して")
        self.assertRegex(row["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$")
        # 日付ファイル名は Asia/Tokyo
        today = datetime.now(JST).strftime("%Y-%m-%d")
        self.assertTrue((self.feed_dir / f"{today}.jsonl").exists())

    def test_text_is_clipped_to_2000(self):
        transcript = Path(self.tmp.name) / "transcript.jsonl"
        write_jsonl(transcript, [
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "あ" * 5000}]}},
        ])
        payload = {"session_id": "s", "transcript_path": str(transcript), "cwd": str(self.cwd), "hook_event_name": "Stop"}
        run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(len(read_rows(self.feed_dir)[0]["text"]), 2000)

    # -- Codex

    def _rollout(self, session_id: str, cwd: str, day: datetime | None = None, first_user: str = "最初の依頼") -> Path:
        day = day or datetime.now(JST)
        path = self.codex_home / "sessions" / day.strftime("%Y/%m/%d") / f"rollout-{day.strftime('%Y-%m-%dT%H-%M-%S')}-{session_id}.jsonl"
        write_jsonl(path, [
            {"timestamp": day.isoformat(), "type": "session_meta", "payload": {"id": session_id, "cwd": cwd, "originator": "codex_cli_rs"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n</environment_context>"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": first_user}]}},
        ])
        return path

    def test_codex_resolves_session_from_rollout(self):
        wanted = "0c6bd4c9-1111-4a2b-9c3d-aaaaaaaaaaaa"
        other = "0c6bd4c9-2222-4a2b-9c3d-bbbbbbbbbbbb"
        # 別 cwd のほうが新しくても、cwd が一致するものを選ぶ
        self._rollout(wanted, str(self.cwd), first_user="README を直して")
        newer = self._rollout(other, "/somewhere/else")
        os.utime(newer, None)
        payload = {
            "type": "agent-turn-complete",
            "turn-id": "t1",
            "input-messages": ["README を直して"],
            "last-assistant-message": "README を直した。",
        }
        result = subprocess.run(
            [sys.executable, str(RECORD), json.dumps(payload)],
            cwd=str(self.cwd), capture_output=True, text=True,
            env=dict(os.environ, **self.env), timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["agent"], "codex")
        self.assertEqual(row["event"], "agent-turn-complete")
        self.assertEqual(row["session"], wanted)
        self.assertEqual(row["session_source"], "rollout")
        self.assertEqual(row["text"], "README を直した。")
        self.assertEqual(row["first_user_text"], "README を直して")
        self.assertEqual(row["repo"], "myrepo")

    def test_codex_accepts_stdin_too(self):
        wanted = "0c6bd4c9-3333-4a2b-9c3d-cccccccccccc"
        self._rollout(wanted, str(self.cwd))
        payload = {"type": "agent-turn-complete", "last-assistant-message": "done", "cwd": str(self.cwd)}
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(read_rows(self.feed_dir)[0]["session"], wanted)

    def test_codex_without_rollout_synthesizes_and_reuses_within_gap(self):
        payload = {"type": "agent-turn-complete", "last-assistant-message": "one", "cwd": str(self.cwd), "input-messages": ["first ask"]}
        run(stdin=json.dumps(payload), env=self.env)
        payload["last-assistant-message"] = "two"
        run(stdin=json.dumps(payload), env=self.env)
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]["session"].startswith("synth-myrepo-"))
        self.assertEqual(rows[0]["session_source"], "synth")
        self.assertEqual(rows[0]["session"], rows[1]["session"], "30分以内なら同じセッション")
        self.assertEqual(rows[0]["first_user_text"], "first ask")

    def test_synth_starts_new_session_after_gap(self):
        self.feed_dir.mkdir(parents=True)
        old_ts = (datetime.now(JST) - timedelta(minutes=45)).isoformat(timespec="seconds")
        today = datetime.now(JST).strftime("%Y-%m-%d")
        write_jsonl(self.feed_dir / f"{today}.jsonl", [{
            "ts": old_ts, "agent": "codex", "repo": "myrepo", "branch": "feature/x",
            "session": "synth-myrepo-old", "session_source": "synth", "cwd": str(self.cwd),
            "event": "agent-turn-complete", "text": "old", "first_user_text": "",
        }])
        payload = {"type": "agent-turn-complete", "last-assistant-message": "new", "cwd": str(self.cwd)}
        run(stdin=json.dumps(payload), env=self.env)
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[1]["session"], "synth-myrepo-old")

    def test_unknown_payload_is_recorded_as_unknown(self):
        result = run(stdin=json.dumps({"hello": "world", "cwd": str(self.cwd)}), env=self.env)
        self.assertEqual(result.returncode, 0)
        rows = read_rows(self.feed_dir)
        self.assertEqual(rows[0]["agent"], "unknown")
        self.assertEqual(rows[0]["session_source"], "synth")


if __name__ == "__main__":
    unittest.main()
