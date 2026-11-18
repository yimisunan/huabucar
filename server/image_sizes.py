# -*- coding: utf-8 -*-
"""Apply change2pro Studio pixel presets without changing stored tasks or references."""
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

# Previous canvas presets are recognized only for this provider and only on new requests.
LEGACY_SIZES = {
    '3:4': {'1K':'1152x1536','2K':'1920x2560','4K':'2480x3312'},
    '2:3': {'1K':'1024x1536','2K':'1712x2560','4K':'2352x3520'},
    '9:16': {'1K':'1024x1792','2K':'1440x2560','4K':'2160x3840'},
    '3:2': {'1K':'1536x1024','2K':'2560x1712','4K':'3520x2352'},
    '16:9': {'1K':'1792x1024','2K':'2560x1440','4K':'3840x2160'},
    '4:3': {'1K':'1536x1152','2K':'2560x1920','4K':'3312x2480'},
    '1:1': {'1K':'1024x1024','2K':'2048x2048'},
}
CHANGE2PRO_HOSTS = frozenset(('gateway.forkc2p.com','gateway.change2pro.com','daily.forkc2p.com'))


@lru_cache(maxsize=1)
def studio_presets():
    path = Path(__file__).resolve().parent.parent / '图片生成供应商能力.json'
    with path.open(encoding='utf-8') as source:
        return json.load(source)['presets']['change2pro']['capabilities']['imageSizePresets']


def normalize_studio_dimensions(width, height):
    def rounded(value):
        return max(16, math.floor(value / 16 + 0.5) * 16)
    def down(value):
        return max(16, math.floor(value / 16) * 16)
    def up(value):
        return max(16, math.ceil(value / 16) * 16)
    w, h = rounded(width), rounded(height)
    for _ in range(4):
        longest = max(w, h)
        if longest > 3840:
            scale = 3840 / longest
            w, h = down(w * scale), down(h * scale)
        if w / h > 3:
            w = down(h * 3)
        elif h / w > 3:
            h = down(w * 3)
        pixels = w * h
        if pixels > 8294400:
            scale = math.sqrt(8294400 / pixels)
            w, h = down(w * scale), down(h * scale)
        elif pixels < 655360:
            scale = math.sqrt(655360 / pixels)
            w, h = up(w * scale), up(h * scale)
    return '%dx%d' % (w, h)


def resolve_image_size(spec, inpaint=False):
    size = str(spec.get('size') or '')
    caps = spec.get('capabilities') or {}
    host = (urlsplit(str(spec.get('baseUrl') or '')).hostname or '').lower()
    enabled = caps.get('imageSizePolicy') == 'change2pro-studio' or host in CHANGE2PRO_HOSTS
    # A mask must remain registered to the original pixels, including old custom tasks.
    if not enabled or inpaint or spec.get('inpaint'):
        return size
    match = re.fullmatch(r'(\d+)x(\d+)', size)
    if not match:
        return size
    table = studio_presets()
    if spec.get('imageSizeMode') != 'custom':
        if any(size in values.values() for values in table.values()):
            return size
        for ratio, tiers in LEGACY_SIZES.items():
            for tier, value in tiers.items():
                if value == size:
                    return table[tier][ratio]
    return normalize_studio_dimensions(int(match[1]), int(match[2]))
