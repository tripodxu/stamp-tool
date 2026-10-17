"""纯标准库实现 CDP 客户端，驱动 Tauri 内嵌的 WebView2。

不需要 websocket 库：手写 WebSocket 帧（客户端必须 mask）即可。

用法：先让 exe 以 --remote-debugging-port 启动，
再调 json 找到 page target 的 webSocketDebuggerUrl。
"""
import base64
import json
import os
import socket
import struct
import subprocess
import time
import urllib.request
from pathlib import Path

# 路径统一在这里解析，且都能用环境变量覆盖——公开仓库里不该写死某台机器的目录。
#   STAMP_EXE      打包好的 exe（默认在桌面，见 README-打包.md：不能放在项目目录树里）
#   STAMP_TESTDATA 夹具目录（默认仓库内的 testdata/）
#   STAMP_OUTDIR   下载落盘目录（默认 testdata/_downloads，已被 .gitignore 忽略）
#   STAMP_CDP_PORT 调试端口（不指定就自己挑一个空的，见 free_port）
ROOT = Path(__file__).resolve().parent.parent

# 调试端口默认不写死 9333：那个端口很可能被别的应用占着（实测遇到一个 Electron
# 应用占着它）。WebView2 绑不上端口时会**静默**放弃调试接口，脚本却照样能连上
# 占用者，于是报出「界面未加载」这种牛头不对马嘴的错。所以：没显式指定时，
# 在 9333 往上找第一个没人监听的端口。0 表示「还没定」。
PORT = int(os.environ.get("STAMP_CDP_PORT") or 0)
EXE = Path(os.environ.get("STAMP_EXE") or (Path.home() / "Desktop" / "印章工具.exe"))
TESTDATA = Path(os.environ.get("STAMP_TESTDATA") or (ROOT / "testdata"))
OUTDIR = Path(os.environ.get("STAMP_OUTDIR") or (TESTDATA / "_downloads"))
OUTDIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- WebSocket
class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        assert b"101" in buf.split(b"\r\n")[0], buf[:200]
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self._id = 0

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, payload: bytes, opcode=0x1):
        hdr = bytearray([0x80 | opcode])
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 1 << 16:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(hdr) + masked)

    def recv(self):
        while True:
            b0, b1 = self._recv(2)
            opcode = b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv(8))[0]
            data = self._recv(length) if length else b""
            if opcode == 0x8:
                raise ConnectionError("server closed")
            if opcode in (0x1, 0x2):
                return data

    def call(self, method, params=None, timeout=60):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params or {}}
        self.send(json.dumps(msg).encode())
        deadline = time.time() + timeout
        while time.time() < deadline:
            data = json.loads(self.recv())
            if data.get("id") == mid:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error']}")
                return data.get("result", {})
        raise TimeoutError(method)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def free_port(start=9333, tries=50):
    """从 start 往上找第一个没人监听的端口。"""
    for p in range(start, start + tries):
        with socket.socket() as s:
            s.settimeout(0.25)
            if s.connect_ex(("127.0.0.1", p)) != 0:  # 连不上＝空着
                return p
    raise SystemExit(f"{start}~{start + tries - 1} 都被占用了，用 STAMP_CDP_PORT 指定一个空端口")


def active_port():
    """launch() 与 find_page_target() 必须用同一个端口，所以只在这里决定一次。"""
    global PORT
    if not PORT:
        PORT = free_port()
    return PORT


def is_ours(target):
    """只认印章工具自己的页面——同一个调试端口上可能有别人的应用。"""
    url = target.get("url") or ""
    return (url.startswith("http://tauri.localhost") or url.startswith("tauri://")
            or "印章工具" in (target.get("title") or ""))


def find_page_target(port=None):
    port = port or active_port()
    others = []
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as r:
                targets = json.load(r)
            for t in targets:
                if t.get("type") != "page" or not t.get("webSocketDebuggerUrl"):
                    continue
                if is_ours(t):
                    return t
                label = f"{t.get('title')} <{t.get('url')}>"
                if label not in others:
                    others.append(label)
        except Exception:
            pass
        time.sleep(1)
    print(f"没找到印章工具的页面（127.0.0.1:{port}）。")
    if others:
        print("  这个端口上看到的是别人的页面：" + "；".join(others))
        print("  说明印章工具没能绑上这个端口（换个空端口会自动重挑，或用 STAMP_CDP_PORT 指定）。")
    return None


def kill_stale():
    """清掉上一轮没退干净的实例。

    残留进程会占住 WebView2 的用户数据目录，新实例起来后**直接退出**：
    窗口不出现、调试端口也不监听，表现为 find_page_target() 超时返回 None。
    （早先 E: 之外的失败是另一回事：0x800700AA 也是这个错，但成因是目录环境。）
    """
    subprocess.run(["taskkill", "/F", "/IM", EXE.name],
                   capture_output=True, text=True)
    time.sleep(0.5)


def launch(port=None):
    port = port or active_port()
    if not EXE.exists():
        raise SystemExit(
            f"找不到打包好的 exe：{EXE}\n"
            "  先 npm run release（会构建并自动拷贝），或用 STAMP_EXE 指定路径。"
        )
    kill_stale()
    env = {**os.environ}
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={port}"
    env.pop("WEBVIEW2_USER_DATA_FOLDER", None)
    p = subprocess.Popen([str(EXE)], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p


if __name__ == "__main__":
    proc = launch()
    tgt = find_page_target()
    if not tgt:
        print("FAILED to find page target")
        proc.kill()
        raise SystemExit(1)
    print("title:", tgt.get("title"))
    print("url  :", tgt.get("url"))
    ws = WS(tgt["webSocketDebuggerUrl"])
    r = ws.call("Runtime.evaluate",
                {"expression": "document.title + '|' + document.body.innerText.slice(0,80)",
                 "returnByValue": True})
    print("evaluate:", r["result"]["value"])
    ws.close()
    proc.kill()
    proc.wait(timeout=10)
    print("OK")