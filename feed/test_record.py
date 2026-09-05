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
import re
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

    def test_skip_env_records_nothing_and_exits_zero(self):
        # SAI が一言（digest）を作るために回す claude -p の子。フックが鳴っても何も書かない
        payload = {"hook_event_name": "Stop", "session_id": "skip-1", "transcript_path": "/nonexistent", "cwd": str(self.cwd)}
        result = run(stdin=json.dumps(payload), env={"AGENT_FEED_DIR": str(self.feed_dir), "AGENT_FEED_SKIP": "1"})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(read_rows(self.feed_dir), [])
        # 立っていなければ普通に記録する
        result = run(stdin=json.dumps(payload), env={"AGENT_FEED_DIR": str(self.feed_dir), "AGENT_FEED_SKIP": ""})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(read_rows(self.feed_dir)), 1)

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

    # -- 行の形の版

    def test_row_carries_record_version_matching_shared_types(self):
        """行の v は shared/types.ts の RECORD_VERSION と同じ値。行の形を変えたら両方上げる"""
        # どちらもソースを文字列で読む（record を import すると同じ秒内の書き換えで古い __pycache__ を拾うことがある）
        types_ts = (HERE.parent / "shared" / "types.ts").read_text(encoding="utf-8")
        match = re.search(r"export const RECORD_VERSION = (\d+)", types_ts)
        self.assertIsNotNone(match, "shared/types.ts に RECORD_VERSION が無い")
        in_py = re.search(r"^RECORD_VERSION = (\d+)$", RECORD.read_text(encoding="utf-8"), re.M)
        self.assertIsNotNone(in_py, "record.py に RECORD_VERSION が無い")
        payload = {"hook_event_name": "Stop", "session_id": "s", "cwd": str(self.cwd)}
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = read_rows(self.feed_dir)[0]
        self.assertEqual(row["v"], int(in_py.group(1)), "行の v は record.py の RECORD_VERSION")
        self.assertEqual(row["v"], int(match.group(1)), "shared/types.ts の RECORD_VERSION とずれている")

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
        self.assertEqual(row["user_text"], "背中のメニューを出して", "tool_result だけの user 行は飛ばす")
        self.assertRegex(row["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$")
        # 日付ファイル名は Asia/Tokyo
        today = datetime.now(JST).strftime("%Y-%m-%d")
        self.assertTrue((self.feed_dir / f"{today}.jsonl").exists())

    def _claude_row(self, entries: list[dict]) -> dict:
        transcript = Path(self.tmp.name) / "transcript.jsonl"
        write_jsonl(transcript, entries)
        payload = {"session_id": "s", "transcript_path": str(transcript), "cwd": str(self.cwd), "hook_event_name": "Stop"}
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return read_rows(self.feed_dir)[-1]

    def test_user_text_is_the_last_turn_input(self):
        # 2ターン目の入力を取る（1ターン目の「最初の依頼」ではない）
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "最初の依頼"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "1ターン目"}]}},
            {"type": "user", "message": {"role": "user", "content": "続きの依頼"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": [{"type": "text", "text": "ツールの戻り"}]}]}},
            {"type": "user", "isMeta": True, "message": {"role": "user", "content": [{"type": "text", "text": "Base directory for this skill: ..."}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "2ターン目"}]}},
        ])
        self.assertEqual(row["user_text"], "続きの依頼")
        self.assertEqual(row["first_user_text"], "最初の依頼")
        self.assertEqual(row["text"], "2ターン目")

    def test_user_text_skips_injected_rows_and_restores_slash_command(self):
        # 入力の後ろに差し込まれた system-reminder は飛ばして、その手前の入力を取る
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "直して"}]}},
            {"type": "user", "message": {"role": "user", "content": "<system-reminder>何か</system-reminder>"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "直した"}]}},
        ])
        self.assertEqual(row["user_text"], "直して")
        # スラッシュコマンドは「/名前 引数」の形に戻す。前のターンの入力までは遡らない
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "前のターン"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "前の返答"}]}},
            {"type": "user", "message": {"role": "user", "content": "<command-message>start-issue</command-message>\n<command-name>/start-issue</command-name>\n<command-args>19</command-args>"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "着手します"}]}},
        ])
        self.assertEqual(row["user_text"], "/start-issue 19")

    def test_user_text_is_empty_for_image_only_or_noise_only(self):
        # 画像だけの入力は空で止まる（前のターンの入力までは遡らない）
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "前のターン"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "前の返答"}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "image", "source": {}}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "画像を見た"}]}},
        ])
        self.assertEqual(row["user_text"], "")
        # 差し込みしか無ければ空
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "<local-command-stdout>...</local-command-stdout>"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "返答"}]}},
        ])
        self.assertEqual(row["user_text"], "")

    def test_user_text_is_clipped_to_2000(self):
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "い" * 5000}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}},
        ])
        self.assertEqual(len(row["user_text"]), 2000)

    def test_task_notification_turn_has_no_user_text(self):
        notice = "<task-notification>\n<task-id>a7e44ec6</task-id>\n<output-file>/tmp/x</output-file>\n</task-notification>"
        # 新しい版: promptSource: system が付く
        row = self._claude_row([
            {"type": "user", "promptSource": "typed", "message": {"role": "user", "content": "46に対応して"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "前の思考"}, {"type": "text", "text": "裏で回します"}]}},
            {"type": "user", "promptSource": "system", "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": notice}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "終わったので報告する"}, {"type": "text", "text": "終わりました"}]}},
        ])
        self.assertEqual(row["user_text"], "", "通知で始まったターンに人の入力は無い。手前の入力を拾って二重に出さない")
        self.assertEqual(row["text"], "終わりました")
        self.assertEqual(row["thinking"], "終わったので報告する", "思考も通知のターンの分だけ")
        self.assertEqual(row["first_user_text"], "46に対応して")
        # 古い版: promptSource が無い。本文の接頭辞で見る
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "やって"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "裏で回します"}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": notice}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "終わりました"}]}},
        ])
        self.assertEqual(row["user_text"], "")
        # 通知が 1 行目でもタイトルにはしない
        row = self._claude_row([
            {"type": "user", "promptSource": "system", "message": {"role": "user", "content": notice}},
            {"type": "user", "message": {"role": "user", "content": "最初の依頼"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}},
        ])
        self.assertEqual(row["first_user_text"], "最初の依頼")
        self.assertEqual(row["user_text"], "最初の依頼")

    def test_model_comes_from_the_last_assistant_row_and_skips_synthetic(self):
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "やって"}},
            {"type": "assistant", "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "text", "text": "前"}]}},
            {"type": "user", "message": {"role": "user", "content": "続けて"}},
            {"type": "assistant", "message": {"role": "assistant", "model": "claude-fable-5-1", "content": [{"type": "text", "text": "後"}]}},
            {"type": "assistant", "message": {"role": "assistant", "model": "<synthetic>", "content": [{"type": "text", "text": "合成"}]}},
        ])
        self.assertEqual(row["model"], "claude-fable-5-1", "最後の assistant 行のモデル。<synthetic> は飛ばす")
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "やって"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "モデル無し"}]}},
        ])
        self.assertEqual(row["model"], "")

    def test_thinking_joins_this_turns_blocks_and_skips_signature_only(self):
        think = lambda t: {"type": "thinking", "thinking": t, "signature": "sig"}
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "前のターン"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [think("前の思考"), {"type": "text", "text": "前の返答"}]}},
            {"type": "user", "message": {"role": "user", "content": "今のターン"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [think("まず調べる"), {"type": "tool_use", "name": "Read", "input": {}}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "..."}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [think(""), {"type": "thinking", "signature": "only"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [think("次に直す"), {"type": "text", "text": "直した"}]}},
        ])
        self.assertEqual(row["thinking"], "まず調べる\n\n次に直す", "前のターンの思考は拾わず、空のブロックは飛ばす")
        self.assertEqual(row["text"], "直した", "思考は text に混ざらない")

    def test_thinking_is_empty_when_absent_and_keeps_the_head_when_clipped(self):
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "やって"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "やった"}]}},
        ])
        self.assertEqual(row["thinking"], "")
        row = self._claude_row([
            {"type": "user", "message": {"role": "user", "content": "やって"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "頭" + "あ" * 5000 + "尾"}, {"type": "text", "text": "ok"}]}},
        ])
        self.assertEqual(len(row["thinking"]), 4000)
        self.assertTrue(row["thinking"].startswith("頭"), "切るときは先頭側を残す")

    def test_text_is_clipped_to_2000(self):
        transcript = Path(self.tmp.name) / "transcript.jsonl"
        write_jsonl(transcript, [
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "あ" * 5000}]}},
        ])
        payload = {"session_id": "s", "transcript_path": str(transcript), "cwd": str(self.cwd), "hook_event_name": "Stop"}
        run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(len(read_rows(self.feed_dir)[0]["text"]), 2000)

    # -- 端末の居場所（pane / pid）

    def test_row_carries_tmux_pane_and_session_pid(self):
        """フックは本体の子プロセスなので、TMUX_PANE と CLAUDE_PID（Codex は親 pid）で居場所が分かる"""
        env = dict(self.env, TMUX_PANE="%42", CLAUDE_PID="12345")
        result = run(stdin=json.dumps({"hook_event_name": "Stop", "session_id": "s", "cwd": str(self.cwd)}), env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = read_rows(self.feed_dir)[-1]
        self.assertEqual(row["pane"], "%42")
        self.assertEqual(row["pid"], 12345)
        # Codex の notify は codex 自身が spawn するので、親 = 本体。テストでは親はこのプロセス
        result = run(argv=[json.dumps({"type": "agent-turn-complete", "last-assistant-message": "yo", "cwd": str(self.cwd)})], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = read_rows(self.feed_dir)[-1]
        self.assertEqual(row["agent"], "codex")
        self.assertEqual(row["pane"], "%42")
        self.assertEqual(row["pid"], os.getpid())
        # tmux の外・CLAUDE_PID が無い
        env = {k: v for k, v in self.env.items()}
        env.update(TMUX_PANE="", CLAUDE_PID="")
        run(stdin=json.dumps({"hook_event_name": "Stop", "session_id": "s", "cwd": str(self.cwd)}), env=env)
        row = read_rows(self.feed_dir)[-1]
        self.assertEqual(row["pane"], "")
        self.assertEqual(row["pid"], 0)

    # -- Claude の待ち（許可待ち・質問待ち）と再開

    def _hook(self, payload: dict, transcript: list[dict] | None = None) -> subprocess.CompletedProcess:
        base = {"session_id": "sess-w", "cwd": str(self.cwd), "permission_mode": "default"}
        if transcript is not None:
            path = Path(self.tmp.name) / "transcript.jsonl"
            write_jsonl(path, transcript)
            base["transcript_path"] = str(path)
        base.update(payload)
        result = run(stdin=json.dumps(base), env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def _stop(self):
        self._hook({"hook_event_name": "Stop"}, transcript=[
            {"type": "user", "message": {"role": "user", "content": "最初の依頼"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "やった"}]}},
        ])

    def test_permission_request_records_waiting_row_and_prints_nothing(self):
        result = self._hook(
            {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "rm -rf node_modules", "description": "掃除"}},
            transcript=[{"type": "user", "message": {"role": "user", "content": "掃除して"}}],
        )
        # 観測するだけ。stdout に decision を出すと許可の判断に触ってしまう
        self.assertEqual(result.stdout, "")
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["event"], "PermissionRequest")
        self.assertEqual(row["text"], "許可待ち: Bash: rm -rf node_modules")
        self.assertEqual(row["user_text"], "", "待ちの行は自分側のバブルにしない")
        self.assertEqual(row["first_user_text"], "掃除して", "タイトル用の first_user_text は待ちの行にも載せる")
        self.assertEqual(row["session"], "sess-w")

    def test_ask_user_question_and_exit_plan_mode_summaries(self):
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion", "tool_input": {
            "questions": [{"question": "どのフレームワーク?", "header": "FW", "options": [{"label": "React"}]}, {"question": "型は?", "options": []}],
        }})
        self._hook({"hook_event_name": "PreToolUse", "tool_name": "ExitPlanMode", "tool_input": {
            "plan": "## 認証を直す\n\n1. トークンの検証を足す\n2. テスト\n3. README\n4. これは出ない",
        }})
        texts = [r["text"] for r in read_rows(self.feed_dir)]
        self.assertEqual(texts, [
            "質問: どのフレームワーク? / 型は?",
            "プランの承認待ち: ## 認証を直す\n1. トークンの検証を足す\n2. テスト",
        ])

    def test_pretooluse_for_other_tools_records_nothing(self):
        self._hook({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(read_rows(self.feed_dir), [])

    def test_waiting_text_is_clipped_to_300(self):
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "x" * 1000}})
        self.assertEqual(read_rows(self.feed_dir)[0]["text"], "許可待ち: Bash: " + "x" * 300)

    def test_notification_records_only_waiting_types(self):
        self._hook({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Claude is waiting for your input"})
        self._hook({"hook_event_name": "Notification", "notification_type": "elicitation_dialog", "message": "Server asks for a token"})
        for kind in ("auth_success", "agent_completed", "quota_auto_resume_fired", "elicitation_complete", "elicitation_response"):
            self._hook({"hook_event_name": "Notification", "notification_type": kind, "message": "..."})
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["Notification", "Notification"])
        self.assertEqual(rows[0]["text"], "入力待ち", "idle_prompt は英語の定型文を添えない")
        self.assertEqual(rows[1]["text"], "MCP サーバーの入力待ち: Server asks for a token")

    def test_permission_prompt_notification_is_dropped_after_permission_request(self):
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Edit", "tool_input": {"file_path": "/x/a.ts"}})
        self._hook({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"})
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1, "6秒後の補欠は重ねない")
        self.assertEqual(rows[0]["text"], "許可待ち: Edit: /x/a.ts")
        # 直前が許可待ちでなければ permission_prompt も書く（サンドボックスのネットワーク許可は PermissionRequest が鳴らない）
        self._stop()
        self._hook({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"})
        self.assertEqual(read_rows(self.feed_dir)[-1]["text"], "許可待ち: Claude needs your permission")

    def test_same_waiting_is_not_duplicated_but_a_new_one_is(self):
        ask = {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "赤か青か?"}]}}
        self._hook(ask)
        self._hook(dict(ask, hook_event_name="PermissionRequest"))
        self.assertEqual(len(read_rows(self.feed_dir)), 1, "PreToolUse と PermissionRequest の両方で鳴っても1行")
        # 拒否のあと別の許可を求めたら、それは新しい待ち
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual([r["text"] for r in read_rows(self.feed_dir)], ["質問: 赤か青か?", "許可待ち: Bash: git push"])

    def test_user_prompt_submit_records_the_prompt(self):
        self._hook({"hook_event_name": "UserPromptSubmit", "prompt": "  最初の依頼 "})
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["UserPromptSubmit"])
        self.assertEqual(rows[0]["text"], "", "返答はまだ無い")
        self.assertEqual(rows[0]["user_text"], "最初の依頼", "入力はその場で載せる。画面は Stop を待たずに自分側のバブルを出す")
        self.assertEqual(rows[0]["first_user_text"], "最初の依頼", "transcript がまだ無くてもタイトルが付く")
        self.assertEqual(rows[0]["session"], "sess-w")

        # 待ちの後の入力は、入力の行であり待ちの解消の合図でもある
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self._hook({"hook_event_name": "UserPromptSubmit", "prompt": "やめて"})
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["UserPromptSubmit", "PermissionRequest", "UserPromptSubmit"])
        self.assertEqual(rows[2]["user_text"], "やめて")

    def test_user_prompt_submit_with_task_notification_is_not_an_input(self):
        notice = "<task-notification>\n<task-id>b739ne05a</task-id>\n</task-notification>"
        self._hook({"hook_event_name": "UserPromptSubmit", "prompt": notice})
        self.assertEqual(read_rows(self.feed_dir), [], "通知は人の入力ではないので、待ってもいないなら書かない")
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self._hook({"hook_event_name": "UserPromptSubmit", "prompt": notice})
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["PermissionRequest", "UserPromptSubmit"])
        self.assertEqual(rows[1]["user_text"], "", "待ちの直後なら解消の合図としてだけ書く")

    def test_user_prompt_submit_without_prompt_only_resolves_a_wait(self):
        self._hook({"hook_event_name": "UserPromptSubmit", "prompt": ""})
        self.assertEqual(read_rows(self.feed_dir), [], "入力が空で、待ってもいないなら書くものが無い")
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self._hook({"hook_event_name": "UserPromptSubmit"})
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["PermissionRequest", "UserPromptSubmit"])
        self.assertEqual(rows[1]["user_text"], "", "合図だけの行")
        self._hook({"hook_event_name": "UserPromptSubmit"})
        self.assertEqual(len(read_rows(self.feed_dir)), 2, "直前が再開の行なら、もう待っていない")
    def test_stop_after_waiting_still_records_a_normal_turn(self):
        self._hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self._stop()
        rows = read_rows(self.feed_dir)
        self.assertEqual([r["event"] for r in rows], ["PermissionRequest", "Stop"])
        self.assertEqual(rows[1]["text"], "やった")
        self.assertEqual(rows[1]["user_text"], "最初の依頼")

    # -- Codex

    def _rollout(self, session_id: str, cwd: str, day: datetime | None = None, first_user: str = "最初の依頼", tail: list[dict] | None = None) -> Path:
        day = day or datetime.now(JST)
        path = self.codex_home / "sessions" / day.strftime("%Y/%m/%d") / f"rollout-{day.strftime('%Y-%m-%dT%H-%M-%S')}-{session_id}.jsonl"
        write_jsonl(path, [
            {"timestamp": day.isoformat(), "type": "session_meta", "payload": {"id": session_id, "cwd": cwd, "originator": "codex_cli_rs"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n</environment_context>"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": first_user}]}},
        ] + (tail or []))
        return path

    def test_codex_thinking_comes_from_reasoning_summary_of_the_last_turn(self):
        wanted = "0c6bd4c9-4444-4a2b-9c3d-dddddddddddd"
        self._rollout(wanted, str(self.cwd), tail=[
            {"type": "response_item", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "前のターンの要約"}], "encrypted_content": "x"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "前の返答"}]}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "続き"}},
            {"type": "response_item", "payload": {"type": "reasoning", "summary": [], "encrypted_content": "x"}},
            {"type": "response_item", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "**調べる**"}, {"type": "summary_text", "text": "直す"}], "encrypted_content": "x"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "直した"}]}},
        ])
        payload = {"type": "agent-turn-complete", "input-messages": ["続き"], "last-assistant-message": "直した"}
        result = subprocess.run(
            [sys.executable, str(RECORD), json.dumps(payload)],
            cwd=str(self.cwd), capture_output=True, text=True,
            env=dict(os.environ, **self.env), timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        row = read_rows(self.feed_dir)[-1]
        self.assertEqual(row["session"], wanted)
        self.assertEqual(row["thinking"], "**調べる**\n\n直す", "前のターンの要約は拾わない。summary が空の reasoning は飛ばす")
        self.assertEqual(row["model"], "", "turn_context が無ければ空")

    def test_codex_model_comes_from_the_last_turn_context(self):
        wanted = "0c6bd4c9-5555-4a2b-9c3d-eeeeeeeeeeee"
        self._rollout(wanted, str(self.cwd), tail=[
            {"type": "event_msg", "payload": {"type": "thread_settings_applied", "thread_settings": {"model": "gpt-5"}}},
            {"type": "turn_context", "payload": {"turn_id": "t1", "model": "gpt-5"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "続き"}},
            {"type": "turn_context", "payload": {"turn_id": "t2", "model": "gpt-5.6-sol"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}},
        ])
        payload = {"type": "agent-turn-complete", "input-messages": ["続き"], "last-assistant-message": "ok"}
        result = subprocess.run(
            [sys.executable, str(RECORD), json.dumps(payload)],
            cwd=str(self.cwd), capture_output=True, text=True,
            env=dict(os.environ, **self.env), timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(read_rows(self.feed_dir)[-1]["model"], "gpt-5.6-sol", "最後の turn_context のモデル")

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
        self.assertEqual(row["user_text"], "README を直して")
        self.assertEqual(row["repo"], "myrepo")

    TITLE_PROMPT = (
        "Generate a concise, single-line task title of at most 36 characters and under five words where possible. "
        "Start with an imperative verb. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\n"
        "User prompt:\nMarkdown適用不備をissue化"
    )

    def _codex(self, payload: dict) -> None:
        payload = {"type": "agent-turn-complete", "turn-id": "t", **payload}
        result = subprocess.run(
            [sys.executable, str(RECORD), json.dumps(payload)],
            cwd=str(self.cwd), capture_output=True, text=True,
            env=dict(os.environ, **self.env), timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_codex_internal_turns_are_not_recorded(self):
        wanted = "0c6bd4c9-5555-4a2b-9c3d-eeeeeeeeeeee"
        self._rollout(wanted, str(self.cwd), first_user="Markdown適用不備をissue化")
        # 進行中のセッションと同じ cwd で、タイトル生成の notify が来る
        self._codex({"input-messages": [self.TITLE_PROMPT], "last-assistant-message": '{"title":"Markdown適用不備をissue化"}'})
        self.assertEqual(read_rows(self.feed_dir), [], "タイトル生成は人のターンではないので行にしない")
        # 提案の生成と安全性チェックも同じ
        self._codex({"input-messages": ["# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do next."], "last-assistant-message": '{"suggestions":[]}'})
        self._codex({"input-messages": ["You are an expert at upholding safety and compliance standards for Codex ambient suggestions."], "last-assistant-message": '{"exclude":[]}'})
        self.assertEqual(read_rows(self.feed_dir), [])
        # 未知の内部プロンプトでも、返答が JSON だけで決まり文句があれば落とす
        self._codex({"input-messages": ["Summarize the thread in one line. Do not answer the request.\n\nThread:\n..."], "last-assistant-message": '{"summary":"x"}'})
        self.assertEqual(read_rows(self.feed_dir), [])
        # 本物のターンは今までどおり、その rollout のセッションに記録される
        self._codex({"input-messages": ["Markdown適用不備をissue化"], "last-assistant-message": "issue #101 を立てました。"})
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session"], wanted)
        self.assertEqual(rows[0]["user_text"], "Markdown適用不備をissue化")
        self.assertEqual(rows[0]["text"], "issue #101 を立てました。")

    def test_codex_json_answer_to_a_human_prompt_is_recorded(self):
        # 人が JSON で答えさせたターンは内部ではない（決まり文句が無い）
        self._codex({"input-messages": ["package.json の scripts を JSON で出して"], "last-assistant-message": '{"test":"node --test","lint":"oxlint"}'})
        rows = read_rows(self.feed_dir)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["text"], '{"test":"node --test","lint":"oxlint"}')

    def test_codex_accepts_stdin_too(self):
        wanted = "0c6bd4c9-3333-4a2b-9c3d-cccccccccccc"
        self._rollout(wanted, str(self.cwd))
        payload = {"type": "agent-turn-complete", "last-assistant-message": "done", "cwd": str(self.cwd)}
        result = run(stdin=json.dumps(payload), env=self.env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(read_rows(self.feed_dir)[0]["session"], wanted)
        self.assertEqual(read_rows(self.feed_dir)[0]["thinking"], "", "reasoning が無い rollout なら空")

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
        self.assertEqual(rows[0]["user_text"], "first ask")
        self.assertEqual(rows[1]["user_text"], "first ask", "input-messages はターンごとの入力なので毎行に載る")

    def test_codex_user_text_accepts_string_and_blocks(self):
        for inputs, want in (
            ("文字列のまま", "文字列のまま"),
            ([{"type": "text", "text": "ブロック"}, {"type": "input_text", "text": "2つ目"}], "ブロック\n2つ目"),
            (None, ""),
        ):
            payload = {"type": "agent-turn-complete", "last-assistant-message": "x", "cwd": str(self.cwd)}
            if inputs is not None:
                payload["input-messages"] = inputs
            run(stdin=json.dumps(payload), env=self.env)
            self.assertEqual(read_rows(self.feed_dir)[-1]["user_text"], want, repr(inputs))

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
