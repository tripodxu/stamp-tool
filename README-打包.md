# 打包成 exe（Tauri）

> ## ⚠️ 改了源码就必须重新打包，否则 exe 里还是旧逻辑
>
> Tauri 把 `dist/` 的前端资源**编译进二进制**。源码改了、exe 没重建，两边界面
> 长得一模一样，但 exe 跑的是旧代码——曾出现过「拖拽旋转明明写在 StampBox.tsx
> 里，装出来的 exe 却没有」的误判，追查成本很高。
>
> 现在有两道防呆：
>
> 1. 界面工具栏显示**构建时间**（`构建 2026-10-17 12:4x`）。它和源码对不上，就说明 exe 该重打了。
> 2. 用 `npm run release`：构建 + 自动把 exe 拷到桌面（`--out <路径>` 或
>    `STAMP_EXE_OUT` 可改目标），并打印大小与 sha256。
>
> 手工流程仍然可用：`npm run tauri build`，然后把
> `src-tauri/target/release/stamp-tool.exe` 复制到项目目录树之外。
> **不要**把它留在项目目录里运行——会让 Tauri 反复重建，见下文。

已完成。产物 **5.11 MB**，单文件、双击即用、目标机器无需安装任何运行库。

## 产物位置

构建产物在标准路径：

```
src-tauri/target/release/stamp-tool.exe
```

但**请把它复制到 `play\` 目录树之外**再运行，例如：

```
E:\印章工具.exe          ← 推荐
C:\Users\lenovo\Desktop\印章工具.exe
```

原因见下方「已知限制」。构建命令：

```powershell
cd C:\Users\lenovo\Desktop\play\stamp-tool
npm run tauri build
```

首次构建约 2 分钟，之后增量约 1 分钟。

## 已安装的工具链（无需重装）

| | 版本 |
|---|---|
| Visual Studio Build Tools C++ | 14.44.35207（`cl.exe` / `link.exe`） |
| Windows SDK | 10.0.22621.0 / 10.0.26100.0 |
| Rust | 1.99.0（stable-x86_64-pc-windows-msvc） |
| WebView2 Runtime | 155.0.4283.45（系统自带） |

## 已验证的完整流程

通过 CDP 远程调试驱动真实的 Tauri 窗口，跑了完整的盖章→导出：

1. 载入 3 页 PDF → pdf.js 在 `tauri.localhost` 协议下正常渲染（**worker 加载正常**）
2. 载入印章 PNG → 自动去白边、裁剪到墨迹边界、检出 532 DPI
3. 放置印章 → 拖拽定位
4. 点击导出 → 文件落到 `Downloads\test-doc-已盖章.pdf`（**blob 下载在 WebView2 下正常**）
5. 对导出文件做像素级校验，**全部通过**：

```
[PASS] 文字仍可提取（未被栅格化）— 原 745 字符 / 出 745 字符
[PASS] 正文逐字一致
[PASS] 印章中心与 UI 拖拽位置一致 — 偏差 (-0.00, -0.02) mm
[PASS] 印章直径 = 设定值 — 设定 40.0mm / 实测 39.62mm
```

相关脚本：[e2e-tauri.py](C:\Users\lenovo\Desktop\play\stamp-tool\scripts\e2e-tauri.py)、[cdp.py](C:\Users\lenovo\Desktop\play\stamp-tool\scripts\cdp.py)、[verify-export.py](C:\Users\lenovo\Desktop\play\stamp-tool\scripts\verify-export.py)。

## 已修复的两个配置坑

### 1. `devUrl` 导致 release 版白屏

`tauri.conf.json` 里同时写了 `devUrl` 和 `frontendDist`。Tauri 的
`generate_context!()` 会优先使用 `devUrl`，于是**打包后的 exe 仍然去访问
`http://localhost:5183/`**（Vite 开发服务器）。开发服务器没跑时，窗口显示
`chrome-error://chromewebdata/` —— 整个界面都不存在，自然点不了任何按钮。

修法：删掉 `devUrl`，只保留 `frontendDist`。`beforeDevCommand` 留着，
`npm run tauri dev` 仍会正常启动开发服务器。

> 这个 bug 很难靠"点按钮试试"发现：窗口确实打开了，只是里面是浏览器的
> 错误页。判断依据是 CDP 里 `location.href` 为 `chrome-error://`。

### 2. pdf.js 的 cMap 缺失导致汉字变空白

控制台报 `Warning: loadFont - translateFont failed: "Ensure that the cMapUrl
API parameter is provided"`。遇到 PDF 内嵌 CJK 子集字体时，pdf.js 要去
cMap 目录查字形映射，找不到就渲染成空白。

`cmaps/` 和 `standard_fonts/` 是「按文件名读取」的静态资源，不是 ES 模块，
`?url` 解析不了（Vite 会报 `failed to resolve import`）。解法是在
[vite.config.ts](C:\Users\lenovo\Desktop\play\stamp-tool\vite.config.ts)
里加一个 `pdfjs-assets` 插件，构建时把这两个目录整份复制到 `dist/` 根，
并在 [pdfReader.ts](C:\Users\lenovo\Desktop\play\stamp-tool\src\lib\pdfReader.ts)
里把 `cMapUrl` / `standardFontDataUrl` 指过去。

代价：dist 从 3.19 MB 涨到 5.06 MB，exe 从 3.70 MB 涨到 5.11 MB。
值得——否则遇到中文 PDF 会静默显示空白。

## 已知限制

### 1. 不能在 `play\` 目录树内运行

exe 只要位于 `C:\Users\lenovo\Desktop\play\` 下（含其任意子目录），启动必定失败：

```
Failed to setup app: WebView2 error: HRESULT(0x800700AA) "请求的资源在使用中。"
```

实测数据：

| 位置 | 成功率 |
|---|---|
| `play\stamp-tool\` 内任意位置 | **0/10** |
| `E:\`、`Desktop`、`LOCALAPPDATA`、`TEMP` | **10/10** |
| 同一个二进制文件（SHA256 `5EAAAD3E…`） | 两处结果不同 |

排除了：代码、配置、前端资源、窗口配置、identifier、用户数据目录残留、残留 webview2 进程、
Rust hello-world 在同目录（正常）。**结论是目录本身的环境因素，未能查明具体成因**——
怀疑与 DSH 对工作区的文件监控钩子冲突，但无法确证。

### 2. 360 安全卫士会拦截构建

Rust 构建会产出大量未签名的中间 exe/DLL。360 + Defender 双开会拦截它们，导致：

```
LNK1104: 无法打开文件 displaydoc-xxx.dll
error: failed to run custom build command ... (os error 32)
```

诊断特征：**只有这个确切文件名**被拒绝创建，同目录其他文件正常，同名文件在其他目录正常。

解决：构建期间退出 360，或把 `src-tauri\target`、`~/.cargo`、`~/.rustup` 加入信任区。

### 3. 未签名 exe

没有代码签名证书，Windows SmartScreen 会提示"未知发布者"。这是分发时的常态。

### 4. 导出文件不弹保存对话框

沿用浏览器的 blob 下载行为，直接落到系统默认下载目录。若需要"另存为"对话框，
加 `tauri-plugin-dialog` 即可（需 npm 装插件 + Rust 依赖 + capabilities 授权）。

## 工程说明

Rust 侧是**空壳**，不含任何业务逻辑：

- [src/lib.rs](C:\Users\lenovo\Desktop\play\stamp-tool\src-tauri\src\lib.rs) 只调用 `tauri::Builder::default().run(...)`
- [capabilities/default.json](C:\Users\lenovo\Desktop\play\stamp-tool\src-tauri\capabilities\default.json) 只授予 `core:default`，**没有**文件系统、Shell、网络权限
- 盖章、渲染、导出全部在前端 WebView 内完成，文件不上传

`src/` 下 14 个前端源文件自始至终一行未改。

### 一处环境适配

[scripts/run-tauri.cjs](C:\Users\lenovo\Desktop\play\stamp-tool\scripts\run-tauri.cjs) 是一层包装。原因：
`@tauri-apps/cli` 的入口靠 `process.argv[0]` 判断是否由 node 启动，而 DSH 宿主环境下
`argv[0]` 是宿主 exe 路径，导致 `unrecognized subcommand 'DSH Desktop.exe'`。
包装把 `argv[0]` 还原成 node，其余行为完全沿用官方逻辑。

## 附：移除了 oxlint

`package.json` 里移除了 `oxlint`（Vite 模板自带）。原因是 npm 11.6.2 解析其平台 binding 包时崩溃：

```
npm error Invalid Version: at canDedupe (arborist/lib/node.js)
```

换官方 registry 同样复现，是 arborist 的 bug，与本项目无关。需要 lint 的话装个固定版本即可。