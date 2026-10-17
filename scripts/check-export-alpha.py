#!/usr/bin/env python3
"""核对导出 PDF 里印章的透明区颜色（回归：「导出后印章周围一圈黑框」）。

原理：导出时印章 PNG 的透明度走 /SMask（颜色图 + 软掩膜两个对象）。
规范渲染器按掩膜合成，透明区的颜色**不可见**；但忽略 /SMask 的渲染器
会把颜色图当实色画出来——如果透明区留着 (0,0,0)，用户就看到红章外面
套着一个黑方块。所以判据是：**α=0 的像素必须接近纯白**。

用法：
    python scripts/check-export-alpha.py <导出的.pdf> [--image out.png]

退出码 0 = 通过；1 = 透明区有暗色（会出现黑框）。
"""
import argparse
import io
import sys
# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


import numpy as np
import pymupdf
from PIL import Image

# α=0 的像素亮度低于这个值就算「会显形的黑底」。255 是纯白，
# 留一点余量给 PNG/JPEG 之类的编码噪声。
DARK_LUMA = 240


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def analyse(pdf_path: str, image_out: str | None = None) -> int:
    doc = pymupdf.open(pdf_path)
    checked = 0
    bad_total = 0

    for pno, page in enumerate(doc):
        for item in page.get_images(full=True):
            xref = item[0]
            smask = page.parent.xref_get_key(xref, "SMask")
            if smask[0] != "xref":
                continue  # 没有软掩膜：不透明图，不在本次判据范围
            sm = int(smask[1].split()[0])

            col = np.array(
                Image.open(io.BytesIO(doc.extract_image(xref)["image"])).convert("RGB")
            ).astype(int)
            msk = np.array(
                Image.open(io.BytesIO(doc.extract_image(sm)["image"])).convert("L")
            ).astype(int)
            checked += 1

            print(f"第 {pno + 1} 页 图像 xref={xref} {col.shape[1]}×{col.shape[0]}  SMask xref={sm}")
            transparent = msk == 0
            n_trans = int(transparent.sum())
            if n_trans == 0:
                print("  没有全透明像素，跳过")
                continue

            t_rgb = col[transparent]
            t_luma = luma(t_rgb)
            dark = t_luma < DARK_LUMA
            bad = int(dark.sum())
            bad_total += bad

            print(f"  全透明像素 {n_trans:,} 个（占 {n_trans / msk.size:.1%}）")
            print(f"  透明区 RGB 均值 {t_rgb.mean(axis=0).round(1).tolist()}  最暗像素亮度 {t_luma.min():.0f}")
            print(f"  其中偏暗（亮度<{DARK_LUMA}）的 {bad:,} 个", end="")
            if bad:
                worst = t_rgb[dark]
                print(f"  → 最暗 RGB {worst[t_luma[dark].argmin()].tolist()}   ← 忽略 /SMask 的渲染器会画成黑底")
            else:
                print("  ✓ 干净")

            if image_out:
                # 把「忽略软掩膜」与「按掩膜正确合成」两种视角并排画出来
                h, w = msk.shape
                white = np.full_like(col, 255)
                correct = np.where((msk[..., None] / 255.0), col, white).astype(np.uint8)
                naive = col.astype(np.uint8)
                gap = np.full((h, 12, 3), 128, np.uint8)
                Image.fromarray(np.concatenate([naive, gap, correct], axis=1)).save(image_out)
                print(f"  对照图（左：忽略 /SMask 的渲染器 / 右：规范渲染器）→ {image_out}")

    doc.close()
    if checked == 0:
        print("没找到带 /SMask 的图像——这个 PDF 里没有印章？")
        return 1
    if bad_total:
        print(f"\n结论：❌ 有 {bad_total:,} 个透明像素是暗色，会在部分阅读器里显示成黑框")
        return 1
    print("\n结论：✓ 透明区是白的，不会出现黑框")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--image", help="把两种渲染视角的对照图写到这个路径")
    args = ap.parse_args()
    return analyse(args.pdf, args.image)


if __name__ == "__main__":
    sys.exit(main())
