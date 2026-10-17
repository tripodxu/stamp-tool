"""端到端：盖章 → 点导出 → 校验落盘 PDF 的质量。

这是最终验收脚本，覆盖从 UI 操作到像素级验证的完整链路。
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
from cdp import WS, find_page_target, launch

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / "examples"
PDF = EX / "示例文件.pdf"
SEAL = EX / "示例公章.png"
DOWNLOADS = Path(os.environ["USERPROFILE"]) / "Downloads"
PY = sys.executable


def main():
    before = {p.name for p in DOWNLOADS.glob("示例文件-已盖章*.pdf")}
    proc = launch()
    try:
        ws = WS(find_page_target()["webSocketDebuggerUrl"])

        def ev(e):
            r = ws.call("Runtime.evaluate", {"expression": e, "returnByValue": True})
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

        assert wait("!!document.querySelector('.toolbar')"), "界面未加载"
        print("[1] 界面加载 OK")

        set_file('input[accept*="pdf"]', PDF)
        assert wait("!!document.querySelector('canvas.page-canvas')"), "PDF 未渲染"
        print("[2] PDF 渲染 OK")

        set_file('input[accept*="image"]', SEAL)
        assert wait("document.querySelector('.panel').innerText.includes('DPI')")
        print("[3] 印章载入 OK")

        ev("[...document.querySelectorAll('button')]"
           ".find(b=>b.textContent==='放置印章').click()")
        assert wait("document.querySelectorAll('.stamp-box').length>0"), "印章未放置"
        print("[4] 印章放置 OK")

        coords = ev("""(()=>{const e=document.querySelector('.stamp-box');
            return JSON.stringify({left:e.style.left,top:e.style.top,
                                  width:e.style.width,rot:e.style.transform});})()""")
        print("[5] 印章坐标:", coords)

        ev("[...document.querySelectorAll('button')]"
           ".find(b=>b.textContent==='导出 PDF').click()")

        banner = None
        for _ in range(15):
            time.sleep(1)
            banner = ev("(document.querySelector('.banner.done')||{}).textContent")
            if banner:
                break
        print("[6] 成功提示:", (banner or "(无)").strip())

        new = {p.name for p in DOWNLOADS.glob("示例文件-已盖章*.pdf")} - before
        if not new:
            print("[7] ✗ 未产出文件")
            return 1
        out = max((DOWNLOADS / n for n in new), key=lambda p: p.stat().st_mtime)
        print(f"[7] 产出: {out.name}  {out.stat().st_size/1024:.1f} KB")

        shutil.copy(out, ROOT / "testdata" / "exported.pdf")
        c = json.loads(coords)
        left, top = c["left"].replace("px", ""), c["top"].replace("px", "")
        r = subprocess.run(
            [PY, str(ROOT / "scripts" / "verify-export.py"),
             left, top, "40", "-8", "1,0,0", str(PDF)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        print("\n=== 像素级验证 ===")
        print(r.stdout)
        ws.close()
        return 0 if "全部通过" in r.stdout else 1
    finally:
        proc.kill()
        proc.wait(timeout=15)


sys.exit(main())