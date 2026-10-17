"""核对 exe 是不是「最新源码构建的」那一版。

为什么需要这个脚本：Tauri 把 dist/ 的前端资源编译进二进制。改了源码、没重新打包时，
exe 的界面看起来和新的完全一样，跑的却是旧逻辑——曾经据此误判「拖拽旋转没做进
exe」。反过来，直接在 exe 字节里 grep 特征串也不可靠（嵌入资源被压缩过，只有个别
字符串能命中）。唯一可信的办法是问**运行中的界面**。

做法：
  1. 取源码树里最新的修改时间（src/**、index.html、vite.config.ts、package.json）；
  2. 启动 exe，读工具栏显示的「构建 …」——它是前端代码被编译进去的那一刻；
  3. 源码比构建时间新 ⇒ 这个 exe 落后于源码，该跑 npm run release 了。

用法：python scripts/check-exe.py
环境变量：STAMP_EXE / STAMP_CDP_PORT（见 cdp.py）
"""
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import EXE, ROOT, WS, find_page_target, launch

# 前端资源的来源；这些文件一变，exe 就必须重打
SOURCES = ["src", "index.html", "vite.config.ts", "package.json"]
# 前端构建完到 exe 落盘之间还有 cargo 编译，留一点余量
GRACE = timedelta(minutes=3)

EVAL = """(() => {
  const txt = document.querySelector('.toolbar .build')?.textContent || '';
  const m = txt.match(/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/);
  return JSON.stringify({
    build: m ? m[0] : '',
    raw: txt.trim(),
    lib: document.querySelectorAll('.seal-item').length,
    panel: !!document.querySelector('.seal-lib'),
    viewport: !!document.querySelector('.viewport'),
  });
})()"""


def newest_source() -> tuple[datetime, Path]:
    best = (0.0, None)
    for rel in SOURCES:
        p = ROOT / rel
        files = [q for q in (p.rglob("*") if p.is_dir() else [p]) if q.is_file()]
        for f in files:
            t = f.stat().st_mtime
            if t > best[0]:
                best = (t, f)
    return datetime.fromtimestamp(best[0]), best[1]


def main() -> int:
    if not EXE.exists():
        print(f"FAIL 找不到 exe：{EXE}\n     先 npm run release")
        return 1

    src_t, src_f = newest_source()
    print(f"exe        {EXE}")
    print(f"           文件时间 {datetime.fromtimestamp(EXE.stat().st_mtime):%Y-%m-%d %H:%M}")
    print(f"最新源码   {src_f.relative_to(ROOT)}  {src_t:%Y-%m-%d %H:%M}")

    proc = launch()
    try:
        tgt = find_page_target()
        if not tgt:
            print("FAIL 调试端口连不上（多半有残留实例占着 WebView2 用户数据目录）")
            return 1
        ws = WS(tgt["webSocketDebuggerUrl"])
        r = ws.call("Runtime.evaluate", {"expression": EVAL, "returnByValue": True})
        info = json.loads(r["result"]["value"])
        ws.close()
    finally:
        proc.kill()
        proc.wait(timeout=10)

    print(f"界面构建   {info['raw']!r}  印章库 {info['lib']} 枚")
    if not info["build"]:
        print("FAIL 工具栏里没有构建时间——这个 exe 太旧了（早于防呆改动），必须重打")
        return 1

    build_t = datetime.strptime(info["build"], "%Y-%m-%d %H:%M")
    ok = True

    # 1) 界面里的构建时间必须晚于（或等于）所有前端源码
    if src_t > build_t + GRACE:
        ok = False
        print(f"FAIL 源码 {src_f.name} 比界面构建时间新 "
              f"{(src_t - build_t).total_seconds() / 60:.0f} 分钟：exe 落后于源码")
        print("     → npm run release")
    else:
        print("OK   界面构建时间不早于前端源码")

    # 2) exe 文件本身必须晚于它内含的前端（拷贝发生在编译之后）
    exe_t = datetime.fromtimestamp(EXE.stat().st_mtime)
    if exe_t + GRACE < build_t:
        ok = False
        print(f"FAIL exe 文件时间 {exe_t:%H:%M} 早于界面构建时间 {build_t:%H:%M}：文件被旧版覆盖过")
    else:
        print("OK   exe 文件时间不早于界面构建时间")

    # 3) 关键 UI 元素确实渲染出来（防止启动即崩、只剩个空壳）
    missing = [k for k in ("panel", "viewport") if not info[k]]
    if missing:
        ok = False
        print(f"FAIL 缺少 UI 元素：{', '.join(missing)}")
    else:
        print("OK   印章库面板与视图区已渲染")

    print("\n结论：" + ("这个 exe 是最新的" if ok else "这个 exe 需要重新构建"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
