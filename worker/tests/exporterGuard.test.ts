import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { stampDocument } from '../src/lib/exporter';
import type { Stamp } from '../src/lib/types';

const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (ch) => ch.charCodeAt(0),
);

const stamp: Stamp = {
  id: 's1', pageIndex: 1, pngBytes: PNG_1x1, xPt: 10, yPt: 10,
  widthPt: 50, heightPt: 50, rotationDeg: 0, opacity: 1, aspect: 1, cropW: 10,
};

describe('导出层的参照系防呆', () => {
  it('frames 缺页时直接报错，不静默按 MediaBox 写', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    doc.addPage([595.28, 841.89]);
    await expect(
      stampDocument(doc, [stamp], {
        frames: [{ view: [0, 0, 595.28, 841.89], rotation: 0, userUnit: 1 }],
      }),
    ).rejects.toThrow(/第 2 页/);
  });

  it('不传 frames 时退回 pdf-lib 的兜底帧（脚本单独调用导出层）', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const out = await stampDocument(doc, [{ ...stamp, pageIndex: 0 }]);
    expect(out.length).toBeGreaterThan(0);
  });
});
