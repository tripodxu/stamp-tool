# -*- coding: utf-8 -*-
"""端到端（交互体验专项）：换文档确认、页码输入与翻页键、「有章的页」、另存为。

这些改动全都不影响导出 PDF 的内容，只影响操作手感——旧脚本（量印迹位置、
量透明区颜色）一个都覆盖不到，所以单开一个。

前置：npm run release（把 exe 放到 scripts/cdp.py 里的 EXE 路径）

用法：python scripts/acceptance-ux.py
"""
import json
import sys
import time
from pathlib import Path

# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import OUTDIR, WS, find_page_target, launch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TESTDATA = ROOT / "testdata"
SEAL = ROOT / "examples" / "示例公章.png"
DOWNLOADS = OUTDIR / "ux"

# 「换文档」确认条的判据：warn 横幅里点名了「清空当前已盖」
CONFIRM = ("[...document.querySelectorAll('.banner.warn')]"
           ".some(b=>b.textContent.includes('清空当前已盖'))")
CONFIRM_EL = ("[...document.querySelectorAll('.banner.warn')]"
              ".find(b=>b.textContent.includes('清空当前已盖'))")

VK = {"Enter": 13, "PageUp": 33, "PageDown": 34, "End": 35, "Home": 36}

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    return ok


def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for old in DOWNLOADS.glob("*.pdf"):
        old.unlink()

    proc = launch()
    try:
        ws = WS(find_page_target()["webSocketDebuggerUrl"])
        ws.call("Browser.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": str(DOWNLOADS), "eventsEnabled": True})

        def ev(expr):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"].get("text"))[:200])
            return r["result"].get("value")

        def wait(expr, t=30):
            end = time.time() + t
            while time.time() < end:
                if ev(expr):
                    return True
                time.sleep(0.3)
            return False

        def set_file(sel, path):
            doc = ws.call("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
            nid = ws.call("DOM.querySelector", {"nodeId": doc, "selector": sel})["nodeId"]
            ws.call("DOM.setFileInputFiles", {"files": [str(path)], "nodeId": nid})

        def click(expr):
            ev(f"(()=>{{const b={expr}; if(!b) return false; b.click(); return true;}})()")

        def click_text(text, tag="button"):
            click(f"[...document.querySelectorAll('{tag}')]"
                  f".find(b=>b.textContent.includes('{text}'))")

        def key(name):
            vk = VK.get(name, 0)
            for t in ("rawKeyDown", "keyUp"):
                ws.call("Input.dispatchKeyEvent",
                        {"type": t, "key": name, "code": name,
                         "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})

        def export_as():
            """导出是「主按钮 + 下拉」：另存为藏在 ▾ 里。"""
            click("document.querySelector('.export-caret')")
            time.sleep(0.3)
            click("[...document.querySelectorAll('.export-menu button')]"
                  ".find(b=>b.textContent.includes('另存为'))")

        def clear_done():
            click("document.querySelector('.banner.done button')"
                  "||document.querySelector('.banner.error button')")
            time.sleep(0.2)

        def open_pdf(path, confirm=True):
            """换文档；确认条弹出来就点「仍然打开」。"""
            set_file('input[accept*="pdf"]', path)
            if confirm and wait(f"!!({CONFIRM})", 5):
                click(f"{CONFIRM_EL}.querySelector('button.primary')")
            return wait("!document.querySelector('.banner.busy')"
                        " && !!document.querySelector('canvas.page-canvas')", 60)

        def page_value():
            return ev("(document.querySelector('.page-input')||{}).value")

        def place_stamp():
            for _ in range(6):
                click_text("放置印章")
                if wait("document.querySelectorAll('.stamp-box').length>0", 3):
                    return True
            return False

        assert wait("!!document.querySelector('.toolbar')", 40), "界面未加载"
        set_file('input[accept*="image"]', SEAL)
        assert wait("document.querySelector('.panel').innerText.includes('DPI')", 30), "印章未载入"

        print("\n【1】换文档：已经盖了章就先问一句")
        assert open_pdf(TESTDATA / "test-doc.pdf"), "test-doc.pdf 未载入"
        check("首次打开（还没有章）不弹确认", not ev(f"!!({CONFIRM})"))
        assert place_stamp(), "印章未放置"

        set_file('input[accept*="pdf"]', TESTDATA / "fixture-rotate90.pdf")
        if wait(f"!!({CONFIRM})", 6):
            text = ev(f"{CONFIRM_EL}.textContent")
            check("确认条说清了会丢几枚章", "1 枚印章" in text, text.strip())
        else:
            check("确认条说清了会丢几枚章", False, "换文档没弹确认")

        # 取消：文档、印章、撤销栈都该原样不动
        click(f"{CONFIRM_EL}.querySelector('button:not(.primary)')")
        time.sleep(0.6)
        kept = ev("document.querySelectorAll('.stamp-box').length")
        total = ev("(document.querySelector('.page-total')||{}).textContent")
        can_undo = ev("![...document.querySelectorAll('button')]"
                      ".find(b=>b.textContent.trim()==='撤销').disabled")
        check("点取消：文档没换、章还在、撤销栈还在",
              kept == 1 and "3" in (total or "") and can_undo,
              f"章 {kept} 枚，页数 {total}，可撤销 {can_undo}")

        # 仍然打开：章清空、文档换掉
        before_w = ev("document.querySelector('canvas.page-canvas').style.width")
        set_file('input[accept*="pdf"]', TESTDATA / "fixture-rotate90.pdf")
        if wait(f"!!({CONFIRM})", 6):
            click(f"{CONFIRM_EL}.querySelector('button.primary')")
        ok = wait("!document.querySelector('.banner.busy') && !document.querySelector('.banner.warn')"
                  " && document.querySelectorAll('.stamp-box').length===0"
                  " && !!document.querySelector('canvas.page-canvas')", 40)
        after_w = ev("document.querySelector('canvas.page-canvas').style.width")
        check("点仍然打开：章清空、文档真的换了", ok and before_w != after_w,
              f"画布宽 {before_w} → {after_w}")

        print("\n【2】页码可以直接敲、翻页键可用")
        assert open_pdf(TESTDATA / "test-doc.pdf"), "test-doc.pdf 未再次载入"
        ev("(()=>{const i=document.querySelector('.page-input'); i.focus(); i.select(); return true;})()")
        ws.call("Input.insertText", {"text": "3"})
        key("Enter")
        time.sleep(0.5)
        check("输入 3 + 回车 → 跳到第 3 页", page_value() == "3", f"页码框 = {page_value()}")

        key("PageUp")
        time.sleep(0.4)
        check("PageUp → 上一页", page_value() == "2", f"页码框 = {page_value()}")
        key("PageDown")
        time.sleep(0.4)
        check("PageDown → 下一页", page_value() == "3", f"页码框 = {page_value()}")
        key("Home")
        time.sleep(0.4)
        check("Home → 第 1 页", page_value() == "1", f"页码框 = {page_value()}")
        key("End")
        time.sleep(0.4)
        check("End → 末页", page_value() == "3", f"页码框 = {page_value()}")

        # 越界与非法输入：夹回范围，不能把文档翻丢
        ev("(()=>{const i=document.querySelector('.page-input'); i.focus(); i.select(); return true;})()")
        ws.call("Input.insertText", {"text": "99"})
        key("Enter")
        time.sleep(0.4)
        check("输入 99 → 夹回末页", page_value() == "3", f"页码框 = {page_value()}")

        print("\n【3】「有章的页」跳转 + 换页回到页首")
        assert place_stamp(), "印章未放置"
        click_text("复制到全部")
        assert wait("document.querySelectorAll('.pager-menu-btn').length===1", 5), "没出现「有章的页」"
        click("document.querySelector('.pager-menu-btn')")
        n = ev("document.querySelectorAll('.pager-menu-list button').length")
        check("菜单列出 3 个有章的页", n == 3, f"{n} 项")
        # 再点一次收起：合成点击不会触发 mousedown，所以浏览器不会替我们关掉它
        click("document.querySelector('.pager-menu-btn')")
        time.sleep(0.3)
        check("再点一次收起菜单", not ev("!!document.querySelector('.pager-menu-list')"))

        key("Home")
        time.sleep(0.4)
        ev("(()=>{document.querySelector('.viewport').scrollTop = 260; return true;})()")
        scrolled = ev("document.querySelector('.viewport').scrollTop")
        key("PageDown")
        time.sleep(0.5)
        scrolled2 = ev("document.querySelector('.viewport').scrollTop")
        check("换页后回到页首", scrolled > 0 and scrolled2 < 2,
              f"scrollTop {scrolled} → {scrolled2}")

        # 回到第 1 页，这样「跳到第 2 页」才是一次真正的跳转
        key("Home")
        time.sleep(0.4)
        click("document.querySelector('.pager-menu-btn')")
        assert wait("!!document.querySelector('.pager-menu-list')", 3), "菜单打不开"
        click("[...document.querySelectorAll('.pager-menu-list button')]"
              ".find(b=>b.textContent.includes('第 2 页'))")
        time.sleep(0.8)
        pv = page_value()
        sel = bool(ev("!!document.querySelector('.stamp-box.is-selected')"))
        boxes = ev("document.querySelectorAll('.stamp-box').length")
        check("跳到有章的页会选中该页的章", pv == "2" and sel and boxes >= 1,
              f"页码框 = {pv}，该页 {boxes} 枚章，选中 = {sel}")

        print("\n【4】另存为")
        check("导出是主按钮 + 下拉，另存为在菜单里",
              not ev("!!document.querySelector('.export-menu')")
              and bool(ev("!!document.querySelector('.export-caret')")),
              "默认收起")
        ev("""(()=>{
          window.__saved = null;
          window.showSaveFilePicker = async (opts) => {
            window.__saved = { opts, size: 0, head: '', closed: false };
            return {
              name: '自动化另存.pdf',
              createWritable: async () => ({
                write: async (blob) => {
                  const buf = await blob.arrayBuffer();
                  window.__saved.size = buf.byteLength;
                  window.__saved.head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 5)));
                },
                close: async () => { window.__saved.closed = true; },
              }),
            };
          };
          return true;
        })()""")
        clear_done()
        export_as()
        got = wait("(document.querySelector('.banner.done')||{}).textContent?.includes('已保存')", 30)
        saved = json.loads(ev("JSON.stringify(window.__saved)") or "null")
        check("另存为：文件真的写进用户选的位置",
              got and saved and saved["size"] > 5000 and saved["head"] == "%PDF-"
              and saved["closed"],
              f"{saved['size']} 字节，开头 {saved['head']!r}，已 close {saved['closed']}" if saved else "没走到 picker")
        check("另存为：建议文件名与类型过滤器都传对了",
              bool(saved) and saved["opts"]["suggestedName"].endswith("-已盖章.pdf")
              and saved["opts"]["types"][0]["accept"].get("application/pdf") == [".pdf"],
              json.dumps(saved["opts"], ensure_ascii=False) if saved else "—")

        # 不支持的环境必须自动回退到下载，不能让按钮点了没反应
        ev("window.showSaveFilePicker = undefined; true")
        clear_done()
        export_as()
        got = wait("(document.querySelector('.banner.done')||{}).textContent?.includes('不支持')", 30)
        text = ev("(document.querySelector('.banner.done')||{}).textContent") or ""
        landed = False
        for _ in range(20):
            if (DOWNLOADS / "test-doc-已盖章.pdf").exists():
                landed = (DOWNLOADS / "test-doc-已盖章.pdf").stat().st_size > 5000
                break
            time.sleep(0.5)
        check("环境不支持时自动回退到下载（并如实告知）", got and landed, text.strip())

        ws.close()

        bad = [r for r in RESULTS if not r[1]]
        print(f"\n结果：{len(RESULTS) - len(bad)}/{len(RESULTS)} 通过"
              + ("" if not bad else "；失败项：" + "、".join(r[0] for r in bad)))
        return 1 if bad else 0
    finally:
        proc.kill()
        proc.wait(timeout=15)


if __name__ == "__main__":
    sys.exit(main())
