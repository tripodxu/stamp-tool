"""在 Tauri 桌面窗口内跑完整盖章流程并验证导出。

这次测试与之前的浏览器版验证互补：浏览器版证明了算法正确，
这里证明「同一份前端在 Tauri/WebView2 里也能跑通」——
尤其是两个 Tauri 特有风险：
  1. pdf.js 的 worker 能否从 tauri.localhost 协议加载
  2. blob 下载在 WebView2 里能否落盘
"""
import base64
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from cdp import OUTDIR as _OUTDIR, WS, find_page_target, launch

TESTDATA = Path(__file__).resolve().parent.parent / "testdata"
OUTDIR = _OUTDIR
PDF = TESTDATA / "test-doc.pdf"
SEAL = TESTDATA / "seal-clean.png"

for f in OUTDIR.glob("*.pdf"):
    f.unlink()
OUTDIR.mkdir(parents=True, exist_ok=True)

proc = launch()
try:
    tgt = find_page_target()
    assert tgt, "no page target"
    ws = WS(tgt["webSocketDebuggerUrl"])

    def ev(expr, await_promise=False, timeout=90):
        r = ws.call("Runtime.evaluate", {
            "expression": expr, "returnByValue": True,
            "awaitPromise": await_promise,
        }, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("text") + " :: " +
                               str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:300])
        return r["result"].get("value")

    def wait_for(expr, timeout=30, interval=0.4):
        t0 = time.time()
        last = None
        while time.time() - t0 < timeout:
            last = ev(expr)
            if last:
                return last
            time.sleep(interval)
        raise TimeoutError(f"{expr} -> {last!r}")

    # 等 React 挂载
    wait_for("!!document.querySelector('.toolbar')", timeout=40)
    print("[1] 前端已挂载")

    # 1. 注入文件
    def set_file(selector, path):
        doc = ws.call("DOM.getDocument")["root"]["nodeId"]
        nid = ws.call("DOM.querySelector", {"nodeId": doc, "selector": selector})["nodeId"]
        ws.call("DOM.setFileInputFiles",
                {"files": [str(path)], "nodeId": nid})

    set_file('input[accept*="pdf"]', PDF)
    wait_for("!!document.querySelector('canvas.page-canvas')", timeout=40)
    print("[2] PDF 已载入并渲染:", ev("document.querySelector('.pager')?.innerText.replace(/\\n/g,' ')"))

    set_file('input[accept*="image"]', SEAL)
    wait_for("document.querySelector('.panel').innerText.includes('DPI')", timeout=40)
    print("[3] 印章预处理:", ev("document.querySelector('.panel').innerText.replace(/\\n/g,' | ')")[:150])

    # 2. 放置印章
    ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='放置印章').click()")
    wait_for("document.querySelectorAll('.stamp-box').length>0", timeout=20)
    print("[4] 印章已放置:", ev("JSON.stringify(document.querySelector('.stamp-box').getBoundingClientRect().width)"))

    # 3. 拖拽
    ev("""(() => {
      const el=document.querySelector('.stamp-box');
      const r=el.getBoundingClientRect();
      const cx=r.left+r.width/2, cy=r.top+r.height/2;
      const pd=(t,x,y,g)=>(g||window).dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,button:0,buttons:1,bubbles:true,pointerId:1}));
      pd('pointerdown',cx,cy,el); pd('pointermove',cx-60,cy+40,el);
      pd('pointermove',cx-120,cy+80,el); pd('pointerup',cx-120,cy+80,el);
    })()""")
    time.sleep(0.6)
    st = ev("""(()=>{const e=document.querySelector('.stamp-box');
      return JSON.stringify({left:e.style.left,top:e.style.top,w:e.style.width,rot:e.style.transform});})()""")
    print("[5] 拖拽后:", st)

    # 4. 导出 —— 这是 Tauri 下最关键的一步
    ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='导出 PDF').click()")
    time.sleep(4)

    # 轮询下载目录
    got = None
    for _ in range(30):
        files = list(OUTDIR.glob("*.pdf"))
        if files:
            time.sleep(1.5)
            got = max(files, key=lambda p: p.stat().st_mtime)
            break
        time.sleep(1)
    print("[6] 导出结果:", got or "未发现下载文件")
    if not got:
        # 再看应用内是否有报错横幅
        print("    横幅:", ev("document.querySelector('.banner')?.innerText"))
        print("    busy:", ev("document.querySelector('.banner.busy')?.innerText"))
    ws.close()
finally:
    proc.kill()
    proc.wait(timeout=15)

print("\nDONE" if got else "\nNO DOWNLOAD")