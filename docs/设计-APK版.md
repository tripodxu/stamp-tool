# 印章工具 · Android（APK）版设计

> 基线：当前 main（桌面 Tauri v2 + 纯前端，零 Rust 业务代码）。
> 设计日期：2026-10-24。
> 一句话结论：**选 Tauri v2 的 Android 目标，前端代码 100% 复用；真正要新做的只有两块——「保存导出文件」的移动链路，和一套窄屏布局。** 核心链路（渲染、坐标、去背、导出、撤销、印章库）是纯 Web 实现，天然跨平台。

---

## 1. 目标与非目标

**目标（首版）**

- 在手机上完成完整闭环：选 PDF → 选/拍印章 → 拖拽盖章 → 导出文件到用户可取到的位置。
- 印章库（IndexedDB）在移动端同样持久：杀进程、重启手机不丢。
- 批量盖章可用，但按手机内存约束限制规模（见 §7）。

**非目标（首版不做，预留）**

- iOS / iPadOS（Tauri v2 同样支持，但需要 macOS 构建链，单独排期）。
- 系统分享接收（「用其他应用打开 PDF → 印章工具」的 intent filter）。
- 深色模式、多语言。
- 云同步 / 账号体系——与「文件不出本机」的产品承诺冲突。

## 2. 技术选型

| 方案 | 结论 | 理由 |
|---|---|---|
| **Tauri v2 android** | ✅ 采用 | 现有 Rust 壳是零业务逻辑的空壳，`tauri android init` 直接生成 Android 工程；构建链、配置、验收脚本全部复用；产物是 WebView 壳 + 打包前端，体积可控（估 15–25MB） |
| Capacitor | ❌ | 要在 Tauri 之外再养一套 Node 原生工程与插件体系，桌面/移动两套壳并存，维护面翻倍 |
| 纯 PWA | ❌ | Android 上 PWA 的「下载文件」体验残缺（无稳定下载路径），File System Access API 在移动端不可用，而**导出文件**恰恰是本应用的生命线 |

WebView 差异是选型的核心代价：桌面是 WebView2（Edge 内核），Android 是 System WebView（Chromium，随 Google Play 更新，evergreen）。两者对 Web 标准的支持都足够新（`CompressionStream`、OffscreenCanvas、Pointer Events 均可用），本项目用到的 API 无一例外。

## 3. 现有代码的移动端就绪度

逐块盘点过源码后的结论：

| 模块 | 就绪度 | 说明 |
|---|---|---|
| pdf.js 渲染 / pdf-lib 导出 / pageSpace 坐标 | ✅ 直接可用 | 纯 Web，与平台无关 |
| 去背算法（sealPixels）、PNG/ZIP 编码 | ✅ 直接可用 | `CompressionStream` 在 Chromium 80+ 可用 |
| IndexedDB 印章库 | ✅ 直接可用 | WebView 中可用且持久；备份策略见 §7 |
| 撤销栈 / reducer / 批量规则 | ✅ 直接可用 | 纯函数 |
| 触摸拖拽 | ✅ 基本可用 | StampBox 全程 Pointer Events，`.stamp-box` 已有 `touch-action: none`；手柄尺寸需加大（§6） |
| 文件选择 | ✅ 可用（需验收） | wry 0.57 的 `RustWebChromeClient` 实现了 `onShowFileChooser`，`<input type="file">` 会弹系统选择器 |
| **导出保存** | ❌ **核心缺口** | wry **没有** DownloadListener，`<a download>` 在 Android WebView 里点了没反应；`showSaveFilePicker`（saveAs.ts 的首选）在移动 WebView 也不存在 → 现有两条保存路径全断 |
| 窄屏布局 | ❌ 需要新做 | index.css（1098 行）没有任何媒体查询；tauri 窗口 `minWidth: 960` 也只是桌面约束 |
| 键盘快捷键 | ⚠️ 失效但无阻塞 | 所有快捷键都有按钮/手势等价物 |

## 4. 保存链路设计（最关键的决策）

桌面版的语义是「文件落进下载目录」；手机上没有用户看得见的「下载目录」心智，对应语义是**分享面板**（存到文件、发给微信、存网盘）。设计按能力探测分层，全部改动收敛在 `lib/saveAs.ts` 与导出按钮的落点：

```
导出 PDF（移动）
  ├─ navigator.canShare({ files: [File] }) 为真
  │    → navigator.share()：弹系统分享面板（首选，最符合手机心智）
  ├─ 否则，Tauri fs+dialog 插件可用（android 构建引入，见下）
  │    → 保存到应用文档目录，Toast 告知路径
  └─ 都不行 → 报错（移动端不做「下载」回退，静默失败最伤信任）
```

- **Web Share API**：Chromium 76+ 支持 `share()` 带文件，System WebView 中 `navigator.share` 通常可用；**wry 场景需要真机实测**（WebView 的 share 需要 Activity 配合，wry 对 `onShare`… 若不可用则落第二层）。这是阶段 1 的第一件验收事项。
- **Tauri 插件层**：项目至今刻意零插件（二进制体积），移动端打破这一条是值得的——用 Cargo 的 target 依赖做到**只在 android 构建引入**：

  ```toml
  [target.'cfg(target_os = "android")'.dependencies]
  tauri-plugin-dialog = "2"
  tauri-plugin-fs = "2"
  ```

  桌面 exe 的体积与依赖完全不受影响。备选：不引插件，自己写一个 ~30 行的 Rust command + `FileProvider` 把文件拷到公共 Documents 再弹分享——保留「零插件」纯度，但多维护一段 Rust。**推荐先用插件，等体积压力真实存在再考虑替换。**

批量导出（ZIP）同理走分享面板；分享多个文件 Android 支持（`files: [...]`）。

## 5. UI 适配设计

三个断点，渐进增强（桌面现状是默认态，不回归）：

| 断点 | 设备 | 布局 |
|---|---|---|
| ≥ 960px | 桌面（现状） | 不动 |
| 600–959px | 平板竖屏 / 折叠屏 | 工具栏换行；Inspector 收窄为可折叠侧栏 |
| < 600px | 手机 | **画布全屏 + 底部操作栏 + 底部抽屉**（见下） |

手机布局（< 600px）：

```
┌──────────────────────┐
│  印章工具      [导出] │  顶栏：品牌 + 导出（唯一常驻按钮）
│                      │
│                      │
│      页面画布         │  双指缩放 → setZoom；单指拖空白 → 滚动
│      （印章层）       │  单指拖章 → 移动（touch-action 已就绪）
│                      │
│                      │
├──────────────────────┤
│ [PDF] [章] [放] [批] │  底部操作栏：选择 PDF / 印章 / 放置 / 批量
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │  上滑抽屉手柄
│  （Inspector 抽屉）    │  选中章时自动弹起半屏：预设/直径/角度/浓度
│  （印章库在抽屉顶部）  │  印章库常驻抽屉第一屏
└──────────────────────┘
```

- 抽屉用现成的 `BatchPanel` 同款交互骨架（遮罩 + 卡片），`translateY` 三档（收起 / 半屏 / 全屏）。
- 触控目标 ≥ 44px：底部栏按钮 48px；缩放/旋转手柄从 18px 提到 24px（`calc(24px / var(--zoom,1))`，机制不变）。
- `index.html` 的 viewport 改 `width=device-width, initial-scale=1.0, viewport-fit=cover`，CSS 用 `env(safe-area-inset-bottom)` 给底部栏让位。
- 印章双击旋转手柄在小屏上太难命中：给选中章加「旋转 ±15°」两个 chip（Inspector 里已有滑杆，chip 是快捷方式）。

## 6. 工程与构建

**目录**：`tauri android init` 生成 `src-tauri/gen/android`（Gradle 工程，进 git）。

**本机环境现状与补齐清单**（2026-10-24 阶段 0 已全部完成 ✅）：

| 组件 | 现状 | 动作 |
|---|---|---|
| Android SDK | ✅ 已装（`%LOCALAPPDATA%\Android\Sdk`：build-tools / platforms / platform-tools） | 无 |
| NDK | ✅ r27（`ndk\27.0.12077973`，腾讯镜像下载解压） | 无 |
| cmdline-tools | ✅ 已装（`cmdline-tools\latest`） | 无 |
| JDK 17 | ✅ 复用 IntelliJ 的 `~/.jdks/jbr-17.0.14`（带 javac；系统默认 JDK 23 过新，Gradle 不认） | 无 |
| Rust targets | ✅ 4 个 android target 已装（走 rsproxy 镜像；官方源在本机不通） | 无 |
| 环境变量 | ✅ 由 `npm run android`（scripts/run-android.cjs）自动注入 | 无 |
| Gradle 9.6.1 | ✅ wrapper 已指腾讯镜像（services.gradle.org 本机不通） | 无 |

**ABI 策略**：release 只出 `arm64-v8a`（覆盖当代 Android 手机的 99%+，APK 体积最小）；debug 出全 ABI 方便模拟器。

**版本与签名**：

- `tauri.conf.json > version`（如 `0.1.0`）→ `versionCode` 用「主.次.修」拼十进制（001.00.00 → 10000）并在 `gen/android` 的构建脚本里同步，避免手改两处。
- release keystore 用 `keytool` 生成，**不进 git**（`.gitignore` 追加 `*.keystore`）；口令经环境变量注入。丢 keystore = 无法原地升级，README-打包.md 要写灾难恢复说明。

**脚本**：`scripts/run-tauri.cjs` 透传子命令即可（`npm run tauri -- android dev` / `android build`）；`scripts/release.mjs` 加 android 分支（产物：`app-universal-release.apk`，输出到 `dist-android/`）。

## 7. 平台行为差异与对策

| 差异 | 影响 | 对策 |
|---|---|---|
| 无 DownloadListener | `<a download>` 静默失败 | §4 的分层保存链路 |
| `dragDropEnabled` 无意义 | 桌面拖放不存在 | 入口只剩文件选择器；「拖进窗口」相关 UI 文案在移动端隐藏（按 `pointer: coarse` 或 Tauri platform 探测） |
| 内存上限严苛（WebView 常见 512MB–1.5GB） | 大 PDF 渲染、批量 ZIP 可能 OOM 被杀 | ① 批量条数上限提示（如 >10 份或 >300MB 总量时警告）；② ZIP 已改为 Blob 分片（不占 JS 堆）；③ OOM 表现为进程被杀，无法捕获——靠预防，不靠兜底 |
| `allowBackup` 默认 true | 换机迁移会带上 IndexedDB（印章库） | **保留**：印章是用户资产，丢了要重新翻拍；在隐私说明里写明 |
| WebView 版本碎片（极老设备） | CompressionStream 缺失 → 导出直接坏 | 启动时探测 `typeof CompressionStream`，缺失则横幅「系统 WebView 过旧，请更新」；不为 2019 年前的设备做 polyfill |
| 相机拍摄印章直传 | 移动端独有高频路径 | `<input type="file" accept="image/*" capture="environment">` 加「拍摄印章」按钮——去背算法（paper 路线）本就为翻拍照片设计，正好对口 |

## 8. 分阶段落地

| 阶段 | 内容 | 验收（PASS 条件） |
|---|---|---|
| **0 · 能跑**（半天） | 补齐环境 → `tauri android init` → debug 包在真机启动 | ✅ 2026-10-24 完成（实录见 §11；真机 vivo V2453A / Android 16） |
| **1 · 能存**（1–2 天） | §4 保存链路 + 手柄/按钮加大 + 双指缩放 | ✅ 基本完成：`share=true` 真机确认，导出/批量走 `navigator.share`（§12）；pinch 已实现（真机手感待用户反馈） |
| **2 · 好用**（2–3 天） | < 600px 布局（底部栏 + 抽屉） | ✅ 2026-10-24 完成（§12；截图验收通过） |
| **3 · 可发**（1 天） | 签名、release 构建、验收脚本、文档 | ⏳ release keystore 与文档待做 |

**验收自动化**：debug 包开 WebView 远程调试（`adb forward tcp:9222 …` + `chrome://inspect`），现有 CDP 验收脚本（`scripts/acceptance*.py`）无需改动即可复用——这是当初选 CDP 做验收的直接回报。真机手动清单保留：分享导出、相机拍章、杀进程重开三项只能真机。

## 9. 风险与备选

| 风险 | 概率 | 备选 |
|---|---|---|
| `navigator.share(files)` 在 wry WebView 不可用 | 中 | §4 第二层（dialog+fs 插件）就是为此准备的，探测式分层保证无需返工 |
| Gradle/JDK23 不兼容 | 中高 | 装 JDK17（§6），一次性成本 |
| 大 PDF 在低端机渲染 OOM | 低中 | 渲染已按需单页 + dpr 封顶 2；必要时把 dpr 上限降为 1.5（一行） |
| wry Android 的 `<input type=file>` 行为差异（如不弹相机） | 低 | `onShowFileChooser` 已在 wry 源码确认；验收覆盖 `capture` 属性 |

## 10. 与桌面版的关系

- 一份前端代码，两份壳；`docs/设计文档.md` 的四条架构决策（预览/导出解耦、alpha≈multiply、物理单位、快照撤销）全部继续成立——它们本来就是平台无关的。
- 桌面优先级不变：移动端新增的代码（保存探测、抽屉布局）都以「桌面零感知」为约束——构建产物不引入移动专属依赖（插件按 target 隔离），CSS 断点不影响 ≥960px 的现状。

---

## 11. 阶段 0 实录（2026-10-24，已跑通）

环境见 §6（全部就绪）。产物：**`dist-android/stamp-tool-arm64.apk`**（1.98MB，debug 签名，arm64-v8a），含 `classes.dex` + `libstamp_tool_lib.so`（308KB，前端资源经 custom-protocol 编进 so）。已验证：签名合法（apksigner verify）。**待真机装机**：`adb install -r dist-android\stamp-tool-arm64.apk`（当前无设备连接）。

### 标准构建路径（环境干净时）

```
npm run android -- build --apk --target aarch64
```

`scripts/run-android.cjs` 负责 JAVA_HOME / ANDROID_HOME / NDK_HOME / cargo PATH 的注入。

### 本机推荐：一键绕行路径

上面三个坑（网络镜像 + 360 拦截 + 符号链接）在本机同时存在时，用固化好的整条链：

```
npm run apk          # scripts/make-apk.mjs：build → cargo → 拷 .so/assets → Gradle → 签名
```

产物直接落在 `dist-android/stamp-tool-arm64.apk`（约 4.2MB，debug 签名）。增量约 1–2 分钟。
脚本容忍 CLI 在符号链接一步的预期失败（.so 已落盘），并补齐它没做完的两份拷贝——尤其是 assets，漏了就是闪退（见坑 4）。

### 本机实际遇到的三个坑与绕行

1. **rustup 官方源不通**：`rustup target add` 卡死。用镜像：
   `RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup rustup target add aarch64-linux-android …`
   （gradle wrapper 同理已指 `mirrors.cloud.tencent.com/gradle/`；dl.google.com 的 zip 下载也被拦，SDK/NDK 全走 `mirrors.cloud.tencent.com/AndroidSDK/`。）
2. **360 主动防御拦截 cargo 派生的 cl.exe**：debug 构建编 `vswhom-sys`（tauri-build 的宿主侧构建脚本）时 cl.exe 无输出退出、退出码 2——与 README-打包.md 记录的拦截同源。单独跑 cl 完全正常，仅 cargo 进程链被杀。**绕行**：改走 release 构建（`--apk --target aarch64`），宿主构建脚本复用桌面 release 的缓存（`target/release/build`），不再触发该编译。**长期方案**：把 `src-tauri\target`、`~\.cargo`、`~\.rustup` 加入 360 信任区，此后 debug 构建也应正常。
3. **符号链接权限**：tauri CLI 把 .so 软链进 jniLibs 需要 Windows 开发者模式/管理员，本机未开。**绕行**：手动复制 + 直接调 Gradle：

   ```
   copy src-tauri\target\aarch64-linux-android\release\libstamp_tool_lib.so ^
        src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\
   cd src-tauri\gen\android && gradlew.bat --no-daemon ^
     -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64 ^
     -x rustBuildArm64Release -x rustBuildUniversalRelease assembleArm64Release
   ```

   首次约 20 分钟（AGP/依赖全量下载）；增量快。若开了开发者模式，标准路径（§标准构建路径）可跳过这一步。

4. **【已踩】绕行 Gradle 时必须手动拷前端资源**：Android 版的前端不在 .so 里，而是 CLI 在调 Gradle 前把 `dist/` 整目录拷进
   `gen/android/app/src/main/assets/`、打进 APK 的 `assets/`，WebView 从那里加载。
   上面第 3 条的绕行跳过了 CLI，**不拷这一步产出的 APK 会闪退**（首版 APK 1.98MB、assets 全空，装上即崩；补拷后 4.42MB 正常）：

   ```
   xcopy /E /I dist src-tauri\gen\android\app\src\main\assets
   ```

   然后重跑 Gradle + 签名。判断方法：`unzip -l app-arm64-release-unsigned.apk | findstr index.html` 必须能看到 `assets/index.html`。

5. **【已踩·真闪退根源】lib.rs 缺 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`**：
   项目原是纯桌面模板，Rust 侧没写移动入口 → 编出的 `libstamp_tool_lib.so`
   **导出符号为零**（llvm-nm -D 只有 libc 的 U 引用），Kotlin 侧 `Rust.kt` 声明的
   `external fun onCreate(...)` 等全部落空，第一次原生调用即 `UnsatisfiedLinkError`，
   表现为打开即闪退。坑 4 修完后它依然崩——两个问题叠加。
   修法（已落）：`src-tauri/src/lib.rs` 的 `run()` 加
   `#[cfg_attr(any(target_os = "android", target_os = "ios"), tauri::mobile_entry_point)]`，
   桌面构建零影响（cargo check 通过）。修复后 .so 308KB→6.28MB、
   JNI 导出 0→24 个（`Java_cn_stamptool_pdf_Rust_onCreate/ipc/handleRequest…`），
   APK 4.4→9.9MB。
   **自检命令**（改任何 Rust 侧内容后跑一遍）：

   ```
   llvm-nm -D gen\android\app\src\main\jniLibs\arm64-v8a\libstamp_tool_lib.so | findstr " T "
   ```

### 签名与装机

```
%LOCALAPPDATA%\Android\Sdk\build-tools\34.0.0\zipalign.exe -f -p 4 <in.apk> <out.apk>
%LOCALAPPDATA%\Android\Sdk\build-tools\34.0.0\apksigner.bat sign ^
  --ks %USERPROFILE%\.android\debug.keystore --ks-pass pass:android --key-pass pass:android <out.apk>
adb install -r dist-android\stamp-tool-arm64.apk
```

正式发布前的 release keystore 方案见 §6（版本与签名）。

---

## 12. 阶段 1/2 实录（2026-10-24 深夜，真机闭环完成）

真机：vivo V2453A（Android 16，360×800 逻辑像素，dpr 3）。开发循环全程
`npm run apk → adb install -r → am start → screencap` 截图目视验收。

### 手机布局（App.tsx 结构分叉 + .app.mobile CSS）

- **结构分叉而非纯 CSS**：`useMediaQuery('(max-width: 599px)')` 且叠加
  **UA 兜底**（`/Android|iPhone|...|Mobile/`）。后者是防御——WebView 若
  忽略 meta viewport，媒体查询会失真；UA 不受影响。（实测本机 viewport
  正常：360×800、mq=true，之前看到桌面布局其实是旧包没装上。）
- 顶栏：品牌 + N 枚章 + 撤销/重做 + 导出；底部五等宽：PDF / 印章 /
  **拍照**（`capture="environment"`，翻拍照片正是去背算法的主战场）/
  放置 / 批量；画布上方浮条：页码 ‹› + 缩放 −+；Inspector 变为底部抽屉
  （62vh，选中章自动弹起，胶囊把手开合）。
- 触控：底部栏 48px、抽屉内非 chip 按钮 42px、拖拽/旋转手柄 24px、
  删除钮 32px（反缩放机制 `calc(1/var(--zoom))` 不变，只改基础尺寸）。
- `viewport` meta：`user-scalable=no`（防整页缩放与画布 pinch 打架）+
  `viewport-fit=cover`；底部栏/抽屉用 `env(safe-area-inset-bottom)` 让位。
- **双指缩放画布**：PageCanvas 捕获阶段监听 touch，两指间距比例 → setZoom；
  桌面无 touch 事件天然不触发。
- 桌面回归零影响：JS 分叉只走一支；CSS 全部限定 `.app.mobile` 域。

### 手机导出：分享面板

真机确认 `navigator.canShare({files}) === true`（诊断条曾验证后已删）。
`saveAs.ts` 新增 `shareFile()/canShareFiles()`：单份导出与批量 ZIP 在
手机 UA 下优先 `navigator.share`（系统面板可存「文件」/发微信），
用户取消静默、不支持回退 blob 下载。桌面路径不变。

### 遗留（阶段 3 前）

- 真机手感项待用户反馈：pinch 手感、拖章精度、抽屉开合、拍照去背效果。
- `adb install -r` 在 vivo 上偶发被安装确认弹窗挡住（表现为装完还是旧
  UI）——排查时先 `am force-stop` 再启动，并看构建时间戳。
- release keystore、版本号联动、README 装机说明。

### 交互补丁（2026-10-24 用户反馈两个问题）

1. **抽屉无返回**：抽屉(z-index 更高)打开时把外侧把手盖住了 → 抽屉自带
   sticky「收起 ▾」条，滚动时常驻顶部（adb 驱动验证开合闭环 ✅）。
2. **放置后看不见 PDF**：抽屉 62vh 自动弹出挡住画布 → 三处修正：
   「放置」新章不自动弹抽屉（先看章落在哪、拖到位）；点选已有章仍自动弹；
   拖动/缩放章时抽屉自动收起（`mobileBeginEdit` 只包画布路径，抽屉内
   滑杆的 beginEdit 不受影响，调参数不会把抽屉调没）。

### 批量盖章问题排查实录（2026-10-24 深夜，adb 驱动真机逐层定位）

用户报「批量盖章有问题」。真机驱动（uiautomator dump 拿物理坐标 + input tap）
逐层挖出**三个叠加的问题**，全部修复：

1. **share 手势过期（真 bug）**：跑完在异步回调里 `navigator.share`——Web Share
   要求 transient activation（~5s），批量跑几十秒必过期 → 落入 downloadBlob →
   Android WebView 无下载器 → 静默失败，UI 却谎报「已保存」。
   **修**：跑完存住 ZIP（zipPending），结果区出「保存 / 分享压缩包」按钮，
   点击（新手势）才交付；单份导出同理加固，失败时诚实报错。
2. **本机 WebView 没有 navigator.share（环境事实）**：vivo System WebView 裁掉了
   Web Share（`no share fn`；之前诊断条的 share=true 是截图 AI 误读）。
   **修**：MainActivity 的 `onWebViewCreate` 注入 `window.AndroidShare` 原生桥
   （JS→base64→cacheDir→FileProvider→ACTION_SEND chooser），
   `saveAs.shareFile` 探测失败自动走桥，桥不依赖用户手势。零新增插件。
3. **交付按钮被固定页脚盖住（UI bug）**：结果区滚到底时「保存/分享」按钮与
   页脚「开始批量盖章」bounds 完全重叠——用户点交付 = 触发重跑。
   **修**：`.app.mobile .batch-body { padding-bottom: 150px }` 留出滚动空间。

排查工具链沉淀：`uiautomator dump` 的坐标是**物理像素**（本机 1260×2800，
WebView viewport 是 360×800，换算 ≈×3.17）——`input tap` 必须用物理坐标，
按逻辑像素点全会点偏。documentsui 选择器可直接驱动（「最近」列表点文件行）。
