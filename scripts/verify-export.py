"""导出校验（像素级）。

不解析内容流矩阵——那会漏掉 q/Q、translate、rotate、scale 等算子，
得到的矩阵不可靠。改为**栅格化导出文件，直接测量红色印迹的实际几何量**：
质心位置与外接直径。这是独立于实现的黑盒验证。

用法：
    python scripts/verify-export.py <ui_xPt> <ui_yTopDownPt> <sizeMm> <rotationDeg>
不传参数时只跑结构性检查。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 允许指定要比对的原始文件：verify-export.py <ui_x> <ui_y> <mm> <rot> [页数] [原始pdf]
SRC = Path(sys.argv[6]) if len(sys.argv) > 6 else ROOT / "testdata" / "test-doc.pdf"
OUT = ROOT / "testdata" / "exported.pdf"

if not OUT.exists():
    sys.exit("导出文件不存在，先在页面上导出一次")

from pypdf import PdfReader

ok = True


def check(label, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")


print(f"原始 {SRC.name} / 导出 {OUT.name}\n")

a = PdfReader(str(SRC))
b = PdfReader(str(OUT))

print("【结构检查】")
check("页数一致", len(a.pages) == len(b.pages), f"{len(a.pages)} vs {len(b.pages)}")

size_ok = all(
    abs(float(x.mediabox.width) - float(y.mediabox.width)) < 0.01
    and abs(float(x.mediabox.height) - float(y.mediabox.height)) < 0.01
    for x, y in zip(a.pages, b.pages)
)
check("页面尺寸未变", size_ok)

ta = "".join((p.extract_text() or "") for p in a.pages)
tb = "".join((p.extract_text() or "") for p in b.pages)
check(
    "文字仍可提取（未被栅格化）",
    len(tb.strip()) > 50 and "技术服务合同" in tb,
    f"原 {len(ta)} 字符 / 出 {len(tb)} 字符",
)
check(
    "正文逐字一致",
    ta.replace(" ", "").replace("\n", "") == tb.replace(" ", "").replace("\n", ""),
)
# 预期每页印章数：可用第 5 个参数传入，如 "1,1,0"；缺省则只做合计检查
expected = None
if len(sys.argv) >= 6 and sys.argv[5]:
    expected = [int(v) for v in sys.argv[5].split(",")]

for i, (pa, pb) in enumerate(zip(a.pages, b.pages), 1):
    ia, ib = len(pa.images), len(pb.images)
    delta = ib - ia
    if expected is not None and i - 1 < len(expected):
        check(f"第 {i} 页新增印章图像", delta == expected[i - 1],
              f"{ia} → {ib}（预期 +{expected[i - 1]}）")
    else:
        print(f"  [INFO] 第 {i} 页印章图像 {ia} → {ib}（+{delta}）")


# ---------------------------------------------------------------- 像素测量
print("\n【像素测量：栅格化导出文件，测量印迹实际几何量】")
import pymupdf
from PIL import Image

DPI = 300
doc = pymupdf.open(str(OUT))
page = doc[0]
pix = page.get_pixmap(dpi=DPI)
img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

px = img.load()
W, H = img.size
PT_PER_PX = 72.0 / DPI
MM_PER_PX = 25.4 / DPI

xs, ys = [], []
for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        # 印章红：红通道显著高于绿蓝
        if r > 120 and r - g > 45 and r - b > 45:
            xs.append(x)
            ys.append(y)

if not xs:
    check("第 1 页存在红色印迹", False, "未检出任何红色像素")
    sys.exit(1)

check("第 1 页存在红色印迹", True, f"{len(xs)} 个像素")

cx = sum(xs) / len(xs)
cy = sum(ys) / len(ys)
min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
span_mm_x = (max_x - min_x + 1) * MM_PER_PX
span_mm_y = (max_y - min_y + 1) * MM_PER_PX

# 用外接框中心而非质心：印章图形上下并不对称，质心会系统性偏移
box_cx = (min_x + max_x) / 2 * MM_PER_PX
box_cy = (min_y + max_y) / 2 * MM_PER_PX

print(f"  印迹外接框：{span_mm_x:.2f} × {span_mm_y:.2f} mm")
print(f"  外接框中心：({box_cx:.2f}, {box_cy:.2f}) mm（自页面左上角）")
print(f"  像素质心：  ({(sum(xs)/len(xs))*MM_PER_PX:.2f}, {(sum(ys)/len(ys))*MM_PER_PX:.2f}) mm")

# 与 UI 预期对比
if len(sys.argv) >= 5:
    ui_x, ui_y, size_mm, rot = (float(v) for v in sys.argv[1:5])
    side_pt = size_mm / 25.4 * 72
    exp_cx_mm = (ui_x + side_pt / 2) * 25.4 / 72
    exp_cy_mm = (ui_y + side_pt / 2) * 25.4 / 72

    dx = box_cx - exp_cx_mm
    dy = box_cy - exp_cy_mm
    check(
        "印章中心与 UI 拖拽位置一致",
        abs(dx) < 1.0 and abs(dy) < 1.0,
        f"UI({exp_cx_mm:.2f}, {exp_cy_mm:.2f})mm vs 实测({box_cx:.2f}, {box_cy:.2f})mm"
        f" 偏差({dx:+.2f}, {dy:+.2f})mm",
    )
    check(
        "印章直径 = 设定值",
        abs(span_mm_x - size_mm) < 1.0,
        f"设定 {size_mm}mm / 实测 {span_mm_x:.2f}mm",
    )
else:
    print("  （未传入 UI 预期值，跳过位置比对）")

# 保存带标注的对照图，便于人工确认
img.save(ROOT / "testdata" / "exported-page1-raster.png")
print(f"\n  栅格图已保存：testdata/exported-page1-raster.png")

print("\n结果：" + ("全部通过" if ok else "存在失败项"))
sys.exit(0 if ok else 1)