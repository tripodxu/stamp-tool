# -*- coding: utf-8 -*-
"""端到端：印章库持久化。

要证明的就一件事：**导入一次，关掉再打开，印章还在，不用重新导入。**

流程：
  1. 启动 → 记录初始印章库状态
  2. 导入 examples/示例公章.png → 库里应出现 1 枚且标记「使用中」
  3. 关掉程序
  4. 重新启动 → 不做任何导入，面板应已直接处于「印章已就绪」状态（有 DPI 体检、库里有使用中项）
  5. 再导入一枚 testdata/seal-clean.png → 库里 2 枚；点选第一枚 → 使用中标记跟着切

用法：python scripts/acceptance-sealibrary.py
前置：npm run tauri build，并把 exe 放到 scripts/cdp.py 的 EXE 路径。
"""
import json
import sys
# Windows 控制台默认 GBK，直接打 ✓/✗ 会 UnicodeEncodeError；统一改成 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import WS, find_page_target, launch

ROOT = Path(__file__).resolve().parent.parent
SEAL_A = ROOT / "examples" / "示例公章.png"
SEAL_B = ROOT / "testdata" / "seal-clean.png"

ok = True


def check(label, cond, detail=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")


def session(fn):
    """开一次程序，跑 fn(ev, wait, set_file)，然后关掉。"""
    proc = launch()
    try:
        ws = WS(find_page_target()["webSocketDebuggerUrl"])

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

        assert wait("!!document.querySelector('.toolbar')"), "界面未加载"
        time.sleep(1.2)  # 等印章库异步读完
        return fn(ev, wait, set_file, ws)
    finally:
        proc.kill()
        proc.wait(timeout=15)
        time.sleep(0.6)


def lib_state(ev):
    return json.loads(ev("""(()=>{
        const items=[...document.querySelectorAll('.seal-list li')];
        return JSON.stringify({
          count: items.length,
          names: items.map(li=>li.querySelector('.seal-name').textContent),
          active: items.findIndex(li=>li.classList.contains('active')),
          hasSeal: document.querySelector('.panel').innerText.includes('DPI'),
          emptyHint: !!document.querySelector('.note-inline'),
        });})()"""))


def import_first(ev, wait, set_file, ws):
    # 先清空（按两下确认），让这次跑从确定状态开始——
    # 上一轮留下的印章本来就该还在，那正是本测试要证明的事。
    ev("(()=>{const b=[...document.querySelectorAll('.link-btn')]"
       ".find(x=>x.textContent.includes('清空')); if(b) b.click(); return 1;})()")
    time.sleep(0.4)
    ev("(()=>{const b=[...document.querySelectorAll('.link-btn')]"
       ".find(x=>x.textContent.includes('确认清空')); if(b) b.click(); return 1;})()")
    time.sleep(0.6)
    set_file('input[accept*="image"]', SEAL_A)
    wait("document.querySelectorAll('.seal-list li').length>0", 30)
    time.sleep(0.8)
    return lib_state(ev)


def reopen(ev, wait, set_file, ws):
    return lib_state(ev)


print("【1】首次启动：导入一枚印章")
first = session(import_first)
check("导入后印章库出现 1 枚", first["count"] == 1, f"count={first['count']} {first['names']}")
check("该枚被标记为使用中", first["active"] == 0)
check("印章已就绪（面板显示 DPI 体检）", first["hasSeal"])

print("\n【2】关掉程序，重新启动（不做任何导入）")
second = session(reopen)
check("重启后印章库仍有 1 枚", second["count"] == 1, f"count={second['count']} {second['names']}")
check("重启后自动选中该枚（使用中）", second["active"] == 0)
check("重启后印章已就绪，无需重新导入", second["hasSeal"])
check("不再显示「空库」提示", not second["emptyHint"])


def add_second(ev, wait, set_file, ws):
    set_file('input[accept*="image"]', SEAL_B)
    wait("document.querySelectorAll('.seal-list li').length>1", 30)
    time.sleep(0.8)
    before = lib_state(ev)
    # 库里按「最近使用」排序，新导入的应该排在第一位且就是使用中的那枚。
    # 这里点选**第二**枚（先导入的 示例公章），使用中标记应当跟着切过去。
    ws.call("Runtime.evaluate", {
        "expression": "[...document.querySelectorAll('.seal-item')][1].click()"})
    time.sleep(1.5)
    after = lib_state(ev)
    return before, after


print("\n【3】再导入一枚 + 点选切换")
before, after = session(add_second)
check("库里现在有 2 枚", before["count"] == 2, f"{before['names']}")
check("新导入的排在最前", before["names"][0] == "seal-clean.png", f"{before['names']}")
check("新导入的即为使用中", before["active"] == 0, f"active={before['active']}")
check("点选另一枚后使用中标记切过去", after["active"] == 1, f"active={after['active']}")

print("\n结果：" + ("全部通过" if ok else "存在失败项"))
sys.exit(0 if ok else 1)
