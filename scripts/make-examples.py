"""生成一套可直接使用的示例文件（放在 examples/ 目录）。

- 示例文件.pdf      : 3 页 A4，真实感合同排版，带盖章位参考线
- 示例公章.png      : 透明底圆形公章，1400px（≈886 DPI @40mm），环形排列单位名
- 示例公章-低分辨率.png : 300px 版本，用于演示分辨率体检提示

公章仅作演示用途，请勿用于任何真实文件。
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "examples"
OUT.mkdir(parents=True, exist_ok=True)

RED = (198, 22, 32, 255)


def _font(size, bold=False):
    from PIL import ImageFont

    paths = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf",
             r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simsun.ttc"]
    if not bold:
        paths = paths[::-1]
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ---------------------------------------------------------------- PDF
def build_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

    W, H = A4
    c = rl_canvas.Canvas(str(OUT / "示例文件.pdf"), pagesize=A4)

    def header(title, no):
        c.setFont("STSong-Light", 20)
        c.drawCentredString(W / 2, H - 85, title)
        c.setFont("STSong-Light", 10.5)
        c.drawString(70, H - 118, f"合同编号：HT-2026-{no}")
        c.drawRightString(W - 70, H - 118, f"第 {no} 页 / 共 3 页")
        c.setLineWidth(0.8)
        c.line(70, H - 132, W - 70, H - 132)

    def seal_zone(y_top, label):
        """画一个虚线框 + 标签，标出建议盖章位置"""
        c.setFont("STSong-Light", 9)
        c.setFillGray(0.45)
        c.drawString(300, y_top + 6, label)
        c.setDash(2, 2)
        c.setLineWidth(0.6)
        c.rect(300, y_top - 128, 140, 128, stroke=1, fill=0)
        c.setDash()

    # ---- 第 1 页：技术服务合同
    header("技术服务合同", "001")
    c.setFillGray(0)
    c.setFont("STSong-Light", 11)
    body1 = [
        "甲方（委托方）：示范科技有限公司",
        "乙方（服务方）：示例信息技术有限公司",
        "签订地点：本市",
        "",
        "第一条  服务内容",
        "    乙方为甲方提供系统开发、技术支持与运维服务，具体范围、",
        "交付标准及里程碑以附件一《技术服务说明书》为准。",
        "",
        "第二条  服务期限",
        "    本合同服务期限自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止。",
        "期限届满前三十日内，双方可另行签订续约协议。",
        "",
        "第三条  服务费用及支付方式",
        "    合同总金额为人民币肆拾贰万元整（¥420,000.00）。甲方于合同",
        "生效后十个工作日内支付百分之三十作为预付款，验收合格后支付",
        "百分之六十，剩余百分之十于质保期满后三十日内结清。",
        "",
        "第四条  保密条款",
        "    双方对在履行本合同过程中知悉的对方商业秘密负有保密义务，",
        "保密期限自本合同签订之日起五年。",
    ]
    for i, line in enumerate(body1):
        c.drawString(70, H - 175 - i * 22, line)

    c.setFont("STSong-Light", 11)
    c.drawString(70, H - 175 - len(body1) * 22 - 20, "（以下无正文，为签署页）")
    seal_zone(430, "甲方盖章处")
    seal_zone(210, "乙方盖章处")

    c.setFont("STSong-Light", 10.5)
    c.drawString(70, 175, "甲方代表（签字）：____________________")
    c.drawString(330, 175, "乙方代表（签字）：____________________")
    c.drawString(70, 120, "日期：        年     月     日")
    c.drawString(330, 120, "日期：        年     月     日")
    c.showPage()

    # ---- 第 2 页：验收确认单
    header("项目验收确认单", "002")
    c.setFillGray(0)
    c.setFont("STSong-Light", 11)
    body2 = [
        "项目名称：企业门户系统开发（一期）",
        "承建单位：示例信息技术有限公司",
        "验收日期：      年     月     日",
        "",
        "一、验收内容",
        "    1. 用户认证与权限管理模块　　符合合同约定　　□是 □否",
        "    2. 文档管理与版本控制模块　　符合合同约定　　□是 □否",
        "    3. 数据统计与报表导出模块　　符合合同约定　　□是 □否",
        "    4. 移动端适配　　　　　　　　符合合同约定　　□是 □否",
        "",
        "二、验收结论",
        "    经检查，上述各模块功能完整，运行稳定，数据迁移完整无误。",
        "验收结论：□ 通过　　□ 限期整改后通过　　□ 不通过",
        "",
        "三、遗留问题",
        "    （如有请在此填写）",
    ]
    for i, line in enumerate(body2):
        c.drawString(70, H - 175 - i * 24, line)
    seal_zone(250, "承建单位盖章处")
    c.showPage()

    # ---- 第 3 页：付款申请单
    header("付款申请单", "003")
    c.setFillGray(0)
    c.setFont("STSong-Light", 11)
    body3 = [
        "申请单位：示范科技有限公司",
        "对应合同：技术服务合同（HT-2026-001）",
        "申请金额：人民币壹拾陆万捌仟元整（¥168,000.00）",
        "付款阶段：第二期（验收合格后支付 60%）",
        "",
        "收款账户信息",
        "    户　名：示例信息技术有限公司",
        "    开户行：示范银行营业部",
        "    账　号：6222 0000 0000 0000",
        "",
        "申请说明",
        "    项目已于本期完成验收并取得验收确认单，申请按合同约定支付",
        "第二期款项，请予审批。",
    ]
    for i, line in enumerate(body3):
        c.drawString(70, H - 175 - i * 24, line)

    # 表格
    ty = 520
    c.setLineWidth(0.7)
    c.rect(70, ty - 110, W - 140, 110)
    c.line(70, ty - 40, W - 70, ty - 40)
    c.line(70, ty - 78, W - 70, ty - 78)
    c.line(330, ty - 110, 330, ty)
    c.setFont("STSong-Light", 10)
    c.drawString(85, ty - 26, "审批意见")
    c.drawString(345, ty - 26, "财务复核")
    c.drawString(85, ty - 64, "（签字）")
    c.drawString(345, ty - 64, "（签字）")
    c.drawString(85, ty - 100, "日期：")
    c.drawString(345, ty - 100, "日期：")

    seal_zone(300, "申请单位盖章处")
    c.showPage()

    c.save()
    print(f"  {OUT / '示例文件.pdf'}")


# ---------------------------------------------------------------- 公章
def arc_text(img, draw, text, center, radius, font, fill, start_deg, sweep_deg):
    """把文字沿圆弧逐字摆放"""
    cx, cy = center
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths)
    arc_len = abs(math.radians(sweep_deg)) * radius
    scale = arc_len / total if total else 1.0
    angle = math.radians(start_deg)
    for ch, w in zip(text, widths):
        step = (w * scale) / radius
        a = angle + (step / 2)
        draw.text(
            (cx + radius * math.cos(a), cy + radius * math.sin(a)),
            ch, font=font, fill=fill, anchor="mm",
        )
        angle += step if sweep_deg > 0 else -step


def build_seal(size=1400, name="示例公章.png"):
    from PIL import Image, ImageDraw

    S = size * 2  # 超采样
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    r = S * 0.470

    # 五角星
    star = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r * (0.26 if i % 2 == 0 else 0.108)
        star.append((c + rad * math.cos(ang), c + rad * math.sin(ang)))
    d.polygon(star, fill=RED)

    # 外圈 + 下方横线（真实公章常见样式）
    d.ellipse([c - r, c - r, c + r, c + r], outline=RED, width=int(S * 0.0165))
    gap = math.radians(38)
    half = math.radians(52)
    for sgn in (-1, 1):
        x = c + sgn * r * math.sin(half)
        y = c + r * math.cos(half)
        x2 = c + sgn * r * math.sin(gap)
        y2 = c + r * math.cos(gap)
        d.line([x, y, x2, y2], fill=RED, width=int(S * 0.0165))

    # 环形单位名
    unit = "示例信息技术有限公司"
    arc_text(img, d, unit, (c, c), r * 0.845, _font(int(S * 0.062), bold=True),
             RED, start_deg=200, sweep_deg=-140)

    # 底部税号（正排，不跟随弧线）
    d.text((c, c + r * 0.415), "示范演示专用章", font=_font(int(S * 0.052), bold=True),
           fill=RED, anchor="mm")
    d.text((c, c + r * 0.585), "编号 91440100MA00DEMO1X",
           font=_font(int(S * 0.040)), fill=RED, anchor="mm")

    img = img.resize((size, size), Image.LANCZOS)
    img.save(OUT / name)
    dpi = size / (40 / 25.4)
    print(f"  {OUT / name}  {size}x{size}  ≈{dpi:.0f} DPI @40mm")


if __name__ == "__main__":
    build_pdf()
    build_seal(1400, "示例公章.png")
    build_seal(300, "示例公章-低分辨率.png")
    print("done")