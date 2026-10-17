# -*- coding: utf-8 -*-
"""端到端（批量盖章）：在真实窗口里一次给多份 PDF 盖章，核对 ZIP 与逐份印迹位置。

为什么必须端到端：批量走的是「规则 + 逐文件重算几何」这条路，单测只能证明
公式对，证明不了「选文件 → 逐份盖章 → 打包成一个 ZIP → 落盘」这条链真的通。
所以这里驱动真实 exe（WebView2），把下载目录指到临时目录，再用标准库
zipfile 打开产物、用 PyMuPDF 量每一页的红色印迹中心。

覆盖四件事：
  1. 页面几何：三份「非普通页面」（/Rotate 90、/Rotate 270、CropBox 内缩）
     各 1 页，位置必须与「落款处」预设的公式一致（±1mm）。
  2. 页码规则：三页的 test-doc.pdf，留空＝三页都盖；「末页」＝只有第 3 页有墨。
  3. 跳过规则：页码全部越界时不出 ZIP，并在界面上给出原因。
  4. 骑缝（左）：章心压左边缘，页内只剩右半边——印迹必须贴着左边缘。

用法：python scripts/acceptance-batch.py
"""
import json
import sys
import time
import zipfile
from pathlib import Path

# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import OUTDIR, WS, find_page_target, launch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TESTDATA = ROOT / "testdata"
SEAL = ROOT / "examples" / "示例公章.png"

# 下载目录交给 CDP 指定，不碰用户真实的「下载」文件夹。
DOWNLOADS = OUTDIR / "batch"
MM = 25.4 / 72.0

# 与 src/lib/geometry.ts 的 presetPatch('signature') 一致：距页左上角 30mm，
# 距页底 35mm（都是显示空间）。
SIG_X_MM = 30.0
SIG_BOTTOM_MM = 35.0
TOL_MM = 1.0

# 与 presetPatch('bindingEdgeLeft' / 'bindingEdgeRight') 一致：
# 章心压在左/右页边；纵向是**章顶**落在页面高度的 28% 处。
# 注意「从页顶算」：Stamp.yPt 是显示坐标（原点在页面左上角，y 向下），
# 导出时才按页面 /Rotate 换算成 PDF 的左下角坐标。
# 这一点由本脚本量出的像素证实——右下角预设的印迹中心在 210mm 高的
# fixture 上是 178mm（= 210 − 40 − 12 + 20），而不是镜像的 32mm。
BIND_Y_RATIO = 0.28

FILES = ["fixture-rotate90.pdf", "fixture-rotate270.pdf", "fixture-cropbox.pdf", "test-doc.pdf"]


def ink_pixels(page, dpi=150):
    """栅格化后扫出红色印迹的像素坐标，返回 (xs, ys, 每像素毫米数)。"""
    from PIL import Image

    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    px = img.load()
    xs, ys = [], []
    for y in range(pix.height):
        for x in range(pix.width):
            r, g, b = px[x, y]
            if r > 120 and r - g > 45 and r - b > 45:
                xs.append(x)
                ys.append(y)
    return xs, ys, 25.4 / dpi


def ink_center_mm(page, dpi=150):
    """红色印迹外接框中心（显示空间，mm）；没有印迹返回 None。"""
    xs, ys, mm = ink_pixels(page, dpi)
    if not xs:
        return None
    return ((min(xs) + max(xs)) / 2 * mm, (min(ys) + max(ys)) / 2 * mm)


def check_binding_left(name, data, box_mm):
    """骑缝（左）：章心压在页面左边缘，页内只看得到右半边。

    这里量不了「印迹中心」（另一半在页外），只能量可见的那半边：
    印迹要贴住左边缘、右边界约等于半个章宽、纵向中心与预设公式一致。
    """
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    problems = []
    for i, page in enumerate(doc):
        xs, ys, mm = ink_pixels(page)
        page_mm = (page.rect.width * MM, page.rect.height * MM)
        if not xs:
            problems.append(f"第 {i+1} 页应有印章，却没找到红色印迹")
            continue
        left, right = min(xs) * mm, max(xs) * mm
        mid_y = (min(ys) + max(ys)) / 2 * mm
        # 章顶 = 页高的 28%（自页顶算）→ 章心再往下半枚章
        want_y = page_mm[1] * BIND_Y_RATIO + box_mm[1] / 2
        half = box_mm[0] / 2
        print(f"      {name} 第 {i+1} 页（{page_mm[0]:.0f}x{page_mm[1]:.0f}mm）"
              f" 左边界 {left:.2f}mm 右边界 {right:.2f}mm（半枚章 {half:.1f}mm）"
              f" 纵向中心 期望 {want_y:.1f} 实测 {mid_y:.1f}mm")
        if left > 0.8:
            problems.append(f"第 {i+1} 页印迹没贴住左边缘（左边界 {left:.2f}mm）")
        if abs(right - half) > TOL_MM + 0.5:
            problems.append(f"第 {i+1} 页页内只剩 {right:.2f}mm，应当约半枚章 {half:.1f}mm")
        if abs(mid_y - want_y) > TOL_MM:
            problems.append(f"第 {i+1} 页纵向中心偏差 {mid_y - want_y:+.2f}mm")
    doc.close()
    return problems


def check_pdf(name, data, want_pages, box_mm):
    """核对一份导出文件：哪些页有印迹、印迹中心是否落在预设位置。

    want_pages 是「应当盖章」的 1 基页号集合；其余页必须没有红色印迹。
    box_mm 是印章的显示尺寸 (宽, 高)，由界面上的「宽 X mm」和缩略图长宽比推出。
    """
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    problems = []
    for i, page in enumerate(doc):
        got = ink_center_mm(page)
        want = (i + 1) in want_pages
        page_mm = (page.rect.width * MM, page.rect.height * MM)  # pt → mm
        if want and got is None:
            problems.append(f"第 {i+1} 页应有印章，却没找到红色印迹")
            continue
        if not want and got is not None:
            problems.append(f"第 {i+1} 页不该有印章，却量到印迹 {got[0]:.1f},{got[1]:.1f}mm")
            continue
        if not want:
            continue
        want_pt = (SIG_X_MM + box_mm[0] / 2, page_mm[1] - SIG_BOTTOM_MM - box_mm[1] / 2)
        dx, dy = got[0] - want_pt[0], got[1] - want_pt[1]
        flag = "OK" if abs(dx) < TOL_MM and abs(dy) < TOL_MM else "偏差超限"
        print(f"      {name} 第 {i+1} 页（{page_mm[0]:.0f}x{page_mm[1]:.0f}mm）"
              f" 期望 ({want_pt[0]:.1f}, {want_pt[1]:.1f})mm 实测 ({got[0]:.1f}, {got[1]:.1f})mm"
              f" 偏差 ({dx:+.2f}, {dy:+.2f})mm  {flag}")
        if flag != "OK":
            problems.append(f"第 {i+1} 页偏差 ({dx:+.2f}, {dy:+.2f})mm 超过 {TOL_MM}mm")
    doc.close()
    return problems


def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for old in list(DOWNLOADS.glob("*.zip")) + list(DOWNLOADS.glob("*.pdf")):
        old.unlink()

    missing = [n for n in FILES if not (TESTDATA / n).exists()]
    if missing:
        print(f"缺少夹具：{', '.join(missing)}（先跑 npm run fixtures）")
        return 1

    proc = launch()
    failures = []
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

        def set_files(paths):
            doc = ws.call("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
            nid = ws.call("DOM.querySelector",
                          {"nodeId": doc, "selector": ".batch-file-input"})["nodeId"]
            assert nid, "没找到批量面板的文件输入框"
            ws.call("DOM.setFileInputFiles", {"files": [str(p) for p in paths], "nodeId": nid})

        def click(text):
            return ev(f"[...document.querySelectorAll('button')]"
                      f".find(b=>b.textContent.trim()==='{text}')?.click(), true")

        # 「结果」是第五个 section，只有跑完（outcomes 非空）才出现；① 里也有一个
        # .batch-files 列表，所以取结果必须限定在这个 section 里，否则会读到文件清单。
        RESULT = ("[...document.querySelectorAll('section.batch-step')]"
                  ".find(s=>s.querySelector('h3')?.textContent.includes('结果'))")

        def wait_result(t=180):
            return wait(f"(()=>{{const s={RESULT};"
                        "return !!s && !document.querySelector('.batch-progress');})()", t)

        def result_text(sel):
            return ev(f"(()=>{{const s={RESULT};const e=s&&s.querySelector('{sel}');"
                      "return e?e.innerText:'';})()") or ""

        def result_rows():
            return ev(f"(()=>{{const s={RESULT};"
                      "return s?[...s.querySelectorAll('li')].map(li=>li.innerText"
                      ".replace(/\\s+/g,' ')):[];})()") or []

        assert wait("!!document.querySelector('.toolbar')", 60), "界面未加载"
        doc = ws.call("DOM.getDocument", {"depth": -1})["root"]["nodeId"]

        # 印章：用示例公章，导入后自动成为当前印章（库里已存在时按内容去重，不会重复）
        nid = ws.call("DOM.querySelector",
                      {"nodeId": doc, "selector": 'input[accept*="image"]'})["nodeId"]
        ws.call("DOM.setFileInputFiles", {"files": [str(SEAL)], "nodeId": nid})
        assert wait("[...document.querySelectorAll('button')]"
                    ".some(b=>b.textContent.trim()==='批量盖章'&&!b.disabled)", 90), \
            "印章未能载入（「批量盖章」一直不可点）"

        click("批量盖章")
        assert wait("!!document.querySelector('.batch-card')", 20), "批量面板没打开"

        # 印章尺寸：面板上的「宽 X mm」＋ 缩略图长宽比，推出显示宽高（mm）。
        # 缩略图是现建的 objectURL，解码要一帧：库里有多枚章时（点开面板的
        # 这一枚可能就是没缓存过的那枚）只读一次会拿到 naturalWidth=0，
        # 那不是产品坏了，是脚本抢跑——所以轮询等到图真的解码出来。
        info: dict = {}
        for _ in range(40):
            info = json.loads(ev("""(()=>{const i=document.querySelector('.batch-seal img');
                const sub=document.querySelector('.batch-seal .seal-sub');
                return JSON.stringify({w:i?i.naturalWidth:0,h:i?i.naturalHeight:0,
                                       has:!!i, text:sub?sub.innerText:''});})()"""))
            if info.get("w") and info.get("h"):
                break
            time.sleep(0.25)
        assert info.get("w") and info.get("h"), f"面板里读不到印章尺寸：{info}"
        seal_w_mm = float(info["text"].split("宽")[1].split("mm")[0].strip())
        box_mm = (seal_w_mm, seal_w_mm * info["h"] / info["w"])
        print(f"  印章显示尺寸 {box_mm[0]:.1f}x{box_mm[1]:.1f}mm（缩略图 {info['w']}x{info['h']}px）"
              f" 位置预设：落款处（距页左上角 {SIG_X_MM:.0f}mm、距页底 {SIG_BOTTOM_MM:.0f}mm）\n")

        # ---- 第一批：留空＝全部页，四种页面各盖各的 ----
        print("【批次 1】4 份文件，页码留空（全部页）")
        set_files([TESTDATA / n for n in FILES])
        assert wait("document.querySelector('.batch-count').innerText.includes('4 份')", 20), \
            "选了 4 份文件，界面没跟上"
        click("开始批量盖章")
        assert wait_result(300), "批量盖章没有结果"
        ok_text = result_text(".batch-ok")
        for row in result_rows():
            print(f"      {row}")
        if not ok_text:
            failures.append(f"批次 1 没有生成 ZIP：{result_text('.batch-err')}")
        else:
            zip_name = ok_text.split("「")[1].split("」")[0]
            path = DOWNLOADS / zip_name
            for _ in range(20):
                if path.exists() and path.stat().st_size > 1000:
                    break
                time.sleep(0.5)
            if not path.exists():
                failures.append(f"界面说已打包「{zip_name}」，但文件没落盘（下载被拦？）")
            else:
                print(f"      → {path.name}  {path.stat().st_size/1024:.0f} KB")
                with zipfile.ZipFile(path) as z:
                    names = z.namelist()
                    want_names = [f"{Path(n).stem}-已盖章.pdf" for n in FILES]
                    if names != want_names:
                        failures.append(f"ZIP 条目不对：{names} != {want_names}")
                    for n in FILES:
                        entry = f"{Path(n).stem}-已盖章.pdf"
                        if entry not in names:
                            continue
                        total = 3 if n == "test-doc.pdf" else 1
                        problems = check_pdf(entry, z.read(entry), set(range(1, total + 1)), box_mm)
                        failures += [f"{entry}: {p}" for p in problems]

        # ---- 第二批：「末页」只盖每份文件的最后一页 ----
        print("\n【批次 2】只选三页的 test-doc.pdf，页码「末页」")
        click("清空")
        time.sleep(0.5)
        set_files([TESTDATA / "test-doc.pdf"])
        assert wait("document.querySelector('.batch-count').innerText.includes('1 份')", 20), \
            "清空后重新选文件失败"
        ev("""(()=>{const i=document.querySelector('.batch-input');
            const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            set.call(i,'末页'); i.dispatchEvent(new Event('input',{bubbles:true})); return true;})()""")
        time.sleep(0.3)
        click("开始批量盖章")
        assert wait_result(180), "第二批没有结果"
        ok_text = result_text(".batch-ok")
        zip_name = ok_text.split("「")[1].split("」")[0]
        path = DOWNLOADS / zip_name
        for _ in range(20):
            if path.exists() and path.stat().st_size > 1000:
                break
            time.sleep(0.5)
        if not path.exists():
            failures.append(f"第二批：界面说已打包「{zip_name}」，但文件没落盘")
        else:
            print(f"      → {path.name}  {path.stat().st_size/1024:.0f} KB")
            with zipfile.ZipFile(path) as z:
                entry = "test-doc-已盖章.pdf"
                if z.namelist() != [entry]:
                    failures.append(f"第二批 ZIP 条目不对：{z.namelist()}")
                else:
                    problems = check_pdf(entry, z.read(entry), {3}, box_mm)
                    failures += [f"{entry}: {p}" for p in problems]

        # ---- 第三批：页码全部越界，应当不产出 ZIP 且说明原因 ----
        print("\n【批次 3】页码写 9（超出 1 页的夹具），应当不出 ZIP、给出原因")
        click("清空")
        time.sleep(0.5)
        set_files([TESTDATA / "fixture-rotate90.pdf"])
        ev("""(()=>{const i=document.querySelector('.batch-input');
            const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            set.call(i,'9'); i.dispatchEvent(new Event('input',{bubbles:true})); return true;})()""")
        time.sleep(0.3)
        click("开始批量盖章")
        assert wait_result(120), "第三批没有结果"
        note = result_text(".batch-err")
        row = (result_rows() or [""])[0]
        print(f"      {note.strip()} / {row.replace(chr(10), ' ')}")
        if "没有生成压缩包" not in note:
            failures.append(f"第三批应当提示「没有生成压缩包」，实际是：{note!r}")
        if "超出这份文件的页数" not in row:
            failures.append(f"第三批的跳过原因不对：{row!r}")

        # ---- 第四批：骑缝（左），章心压左边缘，页内只剩右半边 ----
        print("\n【批次 4】只选一份夹具，预设改「骑缝（左）」")
        click("清空")
        time.sleep(0.5)
        set_files([TESTDATA / "fixture-rotate90.pdf"])
        ev("""(()=>{const i=document.querySelector('.batch-input');
            const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); return true;})()""")
        time.sleep(0.3)
        click("骑缝（左）")
        time.sleep(0.3)
        click("开始批量盖章")
        assert wait_result(180), "第四批没有结果"
        ok_text = result_text(".batch-ok")
        if not ok_text:
            failures.append(f"第四批没有生成 ZIP：{result_text('.batch-err')}")
        else:
            zip_name = ok_text.split("「")[1].split("」")[0]
            path = DOWNLOADS / zip_name
            for _ in range(20):
                if path.exists() and path.stat().st_size > 1000:
                    break
                time.sleep(0.5)
            if not path.exists():
                failures.append(f"第四批：界面说已打包「{zip_name}」，但文件没落盘")
            else:
                print(f"      → {path.name}  {path.stat().st_size/1024:.0f} KB")
                with zipfile.ZipFile(path) as z:
                    entry = "fixture-rotate90-已盖章.pdf"
                    if entry not in z.namelist():
                        failures.append(f"第四批 ZIP 条目不对：{z.namelist()}")
                    else:
                        problems = check_binding_left(entry, z.read(entry), box_mm)
                        failures += [f"{entry}: {p}" for p in problems]

        ws.close()
    finally:
        proc.kill()
        proc.wait(timeout=15)

    print("\n结果：" + ("全部通过" if not failures else "存在失败项"))
    for f in failures:
        print(f"  [FAIL] {f}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
