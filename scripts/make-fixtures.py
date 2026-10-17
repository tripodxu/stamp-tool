"""生成端到端测试夹具。

- test-doc.pdf      : 3 页 A4，reportlab 生成原生矢量文字（用于验证导出后文字未被栅格化）
- seal-clean.png    : 干净透明底公章，900px（≈575 DPI @40mm）
- seal-fringed.png  : 模拟 Photoshop「未预乘 alpha + 白底」导出，带半透明白边
- seal-lowres.png   : 300px 低分辨率章（用于触发分辨率体检警告）
"""
from pathlib import Path
import math

OUT = Path(__file__).resolve().parent.parent / "testdata"
RED = (200, 20, 30, 255)


def _font(size):
    from PIL import ImageFont

    for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
                 r"C:\Windows\Fonts\msyh.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    # 使用 CID 中文字体：导出后文本必须仍是文字，而不是被压成图片
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

    W, H = A4
    titles = ["技术服务合同", "验收确认单", "付款申请单"]
    path = OUT / "test-doc.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=A4)

    for i, title in enumerate(titles):
        c.setFont("STSong-Light", 22)
        c.drawCentredString(W / 2, H - 90, title)

        c.setFont("STSong-Light", 11)
        c.drawString(60, H - 140, f"文件编号：HT-2026-{i + 1:04d}")
        c.setLineWidth(0.5)
        c.rect(40, 40, W - 80, H - 80)

        for k in range(6):
            c.drawString(
                60,
                H - 200 - k * 30,
                f"第 {k + 1} 条  本条为测试正文，用于验证 PDF 渲染与盖章位置。",
            )

        # 盖章参考线：用于把章对准真实位置
        c.setFont("STSong-Light", 10)
        c.line(W - 240, 150, W - 60, 150)
        c.drawString(W - 240, 158, "甲方盖章处")
        c.line(W - 240, 70, W - 60, 70)
        c.drawString(W - 240, 78, "乙方盖章处")
        c.setFont("STSong-Light", 9)
        c.drawString(60, 55, f"第 {i + 1} 页 / 共 3 页")

        c.showPage()

    c.save()
    print(f"  {path}")


def seal(size=900, fringed=False, name="seal-clean.png"):
    from PIL import Image, ImageDraw

    S = size * 2  # 超采样后缩小，得到抗锯齿边缘
    img = Image.new("RGBA", (S, S), (255, 255, 255, 255) if fringed else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    r = S * 0.46

    d.ellipse([c - r, c - r, c + r, c + r], outline=RED, width=int(S * 0.018))

    star = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r * (0.30 if i % 2 == 0 else 0.125)
        star.append((c + rad * math.cos(ang), c + rad * math.sin(ang)))
    d.polygon(star, fill=RED)

    d.text((c, c - r * 0.10), "测试专用章", font=_font(int(S * 0.085)), fill=RED, anchor="mm")
    d.text((c, c - r * 0.50), "示范科技有限公司", font=_font(int(S * 0.055)), fill=RED, anchor="mm")
    d.text((c, c + r * 0.52), "4401000000000", font=_font(int(S * 0.042)), fill=RED, anchor="mm")

    img = img.resize((size, size), Image.LANCZOS)

    if fringed:
        # 模拟未预乘 alpha + 白底存法：把半透明像素向白色混合，产生白色毛边
        px = img.load()
        for y in range(size):
            for x in range(size):
                r0, g0, b0, a = px[x, y]
                if 0 < a < 255:
                    k = a / 255
                    px[x, y] = (
                        int(200 * k + 255 * (1 - k)),
                        int(20 * k + 255 * (1 - k)),
                        int(30 * k + 255 * (1 - k)),
                        min(255, int(a * 1.3)),
                    )

    path = OUT / name
    img.save(path)
    print(f"  {path}  {img.size[0]}x{img.size[1]}  fringe={fringed}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build_pdf()
    seal(900, False, "seal-clean.png")
    seal(900, True, "seal-fringed.png")
    seal(300, False, "seal-lowres.png")
    print("done")