"""复现用户报告的"无法导出"，抓取真实证据。

抓三类信息：
1. 控制台错误/警告（Console / Log domain）
2. 页面异常（Runtime.exceptionThrown）
3. 导出后的应用内状态（横幅文本）+ 磁盘上是否真的产出文件
"""
import base64
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import WS, find_page_target, launch

_ROOT = Path(__file__).resolve().parent.parent
TESTDATA = _ROOT / "testdata"
EX = _ROOT / "examples"
DOWNLOADS = Path(os.environ["USERPROFILE"]) / "Downloads"

logs = []


def main():
    proc = launch()
    try:
        tgt = find_page_target()
        assert tgt, "no page target"
        ws = WS(tgt["webSocketDebuggerUrl"])

        for domain in ("Console", "Log", "Runtime", "DOM"):
            ws.call(f"{domain}.enable", {})

        def drain():
            try:
                ws.sock.settimeout(0.2)
                while True:
                    data = ws.recv()
                    d = json.loads(data)
                    m = d.get("method", "")
                    if m == "Runtime.consoleAPICalled":
                        args = [str(a.get("value", a.get("description", ""))[:200])
                                for a in d["params"].get("args", [])]
                        logs.append(f"[console.{d['params'].get('type')}] " + " | ".join(args))
                    elif m == "Runtime.exceptionThrown":
                        det = d["params"]["exceptionDetails"]
                        logs.append(f"[exception] {det.get('text')} "
                                    f"{det.get('exception', {}).get('description', '')[:200]}")
                    elif m == "Log.entryAdded":
                        e = d["params"]["entry"]
                        logs.append(f"[log.{e.get('level')}] {e.get('text', '')[:200]}")
            except Exception:
                ws.sock.settimeout(30)
            finally:
                ws.sock.settimeout(30)

        def ev(expr, timeout=60):
            r = ws.call("Runtime.evaluate", {
                "expression": expr, "returnByValue": True, "awaitPromise": False,
            }, timeout=timeout)
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:300])
            return r["result"].get("value")

        def wait_for(expr, timeout=40):
            t0 = time.time()
            while time.time() - t0 < timeout:
                drain()
                if ev(expr):
                    return True
                time.sleep(0.4)
            return False

        wait_for("!!document.querySelector('.toolbar')")
        print("[1] 界面已加载")

        def set_file(sel, path):
            # 每次重新取 document：React 重渲染会让旧的 nodeId 失效
            doc = ws.call("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
            nid = ws.call("DOM.querySelector",
                          {"nodeId": doc, "selector": sel})["nodeId"]
            if not nid:
                raise RuntimeError(f"找不到文件输入框: {sel}")
            ws.call("DOM.setFileInputFiles", {"files": [str(path)], "nodeId": nid})

        set_file('input[accept*="pdf"]', EX / "示例文件.pdf")
        ok = wait_for("!!document.querySelector('canvas.page-canvas')")
        print(f"[2] PDF 渲染: {ok}")
        set_file('input[accept*="image"]', EX / "示例公章.png")
        wait_for("document.querySelector('.panel').innerText.includes('DPI')")
        print("[3] 印章已载入")

        ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='放置印章').click()")
        wait_for("document.querySelectorAll('.stamp-box').length>0")
        print("[4] 印章已放置")

        # 记录 UI 上的实际坐标（pt，左上角原点），供 verify-export 比对
        coords = ev(
            "(()=>{const e=document.querySelector('.stamp-box');"
            "return JSON.stringify({left:e.style.left,top:e.style.top,"
            "width:e.style.width,rot:e.style.transform});})()")
        print("[4b] 印章 UI 坐标:", coords)

        # 点击导出前记录 Downloads 快照
        before = {p.name for p in DOWNLOADS.glob("*.pdf")} if DOWNLOADS.exists() else set()

        # 直接调 DOM 的下载路径，捕获是否抛错
        print("[5] 点击导出…")
        ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='导出 PDF').click()")
        drain()

        time.sleep(5)
        for _ in range(12):
            drain()
            after = {p.name for p in DOWNLOADS.glob("*.pdf")} if DOWNLOADS.exists() else set()
            if after - before:
                break
            time.sleep(1)

        print("\n--- 横幅状态 ---")
        for sel in (".banner", ".banner.error", ".banner.busy", ".banner.ok",
                    ".statusbar", "header"):
            txt = ev(f"(document.querySelector({sel!r})||{{}}).innerText")
            if txt:
                print(f"  {sel}: {txt.strip()[:160]!r}")

        print("\n--- 控制台 / 异常 ---")
        seen = set()
        for line in logs:
            k = line[:120]
            if k not in seen:
                seen.add(k)
                print("  " + line)
        if not logs:
            print("  (无)")

        print("\n--- 磁盘产出 ---")
        after = {p.name for p in DOWNLOADS.glob("*.pdf")} if DOWNLOADS.exists() else set()
        new = after - before
        print(f"  Downloads 新增: {sorted(new) if new else '无'}")
        for n in sorted(new):
            f = DOWNLOADS / n
            print(f"    {f.name}  {f.stat().st_size/1024:.1f} KB")

        ws.close()
    finally:
        proc.kill()
        proc.wait(timeout=15)


import json

if __name__ == "__main__":
    main()