#!/usr/bin/env python3
"""一言（digest）と「次に送る文面の案」が使われたかを数える（#446）。

    python3 -m feed.digest_stats            # ~/.agent-feed（AGENT_FEED_DIR）を読む
    python3 -m feed.digest_stats --feed-dir /path --all

読むのは手元の digest.jsonl（作った一言と案）と digest-feedback.jsonl（「変？」と、画面が溜めた
「詳細を開いた」opened・「案を受け取った」next_ask_accepted）だけ。どこにも送らないし、何も書かない。
規則を直すときに人が読む材料で、この数字で一言を自動で作り直したりはしない。

割合の分母は、既定では**最初の合図より後に作ったもの**と、**それより前に作ったが合図が付いたもの**（数え始めた後に
画面に出ていたことが分かるもの）。数え始める前の一言は開いたかどうか分からないので、全部を混ぜると率が薄まる。
数え始めの直後は、前に作ったものが「開いたものだけ」入るので率は高めに出る。`--all` で全部を分母にする。標準ライブラリのみ。
"""
import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

USAGE = ("opened", "next_ask_accepted")


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        pass
    return rows


def parse_ts(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def collect(digests, feedback, include_all=False):
    """集計を dict で返す（表示とテストが同じものを見る）。"""
    # 同じ鍵は後ろの行が正（作り直すと追記される）
    latest = {}
    for d in digests:
        key = d.get("key")
        if isinstance(key, str) and key:
            latest[key] = d
    usage = [f for f in feedback if f.get("reason") in USAGE]
    complaints = Counter(str(f.get("reason")) for f in feedback if f.get("reason") not in USAGE)
    stamps = [t for t in (parse_ts(f.get("ts")) for f in usage) if t is not None]
    since = None if include_all or not stamps else min(stamps)

    used = {f.get("key") for f in usage}

    def counted(d):
        if since is None or d["key"] in used:
            return True
        t = parse_ts(d.get("ts"))
        return t is not None and t >= since

    base = [d for d in latest.values() if counted(d)]
    keys = {d["key"] for d in base}
    opened = {f.get("key") for f in usage if f.get("reason") == "opened"} & keys
    accepted = {f.get("key") for f in usage if f.get("reason") == "next_ask_accepted"} & keys

    def tally(rows):
        summaries = [d for d in rows if str(d.get("summary") or "").strip()]
        asks = [d for d in rows if str(d.get("next_ask") or "").strip()]
        return {
            "summaries": len(summaries),
            "opened": sum(1 for d in summaries if d["key"] in opened),
            "next_asks": len(asks),
            "accepted": sum(1 for d in asks if d["key"] in accepted),
            # 人に聞いている返答なので、わざと一言を作らなかった行（#638）
            "asking": sum(1 for d in rows if d.get("skipped") == "asking"),
        }

    def by(field):
        groups = {}
        for d in base:
            groups.setdefault(str(d.get(field) or "(不明)"), []).append(d)
        return {name: tally(rows) for name, rows in sorted(groups.items())}

    # 手元のモデルに「要約で足りるか」を聞いた行（#639）。足りると答えたのに詳細を開いた＝拾えなかった。
    # 全文が要ると答えた行は本文がそのまま出ていて「開く」が無いので、誤って拾ったかは合図からは分からない（読んで確かめる）
    judged_summary = [d for d in base if d.get("judge") == "summary" and str(d.get("summary") or "").strip()]
    judge = {
        "full": sum(1 for d in base if d.get("skipped") == "judged"),
        "summary": len(judged_summary),
        "summary_opened": sum(1 for d in judged_summary if d["key"] in opened),
    }

    # 案の出どころ（#713）。本文の引用をそのまま採った案（LLM を呼んでいない）と、口で作った案を分けて数える
    with_ask = [d for d in base if str(d.get("next_ask") or "").strip()]
    quoted = [d for d in with_ask if d.get("next_ask_source") == "quote"]
    asks = {
        "quote": len(quoted),
        "quote_accepted": sum(1 for d in quoted if d["key"] in accepted),
        "llm": len(with_ask) - len(quoted),
        "llm_accepted": sum(1 for d in with_ask if d.get("next_ask_source") != "quote" and d["key"] in accepted),
    }

    return {
        "since": since,
        "judge": judge,
        "asks": asks,
        "counting": bool(stamps),
        "total": tally(base),
        "by_model": by("model"),
        "by_persona": by("persona"),
        "complaints": dict(sorted(complaints.items())),
    }


def rate(part, whole):
    return "-" if not whole else "%d%%" % round(100 * part / whole)


def line(name, t):
    return "  %-14s 一言 %5d  詳細を開いた %5d (%4s)   案 %5d  受け取った %5d (%4s)" % (
        name, t["summaries"], t["opened"], rate(t["opened"], t["summaries"]),
        t["next_asks"], t["accepted"], rate(t["accepted"], t["next_asks"]),
    )


def render(stats):
    out = []
    if not stats["counting"]:
        out.append("まだ合図（詳細を開いた・案を受け取った）が 1 件もありません。画面で使うと digest-feedback.jsonl に溜まります。")
    elif stats["since"] is not None:
        out.append("数え始め: %s 以降に作ったものと、それより前で合図が付いたものを分母にしています（--all で全部）" % datetime.fromtimestamp(stats["since"]).strftime("%Y-%m-%d %H:%M"))
    out.append(line("全体", stats["total"]))
    out.append("  人に聞いている返答なので一言にしなかった: %d 本（本文をそのまま出した。#638）" % stats["total"].get("asking", 0))
    j = stats.get("judge") or {}
    if j.get("full") or j.get("summary"):
        out.append("  手元のモデルの判定（#639）: 全文が要る %d 本（一言にしなかった） / 要約で足りる %d 本、うち詳細を開いた %d 本 (%s。拾えなかった分)" % (
            j["full"], j["summary"], j["summary_opened"], rate(j["summary_opened"], j["summary"])))
    k = stats.get("asks") or {}
    if k.get("quote"):
        out.append("  案の出どころ（#713）: 本文の引用 %d 本、うち受け取った %d 本 (%s) / 口で作った %d 本、うち受け取った %d 本 (%s)" % (
            k["quote"], k["quote_accepted"], rate(k["quote_accepted"], k["quote"]), k["llm"], k["llm_accepted"], rate(k["llm_accepted"], k["llm"])))
    out.append("モデルごと:")
    out.extend(line(name, t) for name, t in stats["by_model"].items())
    out.append("性格ごと:")
    out.extend(line(name, t) for name, t in stats["by_persona"].items())
    total = sum(stats["complaints"].values())
    out.append("「変？」: %d 件%s" % (total, "（" + "・".join("%s %d" % kv for kv in stats["complaints"].items()) + "）" if total else ""))
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description="一言と次の案が使われたかを手元で数える（#446）")
    parser.add_argument("--feed-dir", default=os.environ.get("AGENT_FEED_DIR") or str(Path.home() / ".agent-feed"))
    parser.add_argument("--all", action="store_true", help="数え始める前に作ったものも分母に入れる")
    args = parser.parse_args(argv)
    directory = Path(args.feed_dir).expanduser()
    stats = collect(read_jsonl(directory / "digest.jsonl"), read_jsonl(directory / "digest-feedback.jsonl"), args.all)
    print(render(stats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
