#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
更新参考图库索引（姿势 / 服装 / 人像）

用途
    从上游仓库 anhao/ai-pose-gallery-zh 重新拉取三库中文索引，裁剪成画布需要的字段，
    原子写入 data/gallery/{pose,costume,portrait}.json。图库页无需改动即可读到新数据。

用法
    python3 更新参考图库索引.py                  # 更新全部三库
    python3 更新参考图库索引.py pose costume     # 只更新指定库
    python3 更新参考图库索引.py --check          # 只比对上游与本地，不写文件
    python3 更新参考图库索引.py --branch main    # 指定分支（默认 main）
    python3 更新参考图库索引.py --source raw     # 强制单一数据源：site / raw / jsdelivr

说明
    - 取数兜底：站点同源索引 → GitHub raw → jsDelivr；每一源再走「urllib → curl」双通道。
    - 校验：必须是 JSON 数组、条数大于 0、首条含 id 与缩略图，否则视为失败不落盘。
    - 写入：先写同目录临时文件再 os.replace，避免中断产生半截 JSON。
    - 备份：覆盖前把旧文件存到 data/gallery/.backup/<lib>.json.bak，可人工回滚。
    - 纯标准库，Pydroid3 / 任意 Python3 可直接运行；只读上游，不改动上游任何内容。
"""

import json
import os
import sys
import time
import shutil
import subprocess
import urllib.request
import urllib.error
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, 'data', 'gallery')
BACKUP_DIR = os.path.join(OUT_DIR, '.backup')
META_PATH = os.path.join(OUT_DIR, 'meta.json')

REPO = 'anhao/ai-pose-gallery-zh'
DEFAULT_BRANCH = 'main'
UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

KEEP = {
    'pose': ['id', '体系', '姿势编号', '分类', '姿势名称', '角度', '缩略图', '原图'],
    'costume': ['id', '分类', '服装名称', '标签', '缩略图', '原图'],
    'portrait': ['id', '分区', '发长', '发型名称', '标题', '精选', '热门', '缩略图', '原图'],
}
LABEL = {'pose': '姿势', 'costume': '服装', 'portrait': '人像'}
ORDER = ['pose', 'costume', 'portrait']

TIMEOUT = 15
CURL_TIMEOUT = 25
RETRIES = 2
# 取数顺序：站点同源索引最快最稳，其次 GitHub raw，最后 jsDelivr
SOURCE_ORDER = ['site', 'raw', 'jsdelivr']


def sources(lib, branch, only=None):
    name = lib + '-zh.json'
    table = {
        'site': 'https://ai-pose-gallery.anhao.app/data/%s' % name,
        'raw': 'https://raw.githubusercontent.com/%s/%s/data/%s' % (REPO, branch, name),
        'jsdelivr': 'https://cdn.jsdelivr.net/gh/%s@%s/data/%s' % (REPO, branch, name),
    }
    order = [only] if only else SOURCE_ORDER
    return [(k, table[k]) for k in order if k in table]


def fetch_urllib(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json,*/*',
                                               'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def fetch_curl(url):
    exe = shutil.which('curl')
    if not exe:
        raise RuntimeError('环境无 curl')
    cmd = [exe, '-sS', '-L', '--max-time', str(CURL_TIMEOUT), '-A', UA,
           '-H', 'Accept: application/json', url]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', 'ignore').strip()[:120]
        raise RuntimeError('curl rc=%d %s' % (proc.returncode, err))
    if not proc.stdout:
        raise RuntimeError('curl 返回空')
    return proc.stdout


def fetch(url):
    """urllib 快速失败，失败后交给 curl 重试一次（部分网络对 Python TLS 指纹不友好）。"""
    try:
        return fetch_urllib(url)
    except Exception as first:
        try:
            return fetch_curl(url)
        except Exception as second:
            raise RuntimeError('%s；curl：%s' % (first, second))


def fetch_json(lib, branch, only=None):
    """按源顺序尝试，返回 (data, 源名, 字节数)。全部失败则抛 RuntimeError。"""
    last_err = None
    for name, url in sources(lib, branch, only):
        for attempt in range(1, RETRIES + 1):
            try:
                raw = fetch(url)
                data = json.loads(raw.decode('utf-8'))
                if not isinstance(data, list) or not data:
                    raise ValueError('返回不是非空数组')
                first = data[0]
                if not isinstance(first, dict) or 'id' not in first:
                    raise ValueError('首条缺少 id 字段（可能拿到的是站点首页）')
                return data, name, len(raw)
            except urllib.error.HTTPError as exc:
                last_err = '%s: HTTP %s' % (name, exc.code)
                if exc.code in (403, 404):
                    break
            except Exception as exc:
                last_err = '%s: %s' % (name, exc)
            if attempt < RETRIES:
                time.sleep(0.8)
    raise RuntimeError('全部数据源失败（最后错误：%s）' % last_err)


def trim(data, lib):
    fields = KEEP[lib]
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        row = {}
        for f in fields:
            v = it.get(f, '')
            row[f] = v
        if not row.get('id') or not row.get('缩略图'):
            continue
        out.append(row)
    return out


def load_local(path):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, list) else []
    except Exception:
        return []


def atomic_write(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def human(n):
    if n >= 1048576:
        return '%.1f MB' % (n / 1048576.0)
    if n >= 1024:
        return '%.0f KB' % (n / 1024.0)
    return '%d B' % n


def main(argv):
    branch = DEFAULT_BRANCH
    check_only = False
    only = None
    libs = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('-h', '--help'):
            print(__doc__.strip())
            return 0
        elif a == '--check':
            check_only = True
        elif a == '--branch':
            i += 1
            if i >= len(argv):
                print('错误：--branch 缺少参数')
                return 2
            branch = argv[i]
        elif a == '--source':
            i += 1
            if i >= len(argv):
                print('错误：--source 缺少参数')
                return 2
            only = argv[i]
            if only not in ('site', 'raw', 'jsdelivr'):
                print('错误：--source 只支持 site / raw / jsdelivr')
                return 2
        elif a.startswith('-'):
            print('错误：未知参数 %s' % a)
            return 2
        else:
            if a not in KEEP:
                print('错误：未知库名 %s（可用：%s）' % (a, ' '.join(ORDER)))
                return 2
            libs.append(a)
        i += 1
    if not libs:
        libs = list(ORDER)

    os.makedirs(OUT_DIR, exist_ok=True)
    if not check_only:
        os.makedirs(BACKUP_DIR, exist_ok=True)

    print('上游：github.com/%s @ %s' % (REPO, branch))
    print('目标：%s' % OUT_DIR)
    print('模式：%s' % ('只比对（不写文件）' if check_only else '更新'))
    print('')

    stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    meta = {}
    try:
        with open(META_PATH, 'r', encoding='utf-8') as fh:
            meta = json.load(fh)
    except Exception:
        meta = {}
    changed = 0
    failed = 0

    for lib in libs:
        path = os.path.join(OUT_DIR, lib + '.json')
        local = load_local(path)
        local_ids = set(x.get('id') for x in local if isinstance(x, dict))
        label = LABEL[lib]
        try:
            data, src, raw_bytes = fetch_json(lib, branch, only)
        except Exception as exc:
            failed += 1
            print('[失败] %s：%s' % (label, exc))
            continue

        rows = trim(data, lib)
        new_ids = set(x.get('id') for x in rows)
        added = new_ids - local_ids
        removed = local_ids - new_ids
        text = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
        out_bytes = len(text.encode('utf-8'))

        print('[%s] %s  上游 %d 条（源 %s，%s）' % ('比对' if check_only else '就绪', label, len(rows), src, human(raw_bytes)))
        print('       本地 %d 条 → 新增 %d / 移除 %d / 字段裁剪后 %s' % (len(local), len(added), len(removed), human(out_bytes)))
        if added:
            sample = list(added)[:3]
            print('       新增示例：%s%s' % (', '.join(sample), ' …' if len(added) > 3 else ''))
        if removed:
            sample = list(removed)[:3]
            print('       移除示例：%s%s' % (', '.join(sample), ' …' if len(removed) > 3 else ''))

        if check_only:
            if added or removed:
                changed += 1
            continue

        if rows == local:
            print('       内容无变化，跳过写入')
            meta[lib] = {'count': len(rows), 'bytes': out_bytes, 'source': src, 'checkedAt': stamp}
            continue

        try:
            if os.path.exists(path):
                shutil.copy2(path, os.path.join(BACKUP_DIR, lib + '.json.bak'))
            atomic_write(path, text)
            print('       已写入（旧文件备份到 data/gallery/.backup/%s.json.bak）' % lib)
            changed += 1
            meta[lib] = {'count': len(rows), 'bytes': out_bytes, 'source': src, 'updatedAt': stamp}
        except Exception as exc:
            failed += 1
            print('       [失败] 写入出错：%s' % exc)

    if not check_only:
        meta['branch'] = branch
        meta['lastRun'] = stamp
        try:
            atomic_write(META_PATH, json.dumps(meta, ensure_ascii=False, indent=2))
        except Exception:
            pass

    print('')
    if check_only:
        print('比对完成：%d 个库有差异，%d 个库读取失败。' % (changed, failed))
    else:
        print('更新完成：%d 个库已写入，%d 个库失败。' % (changed, failed))
    if changed and not check_only:
        print('提示：图库页刷新即可看到新数据（缩略图仍按需从上游加载）。')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))