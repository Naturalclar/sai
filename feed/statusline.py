#!/usr/bin/env python3
"""Claude の使用率をステータスライン経由で受け取って記録する（#250）。

`~/.claude/settings.json` の `statusLine` に指定すると、Claude Code が**描画のたびに**
このスクリプトを呼び、stdin に JSON を渡す。その `rate_limits` に 5 時間と週の使用率が載る。

**ここが、平常時の使用率をローカルで知る唯一の口**（transcript の `quotaLimits` は上限に
弾かれたときにしか載らない。`claude` CLI に `usage` のサブコマンドは無く、TUI の `/usage` が
叩いている API は OAuth のトークンが要るので SAI からは叩かない）。

- 受け取った `rate_limits` を `<feed dir>/usage-claude[.<host>].json` に置き直す
  （履歴は要らない。画面はいつも「いまの割合」しか見ない）
- **窓ごとに新しいほうを残す**（#689。`merge_windows()`）。`rate_limits` はそのセッションが最後に受け取った
  ものを持ち回るので、しばらく API を呼んでいないセッションが描画すると、古い（低い）値が来る。
  同じ窓なら高いほうを残し、何も変わらなければ書かない（`ts` は**値が最後に変わった時刻**）
- **戻る時刻を過ぎた窓は書かない・置いてある新しい記録（`ts` が少し先で、まだ出せるもの）は置き直さない**（#683。
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
#: 置いてある記録の `ts` が今よりこれ以上先なら、新しい記録ではなく時計のずれとみなして上書きする（#683）
NEWER_TRUST_SECONDS = 300
#: `resets_at` の差がこの秒数以内なら同じ窓とみなす（描画ごとに少しずれても別の窓にしない。#689）
SAME_WINDOW_SECONDS = 60
#: 置いてある窓の割合がこれより長く変わっていなければ、同じ窓の低い値でも置き直す（#689）。枠が途中で
#: リセットされたとき、高いほうを残す決まりだけだと古い高い値がその窓の終わりまで残るので、その逃げ道
KEEP_SECONDS = 24 * 60 * 60
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


def merge_windows(existing: dict, incoming: dict, now: float) -> dict:
    """置いてある窓（生きているものだけ）と来た窓を、**窓ごとに新しいほう**でまとめる（#689）。

    - 同じ窓（`resets_at` の差が SAME_WINDOW_SECONDS 以内）は割合の高いほう。割合は窓の中で下がらないので、
      低いほうは前に受け取った値を持ち回っているだけ。同じなら置いてあるほう（書き直さない）。
      ただし置いてある窓が KEEP_SECONDS より長く変わっていなければ、低くても来たほう（枠の途中リセットの逃げ道。
      **窓ごとの `changed_at` で見る**。記録全体の時刻で見ると、5 時間の窓が動いている間は週の逃げ道が開かない）
    - `resets_at` が先へ進んでいれば新しい窓なので、低くても来たほう。手前なら前の窓の値なので置いてあるほう
    - 来なかった窓は、置いてあるものを持ち越す（週だけ来た描画で、期限内の 5 時間を消さない）
    - どちらかに `resets_at` が無ければ比べられないので、来たほう（来なかったなら持ち越さない。
      戻る時刻の無い窓は自分では期限切れにならないため）
    """
    out = dict(incoming)
    for name, old in existing.items():
        if "resets_at" not in old:
            continue
        new = incoming.get(name)
        if new is None:
            out[name] = old
            continue
        if "resets_at" not in new:
            continue
        ahead = new["resets_at"] - old["resets_at"]
        if ahead < -SAME_WINDOW_SECONDS:
            out[name] = old
        elif ahead <= SAME_WINDOW_SECONDS and new["used_percentage"] <= old["used_percentage"]:
            if new["used_percentage"] == old["used_percentage"] or now - old["changed_at"] <= KEEP_SECONDS:
                out[name] = old
    return out


def stored_windows(value: dict, written: float) -> dict:
    """置いてある記録の窓。`changed_at`（その窓の割合が最後に変わった時刻）が無い・読めない窓は記録の `ts` で補う"""
    limits = value.get("rate_limits")
    out = windows_of(value)
    for name, window in out.items():
        changed = _num(limits[name].get("changed_at"))
        window["changed_at"] = changed if changed is not None else written
    return out


def windows_to_write(path: Path, incoming: dict, now: datetime) -> dict | None:
    """いま置いてある記録と突き合わせて、書く窓を決める。**書かなくてよければ None**。

    - 置いてある記録が無い・読めない・`ts` が比べられない → 来たものをそのまま
    - `ts` が今より少し先（NEWER_TRUST_SECONDS 以内）で生きている窓がある → 書かない（#683。新しい記録を残す）。
      先すぎる `ts`（時計の狂ったマシンが書いたもの）は残すとその時刻まで割合が止まるので、来たものをそのまま
    - それ以外は `merge_windows()`。**置いてあるものと同じになったら書かない**（`ts` を進めない）
    """
    at = now.timestamp()
    incoming = {name: dict(window, changed_at=at) for name, window in incoming.items()}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        written_at = datetime.fromisoformat(value["ts"])
        # タイムゾーンの無い ts は比べられない（aware との比較は TypeError）。読めないのと同じ扱い
        if written_at.tzinfo is None:
            return incoming
        age = (now - written_at).total_seconds()
        written = stored_windows(value, written_at.timestamp())
    except Exception:
        return incoming
    if age < -NEWER_TRUST_SECONDS:
        return incoming
    live = live_windows(written, now)
    if age < 0:
        return None if live else incoming
    merged = merge_windows(live, incoming, at)
    # 比べる相手は生きている窓だけ（期限切れの窓が残っているだけで書き直すと、値が変わっていないのに ts が進む）
    return None if merged == live else merged


def build_record(payload: dict, windows: dict, now: datetime) -> dict:
    """書き出す中身。`ts` は**割合が最後に変わった時刻**（同じ値の描画では書き直さない。#689）。

    `session` / `model` は最後に書いた描画のもの（持ち越した窓は別のセッションが受け取った値のことがある）。
    窓ごとの `changed_at`（epoch 秒）はその窓の割合が最後に変わった時刻で、読む側（shared/usage.ts）は見ない
    """
    model = payload.get("model")
    return {
        "v": USAGE_VERSION,
        "ts": now.isoformat(timespec="seconds"),
        "host": record.host_name(),
        "session": payload.get("session_id") if isinstance(payload.get("session_id"), str) else "",
        "model": model.get("id", "") if isinstance(model, dict) else "",
        "rate_limits": windows,
    }


def write_record(directory: Path, payload: dict, windows: dict, now: datetime) -> None:
    """同じ名前に置き直す（履歴は持たない）。読む側が半端な JSON を見ないように tmp → replace。

    書く窓は `windows_to_write()` が決める（置いてある記録のほうが新しい・何も変わらないときは書かない）
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = usage_file(directory)
    merged = windows_to_write(path, windows, now)
    if merged is None:
        return
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(build_record(payload, merged, now), ensure_ascii=False), encoding="utf-8")
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
            write_record(record.feed_dir(), payload, live, now)
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
