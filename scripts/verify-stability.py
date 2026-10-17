"""严格判定：同一个产物连续跑 10 次，统计成功率。

前面的二分里「基准」也 RUNNING，说明结果受运行时状态影响
（残留 webview2 进程 / UDF 锁），单次结果不可信。
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

EXE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    os.environ.get("STAMP_EXE")
    or (Path(__file__).resolve().parent.parent / "src-tauri" / "target" / "release" / "stamp-tool.exe"))
ENV = {**os.environ, "RUST_BACKTRACE": "1"}
UD = Path(os.environ["LOCALAPPDATA"]) / "cn.stamptool.pdf"
N = 10


def clear_udf():
    if UD.exists():
        shutil.rmtree(UD, ignore_errors=True)


print(f"exe: {EXE}  ({EXE.stat().st_size/1e6:.2f} MB)")
print(f"连续 {N} 次，每次运行前清空 UDF\n")

ok = 0
for i in range(1, N + 1):
    clear_udf()
    p = subprocess.Popen([str(EXE)], cwd=str(EXE.parent),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV)
    try:
        o, e = p.communicate(timeout=12)
        txt = e.decode("utf-8", "replace")
        msg = next((t.split("message:")[-1].strip()[:50] for t in txt.splitlines()
                    if "message:" in t), "(none)")
        print(f"  {i:2}. FAIL  {msg}")
    except subprocess.TimeoutExpired:
        p.kill(); p.communicate()
        print(f"  {i:2}. RUNNING")
        ok += 1
    time.sleep(1)

print(f"\n>>> 成功率 {ok}/{N}")
clear_udf()