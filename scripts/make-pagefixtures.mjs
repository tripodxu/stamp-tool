import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';

/**
 * 生成「页面几何」夹具：/Rotate 90/180/270 各一份 + 裁切框内缩一份。
 *
 * 为什么值得单独做夹具：预览层（pdf.js）会应用 /Rotate 并以裁切框为界，
 * 导出层（pdf-lib）只认 MediaBox、不认旋转。在普通 A4 上怎么测都测不出差别，
 * 而这两种页面在真实文件里极常见——扫描仪出图方向固定，靠 /Rotate 摆正；
 * 印刷稿常带裁切框。没有夹具，这类回归一辈子都不会被发现。
 *
 * 画法：内容先按**显示坐标**写，再经 toUser（与 src/lib/pageSpace.ts 的
 * displayToUser 同一套规则）映射进用户空间；文字再额外反向转 R，保证在
 * 显示方向是正的。映射抄错了的话，check-pagefixtures.py 会当场报出来。
 *
 * ⚠️ 用 pdf-lib 而不是 PyMuPDF 画：PyMuPDF 的绘图 API 会自动做页面反旋转，
 * 在带 /Rotate 的页面上写进去的坐标和最终显示位置对不上，很容易生成出
 * 「看起来对了其实错了」的夹具。
 */

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const W = 595.28;
const H = 841.89;
/**
 * 角标刻意用**蓝色**：像素级校验靠「红色 = 印章」来找印迹，
 * 夹具自己再用红色画角标就会把测量污染掉（bbox 会把两个红块一起框进去）。
 */
const MARK = rgb(0.12, 0.31, 0.85);
const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.6, 0.63, 0.68);

/** 与 src/lib/pageSpace.ts 的 displayToUser 同一套规则 */
function toUser(view, rot, x, y) {
  const [x0, y0, x1, y1] = view;
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [x0 + y, y0 + x];
    case 180:
      return [x1 - x, y0 + y];
    case 270:
      return [x1 - y, y1 - x];
    default:
      return [x0 + x, y1 - y];
  }
}

function drawContent(page, view, rot, w, h, title) {
  const P = (x, y) => toUser(view, rot, x, y);
  const rect = (x, y, rw, rh, opts) => {
    const [ax, ay] = P(x, y);
    const [bx, by] = P(x + rw, y + rh);
    page.drawRectangle({
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
      ...opts,
    });
  };
  const line = (x1, y1, x2, y2, opts) => {
    const [ax, ay] = P(x1, y1);
    const [bx, by] = P(x2, y2);
    page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, ...opts });
  };
  const text = (x, y, s, opts = {}) => {
    const [ax, ay] = P(x, y);
    page.drawText(s, { x: ax, y: ay, size: 9, color: INK, rotate: degrees(rot), ...opts });
  };

  rect(24, 24, w - 48, h - 48, { borderColor: GREY, borderWidth: 1 });
  rect(40, 40, 40, 40, { color: MARK }); // 显示左上角角标
  text(40, 96, 'TOP-LEFT', { color: MARK, size: 9 });
  text(40, 112, title, { size: 9 });

  const cx = w / 2;
  const cy = h / 2;
  line(cx - 18, cy, cx + 18, cy, { color: INK, thickness: 0.6 });
  line(cx, cy - 18, cx, cy + 18, { color: INK, thickness: 0.6 });
  text(cx + 24, cy + 4, 'PAGE CENTER', { size: 8 });

  line(w - 200, h - 46, w - 40, h - 46, { color: INK, thickness: 0.6 });
  text(w - 200, h - 40, 'BOTTOM-RIGHT', { size: 9 });
}

async function rotated(rot) {
  const view = [0, 0, W, H];
  const [, , dw, dh] = [0, 0, ...(rot % 180 === 0 ? [W, H] : [H, W])];
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  page.setRotation(degrees(rot));
  drawContent(page, view, rot, dw, dh, `FIXTURE  /Rotate=${rot}`);
  const file = path.join(OUT, `fixture-rotate${rot}.pdf`);
  fs.writeFileSync(file, await doc.save());
  return { file, rot, w: dw, h: dh };
}

async function cropped(inset = 20) {
  const view = [inset, inset, W - inset, H - inset];
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  // 注意 pdf-lib 的签名是 (x, y, width, height)，不是 x1/y1
  page.setCropBox(inset, inset, W - 2 * inset, H - 2 * inset);
  drawContent(page, view, 0, W - 2 * inset, H - 2 * inset, `FIXTURE  CropBox inset ${inset}pt`);
  const file = path.join(OUT, 'fixture-cropbox.pdf');
  fs.writeFileSync(file, await doc.save());
  return { file, rot: 0, w: W - 2 * inset, h: H - 2 * inset };
}

fs.mkdirSync(OUT, { recursive: true });
const made = [];
for (const rot of [90, 180, 270]) made.push(await rotated(rot));
made.push(await cropped());
for (const m of made) {
  console.log(`  ${path.basename(m.file).padEnd(24)} 显示 ${m.w.toFixed(0)}x${m.h.toFixed(0)}pt  /Rotate=${m.rot}`);
}
console.log('生成完毕，接着跑 check-pagefixtures.py 自检');
