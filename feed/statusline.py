#!/usr/bin/env python3
"""Claude の使用率をステータスライン経由で受け取って記録する（#250）。

`~/.claude/settings.json` の `statusLine` に指定すると、Claude Code が**描画のたびに**
このスクリプトを呼び、stdin に JSON を渡す。その `rate_limits` に 5 時間と週の使用率が載る。

**ここが、平常時の使用率をローカルで知る唯一の口**（transcript の `quotaLimits` は上限に
弾かれたときにしか載らない。`claude` CLI に `usage` のサブコマンドは無く、TUI の `/usage` が
叩いている API は OAuth のトークンが要るので SAI からは叩かない）。

- 受け取った `rate_limits` を `<feed dir>/usage-claude[.<host>].json` に**上書き**する
  （履歴は要らない。画面はいつも「いまの割合」しか見ない）
- **戻る時刻を過ぎた窓は書かない・置いてある記録より古い `ts` では上書きしない**（#683。
  再開した古いセッションは最後に受け取った `rate_limits` を持ち回るので、そのまま書くと
  取れていた割合が、読む側に全部捨てられる中身に置き換わる）
- **stdout に書いたものがそのままステータスラインになる。** 何も出さなければ空になってしまうので、
  短い1行を出す。既に自分のステータスラインを持っている人は README のラッパーで繋ぐ
- record.py と同じ規律: Python 3.9+ の標準ライブラリだけ・**必ず exit 0**・速いこと
  （描画のたびに呼ばれるので、遅いと TUI が待つ）

読み書きする形は shared/types.ts の `ClaudeUsage` と shared/usage.ts の `parseStatusLineUsage()`。
"""

from __future__ import annotations

import json
import math
import os
import signal
import sys
from datetime import datetime
from pathlib import Path

# feed_dir / host_name / tz は record.py と同じものを使う（1 か所で決める）。
# record.py は実行部分が __main__ ガードの中なので、import しても何も起きない
import record

#: このファイルの形の版。増やすときはサーバ側（server/local/usage.ts）も直す
USAGE_VERSION = 1
#: 記録するもの。ここに無い窓（gateway の spend_limit など）は今は捨てる
WINDOWS = ("five_hour", "seven_day")
#: 保険の自殺タイマー。stdin が閉じないなど、何が起きても TUI を待たせない
HARD_TIMEOUT_SECONDS = 5
#: ステータスラインに出す本文の上限（端末の1行に収める）
MAX_LINE = 200
#: ファイル名に使えない文字（record.py の day_file と同じ扱い）
_FILE_HOST_RE = record._FILE_HOST_RE


def usage_file(directory: Path) -> Path:
    """記録先。**`AGENT_FEED_HOST` を設定したときだけ** マシンごとに分ける（record.py の day_file と同じ規則）。

    使用率は口座ごとの値なので 1 ファイルで足りるが、同期フォルダで複数のマシンが
    同じファイルを上書きし合うと「いつ時点か」が壊れるため、分けたいときは分けられるようにする。
    """
    host = _FILE_HOST_RE.sub("-", record.host_name()) if os.environ.get("AGENT_FEED_HOST", "").strip() else ""
    return directory / (f"usage-claude.{host}.json" if host else "usage-claude.json")


def read_stdin_obj() -> dict:
    """stdin の JSON。読めなければ空の dict（記録しないだけ）"""
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _num(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def windows_of(payload: dict) -> dict:
    """payload の `rate_limits` → 記録する窓だけ。数字が取れないものは落とす。

    `rate_limits` は **subscription のときだけ**、かつ最初の API 応答の後にしか載らない
    （API キー利用では出ない。gateway 経由では `spend_limit` になるが、今は扱わない）。
    """
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict):
        return {}
    out = {}
    for name in WINDOWS:
        window = limits.get(name)
        if not isinstance(window, dict):
            continue
        percent = _num(window.get("used_percentage"))
        if percent is None:
            continue
        entry = {"used_percentage": percent}
        resets = _num(window.get("resets_at"))
        if resets is not None and resets > 0:
            entry["resets_at"] = resets
        out[name] = entry
    return out


def live_windows(windows: dict, now: datetime) -> dict:
    """戻る時刻（`resets_at`）を過ぎた窓を落とす。`resets_at` の無い窓は残す。

    **読む側（shared/usage.ts の `parseStatusWindow()`）と同じ条件**（`resets_at <= now` で期限切れ）。
    片方だけ変えると「書いたのに出ない」か「出せるのに書かない」になるので、境界は両方のテストに同じ形で置く
    """
    at = now.timestamp()
    return {name: window for name, window in windows.items() if "resets_at" not in window or window["resets_at"] > at}


def written_at(path: Path) -> datetime | None:
    """いま置いてある記録の `ts`。無い・読めない・時刻として読めないものは None（上書きしてよい）"""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        at = datetime.fromisoformat(value["ts"])
    except Exception:
        return None
    # タイムゾーンの無い ts は比べられない（aware との比較は TypeError）。読めないのと同じ扱い
    return at if at.tzinfo is not None else None


def build_record(payload: dict, windows: dict, now: datetime) -> dict:
    """書き出す中身。`ts` は**いつ時点の割合か**（Claude が動いていない間は更新されない）"""
    model = payload.get("model")
    return {
        "v": USAGE_VERSION,
        "ts": now.isoformat(timespec="seconds"),
        "host": record.host_name(),
        "session": payload.get("session_id") if isinstance(payload.get("session_id"), str) else "",
        "model": model.get("id", "") if isinstance(model, dict) else "",
        "rate_limits": windows,
    }


def write_record(directory: Path, row: dict) -> None:
    """同じ名前に置き直す（履歴は持たない）。読む側が半端な JSON を見ないように tmp → replace。

    置いてある記録の `ts` のほうが新しければ何もしない（#683。新しいほうを残す）
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = usage_file(directory)
    existing = written_at(path)
    if existing is not None and existing > datetime.fromisoformat(row["ts"]):
        return
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def status_line(payload: dict, windows: dict) -> str:
    """ステータスラインに出す1行。使用率が無ければモデル名だけになる"""
    parts = []
    model = payload.get("model")
    if isinstance(model, dict):
        name = model.get("display_name") or model.get("id") or ""
        if isinstance(name, str) and name.strip():
            parts.append(name.strip())
    for name, label in (("five_hour", "5時間"), ("seven_day", "週")):
        window = windows.get(name)
        if window:
            parts.append(f"{label} {round(window['used_percentage'])}%")
    return " · ".join(parts)[:MAX_LINE]


def main() -> None:
    payload = read_stdin_obj()
    windows = windows_of(payload)
    # AGENT_FEED_SKIP は record.py と同じ意味（SAI 自身が回す claude に付く）。表示だけして記録しない
    if windows and os.environ.get("AGENT_FEED_SKIP") != "1":
        now = datetime.now(record.tz())
        # 期限切れの窓は書かない。全部切れていれば、置いてある記録に触らない（#683）
        live = live_windows(windows, now)
        if live:
            write_record(record.feed_dir(), build_record(payload, live, now))
    line = status_line(payload, windows)
    if line:
        print(line)


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))
        signal.alarm(HARD_TIMEOUT_SECONDS)
    except Exception:
        pass
    try:
        main()
    except BaseException:
        pass  # 記録できないだけ。ステータスラインが空になるだけで、Claude は止めない
    sys.exit(0)
