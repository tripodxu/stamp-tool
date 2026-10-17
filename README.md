# 印章工具 · 轻量 PDF 盖章

把一枚背景透明的公章图片，经拖拽/缩放/旋转后盖到 PDF 的任意位置，导出仍是**原文档 + 一枚图**：
文字还是文字、字体还是原字体、矢量零损失。全部处理在本地浏览器/WebView 内完成，文件不上传。

打包成单文件 exe 的流程与已知环境坑见 [README-打包.md](README-打包.md)；
最初的架构推导见 [docs/设计文档.md](docs/设计文档.md)，
首轮代码审查与修复清单见 [docs/优化建议-首轮.md](docs/优化建议-首轮.md)。

## 常用命令

```bash
npm install
npm run dev          # 开发（默认 5173；打包脚本用的是 5183）
npm run build        # tsc -b && vite build → dist/
npm test             # vitest，纯逻辑回归（秒级）
npm run tauri build  # 打包 exe（产物在 src-tauri/target/release/）
npm run fixtures     # 重新生成并自检「旋转页 / 裁切框」测试夹具
```

## 四条不能破的架构决策

1. **编辑期不改文档像素**：预览是 pdf.js 渲染的 canvas + 一个绝对定位的 `<img>`，
   导出是 pdf-lib 往原内容流追加一次 `drawImage`。因此不需要 Konva/Fabric，
   也不需要为了预览去重渲染整页。推论：**导出质量恒 ≥ 预览质量**。
2. **白纸底 ⇒ alpha ≡ 正片叠底**，所以不注入 `/BM /Multiply` 的 ExtGState
   （`src/lib/exporter.ts` 顶部有推导）。
3. **印章有法定物理尺寸 ⇒ 一律用 PDF point 存储**，界面按 mm 显示
   （`src/lib/units.ts` 是唯一换算真源）。
4. **文档不可变 ⇒ 撤销是快照栈**，只存印章数组（`src/state/reducer.ts`）。

### 第 5 条（踩过坑之后补的）：页面几何以 pdf.js 为唯一真源

预览与导出看的**不是同一个坐标系**：

| | 预览（pdf.js getViewport） | 导出（pdf-lib drawImage） |
|---|---|---|
| /Rotate | 应用 | 不认识 |
| 边界 | 裁切框 CropBox | MediaBox |
| /UserUnit | 计入 | 不暴露 |

所以印章坐标一律按**显示空间**（预览里那张纸，左上原点）存储，导出前经
`src/lib/pageSpace.ts` 的 `displayToUser()` 换算成用户空间；页面帧
（`view` / `rotation` / `userUnit`）由 `pdfReader.readPages()` 在载入时采集，
随 `PdfHandle.pages` 一路传到 `stampDocument()`。

不这么做会怎样（栅格化后实测印迹落点）：

| 页面 | 旧实现的后果 |
|---|---|
| `/Rotate 90` + 居中 | 偏 **43.4mm** |
| `/Rotate 90` + 右下角预设 | 印迹**整个掉到可见页面之外**（导出文件里看不见章） |
| `/Rotate 90` + 落款处预设 | 偏 (+91.9, −105.1)mm |
| CropBox 四周内缩 20pt | 恒定偏 **7.2mm** |

而**预览全程正常**——用户要打开导出文件才会发现。扫描件靠 /Rotate 摆正、
印刷稿常带裁切框，这两种页面在真实文件里非常常见。

### 第 6 条：印章去背分两条路线，**别相信翻拍件的 alpha**

早期只有一条路线：把「alpha>0 但 RGB≈白」的像素置透明——这只对**规范的透明底 PNG** 成立。
真实用户交上来的多半是**手机翻拍 / 微信转存的照片**：整张图没有真正的透明像素，
或者 alpha 被抠图工具写成整片半透明。这时半透明的墨直接盖在合同上，
**底下的字会透上来**，看起来就是「重影」。

现在的分流规则（[sealPixels.ts](src/lib/sealPixels.ts)）：

| 输入 | 判据 | 做法 |
|---|---|---|
| 规范透明 PNG | 有 ≥2% 的全透明像素 | 尊重源 alpha，只清白色毛边 |
| 翻拍 / 扫描件 | 几乎没有全透明像素 | 按颜色反推墨量 `α = 距纸色距离 / 纸→墨距离`，再把颜色**反预乘**回实心墨色 |

反预乘保证「合成回白纸 ≡ 原照片」（`tests/sealPixels.test.ts` 里就是用这个往返等式做断言），
于是纸的地方真透明、墨的地方实心，不会把合同上的字带出来。
这类章默认浓度给 **1.0** 而不是 0.85：照片本身已带真实印迹的浓淡，再乘一次透明度只会让字透上来
（见 [geometry.ts](src/lib/geometry.ts) 的 `defaultOpacity`）。

实例对照：[testdata/ghost-before-after.png](testdata/ghost-before-after.png)
（左＝旧算法，右＝现在）；同一份导出文件用 pdf.js 渲染的样子见
[testdata/ghost-pdfjs-render.png](testdata/ghost-pdfjs-render.png)。

> 核查渲染时注意：**MuPDF / PyMuPDF 渲染带 SMask 的印章会明显偏淡**（内部按预乘样本处理）。
> 用它做像素测量（量位置、量直径）没问题，但**不能用它判断印章浓淡**——
> 那是「基色 + SMask」的数学问题，按标准 alpha 合成算，或者直接用 pdf.js 看。

## 印章库：导入一次，长期可用

导入过的印章会自动存进本机（IndexedDB，见 [sealStore.ts](src/lib/sealStore.ts)），
**下次打开直接点选，不必重新导入**；启动时自动选中最近用过的那一枚，打开即能盖章。

- 存的是**处理之后**的 PNG（已去背、已裁到墨迹边界）——正是导出要嵌入的字节，
  再次选用直接取用，不重跑像素处理。
- 入库用内容指纹（FNV-1a + 长度）去重：同一枚章重复导入只留一条，只刷新时间。
- 默认最多留 **30 枚**，超出淘汰最久没用过的（pickEvictions）。
- 列表按**导入时间**排（点选不会让行跳动）；「最近使用」只用于启动时自动选中。
- 「清空」要点两下确认（破坏性且没有撤销）。
- 用 IndexedDB 而不是 localStorage：后者只能存字符串（base64 让体积 +33%）、
  总量卡在 5MB，一枚高分辨率章就可能上百 KB；IndexedDB 直接存 Uint8Array，
  配额是几百 MB 量级，桌面版与浏览器版行为一致，也不必引入 Tauri 的文件系统插件。
- 存储位置：桌面版在 WebView2 的用户数据目录（跟着 exe 的 identifier 走），
  浏览器版在站点数据里。**清掉站点数据、或改 identifier，都会连同印章库一起清掉。**

验收脚本（会真的把程序关掉再打开，验证「不用重新导入」）：

    python scripts/acceptance-sealibrary.py

## 测试

```bash
npm test                                # 单测：映射/几何/单位/撤销栈/导出矩阵
python scripts/check-pagefixtures.py    # 夹具自检（栅格化确认方向没搞反）
```

单测里最值得看的是 `tests/pageSpace.test.ts`：它**不重复实现公式去自证**，
而是拿 pdf.js 自己的 `viewport.convertToPdfPoint()` 当 oracle 逐点比对四种旋转；
`tests/exporter.test.ts` 再进一步，直接解析导出文件内容流里的 `cm`/`Do` 矩阵，
断言印章中心落在 pdf.js 指的位置。这两条一起把「预览/导出各说各话」这类 bug
钉死在测试里——把 `displayToUser` 改回不认旋转，会有 11 条测试立刻变红。

端到端验收（需要先 `npm run tauri build`，并把 exe 放到 `scripts/cdp.py` 里的 `EXE` 路径）：

```bash
python scripts/acceptance.py             # 普通 A4：导入 → 盖章 → 导出 → 像素核对
python scripts/acceptance-pageframes.py  # 旋转页 / 裁切框：四种页面逐一核对
```

Python 侧依赖：`pip install -r scripts/requirements.txt`。

### 测试夹具

| 文件 | 用途 |
|---|---|
| `testdata/test-doc.pdf` | 3 页 A4 中文合同，验证导出后文字未被栅格化 |
| `testdata/fixture-rotate{90,180,270}.pdf` | 带 /Rotate 的页面（内容在显示方向是正的） |
| `testdata/fixture-cropbox.pdf` | 裁切框四周内缩 20pt |
| `testdata/seal-*.png` | 干净 / 带白边 / 低分辨率印章 |
| `testdata/rotate90-bug-proof.png` | 修复前的错位对照图（绿=应到位置，蓝=实际） |

夹具的角标刻意用**蓝色**：像素校验靠「红 = 印章」找印迹，夹具自己再用红色就会污染测量。

## 目录

```
src/lib/pageSpace.ts       显示空间 ↔ 用户空间（含旋转轴反解）—— 坐标系唯一真源
src/lib/exporter.ts        导出：签名检测、嵌入去重、追加 drawImage
src/lib/pdfReader.ts       预览：worker/cMap 配置、按需渲染、采集页面帧
src/lib/seal.ts            印章预处理：去白边、裁剪到墨迹、分辨率体检
src/lib/geometry.ts        摆放决策：预设位置、默认位置、夹紧
src/state/reducer.ts       纯 reducer（可单测）：撤销栈语义都在这里
src/state/useStampTool.ts  把上面这些接成 React hook
```

## 已知限制

- **exe 不能放在 `play` 目录树内运行**（WebView2 `0x800700AA`），详见 [README-打包.md](README-打包.md)。
- 未签名 exe：Windows SmartScreen 会提示"未知发布者"。
- 导出走浏览器 blob 下载，不弹"另存为"对话框，文件直接落进系统下载目录（界面会明确提示）。
- 盖在照片/深色底图上时，普通 alpha 混合与正片叠底不等价，印油观感会有偏差（设计文档 §3 决策 2）。
