#!/usr/bin/env python3
"""/setup-sai の点検（読むだけ。#688 で SKILL.md の本文から出した）。

  doctor.py last        一番新しい記録の行（ts / agent / v / repo）
  doctor.py hooks       ~/.claude/settings.json と ./.claude/settings.json の、record.py に届くフック
  doctor.py usage       ~/.agent-feed/usage-claude*.json（Claude の使用率）が新しいか
  doctor.py statusline  ~/.claude/settings.json の statusLine が statusline.py に届くか

何も書かない。標準ライブラリのみ。判定はサーバと同じ規則（server/local/usage.ts の isClaudeUsageFile、
shared/usage.ts の STATUS_MAX_AGE_MS）に合わせる。
"""
import glob
import json
import os
import re
import shutil
import sys
import time

FEED = os.environ.get('AGENT_FEED_DIR') or os.path.expanduser('~/.agent-feed')
USER_SETTINGS = os.path.expanduser('~/.claude/settings.json')


def reaches(cmd, needle):
    """コマンドが needle（record.py / statusline.py）に届くか。PATH のラッパーは中身を読む"""
    if not cmd:
        return None
    if needle in cmd:
        return cmd
    exe = (cmd.split() or [''])[0]
    p = shutil.which(exe)
    if not p:
        return None
    try:
        body = open(p, encoding='utf-8', errors='replace').read()
    except Exception:
        return None
    return f'{p} 経由' if needle in body else None


def last():
    # 日付のファイルだけを見る。*.jsonl だと digest.jsonl（一言。行の形が違う）を拾って
    # agent も v も None になり、動いているのに「壊れている」と読み違える
    files = sorted(glob.glob(os.path.join(FEED, '20??-??-??*.jsonl')), key=os.path.getmtime)
    if not files:
        print(f'{FEED}: 日付の記録が無い')
        return
    try:
        with open(files[-1], 'rb') as f:
            f.seek(max(0, os.path.getsize(files[-1]) - 262144))
            r = json.loads(f.read().decode('utf-8', 'replace').strip().split('\n')[-1])
    except Exception as e:
        print(f'{files[-1]}: 最後の行が読めない ({e})')
        return
    print(r.get('ts'), r.get('agent'), 'v=%s' % r.get('v'), r.get('repo'))


def hooks():
    for label, path in [('user', USER_SETTINGS), ('project', '.claude/settings.json')]:
        try:
            found = (json.load(open(path)) or {}).get('hooks') or {}
        except Exception:
            print(f'{label}: {path} は無い / 読めない')
            continue
        hits = [(e, g.get('matcher', ''), h.get('command', ''), reaches(h.get('command', ''), 'record.py'))
                for e, gs in found.items() for g in gs for h in g.get('hooks', []) if reaches(h.get('command', ''), 'record.py')]
        print(f'{label}: {path} → record.py に届くフック {len(hits)} 件')
        for e, m, c, v in hits:
            print(f'   {e:18} matcher={m!r} {c!r} -> {v}')


def usage():
    max_age = 8 * 86400  # shared/usage.ts の STATUS_MAX_AGE_MS。これより古いとサーバが捨てる
    try:
        names = sorted(n for n in os.listdir(FEED) if re.fullmatch(r'usage-claude(\.[^/]+)?\.json', n))
    except OSError:
        names = []
    if not names:
        print(f'{FEED}: usage-claude*.json が無い → statusLine 未設定か、まだ 1 回も描画されていない')
    now = time.time()
    for n in names:
        try:
            d = json.load(open(os.path.join(FEED, n)))
        except Exception as e:
            print(f'{n}: 読めない ({e})')
            continue
        age = now - (time.mktime(time.strptime(d.get('ts', '')[:19], '%Y-%m-%dT%H:%M:%S')) if d.get('ts') else 0)
        limits = d.get('rate_limits') or {}
        windows = {k: v.get('used_percentage') for k, v in limits.items() if isinstance(v, dict)}
        print(f'{n}: ts={d.get("ts")} ({age / 3600:.1f}h 前{"、古すぎる" if age > max_age else ""}) windows={windows or "空（subscription でない？）"}')


def statusline():
    try:
        sl = (json.load(open(USER_SETTINGS)) or {}).get('statusLine')
    except Exception as e:
        print(f'{USER_SETTINGS} は無い / 読めない ({e})')
        return
    if not sl:
        print('statusLine: 未設定 → SAI の割合は永久に出ない')
        return
    cmd = sl.get('command', '') if isinstance(sl, dict) else str(sl)
    print(f'statusLine: {cmd!r}')
    print('  statusline.py に届くか:', reaches(cmd, 'statusline.py') or '届かない → 別のものに取られている')


COMMANDS = {'last': last, 'hooks': hooks, 'usage': usage, 'statusline': statusline}

if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else ''
    if name not in COMMANDS:
        print('usage: doctor.py ' + ' | '.join(COMMANDS), file=sys.stderr)
        sys.exit(2)
    COMMANDS[name]()
