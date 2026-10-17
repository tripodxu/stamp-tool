# -*- coding: utf-8 -*-
"""端到端（用户层面改进专项）：多份拖入、按页码盖章、印章库改名与去重、
键盘 Delete/Ctrl+D、每枚章记住自己的直径角度浓度。

这些改动都不影响导出 PDF 的像素（那是 acceptance-pageframes / batch / check-export-alpha
的活），所以单开一个脚本按界面行为验收。

前置：npm run release（把 exe 放到 scripts/cdp.py 里的 EXE 路径）

用法：python scripts/acceptance-improve.py
"""
import base64
import re
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
DOWNLOADS = OUTDIR / "improve"
# 「同一枚章、另一份文件」：像素一致但字节不同（Pillow 重编码），
# 正是用户会遇到的那种重复——同一张章导了两次、或黑框修复前后各导一次。
VARIANT = DOWNLOADS / "同一枚章-另存一份.png"

# 面板上的三个数字。用 \s* 而不是 . —— <b> 在 innerText 里可能另起一行
DIA = r"直径\s*([\d.]+)\s*mm"
ROT = r"旋转\s*(-?\d+)°"
OPA = r"印油浓度\s*(\d+)%"

CONFIRM = ("[...document.querySelectorAll('.banner.warn')]"
           ".some(b=>b.textContent.includes('清空当前已盖'))")
CONFIRM_EL = ("[...document.querySelectorAll('.banner.warn')]"
              ".find(b=>b.textContent.includes('清空当前已盖'))")

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    return ok


def make_variant():
    """把示例公章另存一份：像素一模一样，字节不同（所以是两条库记录）。"""
    from PIL import Image, PngImagePlugin

    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    im = Image.open(SEAL)
    im.load()
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    # 每次跑都写入不同的文字块：像素不变、字节每次都新，
    # 于是每一轮都会稳定地多出一个「重复项」给「清理重复」去收拾
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", f"variant {time.time():.6f}")
    im.save(VARIANT, "PNG", pnginfo=info)
    return VARIANT


def main():
    variant = make_variant()

    proc = launch()
    try:
        ws = WS(find_page_target()["webSocketDebuggerUrl"])
        ws.call("Browser.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": str(DOWNLOADS), "eventsEnabled": True})

        def ev(expr):
            r = ws.call("Runtime.evaluate",
                        {"expression": expr, "returnByValue": True, "awaitPromise": True})
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
            return ev(f"(()=>{{const b={expr}; if(!b) return false; b.click(); return true;}})()")

        def click_text(text, tag="button"):
            return click(f"[...document.querySelectorAll('{tag}')]"
                         f".find(b=>b.textContent.trim().includes('{text}'))")

        def blur():
            ev("document.activeElement && document.activeElement.blur"
               " && document.activeElement.blur(); true")

        def insert_text(text):
            ws.call("Input.insertText", {"text": text})

        def key(name, code=None, vk=0, modifiers=0):
            for t in ("rawKeyDown", "keyUp"):
                ws.call("Input.dispatchKeyEvent",
                        {"type": t, "key": name, "code": code or name,
                         "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk,
                         "modifiers": modifiers})

        def panel_num(pattern):
            text = ev("(document.querySelector('.panel')||{}).innerText") or ""
            m = re.search(pattern, text)
            return m.group(1) if m else None

        def seal_names():
            return ev("[...document.querySelectorAll('.seal-name')].map(n=>n.textContent)") or []

        def seal_count():
            return ev("document.querySelectorAll('.seal-list li').length") or 0

        def stamp_count():
            text = ev("(document.querySelector('.count')||{}).textContent") or ""
            m = re.search(r"(\d+)", text)
            return int(m.group(1)) if m else -1

        def activate_seal(name):
            return ev("(()=>{const li=[...document.querySelectorAll('.seal-list li')]"
                      f".find(x=>(x.querySelector('.seal-name')||{{}}).textContent==={name!r});"
                      " if(!li) return false; li.querySelector('.seal-item').click(); return true;})()")

        def open_pdf(path):
            set_file('input[accept*="pdf"]', path)
            if wait(f"!!({CONFIRM})", 5):
                click(f"{CONFIRM_EL}.querySelector('button.primary')")
            return wait("!document.querySelector('.banner.busy')"
                        " && !!document.querySelector('canvas.page-canvas')", 60)

        def place_stamp():
            for _ in range(6):
                click_text("放置印章")
                if wait("document.querySelectorAll('.stamp-box').length>0", 3):
                    return True
            return False

        def add_stamp():
            """点「放置印章」并等章数真的 +1——画布上本来就有章时，光看有没有章会假通过。"""
            before = stamp_count()
            for _ in range(6):
                click_text("放置印章")
                if wait(f"((document.querySelector('.count')||{{}}).textContent||'')"
                        f".startsWith('{before + 1}')", 4):
                    return True
            return False

        def set_range(index, value):
            return ev("(()=>{const rs=[...document.querySelectorAll('.panel input[type=range]')];"
                      f"const i=rs[{index}]; if(!i) return false;"
                      "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"
                      f"'value').set; s.call(i,{value!r});"
                      "i.dispatchEvent(new Event('input',{bubbles:true})); return i.value;})()")

        def stamp_spec(text):
            """在「盖到…」输入框里写 spec 并提交。"""
            ev("(()=>{const i=document.querySelector('.page-range-input'); if(!i) return false;"
               "i.focus(); i.select(); return true;})()")
            insert_text(text)
            click_text("盖到…")
            time.sleep(0.8)

        assert wait("!!document.querySelector('.toolbar')", 40), "界面未加载"

        # ---------------------------------------------------------------- 1
        print("\n【1】一次拖进多份 PDF：直接开批量面板，别只开第一份")
        pairs = [("fixture-rotate90.pdf", TESTDATA / "fixture-rotate90.pdf"),
                 ("fixture-rotate270.pdf", TESTDATA / "fixture-rotate270.pdf")]
        items = ", ".join(
            "[%r, %r]" % (n, base64.b64encode(p.read_bytes()).decode())
            for n, p in pairs)
        dropped = ev("(async()=>{const dt=new DataTransfer();"
                     f"for(const [n,b64] of [{items}]){{"
                     "const bin=atob(b64); const a=new Uint8Array(bin.length);"
                     "for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i);"
                     "dt.items.add(new File([a],n,{type:'application/pdf'}));}"
                     "const v=document.querySelector('.viewport');"
                     "for(const t of ['dragover','drop'])"
                     "v.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}));"
                     "return dt.files.length;})()")
        opened = wait("!!document.querySelector('.batch-card')", 15)
        listed = ev("[...document.querySelectorAll('.batch-files li')]"
                    ".map(li=>li.textContent)") or []
        check("拖进 2 份 PDF → 批量面板自动打开并预填 2 份",
              opened and len(listed) == 2 and dropped == 2,
              f"拖了 {dropped} 份，面板里 {len(listed)} 份：{'、'.join(x[:24] for x in listed)}")
        click("document.querySelector('.batch-card .seal-del')")
        wait("!document.querySelector('.batch-card')", 10)

        # ---------------------------------------------------------------- 2
        print("\n【2】印章库改名：双击名字改，重启后还在")
        set_file('input[accept*="image"]', SEAL)
        assert wait("document.querySelectorAll('.seal-list li').length>0", 40), "印章未入库"
        was = ev("(document.querySelector('.seal-list li.active .seal-name')||{}).textContent")
        new_name = f"合同章-{int(time.time()) % 100000}.png"
        ev("(()=>{const n=document.querySelector('.seal-list li.active .seal-name');"
           "n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true;})()")
        edited = wait("!!document.querySelector('.seal-name-input')", 5)
        ev("(()=>{const i=document.querySelector('.seal-name-input'); i.focus(); i.select();"
           "return true;})()")
        insert_text(new_name)
        key("Enter", vk=13)
        time.sleep(0.6)
        renamed = new_name in seal_names()
        check("双击名字能改名", edited and renamed, f"「{was}」→「{new_name}」")

        ws.call("Page.reload")
        reloaded = wait(f"!!document.querySelector('.toolbar')"
                        f" && [...document.querySelectorAll('.seal-name')]"
                        f".some(n=>n.textContent==={new_name!r})", 60)
        check("重启（重载）后新名字还在", reloaded, f"库里 {len(seal_names())} 枚")

        # 再导一次同一个文件：不该多出一条，也不该把名字冲回文件名
        before = seal_count()
        set_file('input[accept*="image"]', SEAL)
        wait("!document.querySelector('.banner.busy')", 30)
        time.sleep(1.5)
        after = seal_count()
        still = new_name in seal_names()
        check("重复导入同一个文件：不新增条目、不冲掉改过的名字",
              after == before and still, f"{before} → {after} 枚，名字还在 {still}")

        # ---------------------------------------------------------------- 3
        print("\n【3】单份文档也能按页码盖（不用先去批量面板）")
        assert open_pdf(TESTDATA / "test-doc.pdf"), "test-doc.pdf 未载入"
        assert place_stamp(), "印章未放置"
        check("第 1 页放了一枚", stamp_count() == 1, f"{stamp_count()} 枚")

        stamp_spec("abc")
        text = ev("(document.querySelector('.banner.error')||{}).textContent") or ""
        check("页码写错时如实报错", "看不懂" in text, text.strip()[:60])
        click("document.querySelector('.banner.error button')")

        stamp_spec("1")
        text = ev("(document.querySelector('.banner.error')||{}).textContent") or ""
        check("只写当前页：说明没有新页要盖", "没有需要新盖的页" in text, text.strip()[:60])
        click("document.querySelector('.banner.error button')")

        stamp_spec("3")
        ok = wait("document.querySelectorAll('.pager-menu-btn').length===1", 5)
        done = ev("(document.querySelector('.banner.done')||{}).textContent") or ""
        check("写「3」→ 第 3 页多一枚，且告知盖到哪几页",
              stamp_count() == 2 and ok and "第 3 页" in done,
              f"{stamp_count()} 枚；{done.strip()[:40]}")
        click("document.querySelector('.banner.done button')")

        # ---------------------------------------------------------------- 4
        print("\n【4】键盘：Ctrl+D 复制、Delete 删除、? 看快捷键")
        blur()
        key("d", code="KeyD", vk=68, modifiers=2)  # Ctrl+D
        time.sleep(0.5)
        dup = stamp_count()
        key("Delete", vk=46)
        time.sleep(0.5)
        gone = stamp_count()
        check("Ctrl+D 复制选中的章、Delete 删掉它",
              dup == 3 and gone == 2, f"2 → {dup} → {gone} 枚")

        click("document.querySelector('.icon-btn')")
        time.sleep(0.4)
        items = ev("[...document.querySelectorAll('.keys-menu li')].map(li=>li.textContent)") or []
        check("工具栏「?」列出快捷键", len(items) >= 8 and any("Ctrl+D" in x for x in items),
              f"{len(items)} 条")
        ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true")
        time.sleep(0.3)

        # ---------------------------------------------------------------- 5
        print("\n【5】每枚章记住自己的直径/角度/浓度，重启后新放的章照它来")

        def size_text():
            return (f"直径 {panel_num(DIA)} mm、旋转 {panel_num(ROT)}°"
                    f"、浓度 {panel_num(OPA)}%")

        # 参数是记在「画布上这一枚」上的，所以先把章放下来、面板才会出现这三个滑杆
        assert activate_seal(new_name), "没找到刚改名的章"
        assert add_stamp(), "改参数前先放一枚"
        click("[...document.querySelectorAll('.panel button')]"
              ".find(b=>b.textContent.trim()==='30mm')")
        set_range(1, "10")
        time.sleep(0.9)  # 参数落库是防抖的，等它写完
        check("把这一枚改成 30mm / 10°",
              panel_num(DIA) == "30.0" and panel_num(ROT) == "10", size_text())

        was = seal_count()
        set_file('input[accept*="image"]', variant)
        # 必须等这一枚真的处理完并成为「使用中」——只看库里有没有章会读早了，
        # 后面的判断就变成「用上一枚的参数」而非「用这一枚自己的参数」
        landed = wait(f"document.querySelectorAll('.seal-list li').length==={was + 1}"
                      " && (document.querySelector('.seal-list li.active .seal-name')||{})"
                      f".textContent==={VARIANT.name!r}", 60)
        active_now = ev("(document.querySelector('.seal-list li.active .seal-name')||{})"
                       ".textContent")
        check("另存一份的另一枚章真的入库了", landed,
              f"{was} → {seal_count()} 枚，使用中「{active_now}」")
        assert add_stamp(), "换章后没放下新的章"
        check("换成另一枚章：用回它自己的 40mm / −8°，不受上一枚影响",
              panel_num(DIA) == "40.0" and panel_num(ROT) == "-8",
              f"{VARIANT.name}：{size_text()}")

        assert activate_seal(new_name), "没找回改过参数的那枚"
        assert add_stamp(), "换回来没放下新的章"
        check("换回来：30mm / 10° 还在",
              panel_num(DIA) == "30.0" and panel_num(ROT) == "10", size_text())

        ws.call("Page.reload")
        assert wait("!!document.querySelector('.toolbar')", 60), "重载后界面没起来"
        assert open_pdf(TESTDATA / "test-doc.pdf"), "重载后文档未载入"
        assert place_stamp(), "重载后印章未放置"
        check("重载程序后新放的章仍是 30mm / 10°（参数存在库里）",
              panel_num(DIA) == "30.0" and panel_num(ROT) == "10", size_text())

        # ---------------------------------------------------------------- 6
        print("\n【6】清理重复：同一枚章的不同文件只留一条")
        before = seal_count()
        click("[...document.querySelectorAll('.link-btn')]"
              ".find(b=>b.textContent.includes('清理重复'))")
        got = wait("(document.querySelector('.banner.done')||{}).textContent"
                   "?.includes('重复')", 60)
        time.sleep(0.5)
        text = ev("(document.querySelector('.banner.done')||{}).textContent") or ""
        after = seal_count()
        m = re.search(r"已清理 (\d+) 枚", text)
        removed = int(m.group(1)) if m else 0
        check("「清理重复」把重复的那条删掉并如实报数",
              got and removed >= 1 and after == before - removed,
              f"{before} → {after} 枚；{text.strip()[:40]}")

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
