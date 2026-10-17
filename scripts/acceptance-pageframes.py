# -*- coding: utf-8 -*-
"""端到端（页面几何专项）：在真实窗口里对四种「非普通」页面盖章，再做像素级核对。

覆盖 /Rotate 90/180/270 与 CropBox 内缩——这几类页面在旧实现下会偏 43~105mm，
其中「右下角」预设甚至会把章整个画到可见页面之外，而**预览始终是正常的**，
所以只有把导出文件栅格化、量印迹真实落点，才算真的测过。

前置：
    1. node scripts/make-pagefixtures.mjs && python scripts/check-pagefixtures.py
    2. npm run tauri build，把 exe 复制到 scripts/cdp.py 里的 EXE 路径（默认 E:\\印章工具.exe）
    3. 需要 pymupdf（见 scripts/requirements.txt）

用法：python scripts/acceptance-pageframes.py
"""
import json
import os
import shutil
import subprocess
import sys
# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import OUTDIR, WS, find_page_target, launch  # OUTDIR 默认 E:\\dl

ROOT = Path(__file__).resolve().parent.parent
TESTDATA = ROOT / "testdata"
SEAL = ROOT / "examples" / "示例公章.png"
PY = sys.executable

# 下载目录交给 CDP 指定，不碰用户真实的「下载」文件夹。
#
# 顺带解决一个自动化特有的坑：本脚本用 Runtime.evaluate 合成 .click()，
# 这在 Chromium 眼里**没有用户手势**，于是同一会话里第二次之后的下载会被
# 当作「自动下载」拦掉——应用照样弹「已导出」，磁盘上却没有文件。
# （实测：换成 Input.dispatchMouseEvent 的真实点击，连导三次都正常落盘，
#  所以这是自动化的问题，不是产品的问题。两条路任选：真实点击，或像这里
#  用 Browser.setDownloadBehavior 显式放行。）
DOWNLOADS = OUTDIR

FIXTURES = [
    ("fixture-rotate90.pdf", 297.0, 210.1),
    ("fixture-rotate180.pdf", 210.1, 297.0),
    ("fixture-rotate270.pdf", 297.0, 210.1),
    ("fixture-cropbox.pdf", 196.0, 283.0),
]
TOL_MM = 1.0


def ink_center_mm(pdf: Path):
    """栅格化（PyMuPDF 按显示方向渲染）后量红色印迹外接框中心，单位 mm。"""
    import pymupdf
    from PIL import Image

    dpi = 150
    page = pymupdf.open(str(pdf))[0]
    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    px = img.load()
    mm = 25.4 / dpi
    xs, ys = [], []
    for y in range(pix.height):
        for x in range(pix.width):
            r, g, b = px[x, y]
            if r > 120 and r - g > 45 and r - b > 45:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None, (pix.width * mm, pix.height * mm)
    return ((min(xs) + max(xs)) / 2 * mm, (min(ys) + max(ys)) / 2 * mm), (pix.width * mm, pix.height * mm)


def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for old in DOWNLOADS.glob("fixture-*-已盖章*.pdf"):
        old.unlink()
    proc = launch()
    results = []
    try:
        ws = WS(find_page_target()["webSocketDebuggerUrl"])
        ws.call("Browser.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": str(DOWNLOADS), "eventsEnabled": True})

        def ev(expr):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"].get("text"))[:200])
            return r["result"].get("value")

        def wait(expr, t=40):
            end = time.time() + t
            while time.time() < end:
                if ev(expr):
                    return True
                time.sleep(0.4)
            return False

        def set_file(sel, path):
            doc = ws.call("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
            nid = ws.call("DOM.querySelector", {"nodeId": doc, "selector": sel})["nodeId"]
            ws.call("DOM.setFileInputFiles", {"files": [str(path)], "nodeId": nid})

        # 换文档时会先弹「会清空当前已盖的印章」确认条（第二份夹具起就会遇到），
        # 自动化里直接点「仍然打开」——这条流程本身由 acceptance-ux.py 单独验收。
        CONFIRM = ("[...document.querySelectorAll('.banner.warn')]"
                   ".find(b=>b.textContent.includes('清空当前已盖'))")

        def open_pdf(path):
            set_file('input[accept*="pdf"]', path)
            if wait(f"!!({CONFIRM})", 5):
                ev(f"{CONFIRM}.querySelector('button.primary').click()")

        assert wait("!!document.querySelector('.toolbar')"), "界面未加载"
        set_file('input[accept*="image"]', SEAL)
        assert wait("document.querySelector('.panel').innerText.includes('DPI')"), "印章未载入"

        for name, want_w, want_h in FIXTURES:
            src = TESTDATA / name
            if not src.exists():
                results.append((name, None, "夹具不存在，先跑 make-pagefixtures.mjs"))
                continue

            open_pdf(src)
            # 等新文档就位：旧章清空 + 不在读盘 + 画布已存在。只看 canvas 会误判，
            # 它在新文档解析完之前就已经在 DOM 里了。
            assert wait("!document.querySelector('.banner.busy')"
                        " && document.querySelectorAll('.stamp-box').length===0"
                        " && !!document.querySelector('canvas.page-canvas')", 60), f"{name} 未就绪"
            time.sleep(0.5)

            # 页面数组可能还没填好，点一次没反应就再点，最多 5 次
            placed = False
            for _ in range(5):
                ev("[...document.querySelectorAll('button')]"
                   ".find(b=>b.textContent==='放置印章').click()")
                if wait("document.querySelectorAll('.stamp-box').length>0", 3):
                    placed = True
                    break
            assert placed, f"{name} 印章未放置"
            ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='右下角').click()")
            time.sleep(0.3)

            box = json.loads(ev("""(()=>{const e=document.querySelector('.stamp-box');
                return JSON.stringify({left:parseFloat(e.style.left),top:parseFloat(e.style.top),
                                       width:parseFloat(e.style.width)});})()"""))
            want = ((box["left"] + box["width"] / 2) * 25.4 / 72,
                    (box["top"] + box["width"] / 2) * 25.4 / 72)

            # 先收掉上一轮的成功/失败条，否则轮询 done 会立刻误判
            ev("(()=>{const b=document.querySelector('.banner.done button')"
               "||document.querySelector('.banner.error button'); if(b) b.click(); return true;})()")
            time.sleep(0.2)
            ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('导出')).click()")
            banner = None
            for _ in range(25):
                time.sleep(1)
                banner = ev("(document.querySelector('.banner.done')||{}).textContent")
                if banner:
                    break
            if not banner:
                err = ev("(document.querySelector('.banner.error')||{}).textContent")
                results.append((name, None, f"导出未完成：{err}"))
                continue

            # 应用自称导出的文件名（「已导出「X」，保存在…」）——以它为准去找文件，
            # 找不到就说明下载被浏览器拦了，而应用并不知情。
            claimed = banner.split("「")[1].split("」")[0] if "「" in banner else ""
            out = DOWNLOADS / claimed
            for _ in range(20):
                if out.exists() and out.stat().st_size > 1000:
                    break
                time.sleep(0.5)
            if not out.exists() or out.stat().st_size <= 1000:
                results.append((name, None,
                                f"应用提示已导出「{claimed}」，但文件没落盘（下载被拦截？）"))
                continue

            got, page_mm = ink_center_mm(out)
            print(f"    {name} → {out.name}  {out.stat().st_size / 1024:.0f} KB")
            if got is None:
                results.append((name, None, f"导出文件里没有红色印迹（页面 {page_mm[0]:.0f}x{page_mm[1]:.0f}mm）"))
                continue
            if abs(page_mm[0] - want_w) > 2 or abs(page_mm[1] - want_h) > 2:
                results.append((name, got, f"页面显示尺寸 {page_mm[0]:.0f}x{page_mm[1]:.0f}mm 与预期不符"))
                continue
            dx, dy = got[0] - want[0], got[1] - want[1]
            results.append((name, got, "OK" if abs(dx) < TOL_MM and abs(dy) < TOL_MM else
                            f"偏差 ({dx:+.2f}, {dy:+.2f})mm 超过 {TOL_MM}mm"))
            results[-1] = results[-1] + (want,)

        ws.close()

        print("\n【像素级核对：UI 坐标 vs 导出文件里的印迹】")
        ok = True
        for row in results:
            name, got = row[0], row[1]
            detail = row[2]
            if got is None:
                ok = False
                print(f"  [FAIL] {name:<24} {detail}")
                continue
            want = row[3]
            good = detail == "OK"
            ok = ok and good
            print(f"  [{'PASS' if good else 'FAIL'}] {name:<24} "
                  f"期望 ({want[0]:.1f}, {want[1]:.1f})mm  实测 ({got[0]:.1f}, {got[1]:.1f})mm  {detail}")
        print("\n结果：" + ("全部通过" if ok else "存在失败项"))
        return 0 if ok else 1
    finally:
        proc.kill()
        proc.wait(timeout=15)


if __name__ == "__main__":
    sys.exit(main())
