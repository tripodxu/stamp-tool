# -*- coding: utf-8 -*-
"""夹具自检：栅格化每份夹具，确认红色角标真的落在**显示**左上角。

这一步不是走过场——它同时验证了「显示坐标 → 用户空间」这套映射
（生成夹具时用的是同一套规则），映射抄错、/Rotate 方向搞反都会当场暴露。
"""
import sys
# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pathlib import Path

import pymupdf

OUT = Path(__file__).resolve().parent.parent / "testdata"
CASES = [
    ("fixture-rotate90.pdf", 90, 841.89, 595.28),
    ("fixture-rotate180.pdf", 180, 595.28, 841.89),
    ("fixture-rotate270.pdf", 270, 841.89, 595.28),
    ("fixture-cropbox.pdf", 0, 555.28, 801.89),
]

ok = True
for name, rot, w, h in CASES:
    path = OUT / name
    if not path.exists():
        print(f"  [FAIL] {name} 不存在，先跑 make-pagefixtures.mjs")
        ok = False
        continue
    page = pymupdf.open(path)[0]
    pix = page.get_pixmap(dpi=72)
    s, n = pix.samples, pix.n
    hits = cx = cy = 0
    for y in range(0, pix.height, 2):
        for x in range(0, pix.width, 2):
            i = (y * pix.width + x) * n
            # 蓝色角标（红色留给印章，避免像素校验时互相污染）
            if s[i + 2] > 150 and s[i + 2] - s[i] > 60 and s[i + 2] - s[i + 1] > 60:
                hits += 1
                cx += x
                cy += y

    problems = []
    if page.rotation != rot:
        problems.append(f"/Rotate {page.rotation} != {rot}")
    if abs(pix.width - w) > 1.5 or abs(pix.height - h) > 1.5:
        problems.append(f"显示尺寸 {pix.width}x{pix.height} != {w:.0f}x{h:.0f}")
    if hits < 40:
        problems.append("没找到红色角标")
    elif not (cx / hits < pix.width * 0.3 and cy / hits < pix.height * 0.3):
        problems.append(f"角标不在左上角（{cx / hits:.0f},{cy / hits:.0f}）")

    if problems:
        ok = False
        print(f"  [FAIL] {name}: " + "；".join(problems))
    else:
        print(f"  [PASS] {name:<24} 显示 {pix.width}x{pix.height}pt  /Rotate={rot}"
              f"  角标({cx / hits:.0f},{cy / hits:.0f})")

print("\n结果：" + ("全部通过" if ok else "存在失败项"))
sys.exit(0 if ok else 1)
