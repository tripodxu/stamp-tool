"""抓取 Tauri 窗口内完成盖章后的真实截图。"""
import base64
import os
import time
from pathlib import Path

from cdp import WS, find_page_target, launch

TESTDATA = Path(__file__).resolve().parent.parent / "testdata"
SHOT = Path(os.environ.get("STAMP_SHOT") or (TESTDATA / "tauri-screenshot.png"))

proc = launch()
try:
    tgt = find_page_target()
    ws = WS(tgt["webSocketDebuggerUrl"])

    def ev(expr, timeout=90):
        r = ws.call("Runtime.evaluate",
                    {"expression": expr, "returnByValue": True}, timeout=timeout)
        return r["result"].get("value")

    def wait_for(expr, timeout=40):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if ev(expr):
                return True
            time.sleep(0.4)
        raise TimeoutError(expr)

    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": 1280, "height": 860, "deviceScaleFactor": 1, "mobile": False})
    wait_for("!!document.querySelector('.toolbar')")

    def set_file(selector, path):
        doc = ws.call("DOM.getDocument")["root"]["nodeId"]
        nid = ws.call("DOM.querySelector", {"nodeId": doc, "selector": selector})["nodeId"]
        ws.call("DOM.setFileInputFiles", {"files": [str(path)], "nodeId": nid})

    set_file('input[accept*="pdf"]', TESTDATA / "test-doc.pdf")
    wait_for("!!document.querySelector('canvas.page-canvas')")
    set_file('input[accept*="image"]', TESTDATA / "seal-clean.png")
    wait_for("document.querySelector('.panel').innerText.includes('DPI')")
    ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='放置印章').click()")
    wait_for("document.querySelectorAll('.stamp-box').length>0")
    time.sleep(1.5)

    data = ws.call("Page.captureScreenshot", {"format": "png"})
    SHOT.write_bytes(base64.b64decode(data["data"]))
    print("saved:", SHOT, f"{SHOT.stat().st_size/1024:.0f} KB")
    print("panel:", ev("document.querySelector('.panel').innerText.replace(/\\n/g,' | ')")[:160])
    ws.close()
finally:
    proc.kill()
    proc.wait(timeout=15)